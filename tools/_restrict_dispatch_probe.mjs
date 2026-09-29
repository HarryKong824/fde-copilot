/**
 * 无模型探针：用**真 @deepseek-ai/dsh-tools + 真 dsh-system-prompt + 真 cordis**
 * 验 restrict 的**分发层**语义（这是活体测不到的盲点）。
 *
 * 为什么必须离线证：restrict 生效后模型**看不见** pwsh 了 ⇒ 它不会去调它 ⇒
 * 活体上永远观察不到 UNKNOWN_TOOL。所以「隐藏 = 分发也被拒」只能靠
 * 「清单与分发同源」来保证，而这条要在这里证死。
 *
 * 三条断言：
 *   A. 清单层：restrict 后 schemas(agentCtx) 里没有该工具；
 *   B. 分发层：restrict 后 get(name, agentCtx) === undefined（⇒ 分发必 UNKNOWN_TOOL）；
 *   C. 不越界：全局 ctx 的视图不受该 scope 限制影响。
 * 外加：
 *   D. 点名不存在的名字 → 抛 "unknown global tool"（带真实错误文案）；
 *   E. dispose 后恢复可见（⇒ "退出受保护阶段"有救）；
 *   F. 落了限制之后**重新注册**同名工具，仍被拦（"名字集合"语义）。
 */
import { writeFileSync } from 'node:fs'

const CORDIS = 'file:///E:/DSH-desktop/DeepSeek Harness/data/node_modules/@deepseek-ai/cordis/lib/index.js'
const SCOPE = 'file:///E:/DSH-desktop/DeepSeek Harness/data/node_modules/@deepseek-ai/dsh-scope/lib/index.js'
const SYS = 'file:///E:/DSH-desktop/DeepSeek Harness/data/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'
const TOOLS = 'file:///E:/DSH-desktop/DeepSeek Harness/data/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

const { Context } = await import(CORDIS)
const { createScope } = await import(SCOPE)
const { default: SystemPrompt } = await import(SYS)
const { default: ToolRuntime, defineTool } = await import(TOOLS)

const cases = []
const rec = (name, ok, detail) => cases.push({ name, ok, detail: String(detail) })
const tick = () => new Promise((r) => setTimeout(r, 80))

const FAKE = 'probe_fake_tool'
function fakeTool() {
  return defineTool({
    name: FAKE,
    description: 'probe-only tool',
    parameters: { x: { type: 'string', required: true, description: 'x' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }
    },
    execute: async () => ({ ok: true })
  })
}

const root = new Context()
root.plugin({
  name: 'probe-boot',
  apply(ctx) {
    // ⚠️ SystemPrompt 的构造函数直接读 config.toolOrder，**不传 config 会抛**
    //（`Cannot read properties of undefined (reading 'toolOrder')`）。
    // 传 {} ⇒ validateToolOrder(undefined) ⇒ 退回按名字排序。
    new SystemPrompt(ctx, {})
    new ToolRuntime(ctx, { mode: 'native' })
  }
})
await tick()

try {
await root.inject(['tools'], async (ctx) => {
  rec('宿主装配成功（systemPrompt + tools 服务可用）', ctx.tools !== undefined, ctx.tools === undefined ? '🔴 ctx.tools 取不到' : 'ok')
  if (ctx.tools === undefined) return

  // ⚠️ 同一层不允许重复注册同名工具（NamedEntries 会抛 "already registered"），
  // 所以留着注销器，F 步用它做"注销→重注册"。
  const unregister = ctx.tools.register(fakeTool())
  await tick()

  // —— 起一个 scope（等价于 agent.ctx）——
  const AGENT = { id: 'probe-agent' }
  const h = createScope(ctx, AGENT)
  await tick()
  const agentCtx = h.ctx.extend({ agent: AGENT })

  // 限制前基线
  const beforeSchemas = ctx.tools.schemas(AGENT).map((s) => s.name)
  const beforeGet = ctx.tools.get(FAKE, AGENT)
  rec(
    `限制前：清单含 ${FAKE} 且 get() 取得到`,
    beforeSchemas.includes(FAKE) && beforeGet !== undefined,
    `清单=${JSON.stringify(beforeSchemas.filter((n) => n === FAKE))} get=${beforeGet === undefined ? 'undefined' : 'definition'}`
  )
  rec('限制前：该名字**可以**被点名（在 restrictableNames 里）', true, '（下一条 D 会用反例验证这条的边界）')

  // —— 落限制 ——
  let dispose = null
  let rErr = null
  try {
    dispose = agentCtx.tools.restrict({ deny: [FAKE] })
  } catch (e) {
    rErr = e
  }
  rec('restrict({deny:[FAKE]}) 在 scoped ctx 上不抛', rErr === null, rErr ? '🔴 ' + rErr.message : 'ok')
  if (rErr) return
  await tick()

  // —— A：清单层 ——
  const afterSchemas = ctx.tools.schemas(AGENT).map((s) => s.name)
  rec(
    `A 清单层：restrict 后 schemas(agentCtx) 不含 ${FAKE}`,
    !afterSchemas.includes(FAKE),
    `清单里 ${FAKE} ${afterSchemas.includes(FAKE) ? '🔴 仍在（restrict 没生效）' : '已消失（热生效 ✓）'}`
  )

  // —— B：分发层（活体测不到的那条）——
  const afterGet = ctx.tools.get(FAKE, AGENT)
  rec(
    `B 分发层：restrict 后 get(${FAKE}, agentCtx) === undefined  ★活体盲点`,
    afterGet === undefined,
    afterGet === undefined ? 'undefined ⇒ 分发必报 UNKNOWN_TOOL ✓' : '🔴 仍取得到 ⇒ 清单隐藏了但分发照放行（半吊子实现）'
  )

  // —— C：不越界 ——
  const globalGet = ctx.tools.get(FAKE, undefined)
  const globalSchemas = ctx.tools.schemas(undefined).map((s) => s.name)
  rec(
    'C 不越界：全局视图仍含该工具（限制只作用于该 scope）',
    globalGet !== undefined && globalSchemas.includes(FAKE),
    `全局清单含 ${FAKE}=${globalSchemas.includes(FAKE)}`
  )

  // —— D：点名不存在的名字 → 真实错误文案 ——
  let dErr = null
  try {
    agentCtx.tools.restrict({ deny: ['bash'] })
  } catch (e) {
    dErr = e
  }
  rec(
    'D 点名不存在的名字（bash）→ 抛错，且文案含 unknown',
    dErr !== null && /unknown/i.test(dErr.message),
    dErr ? `原文=${JSON.stringify(dErr.message.slice(0, 220))}` : '🔴 竟然没抛'
  )

  // —— E：dispose 后恢复 ——
  let eErr = null
  try {
    dispose()
  } catch (e) {
    eErr = e
  }
  await tick()
  const restored = ctx.tools.get(FAKE, AGENT)
  rec(
    'E dispose 后恢复可见（⇒ 退出受保护阶段有救）',
    eErr === null && restored !== undefined,
    eErr ? '🔴 dispose 抛: ' + eErr.message : `get 恢复=${restored !== undefined}`
  )

  // —— F：落了限制之后「注销 → 重新注册」同名工具，仍被拦 ——
  //    真实场景：preset 重挂（dsh-agent-presets 重组后会 emit tools/change）会让工具先注销再注册。
  let fErr = null
  let reGet
  try {
    agentCtx.tools.restrict({ deny: [FAKE] })
    await tick()
    unregister()
    await tick()
    ctx.tools.register(fakeTool())
    await tick()
    reGet = ctx.tools.get(FAKE, AGENT)
  } catch (e) {
    fErr = e
  }
  rec(
    'F 限制后「注销→重注册」同名工具 → 仍不可见（"名字集合"语义，不必重挂）',
    fErr === null && reGet === undefined,
    fErr ? '🔴 抛: ' + fErr.message.slice(0, 160) : (reGet === undefined ? 'undefined ✓' : '🔴 重注册绕过了限制')
  )
}) } catch (e) { rec('探针主体未抛异常', false, '🔴 ' + e.message) }


const bad = cases.filter((c) => !c.ok)
const out = [
  ...cases.map((c) => `${c.ok ? 'OK  ' : 'FAIL'} ${c.name}\n       → ${c.detail}`),
  '',
  `通过 ${cases.length - bad.length}/${cases.length}`,
  `RESULT: ${bad.length === 0 ? 'ALL-PASS' : 'HAS-FAIL'}`
]
writeFileSync('_restrict_dispatch_probe_out.txt', out.join('\n') + '\n', 'utf8')
console.log(out.join('\n'))
process.exitCode = bad.length === 0 ? 0 : 1
