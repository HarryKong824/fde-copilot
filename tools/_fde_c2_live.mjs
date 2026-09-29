/**
 * C2 变更闭环 —— 真 SDK 活验（import **已安装副本**的 lib，让 lib 内部解析到真 SDK）。
 *
 * 跑法：node _fde_c2_live.mjs
 *
 * ## 这一层验的是什么 / 不验什么（不许混）
 *
 * ✅ 验：真 `@deepseek-ai/dsh-tools` 的 `defineTool` 构造 + 真 `@deepseek-ai/dsh-llm` 的
 *        `HarnessError` 构造 + **真实数据路径上的判定**（真 `gate.jsonl` / 真 `E:/ontologyRoot`）。
 * ❌ 不验：工具在 **DSH 进程内**注册成功。那一条由 `precheck.mjs`（真 SDK 注册+schema 校验）
 *        与重启后的 `pluginInventory/list`（fiberPhase=active）分别覆盖。
 *
 * ## 零污染（硬约束）
 *
 * - `auditPath: ''` ⇒ 本插件的审计链**仅内存**，不写真实 `phase.jsonl`。
 * - 场景 2/3/4 的 gate 链写在**系统临时目录**，不碰真 `gate.jsonl`。
 * - 场景 3/4 的 ontology 也在临时目录，不碰 `E:/ontologyRoot`。
 * - 只有场景 1 读真 `gate.jsonl` —— **只读**。
 *
 * ## 场景
 *
 * 1. 真 gate.jsonl（当前实况：链里只有 deny/write-probe，**无** allow 的 write 记录）
 *    ⇒ `CHANGE_NONE`。这是当前真实状态下的正确结论，不是"测试造出来的"。
 * 2. 隔离 gate 链写一条 `allow level=L1` + **真 ontologyRoot**（mirror 为空）
 *    ⇒ 级别读到了（L1）但检查未跑过 ⇒ `CHANGE_FLOW_INCOMPLETE`，缺 D1+D3，且指路工具名正确。
 *    ⇒ 证明「级别从 gate 链读」这条路在真数据上跑通。
 * 3. 隔离环境 + 三项结论新鲜通过 + L2 ⇒ approval 通道未 compose（`unavailable`）
 *    ⇒ `CHANGE_APPROVAL_REQUIRED`（fail-closed，与 D4 ask 的三态相反）。
 * 4. 同 3 但级别 L1（不需审批）+ 三项里只需 D1/D3 ⇒ 闭环成功，回执带 `level`（级别被消费的证据）。
 */

import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '_fde_c2_live_out.txt')
const DEP = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/node_modules/dsh-fde-phase'
const lib = (f) => pathToFileURL(join(DEP, 'lib', f)).href

const { normalizeConfig } = await import(lib('config.js'))
const { AuditChain } = await import(lib('audit.js'))
const { D1Mirror, ANCHOR_ALGS, compositeAnchorSha } = await import(lib('mirror.js'))
const { D5_ANCHOR_ALG, complianceFingerprintSync } = await import(lib('check-d5.js'))
const { installChangeCloseTool, CHANGE_CLOSE_TOOL } = await import(lib('tools.js'))

// 真数据路径（与部署一致）
const REAL_PROJECT = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state'
const REAL_ONTOLOGY = 'E:/ontologyRoot'
const REAL_GATE = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-audit/gate.jsonl'

const lines = []
let passed = 0
let failed = 0
function check(name, fn) {
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
function assert(c, m) {
  if (!c) throw new Error(m || '断言失败')
}

/** 造一套隔离环境：{dir, onto, gate, cfg, mirror, auditRecords, tool} */
function makeIso({ level, targets } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'c2live-'))
  const onto = join(dir, 'onto')
  mkdirSync(onto, { recursive: true })
  const files = {
    'objects.yaml': 'objects:\n  - id: obj_live\n',
    'logic.yaml': 'logic:\n  - id: rule_live\n',
    'actions.yaml': 'actions:\n  - id: act_live\n',
    'guards.yaml': 'guards:\n  - ref: guard.live\n',
    'compliance.yaml': 'output_boundary:\n  statement: "live"\nrollback_preauth:\n  authorized: true\n'
  }
  for (const [n, c] of Object.entries(files)) writeFileSync(join(onto, n), c, 'utf8')

  const gate = join(dir, 'gate.jsonl')
  const rec = {
    seq: 9001,
    ts: new Date().toISOString(),
    tool: 'fde_ontology_write',
    decision: 'allow',
    level: level ?? 'L1',
    autoLevel: level ?? 'L1',
    target: targets ?? 'logic.yaml'
  }
  writeFileSync(gate, JSON.stringify(rec) + '\n', 'utf8')

  const cfg = normalizeConfig({
    projectRoot: dir,
    ontologyRoot: onto,
    gateAuditPath: gate,
    auditPath: '', // 仅内存，不污染真实 phase 链
    mode: 'enforce',
    industry: 'medical-aesthetics'
  })
  const auditRecords = []
  const audit = new AuditChain(cfg.auditPath)
  const origRecord = audit.record.bind(audit)
  audit.record = async (e) => {
    auditRecords.push(e)
    return origRecord(e)
  }
  const mirror = new D1Mirror()
  let tool = null
  const ctx = {
    tools: { register: (t) => { if (t.name === CHANGE_CLOSE_TOOL) tool = t; return () => {} } },
    effect: (fn) => fn(),
    logger: console,
    get: () => undefined // approval 未 compose ⇒ 'unavailable'
  }
  installChangeCloseTool(ctx, cfg, audit, mirror)
  assert(tool, `${CHANGE_CLOSE_TOOL} 未注册`)
  return { dir, onto, gate, cfg, mirror, auditRecords, tool, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 按"当前文件内容"把三项结论灌进镜像（模拟刚跑过三个检查且都通过）。 */
function prime(mirror, onto, which = ['D1', 'D3', 'D5']) {
  if (which.includes('D1')) {
    mirror.update({
      check: 'D1',
      passed: true,
      anchor: {
        alg: ANCHOR_ALGS.D1,
        files: ['actions.yaml', 'guards.yaml'],
        sha256: compositeAnchorSha([
          readFileSync(join(onto, 'actions.yaml'), 'utf8'),
          readFileSync(join(onto, 'guards.yaml'), 'utf8')
        ])
      }
    })
  }
  if (which.includes('D3')) {
    mirror.update({
      check: 'D3',
      passed: true,
      anchor: {
        alg: ANCHOR_ALGS.D3,
        files: ['objects.yaml', 'logic.yaml'],
        sha256: compositeAnchorSha([
          readFileSync(join(onto, 'objects.yaml'), 'utf8'),
          readFileSync(join(onto, 'logic.yaml'), 'utf8')
        ])
      }
    })
  }
  if (which.includes('D5')) {
    const fp = complianceFingerprintSync(join(onto, 'compliance.yaml'))
    mirror.update({
      check: 'D5',
      passed: true,
      anchor: { alg: D5_ANCHOR_ALG, sha256: fp.sha256, len: fp.len, nonempty: fp.nonempty }
    })
  }
}

async function callClose(tool, agent = { id: 'live-agent' }) {
  let threw = null
  let res = null
  try {
    res = await tool.execute(
      { reason: '活验：验证 C2 变更闭环在真 SDK 下的判定（零业务影响）' },
      { callId: 'c2-live', name: CHANGE_CLOSE_TOOL, agent }
    )
  } catch (e) {
    threw = e
  }
  return { threw, res }
}

// ================================================================ 场景
lines.push('== C2 变更闭环 · 真 SDK 活验 ==')
lines.push(`副本：${DEP}`)
lines.push(`真数据：project=${REAL_PROJECT}  ontology=${REAL_ONTOLOGY}`)
lines.push('')

const pending = []

// ---------- 场景 1：真 gate.jsonl 的当前实况 ----------
// 🔴 期望值**由本脚本自己扫链算出**，不问 lib 要 —— 这是交叉验证，不是把断言改成"实现输出什么就认什么"。
// （本节初版我写错过一次：凭 `tail -6` 就对真链断言"没有 allow 记录"，而链里其实有两条 —— 断言域 ≠ 验证域。）
const gateRecs = readFileSync(REAL_GATE, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  })
  .filter(Boolean)
const writeRecs = gateRecs.filter((r) => r.tool === 'fde_ontology_write')
const allowRecs = writeRecs.filter((r) => r.decision === 'allow')
const latestAllow = allowRecs[allowRecs.length - 1]
const latestAllowHasLevel = !!(latestAllow && typeof latestAllow.level === 'string' && latestAllow.level.trim() !== '')
// 期望：无 allow ⇒ CHANGE_NONE；有 allow 但最新那条无 level ⇒ CHANGE_NO_LEVEL；
//       有 allow 且有 level ⇒ 应进入检查路径（不再是"找不到变更"类拒绝）。
const expectCode = !latestAllow ? 'CHANGE_NONE' : latestAllowHasLevel ? null : 'CHANGE_NO_LEVEL'
const expectOutcome = expectCode === 'CHANGE_NONE' ? 'no-change' : 'no-level'

lines.push('[场景 1] 真实 gate.jsonl（只读）—— 期望由脚本自己扫链算出')
lines.push(
  `      链共 ${gateRecs.length} 条记录；fde_ontology_write ${writeRecs.length} 条（allow ${allowRecs.length} 条：` +
    allowRecs.map((r) => `seq=${r.seq}${typeof r.level === 'string' ? `/level=${r.level}` : '/无 level'}`).join('、') +
    '）'
)
lines.push(
  `      ⇒ 最新一条 allow = ` +
    (latestAllow ? `seq=${latestAllow.seq}（${latestAllow.ts}）level=${typeof latestAllow.level === 'string' ? latestAllow.level : '无'} ` : '（不存在）') +
    `⇒ 期望拒绝码 = ${expectCode ?? '（走检查路径）'}`
)

const realCfg = normalizeConfig({
  projectRoot: REAL_PROJECT,
  ontologyRoot: REAL_ONTOLOGY,
  gateAuditPath: REAL_GATE,
  auditPath: '',
  mode: 'enforce',
  industry: 'medical-aesthetics'
})
{
  const auditRecords = []
  const audit = new AuditChain('')
  const orig = audit.record.bind(audit)
  audit.record = async (e) => {
    auditRecords.push(e)
    return orig(e)
  }
  let tool = null
  const ctx = {
    tools: { register: (t) => { if (t.name === CHANGE_CLOSE_TOOL) tool = t; return () => {} } },
    get: () => undefined
  }
  installChangeCloseTool(ctx, realCfg, audit, new D1Mirror())
  pending.push(
    check(
      expectCode
        ? `真实链当前实况 ⇒ ${expectCode} + 审计 ${expectOutcome}（fail-closed，不猜级别）`
        : '真实链已有带 level 的 allow ⇒ 应进入检查路径',
      async () => {
        const { threw } = await callClose(tool)
        assert(threw, '应抛错（本轮不应闭环成功）')
        if (expectCode) {
          assert(threw.code === expectCode, `code 应为 ${expectCode}，实际 ${threw.code}（${threw.message}）`)
          assert(
            auditRecords.some((r) => r.type === 'change-close-denied' && r.outcome === expectOutcome),
            `审计应有 change-close-denied/${expectOutcome}`
          )
          if (expectCode === 'CHANGE_NO_LEVEL') {
            assert(
              String(threw.message).includes(`seq=${latestAllow.seq}`),
              `文案应点名是哪条旧记录（seq=${latestAllow.seq}），实际：${threw.message}`
            )
          }
        } else {
          assert(threw.code === 'CHANGE_FLOW_INCOMPLETE', `应进入检查路径，实际 ${threw.code}`)
        }
      }
    )
  )
}

// ---------- 场景 2：隔离链给级别 + 真 ontology + 空镜像 ----------
lines.push('[场景 2] 隔离 gate 链给 L1 + **真 ontologyRoot** + 空镜像 ⇒ 级别读到、检查未跑')
{
  const dir = mkdtempSync(join(tmpdir(), 'c2live2-'))
  const gate = join(dir, 'gate.jsonl')
  writeFileSync(
    gate,
    JSON.stringify({ seq: 9002, ts: new Date().toISOString(), tool: 'fde_ontology_write', decision: 'allow', level: 'L1', autoLevel: 'L1', target: 'logic.yaml' }) + '\n',
    'utf8'
  )
  const cfg = normalizeConfig({
    projectRoot: REAL_PROJECT,
    ontologyRoot: REAL_ONTOLOGY, // ← 真 ontology
    gateAuditPath: gate, // ← 隔离链
    auditPath: '',
    mode: 'enforce',
    industry: 'medical-aesthetics'
  })
  const auditRecords = []
  const audit = new AuditChain('')
  const orig = audit.record.bind(audit)
  audit.record = async (e) => {
    auditRecords.push(e)
    return orig(e)
  }
  let tool = null
  installChangeCloseTool(
    { tools: { register: (t) => { if (t.name === CHANGE_CLOSE_TOOL) tool = t; return () => {} } }, get: () => undefined },
    cfg,
    audit,
    new D1Mirror()
  )
  pending.push(
    check('级别从链读到（L1）⇒ 检查未跑过 ⇒ CHANGE_FLOW_INCOMPLETE，缺 D1+D3 且指路真工具名', async () => {
      const { threw } = await callClose(tool)
      assert(threw, '应抛错')
      assert(threw.code === 'CHANGE_FLOW_INCOMPLETE', `code 应为 CHANGE_FLOW_INCOMPLETE，实际 ${threw.code}（${threw.message}）`)
      assert(threw.message.includes('缺 2 项'), `应缺 2 项（D1+D3），实际：${threw.message}`)
      assert(threw.message.includes('fde-run-guardrails-check'), '应指路 D1 工具')
      assert(threw.message.includes('fde-run-validation'), '应指路 D3 工具')
      const d = auditRecords.find((r) => r.type === 'change-close-denied')
      assert(d && d.outcome === 'checks-incomplete' && d.level === 'L1', `审计应记 level=L1 的 checks-incomplete，实际 ${JSON.stringify(d)}`)
      assert(JSON.stringify(d.failed) === JSON.stringify(['D1', 'D3']), `failed 应为 D1+D3，实际 ${JSON.stringify(d.failed)}`)
    }),
    check('同一场景：把 D1/D3 结论灌成"与真 ontology 内容一致"⇒ L1 闭环成功、回执带 level', async () => {
      const m = new D1Mirror()
      prime(m, REAL_ONTOLOGY, ['D1', 'D3'])
      let tool = null
      installChangeCloseTool(
        { tools: { register: (t) => { if (t.name === CHANGE_CLOSE_TOOL) tool = t; return () => {} } }, get: () => undefined },
        cfg,
        new AuditChain(''),
        m
      )
      const { threw, res } = await callClose(tool)
      assert(!threw, `不应抛错，实际 ${threw && threw.message}`)
      assert(res.level === 'L1', `回执 level 应为 L1，实际 ${res.level}`)
      assert(JSON.stringify(res.checks) === JSON.stringify(['D1', 'D3']), `checks 应为 D1+D3，实际 ${JSON.stringify(res.checks)}`)
      assert(res.approval === 'n/a', `L1 不需审批，实际 ${res.approval}`)
    })
  )
  rmSync(dir, { recursive: true, force: true })
}

// ---------- 场景 3：L2 + approval 未 compose ----------
lines.push('[场景 3] L2 + 三项新鲜通过 + approval 未 compose ⇒ fail-closed 拒绝')
{
  const iso = makeIso({ level: 'L2', targets: 'compliance.yaml' })
  prime(iso.mirror, iso.onto) // 三项全灌
  pending.push(
    check('L2 检查全过但审批通道不可用 ⇒ CHANGE_APPROVAL_REQUIRED（与 D4 ask 三态相反）', async () => {
      const { threw, res } = await callClose(iso.tool)
      assert(threw, '应抛错')
      assert(res === null, '不应有返回值')
      assert(threw.code === 'CHANGE_APPROVAL_REQUIRED', `code 应为 CHANGE_APPROVAL_REQUIRED，实际 ${threw.code}`)
      assert(threw.message.includes('unavailable'), `文案应写明 unavailable，实际：${threw.message}`)
      assert(!iso.auditRecords.some((r) => r.type === 'change-closed'), '不应有 change-closed 审计')
      const d = iso.auditRecords.find((r) => r.type === 'change-close-denied')
      assert(d && d.outcome === 'approval-unavailable', `审计应记 approval-unavailable，实际 ${JSON.stringify(d)}`)
    })
  )
  pending.push(
    check('L2 审批放行（注入 allowed-once）⇒ 闭环成功 approval=confirmed', async () => {
      const iso2 = makeIso({ level: 'L2' })
      prime(iso2.mirror, iso2.onto)
      let tool = null
      const asked = []
      installChangeCloseTool(
        {
          tools: { register: (t) => { if (t.name === CHANGE_CLOSE_TOOL) tool = t; return () => {} } },
          get: (k) => (k === 'approval' ? { request: async (r) => { asked.push(r); return 'allowed-once' } } : undefined)
        },
        iso2.cfg,
        (() => {
          const a = new AuditChain('')
          return a
        })(),
        iso2.mirror
      )
      const { threw, res } = await callClose(tool)
      assert(!threw, `不应抛错，实际 ${threw && threw.message}`)
      assert(res.level === 'L2' && res.approval === 'confirmed', `应 L2/confirmed，实际 ${JSON.stringify(res)}`)
      assert(asked.length === 1, '应发起 1 次审批请求')
      assert(asked[0].agent && asked[0].agent.id === 'live-agent', '审批请求应带 agent')
      assert(String(asked[0].reason).includes('L2'), `审批理由应说明 L2，实际 ${asked[0].reason}`)
      iso2.cleanup()
    })
  )
  iso.cleanup()
}

// ---------- 场景 4：真 SDK 下的 schema 契约（真 defineTool 已构造过，这里看结构） ----------
lines.push('[场景 4] 真 SDK 构造出的工具定义：参数/输出契约')
{
  const iso = makeIso()
  const def = iso.tool
  pending.push(
    check('参数清单 = [reason]；输出字段 = level/target/change_seq/checks/approval', async () => {
      const params = Object.keys(def.parameters?.properties ?? {})
      assert(JSON.stringify(params) === JSON.stringify(['reason']), `参数应只有 reason，实际 ${JSON.stringify(params)}`)
      const out = Object.keys(def.output?.schema?.properties ?? {})
      const want = ['level', 'target', 'change_seq', 'checks', 'approval']
      assert(JSON.stringify(out) === JSON.stringify(want), `输出字段应为 ${JSON.stringify(want)}，实际 ${JSON.stringify(out)}`)
    })
  )
  iso.cleanup()
}

await Promise.all(pending)

lines.push('')
lines.push('PASS ' + passed + ' / FAIL ' + failed)
lines.push('RESULT: ' + (failed === 0 ? 'PASS' : 'FAIL'))
writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
console.log(`[c2-live] wrote ${OUT}  PASS ${passed} / FAIL ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
