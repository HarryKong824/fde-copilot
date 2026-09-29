/**
 * D1（spec §8 审计外置 L2/L3 + 离线降级）**活体验证主控**。
 *
 * 为什么需要它：离线套件（`_fde_d1_test.mjs` 107 条）证明的是"给定输入算得对"，
 * 证明不了"在真 DSH 进程里这条链会不会被接上"。两者的差就是**接线**：
 * config → normalizeConfig → installTelemetrySink → audit.record → writeOutboxSync → fetch。
 * 接线断了，离线全绿、活体一声不响 —— 本项目已经栽过同型的坑（注释里的机制断言）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 命令（分步执行，每步把证据写进 `_fde_d1_live_out.txt`，**不覆盖**上一次，是追加）：
 *   dry      不碰 DSH：校验配置补丁生成得对、桩能起能收，然后清理
 *   prep     备份配置 → 打补丁 → 起桩 → 重启 DSH（**这是唯一动 DSH 的命令**）
 *   v1       验心跳：桩收到 kind=telemetry-heartbeat，且 outbox/state.json 已 present
 *   ev       造一条会话事件（session/create）—— **不碰任何已有会话**
 *   v2       验入队→投递→删净：桩收到 kind=session-audit-event，且队列里那条没了
 *   out      桩切 fail + 造事件 + 等 2s（阈值 4s，**故意不达阈值**）
 *   v3       验「未达阈值 ⇒ missing」：outageSince 置位、队列积压、evaluateRemote 判 missing
 *   down     继续等到超阈值
 *   v4       验「超阈值 ⇒ degraded」：evaluateRemote 真读 ⇒ degraded + memory 链有 telemetry-degraded
 *   rec      桩切 ok + 等
 *   v5       验恢复：队列投净 + memory 链有 telemetry-recovered（带 pendingReview）
 *   restore  还原配置 → 杀桩 → 重启 → 探活（**收尾必跑**，否则部署停在指向桩的配置上）
 *
 * 🔴 `prep` 与 `restore` 都会**重启 DSH**。两处都先备份配置；`prep` 的备份若已存在则不覆盖
 *    （防把一份已被补丁污染的配置当成"干净原件"）。
 *
 * 端口：DSH 3080（被测方）；桩 3099（本地，不冲突）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, appendFileSync, readdirSync, rmSync, renameSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const DSH_DIR = 'E:\\DSH-desktop\\DeepSeek Harness'
const EXE = DSH_DIR + '\\DeepSeek Harness.exe'
const CFG = 'E:\\DSH-desktop\\DeepSeek Harness\\data\\dsh-home\\profiles\\web\\cordis.patch.yml'
const FDE_STATE = 'E:\\DSH-desktop\\DeepSeek Harness\\data\\dsh-home\\fde-state'
const OUTBOX = FDE_STATE + '\\memory\\outbox'
const STATE = OUTBOX + '\\state.json'
const EVENTS = FDE_STATE + '\\memory\\audit\\events.jsonl'
const STUB_LOG = join(HERE, '_d1_live_stub.jsonl')
const STUB_PID = join(HERE, '_d1_live_stub.pid')
const STUB_READY = join(HERE, '_d1_live_stub_ready.txt')
const BAKDIR = join(HERE, '_snapshots', 'd1-live')
const BAK = join(BAKDIR, 'cordis.patch.yml.orig')
const OUT = join(HERE, '_fde_d1_live_out.txt')

const BASE = 'http://127.0.0.1:3080'
const STUB_PORT = 3099
const STUB_URL = `http://127.0.0.1:${STUB_PORT}/audit`
const JAR = 'C:/Users/DELL/AppData/Local/Temp/dshjar.txt'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const L = []
const say = (s) => {
  L.push(String(s))
  console.log(String(s))
}
function flush() {
  appendFileSync(OUT, `\n########## ${new Date().toISOString()}  cmd=${process.argv[2] ?? '(none)'} ##########\n` + L.join('\n') + '\n', 'utf8')
}

// ───────────────────────── 断言 ─────────────────────────
const PASS = []
const FAIL = []
function ok(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) PASS.push(name)
  else FAIL.push({ name, actual: a, expected: e })
}
/** 安全读：任一层缺席返回 undefined，**绝不抛**（崩溃会让整份报告消失）。 */
const at = (o, ...p) => p.reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), o)

// ───────────────────────── 环境 ─────────────────────────
function listPids() {
  try {
    const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8' })
    const pids = []
    for (const line of out.split('\n')) {
      const cols = line.split('","').map((c) => c.replace(/"/g, ''))
      if (cols[0] === 'DeepSeek Harness.exe' && cols[1]) pids.push(Number(cols[1]))
    }
    return pids
  } catch {
    return []
  }
}
async function portAlive() {
  try {
    const r = await fetch(BASE + '/api/session/list', { method: 'POST' })
    await r.text()
    return true
  } catch {
    return false
  }
}

/** 解析**一段 JSON 文本**（不读文件）。 */
const parseJsonText = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
/** 读一个**文件**并解析（不存在/读不出都返回 null，不抛）。 */
const readJson = (p) => {
  try {
    return parseJsonText(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
/**
 * 🔴 逐行解析 JSONL。**必须用 `parseJsonText`，不是 `readJson`** ——
 *    这个脚本第一版把「一行文本」当路径传给了 `readJson`，于是每一行都 ENOENT ⇒
 *    `chainEvents()` 报「0 行（坏行 432）」，也就是**所有"链上有 X"的断言都会红**，
 *    而它长得完全像"实现没做到"。同族错误在本项目已经出现过多次
 *    （期望写错会伪装成实现有缺陷，诱使人去改**正确**的实现）。
 *    防御不是"下次小心"：`probe` 里加了一条「坏行必须为 0」的断言，读法一错就当场红。
 */
function jsonlRows(p) {
  const rows = []
  let bad = 0
  if (!existsSync(p)) return { rows, bad, exists: false }
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    if (!l.trim()) continue
    const j = parseJsonText(l)
    if (j) rows.push(j)
    else bad++
  }
  return { rows, bad, exists: true }
}
const stubLines = () => jsonlRows(STUB_LOG).rows
const chainEvents = () => jsonlRows(EVENTS)

/** 只读 DSH RPC。参数名因端点而异 —— create 用 `request`，list 用 `_request`。 */
let rpcN = 0
async function rpc(method, args) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
    body: JSON.stringify({ type: 'client-request', rpcId: `r${++rpcN}`, method, payload: { args } })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  const j = JSON.parse(text)
  if (j.result?.ok === false) throw new Error(`${method}: ${JSON.stringify(j.result.error).slice(0, 400)}`)
  return j.result?.value
}
function cookieHeader() {
  const raw = readFileSync(JAR, 'utf8')
  const out = []
  for (let line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    else if (line.startsWith('#')) continue
    const f = line.split('\t')
    if (f.length < 7) continue
    out.push(`${f[5]}=${f[6]}`)
  }
  if (!out.length) throw new Error('cookie jar 里没解析出任何 cookie')
  return out.join('; ')
}

// ───────────────────────── 桩 ─────────────────────────
async function stubUp() {
  try {
    const r = await fetch(`http://127.0.0.1:${STUB_PORT}/__mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'ok' })
    })
    await r.text()
    return true
  } catch {
    return false
  }
}
async function stubSetMode(mode) {
  const r = await fetch(`http://127.0.0.1:${STUB_PORT}/__mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode })
  })
  return (await r.text()).trim()
}
async function spawnStub() {
  // 先清掉 ready 标记（"文件在"是这一轮桩在听的证据，留着上一轮的就成了假证据）
  try {
    writeFileSync(STUB_READY, '', 'utf8')
  } catch {}
  const child = spawn(process.execPath, [join(HERE, '_fde_d1_stub.mjs')], { detached: true, stdio: 'ignore' })
  child.unref()
  writeFileSync(STUB_PID, String(child.pid), 'utf8')
  for (let i = 0; i < 30; i++) {
    await sleep(200)
    if (await stubUp()) return child.pid
  }
  return null
}

// ───────────────────────── 配置补丁 ─────────────────────────
const PATCH_MEMORY = [
  `        # ── D1 活验（**临时**，由 _fde_d1_live.mjs restore 还原）────────────`,
  `        telemetryEndpoint: '${STUB_URL}'`,
  `        telemetryToken: 'D1-LIVE-STUB-TOKEN'`,
  `        telemetryDegradeAfterMs: 4000`,
  `        telemetryTimeoutMs: 2000`,
  `        telemetryRetryMs: 1500`
]
const PATCH_PHASE = [
  `        # ── D1 活验（**临时**，由 _fde_d1_live.mjs restore 还原）────────────`,
  `        telemetryStatePath: '${OUTBOX}\\state.json'`
]

/**
 * 把补丁插进配置文本。**按段定位，不按行号**（行号一改就腐坏）。
 * memory 段的锚是它自己段内第一个 `mode: enforce`（文件里 gate 段也有同样的行 ⇒ 不能用全局匹配）；
 * phase 段的锚是 `lockTtlMs`。
 */
function patchConfig(text) {
  const lines = text.split(/\r?\n/)
  const findSeg = (id) => {
    const i = lines.findIndex((l) => new RegExp(`^\\s*- id: ${id}\\s*$`).test(l))
    if (i < 0) throw new Error(`配置里找不到段 - id: ${id}`)
    return i
  }
  const after = (from, re, label) => {
    for (let i = from + 1; i < lines.length; i++) {
      if (/^\s*- id: /.test(lines[i])) break // 出段了
      if (re.test(lines[i])) return i
    }
    throw new Error(`段内找不到锚点 ${label}`)
  }
  const mSeg = findSeg('dsh-fde-memory')
  const mAnchor = after(mSeg, /^\s*mode: enforce\s*$/, 'dsh-fde-memory 的 mode: enforce')
  const pSeg = findSeg('dsh-fde-phase')
  const pAnchor = after(pSeg, /^\s*lockTtlMs:\s*\d+\s*$/, 'dsh-fde-phase 的 lockTtlMs')

  // 从后往前插，避免前面的插入让后面的下标失效
  const out = lines.slice()
  out.splice(pAnchor + 1, 0, ...PATCH_PHASE)
  out.splice(mAnchor + 1, 0, ...PATCH_MEMORY)
  return out.join('\n')
}

// ───────────────────────── 重启 ─────────────────────────
/**
 * 重启 DSH。加固两点（相对 `_restart_dsh.mjs` 的 120s 单次尝试）：
 *   ① 总等待 420s；② 240s 还没起来就**再 spawn 一次**。
 * 期间每 30s 记一次**进程数** —— 用来区分"进程根本没起"与"起了但端口没开"，
 * 这两种情况修法完全不同，而上一次的 `RESTART-NEEDS-ATTENTION` 从输出里分不出来。
 */
async function restartDSH() {
  const before = listPids()
  say(`重启前：进程 ${before.join(',') || '无'}；3080 可达=${await portAlive()}`)
  for (const pid of before) {
    try {
      process.kill(pid)
    } catch (e) {
      say(`  kill ${pid} 失败：${e.code ?? e.message}`)
    }
  }
  await sleep(2500)
  let released = false
  for (let i = 0; i < 20; i++) {
    if (!(await portAlive())) {
      released = true
      break
    }
    await sleep(1000)
  }
  say(`端口已释放：${released}`)
  if (listPids().length > 0) {
    say(`仍有残留 ${listPids().join(',')} ⇒ 强杀`)
    try {
      execSync('taskkill /F /T /IM "DeepSeek Harness.exe"', { encoding: 'utf8' })
    } catch {}
    await sleep(2000)
  }

  let up = false
  let waited = 0
  let spawned = 0
  while (waited < 420000 && !up) {
    if (spawned === 0 || (spawned === 1 && waited >= 240000)) {
      try {
        const c = spawn(EXE, [], { cwd: DSH_DIR, detached: true, stdio: 'ignore' })
        c.unref()
        spawned++
        say(`  第 ${spawned} 次 spawn（已等 ${waited / 1000}s）`)
      } catch (e) {
        say(`  spawn 失败：${e.message}`)
      }
    }
    await sleep(2000)
    waited += 2000
    if (await portAlive()) {
      up = true
      break
    }
    if (waited % 30000 === 0) say(`  …${waited / 1000}s：进程数=${listPids().length}`)
  }
  const after = listPids()
  say(`3080 恢复：${up}（等待 ${waited / 1000}s，spawn ${spawned} 次）；重启后进程 ${after.length} 个`)
  return { up, changed: JSON.stringify(before.slice().sort()) !== JSON.stringify(after.slice().sort()) }
}

// ───────────────────────── 各命令 ─────────────────────────
const cmd = process.argv[2]

if (cmd === 'dry') {
  const orig = readFileSync(CFG, 'utf8')
  const patched = patchConfig(orig)
  say(`原文 ${orig.split('\n').length} 行 → 补丁后 ${patched.split('\n').length} 行（应 +${PATCH_MEMORY.length + PATCH_PHASE.length}）`)
  ok('dry-1 补丁后行数 = 原文 + 11', patched.split('\n').length - orig.split('\n').length, PATCH_MEMORY.length + PATCH_PHASE.length)
  ok('dry-2 补丁含 telemetryEndpoint', patched.includes(`telemetryEndpoint: '${STUB_URL}'`), true)
  ok('dry-3 补丁含 telemetryStatePath', patched.includes(`telemetryStatePath: '${OUTBOX}\\state.json'`), true)
  // 逐段复核：补丁确实落在**对的段**里（落在 gate 段就成了"给 gate 配 telemetry"）
  // 判据写成「落在该段起始与**下一个段起始**之间」—— 只判 `pi < si` 的话，
  // 插到文件末尾也会绿（那是"在 phase 段之后"，不是"在 phase 段之内"）。
  const ls = patched.split('\n')
  const segStart = (id) => ls.findIndex((l) => new RegExp(`^\\s*- id: ${id}\\s*$`).test(l))
  const nextSeg = (from) => {
    for (let i = from + 1; i < ls.length; i++) if (/^\s*- id: /.test(ls[i])) return i
    return ls.length
  }
  const mS = segStart('dsh-fde-memory')
  const pS = segStart('dsh-fde-phase')
  const ei = ls.findIndex((l) => l.includes('telemetryEndpoint'))
  const si = ls.findIndex((l) => l.includes('telemetryStatePath'))
  say(`段边界：memory@${mS}（止于 ${nextSeg(mS)}）、phase@${pS}（止于 ${nextSeg(pS)}）；补丁落在 ${ei} / ${si}`)
  ok('dry-4 telemetryEndpoint 落在 memory 段内', mS < ei && ei < nextSeg(mS), true)
  ok('dry-5 telemetryStatePath 落在 phase 段内', pS < si && si < nextSeg(pS), true)
  // YAML 语法：用 DSH 自家的 js-yaml 解析（解析不过 ⇒ 插件全部加载失败）
  let yamlOk = 'skipped: 找不到 js-yaml'
  let doc = null
  for (const p of [
    'E:\\DSH-desktop\\DeepSeek Harness\\data\\node_modules\\js-yaml\\index.js',
    'E:\\DSH-desktop\\DeepSeek Harness\\node_modules\\js-yaml\\index.js'
  ]) {
    if (!existsSync(p)) continue
    try {
      const yaml = (await import('file://' + p.replace(/\\/g, '/'))).default
      doc = yaml.load(patched)
      // 列出**全部**条目：顶层是 [tools, insert]，而 insert 里才是四个插件。
      // 只打 `insert[0]` 会让人读到"顶层 2 条：tools, fde-ontology-gate"，
      // 像是配置里只有两个插件 —— 一个会误导读者的摘要，等于一个错的摘要。
      const ids = []
      for (const e of Array.isArray(doc) ? doc : []) {
        if (e?.id) ids.push(e.id)
        if (Array.isArray(e?.insert)) for (const s of e.insert) ids.push('insert:' + (s?.id ?? '?'))
      }
      yamlOk = `ok，顶层 ${Array.isArray(doc) ? doc.length : '非数组'} 条，展开：${ids.join(', ')}`
    } catch (e) {
      yamlOk = 'FAIL: ' + String(e.message).slice(0, 200)
    }
    break
  }
  say('YAML 解析：' + yamlOk)
  ok('dry-6 YAML 解析通过', yamlOk.startsWith('ok，'), true)
  // 解析层面复核（比文本层面强）：补丁确实进了**那个插件的 config 对象**。
  // 文本层面只能证明"这些字在某行附近"，证明不了 loader 会把它们当谁的配置读。
  const findEntry = (id) => {
    for (const e of Array.isArray(doc) ? doc : []) {
      if (e?.id === id) return e
      if (Array.isArray(e?.insert)) for (const s of e.insert) if (s?.id === id) return s
    }
    return null
  }
  ok('dry-12 YAML 层面：memory.config.telemetryEndpoint 就是桩 URL', at(findEntry('dsh-fde-memory'), 'config', 'telemetryEndpoint'), STUB_URL)
  ok('dry-13 YAML 层面：phase.config.telemetryStatePath 就是 outbox/state.json', at(findEntry('dsh-fde-phase'), 'config', 'telemetryStatePath'), OUTBOX + '\\state.json')
  ok('dry-14 YAML 层面：阈值 4000 进了 memory.config', at(findEntry('dsh-fde-memory'), 'config', 'telemetryDegradeAfterMs'), 4000)
  ok('dry-15 YAML 层面：**别的插件**没被误加 telemetry', [at(findEntry('dsh-fde-dsl'), 'config', 'telemetryEndpoint'), at(findEntry('fde-ontology-gate'), 'config', 'telemetryEndpoint')], [undefined, undefined])
  // 桩能起、能收、能切模式
  const pid = await spawnStub()
  ok('dry-7 桩起来了', typeof pid === 'number', true)
  if (pid) {
    const r = await fetch(`http://127.0.0.1:${STUB_PORT}/ping`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"hello":"dry"}' })
    ok('dry-8 桩收下并回 202', r.status, 202)
    ok('dry-9 切 fail 生效', await stubSetMode('fail'), 'mode=fail')
    const r2 = await fetch(`http://127.0.0.1:${STUB_PORT}/ping`, { method: 'POST' })
    ok('dry-10 fail 模式回 500', r2.status, 500)
    ok('dry-11 切回 ok', await stubSetMode('ok'), 'mode=ok')
    process.kill(pid)
    say(`桩 ${pid} 已停（dry 不留进程）`)
    // dry 的桩日志是**自测痕迹**，不是活验证据。留着会混进 v1/v2 的计数里
    // ⇒ 把"我自测过"读成"活体验到了"，这正是本项目反复栽的"仪器自身撒谎"形状之一。
    rmSync(STUB_LOG, { force: true })
    say('已删掉 dry 的桩日志（它不该混进活验证据）')
  }
  say('⚠️ dry **不碰** DSH、**不碰**配置')
}

if (cmd === 'probe') {
  // 纯只读勘察：**不改配置、不碰 DSH 进程**。可随时复跑。
  // 它回答的问题：**跑着的那个 DSH 进程里，有没有我这次的 D1 代码？**
  //   判据 = `memory/audit/events.jsonl` 里有没有 `telemetry-disabled` 记录
  //   —— `installTelemetrySink` 在"未配端点"时**每次 apply 写一条**，
  //      所以"一条都没有"= 这段代码从没在本进程里跑过（不是"跑了但没留痕"）。
  const ch = chainEvents()
  const tele = ch.rows.filter((r) => String(r.type ?? '').startsWith('telemetry-'))
  const last = ch.rows[ch.rows.length - 1]
  const lastT = last?.ts ?? null
  say(`memory 链：${ch.rows.length} 行（坏行 ${ch.bad}），最后一行 time=${JSON.stringify(lastT)}`)
  say(`telemetry-* 记录：${tele.length} 条${tele.length ? ' ⇒ ' + tele.map((r) => r.type).join(', ') : ''}`)
  say(`outbox 目录：${existsSync(OUTBOX) ? '存在（含 ' + readdirSync(OUTBOX).length + ' 项）' : '**不存在**'}`)
  say(`state.json：${existsSync(STATE) ? '存在' : '**不存在**'}`)
  const d1Loaded = tele.some((r) => r.type === 'telemetry-disabled')
  // 仪器自检：链是 JSONL，逐行都该能解析。坏行 >0 说明**我的读法坏了**（不是数据坏了）——
  // 这条断言的存在理由见 `jsonlRows` 的头注（第一版把行文本当路径读，432 行全"坏"）。
  ok('probe-0 memory 链逐行可解析（坏行 0）', ch.bad, 0)
  ok('probe-0b 链非空（否则"没有 telemetry-* 记录"是空集的假绿）', ch.rows.length > 0, true)
  say(`⇒ 判定：运行中的 DSH **${d1Loaded ? '已' : '尚未'}**加载 D1 代码`)
  if (!d1Loaded) say('   （未加载 ⇒ 活验必须**重启一次 DSH**；`prep` 会做，但那是需要授权的动作）')
  // ⚠️ 这两条**只在"配置里确实没配端点"时才是判据**。前提不成立还照跑，
  //    就会用一条恒真（或恒假）的断言冒充"检查过了"—— 所以先判前提，再判结论。
  const cfgText = readFileSync(CFG, 'utf8')
  const cfgHasEndpoint = /^\s*telemetryEndpoint:\s*['"]?\S/m.test(cfgText)
  say(`配置里 telemetryEndpoint：${cfgHasEndpoint ? '已配' : '未配（留空 ⇒ 外置不启用）'}`)
  if (!cfgHasEndpoint) {
    ok('probe-1 未配端点 ⇒ outbox 目录**不该**出现', existsSync(OUTBOX), false)
    ok('probe-2 未配端点 ⇒ state.json **不该**出现', existsSync(STATE), false)
  } else {
    say('   ⇒ 已配端点，跳过上面两条"不该出现"（前提不成立，跑了也是假的）')
  }
  // 会话端点只读探活（cookie 可能过期 ⇒ 失败不算红，只如实记）
  try {
    const v = await rpc('session/list', { _request: {} })
    say(`session/list 只读探活：通，${(v?.items ?? []).length} 个会话`)
  } catch (e) {
    say(`session/list 只读探活：不通（${String(e.message).slice(0, 120)}）—— 只影响 RPC 类命令，不影响文件类判据`)
  }
}

if (cmd === 'live') {
  // 🔴 **交付态活验**（用户手动重启后跑）：**只读**，不改配置、不碰进程。
  // 它验的是"新代码在真 DSH 里装上了、而且在**未配端点**这个交付态下行为正确"。
  // ⚠️ 它**不**覆盖投递/降级/恢复（那些要配端点 ⇒ 要 `prep`）。别把这一层说成"审计外置已活验"。
  const ch = chainEvents()
  const tele = ch.rows.filter((r) => String(r.type ?? '').startsWith('telemetry-'))
  // A. 代码装上了：`installTelemetrySink` 在未配端点时**每次 apply 写一条** telemetry-disabled。
  //    ⚠️ 判据口径：A2 判的是**种类**（写了哪几种 telemetry 记录），**不是条数** ——
  //    未配端点时**每重启一次就写一条**，所以条数 = apply 次数，会随重启增长。
  //    （第一版把它写成 `tele.map(type) === ['telemetry-disabled']` ⇒ 第二次重启后当场**假红**。
  //      这就是"把『只有这一种』写成『恰好一条』"的经典形状：措辞对、判据窄。）
  const disAll = tele.filter((r) => r.type === 'telemetry-disabled')
  const disLast = disAll.reduce((a, b) => (a && a.seq > b.seq ? a : b), null) // 按 seq 取最新，不按行序
  ok('live-A1 真进程里写出了 telemetry-disabled（⇒ D1 代码被 apply 过）', disAll.length > 0, true)
  ok('live-A2 而且链上 telemetry 记录**只有这一种**（判种类，不判条数）',
    [...new Set(tele.map((r) => r.type))], ['telemetry-disabled'])
  ok('live-A3 最新那条在链尾窗口内（时序：它是本次重启之后写的）',
    disLast ? disLast.seq >= ch.rows.length - 5 : false, true)
  say(`     telemetry-disabled 共 ${disAll.length} 条（= apply 次数）；最新一条 seq=${disLast?.seq}，链共 ${ch.rows.length} 行，ts=${disLast?.ts}`)

  // B. 记录内容：必须能读成"配置选择"而不是"故障"（否则运维会去修一个没坏的东西）
  ok('live-B1 reason 点明「未配置 telemetryEndpoint」', /未配置\s*telemetryEndpoint/.test(String(disLast?.reason ?? '')), true)
  ok('live-B2 note 点明「这是配置选择不是故障」', String(disLast?.note ?? '').includes('配置选择'), true)

  // C. **本地链完整性**（L4 的前半句「本地链完整」—— 活体上真算一遍）
  //    用**部署副本的真代码** `linkHash` 重算 434 行，不是自己再写一份哈希。
  //
  //    🔴 口径：**按 `seq` 升序重放，不按文件行序**。
  //    实测本链第 224 行的 `seq=223` 排在第 223 行 `seq=224` **之后** —— 两个写者并发
  //    分配 seq 后落盘次序被打乱（同 ms 的 `memory-confirm` 与 `session-event`）。
  //    按行序重放会报 3 处**假断链**（我第一版就这么报的）。链本身完好：
  //    按 seq 重放断链 0、哈希不符 0。⇒ 这正是 README §12.6 第 5 条。
  const audit = await import('file://' + join(HERE, 'dsh-fde-memory', 'lib', 'audit.js').replace(/\\/g, '/'))
  const sorted = [...ch.rows].sort((a, b) => a.seq - b.seq)
  let head = audit.GENESIS
  let broken = 0
  let mismatch = 0
  for (const row of sorted) {
    // ⚠️ 用 rest 解构：它保留 record 其余键的**原顺序**，而 `linkHash` 的输入是
    //    `JSON.stringify(record)` —— 键顺序变了哈希就变。**不许**手工重新拼装对象。
    const { prevHash, hash, ...record } = row
    if (prevHash !== head) broken++
    if (audit.linkHash(head, record) !== hash) mismatch++
    head = hash
  }
  const seqs = ch.rows.map((r) => r.seq)
  const uniq = new Set(seqs)
  const missing = []
  for (let s = Math.min(...seqs); s <= Math.max(...seqs); s++) if (!uniq.has(s)) missing.push(s)
  const lastOnDisk = ch.rows[ch.rows.length - 1].hash
  say(`     链完整性：${sorted.length} 条（seq ${Math.min(...seqs)}..${Math.max(...seqs)}，去重 ${uniq.size}）`)
  say(`       按 seq 重放：断链 ${broken}，哈希不符 ${mismatch}；缺号 ${missing.length}；链尾 ${head.slice(0, 16)}…`)
  say(`       末行 hash 与链尾${head === lastOnDisk ? '一致（#restoreFromTail 取到的 head 是对的）' : '**不一致**'}`)
  ok('live-C1 无断链（按 seq 重放，prevHash 逐条接得上）', broken, 0)
  ok('live-C2 无哈希不符（每条 hash 都能用真 linkHash 重算出来）', mismatch, 0)
  // C1/C2 只在"seq 本身连续"时才有意义：缺号会让重放静默跳过一条而不报断链。
  ok('live-C3 seq 无重号（去重数 == 行数）', uniq.size, sorted.length)
  ok('live-C4 seq 无缺号', missing, [])
  ok('live-C5 链尾 head == 文件末行 hash（否则重启后新记录会挂在错 head 上）', head === lastOnDisk, true)
  ok('live-C6 链非空（否则上面几条是空集的假绿）', ch.rows.length > 0, true)
  // C7 自证：故意篡改一条 ⇒ 重算必须不符。没有它，C1/C2 可能只是"我压根没在算"。
  {
    const victim = { ...sorted[Math.floor(sorted.length / 2)] }
    // 改 `ts`：`record()` 无条件给每条加它 ⇒ 一定存在，且值不可能撞上 2000 年。
    victim.ts = '2000-01-01T00:00:00.000Z'
    const { prevHash, hash, ...record } = victim
    ok('live-C7 自证：篡改一条 ⇒ 重算必然不符（证明 C2 不是恒真式）',
      audit.linkHash(prevHash, record) !== hash, true)
  }

  // D. 未配端点 ⇒ 那两个文件**不该**出现（双向判据的另一半）
  ok('live-D1 未配端点 ⇒ outbox 目录不存在', existsSync(OUTBOX), false)
  ok('live-D2 未配端点 ⇒ state.json 不存在', existsSync(STATE), false)

  // E. 插件装载（硬证据：四个 fde 插件都 active）
  try {
    const inv = await rpc('pluginInventory/list', {})
    const entries = inv?.entries ?? inv?.value?.entries ?? []
    say(`     pluginInventory/list ⇒ ${entries.length} 个条目`)
    const fde = entries.filter((e) => String(e.moduleName ?? '').includes('fde'))
    for (const e of fde) say(`       ${e.moduleName}: fiberPhase=${e.fiberPhase} enabled=${e.enabled}`)
    ok('live-E1 四个 fde 插件全部 active', fde.every((e) => e.fiberPhase === 'active'), true)
    ok('live-E2 且数量是 4', fde.length, 4)
    ok('live-E3 没有一个 failed', fde.filter((e) => e.fiberPhase !== 'active').length, 0)
  } catch (e) {
    say(`     pluginInventory/list 不通：${String(e.message).slice(0, 200)}`)
    ok('live-E1 插件装载可核（RPC 通）', false, true)
  }
}

if (cmd === 'prep') {
  mkdirSync(BAKDIR, { recursive: true })
  if (existsSync(BAK)) {
    say(`⚠️ 备份已存在，**不覆盖**：${BAK}`)
    say('   （防把一份已被补丁污染的配置当成干净原件。要重来请先人工确认并删掉它。）')
  } else {
    copyFileSync(CFG, BAK)
    say(`已备份配置 → ${BAK}`)
  }
  const orig = readFileSync(BAK, 'utf8')
  if (orig.includes('telemetryEndpoint') || orig.includes('telemetryStatePath')) {
    say('🔴 备份里**已含** telemetry 配置 ⇒ 这份"原件"不干净，拒绝继续。')
    flush()
    process.exitCode = 1
    process.exit()
  }
  writeFileSync(CFG, patchConfig(orig), 'utf8')
  say('已把补丁写进 cordis.patch.yml')

  const oldPid = existsSync(STUB_PID) ? Number(readFileSync(STUB_PID, 'utf8')) : 0
  if (oldPid) {
    try {
      process.kill(oldPid)
      say(`停掉上一轮的桩 ${oldPid}`)
    } catch {}
  }
  // 归档上一轮的桩日志：本轮证据从零开始数，否则 v1 的"心跳 ≥1"可能数到的是上一轮的
  if (existsSync(STUB_LOG)) {
    renameSync(STUB_LOG, STUB_LOG + '.prev')
    say('上一轮桩日志已归档为 _d1_live_stub.jsonl.prev（本轮从零计）')
  }
  const pid = await spawnStub()
  if (!pid) {
    say('🔴 桩起不来 ⇒ 中止（不改 DSH）')
    flush()
    process.exitCode = 1
    process.exit()
  }
  say(`桩已起：pid=${pid}，端口 ${STUB_PORT}`)

  const r = await restartDSH()
  say(`RESULT: ${r.up ? 'PREP-OK' : 'PREP-DSH-NOT-UP'}`)
  if (!r.up) say('🔴 DSH 没起来 ⇒ 立刻跑 `node _fde_d1_live.mjs restore` 把配置还原')
}

if (cmd === 'v1' || cmd === 'v2' || cmd === 'v3' || cmd === 'v4' || cmd === 'v5') {
  const lines = stubLines()
  const beats = lines.filter((l) => l.body?.kind === 'telemetry-heartbeat')
  const evs = lines.filter((l) => l.body?.kind === 'session-audit-event')
  const st = readJson(STATE)
  const q = existsSync(OUTBOX) ? readdirSync(OUTBOX).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.slice(0, -5))).sort((a, b) => a - b) : []
  const ch = chainEvents()
  say(`桩日志 ${lines.length} 条（心跳 ${beats.length}、事件 ${evs.length}）；outbox 队列 [${q.join(',')}]`)
  say(`state.json: ${st ? JSON.stringify(st) : '（不存在/读不出）'}`)
  say(`memory 链 ${ch.rows.length} 行（坏行 ${ch.bad}）`)

  // 用**真实代码**读**真实文件**（phase 侧 L4 的判据函数，与 memory 侧镜像）
  const rs = await import('file://' + join(HERE, 'dsh-fde-phase', 'lib', 'remote-state.js').replace(/\\/g, '/'))
  const real = rs.crossCheckRemoteSync ? rs.crossCheckRemoteSync(OUTBOX + '\\state.json', Date.now()) : null
  say(`crossCheckRemoteSync(真实 state.json) = ${JSON.stringify(real)}`)

  if (cmd === 'v1') {
    ok('v1-a 桩收到心跳', beats.length >= 1, true)
    ok('v1-b 心跳是 POST', at(beats, 0, 'method'), 'POST')
    ok('v1-c 心跳打到配置的 URL', at(beats, 0, 'url'), '/audit')
    ok('v1-d 配了 token ⇒ 带 Bearer', at(beats, 0, 'auth'), 'Bearer D1-LIVE-STUB-TOKEN')
    ok('v1-e state.json 已落盘', typeof at(st, 'schemaVersion') === 'number', true)
    ok('v1-f 投递成功后 lastDeliveredAt 有值', typeof at(st, 'lastDeliveredAt') === 'string', true)
    ok('v1-g 且 outageSince 为空', at(st, 'outageSince'), null)
    ok('v1-h 阈值来自本次 config（4000）', at(st, 'degradeAfterMs'), 4000)
    ok('v1-i outbox 目录存在', existsSync(OUTBOX), true)
    ok('v1-j L4 读真实文件 ⇒ present', at(real, 'status'), 'present')
  }
  if (cmd === 'v2') {
    ok('v2-a 桩收到会话审计事件', evs.length >= 1, true)
    ok('v2-b 事件带 kind', at(evs, 0, 'body', 'kind'), 'session-audit-event')
    ok('v2-c 事件带链上 seq（整数）', Number.isInteger(at(evs, 0, 'body', 'seq')), true)
    ok('v2-d 事件带 chainHash', typeof at(evs, 0, 'body', 'chainHash') === 'string', true)
    ok('v2-e 投递成功 ⇒ 队列里那条已删', q.includes(at(evs, 0, 'body', 'seq')), false)
    ok('v2-f 链上那行确实存在（seq 能对上）', ch.rows.some((r) => r.seq === at(evs, 0, 'body', 'seq')), true)
    ok('v2-g 链上那行 hash 与投递的一致', ch.rows.find((r) => r.seq === at(evs, 0, 'body', 'seq'))?.hash, at(evs, 0, 'body', 'chainHash'))
  }
  if (cmd === 'v3') {
    ok('v3-a 投递失败 ⇒ 队列积压（>0）', q.length > 0, true)
    ok('v3-b outageSince 已置位', typeof at(st, 'outageSince'), 'string')
    ok('v3-c lastError 记了原因（HTTP 500）', String(at(st, 'lastError')).includes('500'), true)
    ok('v3-d **未达阈值** ⇒ L4 判 missing（不许提前降级）', at(real, 'status'), 'missing')
    ok('v3-e 且 outageMs 小于阈值', at(real, 'outageMs') < 4000, true)
    ok('v3-f 此时链上**没有** telemetry-degraded', ch.rows.some((r) => r.type === 'telemetry-degraded'), false)
  }
  if (cmd === 'v4') {
    ok('v4-a **超阈值** ⇒ L4 判 degraded', at(real, 'status'), 'degraded')
    ok('v4-b outageMs ≥ 阈值', at(real, 'outageMs') >= 4000, true)
    ok('v4-c memory 链有 telemetry-degraded', ch.rows.some((r) => r.type === 'telemetry-degraded'), true)
    const deg = ch.rows.find((r) => r.type === 'telemetry-degraded')
    ok('v4-d 降级记录带 outageSince', typeof at(deg, 'outageSince'), 'string')
    ok('v4-e 降级记录带阈值', at(deg, 'degradeAfterMs'), 4000)
    ok('v4-f 降级期间队列仍积压（>0，没被丢掉）', q.length > 0, true)
  }
  if (cmd === 'v5') {
    ok('v5-a 恢复后队列投净', q.length, 0)
    ok('v5-b outageSince 清空', at(st, 'outageSince'), null)
    ok('v5-c degradedSince 归零', at(st, 'degradedSince'), null)
    ok('v5-d degradedDelivered 归零', at(st, 'degradedDelivered'), 0)
    const rec = ch.rows.find((r) => r.type === 'telemetry-recovered')
    ok('v5-e memory 链有 telemetry-recovered', !!rec, true)
    ok('v5-f 且带 pendingReview（数字）', typeof at(rec, 'pendingReview'), 'number')
    ok('v5-g 带降级窗口起止', [typeof at(rec, 'degradedSince'), typeof at(rec, 'degradedUntil')], ['string', 'string'])
    ok('v5-h L4 回到 present', at(real, 'status'), 'present')
  }
}

if (cmd === 'ev') {
  const v = await rpc('session/create', { request: {} })
  say(`session/create ⇒ ${JSON.stringify(v).slice(0, 300)}`)
  ok('ev-1 会话建成', !!at(v, 'sessionId') || !!at(v, 'id'), true)
}

if (cmd === 'out') {
  say('桩切 fail ⇒ ' + (await stubSetMode('fail')))
  const v = await rpc('session/create', { request: {} })
  say(`造事件 session/create ⇒ ${JSON.stringify(v).slice(0, 200)}`)
  await sleep(2000)
}
if (cmd === 'down') {
  say('等 5s（阈值 4000ms + 一个心跳周期 1500ms）…')
  await sleep(5000)
}
if (cmd === 'rec') {
  say('桩切 ok ⇒ ' + (await stubSetMode('ok')))
  await sleep(4000)
}

if (cmd === 'restore') {
  if (!existsSync(BAK)) {
    say(`🔴 备份不存在（${BAK}）⇒ 不敢乱改配置，中止。`)
    flush()
    process.exitCode = 1
    process.exit()
  }
  copyFileSync(BAK, CFG)
  say(`已从备份还原配置：${BAK} → cordis.patch.yml`)
  const now = readFileSync(CFG, 'utf8')
  ok('restore-1 还原后不含 telemetryEndpoint', now.includes('telemetryEndpoint'), false)
  ok('restore-2 还原后不含 telemetryStatePath', now.includes('telemetryStatePath'), false)
  if (existsSync(STUB_PID)) {
    const pid = Number(readFileSync(STUB_PID, 'utf8'))
    try {
      process.kill(pid)
      say(`已杀桩 ${pid}`)
    } catch (e) {
      say(`杀桩 ${pid} 失败（可能已退出）：${e.code ?? e.message}`)
    }
  }
  const r = await restartDSH()
  say(`RESULT: ${r.up ? 'RESTORE-OK' : 'RESTORE-DSH-NOT-UP'}`)
}

// ───────────────────────── 收尾 ─────────────────────────
const failed = FAIL.length
say('')
say('────────────────────────────────────────────')
say(`[fde-d1-live ${cmd}] 通过 ${PASS.length} / 失败 ${failed}（共 ${PASS.length + failed}）`)
for (const f of FAIL) {
  say(`FAIL ${f.name}`)
  say(`  实际 ${f.actual}`)
  say(`  期望 ${f.expected}`)
}
flush()
if (failed > 0) process.exitCode = 1
