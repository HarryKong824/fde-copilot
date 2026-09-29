/**
 * 无模型探针：用**真 cordis + 真 dsh-scope** 验「scoped ctx 访问服务时，方法里的 this.ctx 是不是访问方」。
 *
 * 为什么这是 restrict 的成败关键：
 *   ToolRuntime.restrict() 第一句就是 `const scope = scopeOf(this.ctx)`，
 *   取不到 scope 直接抛 "requires a scoped context (agent.ctx)"。
 *   而 `this.ctx` 在 Service 构造时被赋成**服务自己的 ctx**（全局）。
 *   若没有 traceable 代理改写，从任何地方调 restrict 都必抛 —— 那第二批就无从谈起。
 *
 * 本探针不碰 DSH、不碰活体，只验这条语言级机制。
 */
import { writeFileSync } from 'node:fs'

const CORDIS = 'file:///E:/DSH-desktop/DeepSeek Harness/data/node_modules/@deepseek-ai/cordis/lib/index.js'
const SCOPE = 'file:///E:/DSH-desktop/DeepSeek Harness/data/node_modules/@deepseek-ai/dsh-scope/lib/index.js'

const { Context, Service } = await import(CORDIS)
const { createScope, scopeOf } = await import(SCOPE)

const cases = []
const rec = (name, ok, detail) => cases.push({ name, ok, detail: String(detail) })
const tick = () => new Promise((r) => setTimeout(r, 60))

/** 复刻 ToolRuntime 的取 scope 方式：方法里读 `this.ctx`。 */
class Probe extends Service {
  constructor(ctx) {
    super(ctx, 'probe')
  }
  /** 等价于 `scopeOf(this.ctx)` —— restrict() 的第一句。 */
  whoAmI() {
    return scopeOf(this.ctx)
  }
}

const root = new Context()
root.plugin({
  name: 'probe-installer',
  apply(ctx) {
    new Probe(ctx)
  }
})
await tick()

// cordis 里访问服务需要 inject 声明；在一个注入了 probe 的 ctx 里做断言。
await root.inject(['probe'], async (ctx) => {
  rec('服务已注册且可访问（inject 后 ctx.probe 可用）', ctx.probe !== undefined, ctx.probe === undefined ? '🔴 ctx.probe 取不到' : 'ok')
  if (ctx.probe === undefined) return

  // —— P1：从全局 ctx 访问 → scope 应为 undefined（restrict 会在此抛错）——
  let globalScope
  let globalErr = null
  try {
    globalScope = ctx.probe.whoAmI()
  } catch (e) {
    globalErr = e
  }
  rec(
    'P1 全局 ctx 访问 → scopeOf(this.ctx) === undefined',
    globalErr === null && globalScope === undefined,
    globalErr ? '抛错: ' + globalErr.message : `scope=${JSON.stringify(globalScope)}`
  )

  // —— P2：从 scoped ctx 访问 → scope 应为该 scope 的 key（这一条决定 restrict 可行）——
  const AGENT_KEY = { id: 'fake-agent' }
  const handle = createScope(ctx, AGENT_KEY)
  await tick()
  let scopedScope
  let scopedErr = null
  try {
    scopedScope = handle.ctx.probe.whoAmI()
  } catch (e) {
    scopedErr = e
  }
  rec(
    'P2 scoped ctx 访问 → scopeOf(this.ctx) === 该 scope 的 key  ★关键',
    scopedErr === null && scopedScope === AGENT_KEY,
    scopedErr ? '抛错: ' + scopedErr.message : `scope=${scopedScope === AGENT_KEY ? '=== AGENT_KEY ✓' : JSON.stringify(scopedScope)}`
  )

  // —— P3：同一实例、两种访问方式给出不同 scope → 证明由"访问方"决定 ——
  rec(
    'P3 同一实例两种访问方给出不同 scope（证明随访问方而非构造方）',
    scopedScope === AGENT_KEY && globalScope === undefined,
    `全局=${JSON.stringify(globalScope)} vs scoped=${scopedScope === AGENT_KEY ? 'AGENT_KEY' : JSON.stringify(scopedScope)}`
  )

  // —— P4：另一个 scope 取到它自己的 key，不串 ——
  const OTHER = { id: 'other' }
  const other = createScope(ctx, OTHER)
  await tick()
  const otherGot = other.ctx.probe.whoAmI()
  rec('P4 另一个 scope 取到的是它自己的 key（不串）', otherGot === OTHER, `other.scope=${otherGot === OTHER ? '=== OTHER ✓' : JSON.stringify(otherGot)}`)

  // —— P5：dispose 后不应把已捕获的 scope 弄坏（只验不抛）——
  let dErr = null
  try {
    handle.dispose()
  } catch (e) {
    dErr = e
  }
  rec('P5 scope 可正常 dispose 且不抛', dErr === null, dErr ? '🔴 ' + dErr.message : 'ok')

  // —— P6：`agents.ctx.agent` 这类 extend 出来的 ctx 是否仍保留 scope 标记 ——
  //   agent.ctx = scope.ctx.extend({ agent: this }) —— 这一条直接对应活体形态。
  const FAKE_AGENT = { id: 'a1' }
  const h2 = createScope(ctx, FAKE_AGENT)
  await tick()
  const agentCtx = h2.ctx.extend({ agent: FAKE_AGENT })
  let viaExtended
  let e2 = null
  try {
    viaExtended = agentCtx.probe.whoAmI()
  } catch (e) {
    e2 = e
  }
  rec(
    'P6 scope.ctx.extend({agent}) 之后仍带 scope 标记  ★活体形态',
    e2 === null && viaExtended === FAKE_AGENT,
    e2 ? '抛错: ' + e2.message : `scope=${viaExtended === FAKE_AGENT ? '=== FAKE_AGENT ✓' : JSON.stringify(viaExtended)}`
  )

  // —— P7：从 scope 的**祖先**访问不应拿到子 scope（事件上溯、scope 不下传）——
  rec(
    'P7 祖先 ctx 访问仍为 undefined（scope 不下传到父）',
    ctx.probe.whoAmI() === undefined,
    `scope=${JSON.stringify(ctx.probe.whoAmI())}`
  )
})

const bad = cases.filter((c) => !c.ok)
const out = [
  ...cases.map((c) => `${c.ok ? 'OK  ' : 'FAIL'} ${c.name}\n       → ${c.detail}`),
  '',
  `通过 ${cases.length - bad.length}/${cases.length}`,
  `RESULT: ${bad.length === 0 ? 'ALL-PASS' : 'HAS-FAIL'}`
]
writeFileSync('_scoped_ctx_probe_out.txt', out.join('\n') + '\n', 'utf8')
console.log(out.join('\n'))
process.exitCode = bad.length === 0 ? 0 : 1
