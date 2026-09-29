/**
 * C1 变更分级 —— `fde_ontology_write` execute 层集成回归（mock ctx/audit，不走真实 DSH）。
 *
 * 覆盖：自动分级 + 手动降级拒绝（不落文件 + 审计 deny）+ 手动升级放行 + 审计带 level/added。
 * 纯函数 classifyChange / resolveManualLevel 由 `_fde_classify_test.mjs` 覆盖。
 *
 * 跑法： node _fde_classify_exec_test.mjs
 *       FDE_INVERT=1 node _fde_classify_exec_test.mjs
 */

import { writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { installOntologyTools } from '../dsh-fde-ontology-gate/lib/tools.js'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '_classify_exec_out.txt')
const lines = []
let passed = 0
let failed = 0

function t(name, fn) {
  return (async () => {
    try {
      await fn()
      passed += 1
      lines.push(`  ✓ ${name}`)
    } catch (e) {
      failed += 1
      lines.push(`  ✗ ${name}`)
      lines.push(`      ${e && e.message ? e.message : String(e)}`)
    }
  })()
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败')
}

const ALLOW = `rules:
  - id: r1
    effect: allow
    reason: 常规建议
    condition: {">": [{"var": "treatment.score"}, 0]}
`
const DENY = `rules:
  - id: r1
    effect: deny
    reason: 分数超限
    condition: {">": [{"var": "treatment.score"}, 100]}
`
const ALLOW_PLUS_DENY = `rules:
  - id: r1
    effect: allow
    reason: 常规建议
    condition: {">": [{"var": "treatment.score"}, 0]}
  - id: r2
    effect: deny
    reason: 分数超限
    condition: {">": [{"var": "treatment.score"}, 100]}
`

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'c1-exec-'))
  const ontologyRoot = join(root, 'onto')
  const auditRecords = []
  let writeTool = null
  const ctx = {
    tools: {
      register: (tool) => {
        if (tool.name === 'fde_ontology_write') writeTool = tool
        return () => {}
      }
    }
  }
  const audit = {
    record: async (e) => {
      auditRecords.push(e)
      return { seq: auditRecords.length, hash: '0'.repeat(64), persisted: false }
    }
  }
  const cfg = { ontologyRoot, industry: '未声明', mode: 'enforce' }

  installOntologyTools(ctx, cfg, audit)
  assert(writeTool, '应注册 fde_ontology_write 工具')
  const execute = writeTool.execute
  const exec = { callId: 'c1' }
  const logicPath = join(ontologyRoot, 'logic.yaml')

  lines.push('== C1 fde_ontology_write execute 集成回归 ==')

  await t('降级拒绝：自动 L1（新增 deny）+ 请求 L0 → throw LEVEL_DOWNGRADE_DENIED', async () => {
    let threw = null
    try {
      await execute(
        { path: 'logic.yaml', content: DENY, source: 'model', confidence: 80, reason: '测试', level: 'L0' },
        exec
      )
    } catch (e) {
      threw = e
    }
    assert(threw, '应抛错')
    // 桩环境 HarnessError 降级为 Error，code 不进 message；真实 SDK 里 code 在 error.info.code。
    assert(String(threw.message).includes('拒绝降级'), `错误应含「拒绝降级」，实际 ${threw.message}`)
    assert(String(threw.message).includes('自动判为 L1'), `错误应含自动级别 L1，实际 ${threw.message}`)
    assert(!existsSync(logicPath), '降级拒绝时文件不得落盘')
    assert(auditRecords.some((r) => r.decision === 'deny'), '应有 deny 审计')
  })

  await t('升级放行：自动 L0（新增 allow）+ 请求 L1 → 落盘 + 审计 level=L1', async () => {
    const res = await execute(
      { path: 'logic.yaml', content: ALLOW, source: 'model', confidence: 80, reason: '测试', level: 'L1' },
      exec
    )
    assert(res.level === 'L1', `返回 level 应 L1，实际 ${res.level}`)
    assert(existsSync(logicPath), '升级放行时文件应落盘')
    assert(auditRecords.some((r) => r.decision === 'allow' && r.level === 'L1'), '应有 allow 审计且 level=L1')
  })

  await t('自动分级：不传 level，新增 deny → 审计 level=L1 + added=1', async () => {
    await execute(
      { path: 'logic.yaml', content: ALLOW_PLUS_DENY, source: 'model', confidence: 80, reason: '测试' },
      exec
    )
    const rec = [...auditRecords].reverse().find((r) => r.decision === 'allow' && r.target === logicPath)
    assert(rec, '应有 allow 审计')
    assert(rec.level === 'L1', `自动 level 应 L1，实际 ${rec.level}`)
    assert(rec.autoLevel === 'L1', `autoLevel 应 L1，实际 ${rec.autoLevel}`)
    assert(rec.added === 1, `added 应 1，实际 ${rec.added}`)
    assert(rec.classifyReasons && rec.classifyReasons.length > 0, '应带 classifyReasons')
  })

  rmSync(root, { recursive: true, force: true })

  lines.push('')
  if (process.env.FDE_INVERT === '1') {
    lines.push(`  ✗ [INVERT] 故意失败以验证退出码敏感`)
    failed += 1
  }
  lines.push(`通过 ${passed} / 失败 ${failed}`)
  lines.push(failed > 0 ? 'RESULT: FAIL' : 'RESULT: PASS')
  writeFileSync(process.env.FDE_OUT ?? OUT, lines.join('\n') + '\n', 'utf8')
  console.log(`[classify-exec] 结果已写入 ${OUT}：通过 ${passed} / 失败 ${failed}`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
