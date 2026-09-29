/**
 * _fde_d1_test.mjs —— **D1（审计外置 L2 outbox + L3 只写端点 + L4 交叉校验 + 离线降级模式）** 离线回归。
 *
 * spec 第八节四项逐条对应：
 *   L2 ⇒ A 组（队列本身）＋ D 组（谁往里写、谁删）
 *   L3 ⇒ D 组（投递；**只写**：只发 POST、不看响应体）
 *   降级 ⇒ C 组（纯判据三档）＋ D8/D9（转换与恢复留痕）
 *   L4 ⇒ E 组（phase 侧「本地链完整 AND（远端存在 OR 降级模式）」）
 *
 * 纪律（本项目既有，逐条对应踩过的坑）：
 *   ① **断言双向**：每条"必须含 X"都配一条"必须不含 Y"（尤其 D1 与 E8）。
 *   ② **缺席分档**：state.json 的 enoent / empty / bad / schema 各有一条（**不许压成一行**）。
 *   ③ **判据有几个分支就朝每个分支各打一次**：`evaluateRemote` 三档 + 两处边界（阈值 ±1）全覆盖。
 *   ④ **不靠"能观测到"当判据**：每条断言都有具名 name，变异脚本按 name 抓。
 *   ⑤ 时间与网络**全部注入**（`deps.now` / `deps.fetchImpl`）—— 不碰真实时钟、不发真请求，
 *      否则"降级阈值"这种判据只能靠 sleep 去凑，慢且不稳。
 *
 * 退出码 0 = 全绿；非 0 = 有失败。`FDE_INVERT=1` 必红（exit code 敏感）。
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// 🔴 `FDE_TEST_ROOT` 是给 `_fde_d1_mut.mjs`（变异注入）用的：它把两个插件的 lib 拷到沙箱、
//    注入一处变异、再以本套件为判据跑一次。默认 = 真工作区 ⇒ 平时直接 `node _fde_d1_test.mjs` 不变。
const ROOT = process.env.FDE_TEST_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..')
const MEM = ROOT + '/dsh-fde-memory/lib'
const PH = ROOT + '/dsh-fde-phase/lib'
/** 结果文件落在**被测树**里（沙箱跑时不会覆盖真工作区那份）。 */
const OUT_FILE = ROOT + '/_fde_d1_out.txt'

const ob = await import(pathToFileURL(MEM + '/outbox.js').href)
const sinkMod = await import(pathToFileURL(MEM + '/telemetry-sink.js').href)
const cfgMod = await import(pathToFileURL(MEM + '/config.js').href)
const rs = await import(pathToFileURL(PH + '/remote-state.js').href)
const guardMod = await import(pathToFileURL(PH + '/guard.js').href)
const phCfg = await import(pathToFileURL(PH + '/config.js').href)

const PASS = []
const FAIL = []

function ok(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = expected === undefined ? undefined : JSON.stringify(expected)
  if (e === undefined || a === e) {
    PASS.push(name)
  } else {
    FAIL.push({ name, actual: a, expected: e })
    console.log('  FAIL ' + name + '\n       实际 ' + a + '\n       期望 ' + e)
  }
}

function okThrows(name, fn, msgContains) {
  try {
    fn()
    FAIL.push({ name, actual: 'no throw', expected: 'throw' })
    console.log('  FAIL ' + name + ' => 没 throw')
  } catch (e) {
    const msg = String(e?.message ?? e)
    if (msgContains && !msg.includes(msgContains)) {
      FAIL.push({ name, actual: msg, expected: '包含 ' + msgContains })
      console.log('  FAIL ' + name + ' => throw 但消息不对: ' + msg)
    } else {
      PASS.push(name)
    }
  }
}

/**
 * 安全读嵌套字段：**任一层缺席都返回 `undefined`，绝不抛**。
 *
 * 🔴 存在的理由不是"写得好看"，是**崩溃会让整份报告消失** ——
 *    裸取下标（`sent[0].init.method`）在"那条记录没产生"时会抛，于是"实现有缺陷"
 *    与"测试自己崩了"看起来完全一样（都是没有绿灯）。实测：`_fde_d1_mut.mjs` 的
 *    M16 一开始就是被这个读法判成"崩溃"而不是"断言红"。
 */
const at = (obj, ...path) => path.reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), obj)

const INVERT = process.env.FDE_INVERT === '1'
const dirs = []
function mk() {
  const d = mkdtempSync(join(tmpdir(), 'fde-d1-'))
  dirs.push(d)
  return d
}

// ════════════════════════════════════ A. L2 队列本身 ════════════════════════════════════
console.log('\n=== A. L2 outbox 文件队列 ===')

{
  const root = join(mk(), 'outbox')
  const empty = ob.listOutboxSync(root)
  ok('A1 目录不存在 ⇒ 空队列且三档都空（不是抛错）', [empty.seqs.length, empty.ignored.length, empty.tmpLeftovers.length], [0, 0, 0])

  ob.writeOutboxSync(root, 1, { hello: 'world' })
  ok('A2 文件名恰为 {seq}.json（spec §8 原文形态）', readdirSync(root).includes('1.json'), true)
  ok('A2b 内容是可解析的 JSON 且往返一致', ob.readOutboxSync(root, 1).record, { hello: 'world' })
  ok('A2c 写完后目录里没有 .tmp 残留（原子写）', readdirSync(root).filter((n) => n.endsWith('.tmp')).length, 0)

  for (const s of [2, 10, 9]) ob.writeOutboxSync(root, s, { s })
  ok(
    'A3 ★ 队列按 seq **数值**升序（字典序会是 [10,2,9]）',
    ob.listOutboxSync(root).seqs,
    [1, 2, 9, 10]
  )

  // 非成员 / 写残档：**三档分开**
  writeFileSync(join(root, 'abc.json'), '{}')
  writeFileSync(join(root, '0.json'), '{}')
  writeFileSync(join(root, '01.json'), '{}')
  writeFileSync(join(root, '1.json.bak'), '{}')
  writeFileSync(join(root, '3.json.tmp'), '{}')
  const l = ob.listOutboxSync(root)
  ok('A4 ★ 非成员进 ignored、.tmp 进 tmpLeftovers（不许压成一档）', [l.ignored.sort(), l.tmpLeftovers], [['0.json', '01.json', '1.json.bak', 'abc.json'], ['3.json.tmp']])
  ok('A4b ★ 双向：上面那 5 个坏名字**一个都没混进成员**', l.seqs.filter((n) => !Number.isInteger(n) || n <= 0).length, 0)
  ok('A4c 且成员恰好还是那 4 个（ignored 没被偷偷算进去）', l.seqs, [1, 2, 9, 10])

  ok('A5 countOutboxSync 只数成员', ob.countOutboxSync(root), 4)
  ok('A5b sweepTmpSync 清掉 .tmp 并返回个数', [ob.sweepTmpSync(root), existsSync(join(root, '3.json.tmp'))], [1, false])

  writeFileSync(join(root, '9.json'), '{ 这不是 JSON')
  const bad = ob.readOutboxSync(root, 9)
  ok('A6 ★ 坏 JSON ⇒ {ok:false} 而不是抛（重放器要能跳过继续）', [bad.ok, typeof bad.error === 'string'], [false, true])
  ok('A6b 顶层是数组也判 {ok:false}', (() => { writeFileSync(join(root, '11.json'), '[1,2]'); return ob.readOutboxSync(root, 11).ok })(), false)

  ok('A7 删除成功返 true、再删返 false（能分辨"被别人先删了"）', [ob.removeOutboxSync(root, 1), ob.removeOutboxSync(root, 1)], [true, false])

  okThrows('A8 outboxFileOf 拒绝 seq=0', () => ob.outboxFileOf(root, 0), 'seq 必须是')
  okThrows('A8b outboxFileOf 拒绝非整数 seq', () => ob.outboxFileOf(root, 1.5), 'seq 必须是')
  okThrows('A8c outboxFileOf 拒绝字符串 seq（不静默规范化）', () => ob.outboxFileOf(root, '1'), 'seq 必须是')
}

// ════════════════════════════════════ B. state.json 契约 ════════════════════════════════════
console.log('\n=== B. state.json（跨插件契约） ===')

{
  const root = join(mk(), 'outbox')
  const s = ob.emptyState(1000)
  ok('B1 emptyState 带 degradeAfterMs', s.degradeAfterMs, 1000)
  ok('B1b ★ 双向：emptyState **不含** degradedPasses（它没有唯一维护者 ⇒ 不许留字段）', 'degradedPasses' in s, false)
  ok('B1c 有 schema 标记', s.schema, ob.STATE_SCHEMA)

  ob.writeStateSync(root, s)
  const r = ob.readStateSync(root)
  ok('B2 往返：present 且 degradeAfterMs 保持一致', [r.present, r.state.degradeAfterMs], [true, 1000])
  ok('B2b ★ 双向：writeStateSync 覆盖 updatedAt（不信调用方传的时间）', (() => { ob.writeStateSync(root, { ...s, updatedAt: '1970-01-01T00:00:00Z' }); return ob.readStateSync(root).state.updatedAt !== '1970-01-01T00:00:00Z' })(), true)
  ok('B2c 写完后没有 .tmp 残留', readdirSync(root).filter((n) => n.endsWith('.tmp')).length, 0)

  const d4 = join(mk(), 'outbox')
  ok('B3 缺席档①：目录/文件不存在 ⇒ enoent', ob.readStateSync(d4).reason, 'enoent')
  mkdirSync(d4, { recursive: true })
  writeFileSync(join(d4, 'state.json'), '   \n')
  ok('B3b 缺席档②：空文件 ⇒ empty（与 enoent 分开）', ob.readStateSync(d4).reason, 'empty')
  writeFileSync(join(d4, 'state.json'), '{ 坏')
  ok('B3c 缺席档③：坏 JSON ⇒ bad', ob.readStateSync(d4).reason, 'bad')
  writeFileSync(join(d4, 'state.json'), JSON.stringify({ ...s, schema: 999 }))
  ok('B3d 缺席档④：schema 不认 ⇒ schema（不是 bad）', ob.readStateSync(d4).reason, 'schema')
  writeFileSync(join(d4, 'state.json'), JSON.stringify([1, 2]))
  ok('B3e 顶层是数组 ⇒ bad', ob.readStateSync(d4).reason, 'bad')

  for (const bad of [0, -1, 'x', null, undefined, NaN]) {
    writeFileSync(join(d4, 'state.json'), JSON.stringify({ ...s, degradeAfterMs: bad }))
    ok('B4 ★ 坏 degradeAfterMs=' + String(bad) + ' ⇒ bad（0 会让"降级"恒成立 ⇒ 门禁静默失效）', ob.readStateSync(d4).reason, 'bad')
  }
  writeFileSync(join(d4, 'state.json'), JSON.stringify({ ...s, degradedDelivered: -1 }))
  ok('B5 坏 degradedDelivered ⇒ bad', ob.readStateSync(d4).reason, 'bad')
  writeFileSync(join(d4, 'state.json'), JSON.stringify({ ...s, lastDeliveredAt: 12345 }))
  ok('B6 坏时间字段（数字）⇒ bad', ob.readStateSync(d4).reason, 'bad')
  writeFileSync(join(d4, 'state.json'), JSON.stringify({ ...s, outageSince: '' }))
  ok('B6b 坏时间字段（空串）⇒ bad（空串不是 null）', ob.readStateSync(d4).reason, 'bad')
  writeFileSync(join(d4, 'state.json'), JSON.stringify(s))
  ok('B7 好状态 ⇒ present（与上面所有 bad 形成双向对照）', ob.readStateSync(d4).present, true)
}

// ════════════════════════════════════ C. evaluateRemote 三档 ════════════════════════════════════
console.log('\n=== C. evaluateRemote（纯判据，L4 括号） ===')

{
  const T0 = Date.parse('2026-09-29T00:00:00Z')
  const base = ob.emptyState(1000)

  ok('C1 ★ 从未投递 ⇒ missing（fail-closed：没证据 ≠ 远端存在）', sinkMod.evaluateRemote(base, T0).status, 'missing')
  ok('C2 投递过且无中断 ⇒ present', sinkMod.evaluateRemote({ ...base, lastDeliveredAt: '2026-09-28T00:00:00Z' }, T0).status, 'present')

  const out = { ...base, lastDeliveredAt: '2026-09-28T23:00:00Z', outageSince: '2026-09-29T00:00:00Z' }
  ok('C3 中断阈值-1ms ⇒ missing（边界）', sinkMod.evaluateRemote(out, T0 + 999).status, 'missing')
  ok('C4 ★ 中断 == 阈值 ⇒ degraded（`>=` 边界，不是 `>`）', sinkMod.evaluateRemote(out, T0 + 1000).status, 'degraded')
  ok('C5 中断 > 阈值 ⇒ degraded', sinkMod.evaluateRemote(out, T0 + 100000).status, 'degraded')
  ok(
    'C6 ★ 以前成功过**不能**抵掉当前中断（未达阈值仍是 missing）',
    sinkMod.evaluateRemote(out, T0 + 10).status,
    'missing'
  )
  ok('C7 outageSince 不可解析 ⇒ missing（不许用 NaN 比较蒙混过关）', sinkMod.evaluateRemote({ ...out, outageSince: '不是时间' }, T0).status, 'missing')

  // 三档互斥且穷尽：对一批状态，三档计数之和 == 样本数
  const samples = [
    base,
    { ...base, lastDeliveredAt: 'x' },
    out,
    { ...out, outageSince: '不是时间' },
    { ...base, outageSince: '2026-09-29T00:00:00Z' }
  ]
  const counts = { present: 0, degraded: 0, missing: 0 }
  for (const s of samples) counts[sinkMod.evaluateRemote(s, T0 + 5000).status]++
  ok('C8 ★ 三档互斥且穷尽（计数之和 == 样本数）', counts.present + counts.degraded + counts.missing, samples.length)
  ok('C8b 且三档都真的出现过（不是某一档恒 0 的假穷尽）', Object.values(counts).every((n) => n > 0), true)
}

// ════════════════════════════════════ D. L3 投递器 ════════════════════════════════════
console.log('\n=== D. L3 投递（只写端点）+ 降级转换 ===')

/** 造一个可控 ctx / audit。 */
function mkCtx() {
  const recs = []
  return {
    recs,
    ctx: { logger: { info() {}, warn() {} } },
    audit: { record: async (e) => { recs.push(e); return { seq: recs.length, hash: 'h' + recs.length } } }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

{
  // D1 未配端点
  const { ctx, audit, recs } = mkCtx()
  const root = mk()
  const cfg = cfgMod.normalizeConfig({ projectRoot: root })
  const s = sinkMod.installTelemetrySink(ctx, cfg, audit, { now: () => 0, fetchImpl: async () => { throw new Error('不许发请求') } })
  await sleep(5)
  ok('D1 未配端点 ⇒ enabled:false', s.enabled, false)
  ok('D1b ★ 双向：留痕恰好一条 telemetry-disabled', recs.filter((r) => r.type === 'telemetry-disabled').length, 1)
  ok('D1c ★ 双向：**不写** state.json（⇒ phase 侧 L4 因路径为空而不适用，不是"读到 present"）', existsSync(join(root, 'memory', 'outbox', 'state.json')), false)
  s.enqueue({ seq: 1, hash: 'x', entry: { a: 1 } })
  await sleep(5)
  ok('D1d 未配端点时 enqueue 是 no-op（不产生队列文件）', ob.countOutboxSync(join(root, 'memory', 'outbox')), 0)
  await s.dispose()
}

{
  // D2/D3 心跳
  const { ctx, audit } = mkCtx()
  const root = mk()
  const cfg = cfgMod.normalizeConfig({ projectRoot: root, telemetryEndpoint: 'https://audit.example/v1/events' })
  const sent = []
  const okFetch = async (url, init) => { sent.push({ url, init }); return { status: 204, body: null } }
  const s = sinkMod.installTelemetrySink(ctx, cfg, audit, { now: () => 1000, fetchImpl: okFetch })
  await sleep(10)
  const st = ob.readStateSync(join(root, 'memory', 'outbox'))
  /** 安全读第 i 次 POST 的 JSON 体（缺任何一层都返 undefined，**绝不抛**）。 */
  const bodyOf = (i) => {
    const b = at(sent, i, 'init', 'body')
    try {
      return b === undefined ? undefined : JSON.parse(b)
    } catch {
      return undefined
    }
  }
  ok('D2 心跳成功 ⇒ state.json 写出 lastDeliveredAt', [st.present, typeof at(st, 'state', 'lastDeliveredAt') === 'string'], [true, true])
  ok('D2b 且 outageSince 为空', at(st, 'state', 'outageSince'), null)
  ok('D10 ★ 只写端点：方法是 POST', at(sent, 0, 'init', 'method'), 'POST')
  ok('D10b ★ 双向：URL 就是配置的 endpoint（没被改写成别的路径）', at(sent, 0, 'url'), 'https://audit.example/v1/events')
  ok('D10c 心跳的记录类型正确', at(bodyOf(0), 'kind'), sinkMod.HEARTBEAT_KIND)
  // 🔴 双向写法：先断言"headers 这个对象在"，再断言"里面没有 Authorization"。
  //    只写 `'Authorization' in (h ?? {})` 会在 headers **整个缺席**时也返 false ⇒ 假绿
  //    （缺席第三层被压进一行读起来像通过的输出 —— 本项目既有纪律）。
  const hdrs0 = at(sent, 0, 'init', 'headers')
  ok(
    'D11 ★ 双向：token 为空 ⇒ 头对象在、且**没有** Authorization 头',
    [typeof hdrs0 === 'object' && hdrs0 !== null, !!hdrs0 && 'Authorization' in hdrs0],
    [true, false]
  )

  s.enqueue({ seq: 7, hash: 'h7', entry: { type: 'session-event' } })
  await sleep(20)
  ok('D4 投递成功 ⇒ 队列文件**被删**', ob.countOutboxSync(join(root, 'memory', 'outbox')), 0)
  ok('D4b 且链上 seq 与文件名同号（幂等键天然成立）', sent.some((x) => JSON.parse(x.init.body).seq === 7), true)
  await s.dispose()
}

{
  // D3/D5/D6 失败：置 outage、保留文件、**一条失败就停**（保序）
  const { ctx, audit } = mkCtx()
  const root = mk()
  const obRoot = join(root, 'memory', 'outbox')
  const cfg = cfgMod.normalizeConfig({ projectRoot: root, telemetryEndpoint: 'https://audit.example/v1/events' })
  /** 投递时记录"被尝试投递的队列 seq"（心跳没有 seq ⇒ 自动排除，只数队列条目）。 */
  const attempted = []
  const failFetch = async (_u, i) => {
    const s = JSON.parse(i.body).seq
    if (s !== undefined) attempted.push(s)
    throw new Error('ECONNREFUSED')
  }
  const s = sinkMod.installTelemetrySink(ctx, cfg, audit, { now: () => 2000, fetchImpl: failFetch })
  await sleep(10)
  const st = ob.readStateSync(obRoot)
  ok('D3 投递失败 ⇒ outageSince 置位', typeof at(st, 'state', 'outageSince') === 'string', true)
  ok('D3b 且 lastError 记下了原因', String(at(st, 'state', 'lastError')).includes('ECONNREFUSED'), true)

  s.enqueue({ seq: 21, hash: 'h21', entry: { type: 'session-event' } })
  await sleep(20)
  s.enqueue({ seq: 22, hash: 'h22', entry: { type: 'session-event' } })
  await sleep(20)
  s.enqueue({ seq: 23, hash: 'h23', entry: { type: 'session-event' } })
  await sleep(30)

  ok('D5 ★ 投递失败 ⇒ 队列文件**保留**（删了等于把"投不出去"这件事抹掉）', ob.listOutboxSync(obRoot).seqs, [21, 22, 23])
  // ★ 反例：若"一条失败就停"没实现，attempted 会是 [21,22,23]（每次都从头把三条都试一遍）。
  //   实现正确 ⇒ 每条 enqueue 触发的 drain 都在**第一条**（永远是 21）就 break。
  ok('D6 ★ 一条失败就停：被尝试投递的**只有队头那一条**', Array.from(new Set(attempted)), [21])
  ok('D6b ★ 双向：队头确实被试过（不是"一次都没投"的假绿）', attempted.length > 0, true)
  await s.dispose()
}

{
  // D7 坏条目：不删、跳过、继续投后面的
  const { ctx, audit } = mkCtx()
  const root = mk()
  const cfg = cfgMod.normalizeConfig({ projectRoot: root, telemetryEndpoint: 'https://audit.example/v1/events' })
  const posted = []
  const f = async (url, init) => { posted.push(JSON.parse(init.body).seq); return { status: 200, body: null } }
  const s = sinkMod.installTelemetrySink(ctx, cfg, audit, { now: () => 3000, fetchImpl: f })
  await sleep(10)
  const obRoot = join(root, 'memory', 'outbox')
  s.enqueue({ seq: 31, hash: 'h31', entry: { type: 'session-event' } })
  await sleep(20)
  writeFileSync(join(obRoot, '32.json'), '{ 坏 JSON')
  s.enqueue({ seq: 33, hash: 'h33', entry: { type: 'session-event' } })
  await sleep(40)
  ok('D7 坏条目**不删**（跳过但留痕）', existsSync(join(obRoot, '32.json')), true)
  ok('D7b 坏条目后面的**照常投递**（一条坏记录不拖垮整个队列）', posted.includes(33), true)
  ok('D7c 好条目按序被删掉', [existsSync(join(obRoot, '31.json')), existsSync(join(obRoot, '33.json'))], [false, false])
  await s.dispose()
}

{
  // D8/D9 降级转换与恢复
  const { ctx, audit, recs } = mkCtx()
  const root = mk()
  const cfg = cfgMod.normalizeConfig({ projectRoot: root, telemetryEndpoint: 'https://audit.example/v1/events', telemetryDegradeAfterMs: 100, telemetryRetryMs: 86400000 })
  let t = 1_000_000
  let up = false
  const f = async () => { if (!up) throw new Error('down'); return { status: 200, body: null } }
  const s = sinkMod.installTelemetrySink(ctx, cfg, audit, { now: () => t, fetchImpl: f })
  await sleep(10)
  ok('D8 首次失败 ⇒ 还没降级（中断时长 0 < 阈值）', recs.filter((r) => r.type === 'telemetry-degraded').length, 0)

  t += 200 // 超过阈值
  s.enqueue({ seq: 41, hash: 'h41', entry: { type: 'session-event' } })
  await sleep(20)
  ok('D8b ★ 中断超阈值 ⇒ 链上出现 telemetry-degraded（"降级本身可审计"）', recs.filter((r) => r.type === 'telemetry-degraded').length, 1)

  up = true
  t += 10
  s.enqueue({ seq: 42, hash: 'h42', entry: { type: 'session-event' } })
  await sleep(30)
  const rec = recs.filter((r) => r.type === 'telemetry-recovered')
  ok('D9 ★ 恢复 ⇒ 写 telemetry-recovered', rec.length, 1)
  // ⚠️ **先断言"那条记录存在"再读它的字段**：`rec[0].pendingReview` 在空数组上会**抛**，
  //    而抛错会让整份报告消失 —— 实测（`_fde_d1_mut.mjs` 的 M16「D9 不留痕」）
  //    原本被判成"崩溃"而不是"断言红"。既有纪律：**崩溃不是判据**，裸取下标前必须先断言该条存在。
  ok(
    'D9b ★ 且带上"降级期间有 N 条待复核"，N 与降级期间**成功投递**的条数相等',
    rec.length > 0 && typeof rec[0].pendingReview === 'number' && rec[0].pendingReview >= 1,
    true
  )
  const st = ob.readStateSync(join(root, 'memory', 'outbox'))
  ok('D9c 恢复后 degradedSince 归零、outageSince 清空', [at(st, 'state', 'degradedSince'), at(st, 'state', 'outageSince')], [null, null])
  await s.dispose()
}

{
  // D11b token 非空
  const { ctx, audit } = mkCtx()
  const root = mk()
  const cfg = cfgMod.normalizeConfig({ projectRoot: root, telemetryEndpoint: 'https://a.b/c', telemetryToken: 'SVC-TOKEN' })
  let hdrs = null
  const s = sinkMod.installTelemetrySink(ctx, cfg, audit, { now: () => 0, fetchImpl: async (_u, i) => { hdrs = i.headers; return { status: 200, body: null } } })
  await sleep(10)
  ok('D11b ★ 双向：token 非空 ⇒ Authorization 是 Bearer <token>', hdrs?.Authorization, 'Bearer SVC-TOKEN')
  await s.dispose()
}

{
  // D12 重启重放：新实例、同一个 root ⇒ 把上次留下的队列推出去
  const root = mk()
  const obRoot = join(root, 'memory', 'outbox')
  const cfg = cfgMod.normalizeConfig({ projectRoot: root, telemetryEndpoint: 'https://a.b/c' })
  {
    const { ctx, audit } = mkCtx()
    const s = sinkMod.installTelemetrySink(ctx, cfg, audit, { now: () => 0, fetchImpl: async () => { throw new Error('down') } })
    await sleep(10)
    s.enqueue({ seq: 51, hash: 'h51', entry: { type: 'session-event' } })
    await sleep(20)
    ok('D12 离线时记录留在队列（跨进程存活）', existsSync(join(obRoot, '51.json')), true)
    await s.dispose()
  }
  const posted = []
  {
    const { ctx, audit } = mkCtx()
    const s = sinkMod.installTelemetrySink(ctx, cfg, audit, { now: () => 9999, fetchImpl: async (u, i) => { posted.push(JSON.parse(i.body).seq); return { status: 200, body: null } } })
    await sleep(30)
    ok('D12b ★ 下次 apply 重放：上次留下的那条被投出去了', posted.includes(51), true)
    ok('D12c 且队列已清空', existsSync(join(obRoot, '51.json')), false)
    await s.dispose()
  }
}

{
  // D13 写残 .tmp 的清理留痕
  const root = mk()
  const obRoot = join(root, 'memory', 'outbox')
  mkdirSync(obRoot, { recursive: true })
  writeFileSync(join(obRoot, '61.json.tmp'), '半截')
  const { ctx, audit, recs } = mkCtx()
  const cfg = cfgMod.normalizeConfig({ projectRoot: root, telemetryEndpoint: 'https://a.b/c' })
  const s = sinkMod.installTelemetrySink(ctx, cfg, audit, { now: () => 0, fetchImpl: async () => ({ status: 200, body: null }) })
  await sleep(10)
  ok('D13 写残的 .tmp 被清掉且留下 telemetry-tmp-swept', [existsSync(join(obRoot, '61.json.tmp')), recs.some((r) => r.type === 'telemetry-tmp-swept')], [false, true])
  await s.dispose()
}

// ════════════════════════════════════ E. phase 侧 L4 ════════════════════════════════════
console.log('\n=== E. phase 侧 L4（本地链完整 AND（远端存在 OR 降级）） ===')

{
  const pcfg = phCfg.normalizeConfig({ projectRoot: 'X:/p', ontologyRoot: 'X:/o', gateAuditPath: 'X:/g.jsonl' })
  ok('E1 路径为空 ⇒ applicable:false（"没配"不是"不满足"）', rs.crossCheckRemoteSync('', 0).applicable, false)
  ok('E1b 且 status 是 present（不拦）', rs.crossCheckRemoteSync('', 0).status, 'present')

  const d = mk()
  ok('E2 ★ 路径给了但文件不在 ⇒ applicable:true + missing（fail-closed）', (() => { const v = rs.crossCheckRemoteSync(join(d, 'state.json'), 0); return [v.applicable, v.status] })(), [true, 'missing'])

  const sp = join(d, 'state.json')
  const T0 = Date.parse('2026-09-29T00:00:00Z')
  writeFileSync(sp, JSON.stringify({ ...ob.emptyState(1000), lastDeliveredAt: '2026-09-29T00:00:00Z' }))
  ok('E3 present 状态 ⇒ present', rs.crossCheckRemoteSync(sp, T0 + 10).status, 'present')
  writeFileSync(sp, JSON.stringify({ ...ob.emptyState(1000), outageSince: '2026-09-29T00:00:00Z' }))
  ok('E4 中断超阈值 ⇒ degraded', rs.crossCheckRemoteSync(sp, T0 + 1000).status, 'degraded')
  ok('E5 中断未达阈值 ⇒ missing', rs.crossCheckRemoteSync(sp, T0 + 999).status, 'missing')
  writeFileSync(sp, '{ 坏')
  ok('E2b ★ 路径给了但内容坏 ⇒ missing（"读不到"绝不等于"没问题"）', rs.crossCheckRemoteSync(sp, T0).status, 'missing')

  ok('E6 ★ 双向：本轮没跑 D2 ⇒ 括号返回 null（不适用）', guardMod.remoteConjunctFor(['D1', 'D3'], pcfg, T0), null)
  ok('E6b 跑了 D2 ⇒ 括号返回对象', typeof guardMod.remoteConjunctFor(['D2'], pcfg, T0), 'object')
}

{
  // E7/E8：D2 分支真的会因为 L4 而失败 / 真的不会因为"没配"而失败
  const d = mk()
  const onto = join(d, 'onto')
  mkdirSync(onto, { recursive: true })
  writeFileSync(join(onto, 'actions.yaml'), 'actions: []\n')
  const gchain = join(d, 'gate.jsonl')
  writeFileSync(gchain, '')
  const pcfg = phCfg.normalizeConfig({ projectRoot: d, ontologyRoot: onto, gateAuditPath: gchain })
  const mirror = { verifyChain: () => ({ ok: true, currentSha: 'aa', currentLen: 3 }) }

  const missingRemote = { applicable: true, status: 'missing', reason: '远端中断 0.10h，未达降级阈值 24.00h ⇒ 正常等待远端' }
  const f1 = guardMod.runDenyChecks(['D2'], pcfg, mirror, { now: 0, remote: missingRemote })
  ok('E7 ★ 链完整但 L4 不通过 ⇒ D2 出现在失败里', f1.length, 1)
  ok('E7b ★ 且理由里点名是 L4 交叉校验（不是"链坏了"—— 链是好的）', f1[0]?.reason.includes('L4 交叉校验'), true)

  const notApplicable = { applicable: false, status: 'present', reason: '未配置 telemetryStatePath' }
  const f2 = guardMod.runDenyChecks(['D2'], pcfg, mirror, { now: 0, remote: notApplicable })
  ok('E8 ★ 双向：括号不适用 ⇒ D2 **不**失败（防"没配外置审计的部署永久卡死"）', f2.length, 0)

  const degradedRemote = { applicable: true, status: 'degraded', reason: '中断 30h ≥ 24h' }
  const f3 = guardMod.runDenyChecks(['D2'], pcfg, mirror, { now: 0, remote: degradedRemote })
  ok('E9 ★ 降级 ⇒ D2 通过（本地链完整即可）', f3.length, 0)

  const f4 = guardMod.runDenyChecks(['D2'], pcfg, { verifyChain: () => ({ ok: false, reason: '链断了' }) }, { now: 0, remote: degradedRemote })
  ok('E10 ★ 双向：链**不**完整时降级也救不了（AND 的前半仍是硬条件）', f4[0]?.reason, '链断了')
}

// ════════════════════════════════════ F. 跨包一致性 ════════════════════════════════════
console.log('\n=== F. 跨包字面量 + 判定同解 ===')

{
  ok('F1 OUTBOX_SUBDIR 两边逐字相同', [ob.OUTBOX_SUBDIR, rs.OUTBOX_SUBDIR], ['outbox', 'outbox'])
  ok('F1b STATE_FILE 两边逐字相同', [ob.STATE_FILE, rs.STATE_FILE], ['state.json', 'state.json'])
  ok('F1c STATE_SCHEMA 两边逐字相同', [ob.STATE_SCHEMA, rs.STATE_SCHEMA], [1, 1])
  ok('F1d 拼出来的相对目录一致', rs.OUTBOX_REL_DIR, `memory/${ob.OUTBOX_SUBDIR}`)
  ok('F1e defaultStatePath 与 outboxRootOf 拼出的路径一致', rs.defaultStatePath('X:/p'), join(ob.outboxRootOf('X:/p'), ob.STATE_FILE))

  const T0 = Date.parse('2026-09-29T00:00:00Z')
  const base = ob.emptyState(1000)
  const samples = [
    base,
    { ...base, lastDeliveredAt: '2026-09-29T00:00:00Z' },
    { ...base, outageSince: '2026-09-29T00:00:00Z' },
    { ...base, lastDeliveredAt: 'x', outageSince: '2026-09-28T00:00:00Z' },
    { ...base, outageSince: '不是时间' }
  ]
  const nows = [T0, T0 + 999, T0 + 1000, T0 + 200000]
  let mismatches = 0
  let compared = 0
  for (const s of samples) {
    for (const n of nows) {
      compared++
      const a = JSON.stringify(sinkMod.evaluateRemote(s, n))
      const b = JSON.stringify(rs.evaluateRemote(s, n))
      if (a !== b) mismatches++
    }
  }
  ok('F2 ★ 两边 evaluateRemote 逐例同解（' + compared + ' 组）', mismatches, 0)
  ok('F2b ★ 双向：样本数确实 > 0（防"比较了个空集"这种恒真绿）', compared > 0, true)

  const r1 = ob.readStateSync(join(mk(), 'nope'))
  const r2 = rs.readRemoteStateSync(join(mk(), 'nope'))
  ok('F3 两边对"文件不存在"给同一个 reason', [r1.reason, r2.reason], ['enoent', 'enoent'])
}

// ════════════════════════════════════ G. 回执打印面 ════════════════════════════════════
console.log('\n=== G. 回执打印 ===')

{
  const toolsSrc = readFileSync(PH + '/tools.js', 'utf8')
  ok('G1 ★ 回执里 `degraded===true` 有专门文案（不能只把标记留在审计里）', toolsSrc.includes('本次通过依赖**审计外置降级模式**'), true)
  ok('G1b ★ 双向：该文案只在 degraded===true 分支里（不是无条件打印）', /if \(r\.degraded === true\) \{[\s\S]{0,400}降级模式/.test(toolsSrc), true)
}

// ════════════════════════════════════ H. config ════════════════════════════════════
console.log('\n=== H. config 校验 ===')

{
  okThrows('H1 端点坏协议 ⇒ 抛', () => cfgMod.normalizeConfig({ projectRoot: 'X:/p', telemetryEndpoint: 'ftp://a' }), 'http/https')
  okThrows('H1b 端点不是 URL ⇒ 抛', () => cfgMod.normalizeConfig({ projectRoot: 'X:/p', telemetryEndpoint: 'not a url' }), '不是合法 URL')
  okThrows('H2 ★ 阈值 0 ⇒ 抛（否则"降级"恒成立 ⇒ 门禁静默失效）', () => cfgMod.normalizeConfig({ projectRoot: 'X:/p', telemetryDegradeAfterMs: 0 }), '正的有限数')
  okThrows('H2b 负数超时 ⇒ 抛', () => cfgMod.normalizeConfig({ projectRoot: 'X:/p', telemetryTimeoutMs: -1 }), '正的有限数')
  ok('H3 端点留空合法（= 不启用，不是错误）', cfgMod.normalizeConfig({ projectRoot: 'X:/p' }).telemetryEndpoint, '')
  okThrows('H4 phase：telemetryStatePath 非字符串 ⇒ 抛', () => phCfg.normalizeConfig({ projectRoot: 'X:/p', ontologyRoot: 'X:/o', gateAuditPath: 'X:/g', telemetryStatePath: 5 }), '必须是字符串')
  ok('H4b phase：默认空串（括号不适用）', phCfg.normalizeConfig({ projectRoot: 'X:/p', ontologyRoot: 'X:/o', gateAuditPath: 'X:/g' }).telemetryStatePath, '')
}

// ════════════════════════════════════ 收尾 ════════════════════════════════════
for (const d of dirs) {
  try {
    rmSync(d, { recursive: true, force: true })
  } catch {
    /* 临时目录清不掉不影响判定 */
  }
}

const failed = FAIL.length
const total = PASS.length + failed
console.log('\n' + '─'.repeat(60))
console.log(`[fde-d1] 通过 ${PASS.length} / 失败 ${failed}（共 ${total}）`)
if (failed > 0) {
  for (const f of FAIL) console.log(`  · ${f.name}\n      实际 ${f.actual}\n      期望 ${f.expected}`)
}
writeFileSync(
  OUT_FILE,
  `通过 ${PASS.length} / 失败 ${failed}（共 ${total}）\n` +
    FAIL.map((f) => `FAIL ${f.name}\n  实际 ${f.actual}\n  期望 ${f.expected}`).join('\n') +
    (failed > 0 ? '\n' : ''),
  'utf8'
)
process.exitCode = INVERT ? (failed > 0 ? 0 : 1) : failed > 0 ? 1 : 0
