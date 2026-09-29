/**
 * _fde_memory_session_audit_test.mjs —— dsh-fde-memory 0077 B 单（审计外置 L1）离线回归。
 *
 * 覆盖（0077 §6 验证表）：
 *   1. 脱敏真阳性（§6.3）：键名命中 / 值命中 Bearer·sk·JWT / 嵌套·数组递归 / 深度限制；
 *      **核心判据**：含凭据的事件脱敏后 JSON.stringify **不含**明文。
 *   2. 监听器不阻塞（§6.4）：session/event 监听器同步返回（零 IO）。
 *   3. assistant/chunk 过滤（token 级流式，不采集）。
 *   4. 生命周期标记（session/created + session/disposed）。
 *   5. 链完整性（§6.2）：落盘后重放 prevHash+hash 链 ⇒ CHAIN-INTACT。
 *
 * 退出码 0 = 全绿；非 0 = 有失败。FDE_INVERT=1 必红（exit code 敏感）。
 */

import { pathToFileURL } from 'node:url'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = 'C:/Users/DELL/WorkBuddy/2026-09-22-18-30-18'
const MEM_ROOT = ROOT + '/dsh-fde-memory'

const sessionAuditUrl = pathToFileURL(MEM_ROOT + '/lib/session-audit.js').href
const auditUrl = pathToFileURL(MEM_ROOT + '/lib/audit.js').href

const { redactValue, installSessionAudit, SKIP_EVENT_TYPES } = await import(sessionAuditUrl)
const { AuditChain } = await import(auditUrl)

const GENESIS = '0'.repeat(64)
function linkHash(prevHash, record) {
  return createHash('sha256').update(prevHash).update('\n').update(JSON.stringify(record)).digest('hex')
}

const PASS = []
const FAIL = []

function ok(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = expected === undefined ? undefined : JSON.stringify(expected)
  if (e === undefined || a === e) {
    PASS.push(name)
    console.log('  OK ' + name + (expected !== undefined ? ' => ' + a : ''))
  } else {
    FAIL.push({ name: name, actual: a, expected: e })
    console.log('  FAIL ' + name + ' => ' + a + ' (期望 ' + e + ')')
  }
}

function okThrows(name, fn, msgContains) {
  try {
    fn()
    FAIL.push({ name: name, actual: 'no throw', expected: 'throw' })
    console.log('  FAIL ' + name + ' => 没 throw (期望 throw)')
  } catch (e) {
    const msg = String(e && e.message ? e.message : e)
    if (msgContains && !msg.includes(msgContains)) {
      FAIL.push({ name: name, actual: msg, expected: '包含 "' + msgContains + '"' })
      console.log('  FAIL ' + name + ' => throw 但消息不对: ' + msg)
    } else {
      PASS.push(name)
      console.log('  OK ' + name + ' => throw: ' + msg.slice(0, 80))
    }
  }
}

const INVERT = process.env.FDE_INVERT === '1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ===== 1. 脱敏（0077 §6.3 真阳性）=====
console.log('\n[脱敏 redactValue]')

ok('键名 token ⇒ [REDACTED]', redactValue({ token: 'abc-secret-123' }).token, '[REDACTED]')
ok('键名 authorization ⇒ [REDACTED]', redactValue({ authorization: 'Bearer x' }).authorization, '[REDACTED]')
ok('键名 api_key ⇒ [REDACTED]', redactValue({ api_key: 'k123' }).api_key, '[REDACTED]')
ok('键名 cookie ⇒ [REDACTED]', redactValue({ cookie: 'sid=abc' }).cookie, '[REDACTED]')

ok('值 Bearer ⇒ [REDACTED:bearer]', redactValue('Authorization: Bearer abc.def.ghi'), 'Authorization: [REDACTED:bearer]')
ok('值 sk- ⇒ [REDACTED:sk]', redactValue('key=sk-abcdefghijklmnop123456'), 'key=[REDACTED:sk]')
ok('值 JWT ⇒ [REDACTED:jwt]', redactValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'), '[REDACTED:jwt]')

// 嵌套 + 数组递归
const nested = redactValue({ headers: { auth: { token: 'deep-secret' } }, list: [{ password: 'p1' }] })
ok('嵌套键命中（headers.auth.token）', nested.headers.auth.token, '[REDACTED]')
ok('数组元素键命中（list[0].password）', nested.list[0].password, '[REDACTED]')

// 深度限制：超深嵌套不炸
let deep = { a: 'x' }
for (let i = 0; i < 40; i++) deep = { child: deep }
let deepOk = true
try { redactValue(deep) } catch { deepOk = false }
ok('40 层深嵌套不炸', deepOk, true)

// **核心判据**：脱敏后 JSON.stringify 不含明文（0077 §6.3「不许只验没崩」）
const plain = {
  type: 'tool/call',
  data: {
    name: 'run',
    arguments: 'curl -H "Authorization: Bearer sk-abcdefghijklmnop123456" https://x/api'
  }
}
const redactedJson = JSON.stringify(redactValue(plain))
ok('脱敏后不含 bearer 明文（核心真阳性）', redactedJson.includes('sk-abcdefghijklmnop123456'), false)
ok('脱敏后含 [REDACTED] 标记', redactedJson.includes('REDACTED'), true)

// 原对象不被原地改（返回新对象）
const src = { token: 'keep-me' }
redactValue(src)
ok('redactValue 不原地改原对象', src.token, 'keep-me')

// ===== 2. 监听器 + 链完整性（0077 §6.2/6.4）=====
console.log('\n[installSessionAudit + 链完整性]')

function makeMockCtx() {
  const handlers = new Map()
  return {
    on(name, fn) {
      handlers.set(name, fn)
      return () => handlers.delete(name)
    },
    emit(name, ...args) {
      const fn = handlers.get(name)
      if (fn) return fn(...args)
    }
  }
}

const auditDir = mkdtempSync(join(tmpdir(), 'fde-mem-audit-'))
const audit = new AuditChain(join(auditDir, 'events.jsonl'))
const ctx = makeMockCtx()
installSessionAudit(ctx, { projectRoot: auditDir }, audit)

// 同步返回（零 IO）
let returned = false
ctx.emit('session/event', { id: 's1' }, { type: 'tool/call', seq: 100, time: 1000, data: { arguments: 'Bearer sk-abcdefghijklmnop123456' } })
returned = true
ok('session/event 监听器同步返回（不阻塞）', returned, true)

// assistant/chunk 过滤（不采集）
ctx.emit('session/event', {}, { type: 'assistant/chunk', seq: 101, time: 1001, data: { chunk: 'x' } })
ok('SKIP_EVENT_TYPES 含 assistant/chunk', SKIP_EVENT_TYPES.has('assistant/chunk'), true)

// 生命周期标记
ctx.emit('session/created', { id: 's1' })
ctx.emit('session/disposed', { id: 's1' })

// 等异步 writer 落盘
await sleep(80)

const fileText = readFileSync(join(auditDir, 'events.jsonl'), 'utf8')
ok('落盘含 session-event', fileText.includes('session-event'), true)
ok('落盘含 session-created', fileText.includes('session-created'), true)
ok('落盘含 session-disposed', fileText.includes('session-disposed'), true)
ok('落盘不含 assistant/chunk（被过滤）', fileText.includes('assistant/chunk'), false)
ok('落盘不含 bearer 明文（脱敏真阳性）', fileText.includes('sk-abcdefghijklmnop123456'), false)

// 链完整性：逐行重算（0077 §6.2）
const lines = fileText.split('\n').filter((l) => l.trim() !== '')
let prevHash = GENESIS
let expectSeq = null
let chainOk = lines.length > 0
const seenSeq = new Set()
for (const line of lines) {
  let row
  try { row = JSON.parse(line) } catch { chainOk = false; break }
  const seq = row.seq
  if (typeof seq !== 'number' || !Number.isInteger(seq)) { chainOk = false; break }
  if (expectSeq === null) expectSeq = seq
  else if (seq !== expectSeq) { chainOk = false; break }
  if (seenSeq.has(seq)) { chainOk = false; break }
  seenSeq.add(seq)
  expectSeq = seq + 1
  // ⚠️ 重算 hash 必须保留 seq（audit.js record() 计算 hash 时 record 含 seq+ts，
  //    键顺序 = seq, ts, ... —— 去掉 prevHash/hash 即可，不能再去 seq，否则 hash 不符）
  const { prevHash: prev, hash, ...record } = row
  if (prev !== prevHash) { chainOk = false; break }
  if (linkHash(prevHash, record) !== hash) { chainOk = false; break }
  prevHash = hash
}
ok('链完整性（prevHash+hash 重放 CHAIN-INTACT）', chainOk, true)
ok('链行数 > 0', lines.length > 0, true)

// 重启接续：新 AuditChain 从尾部恢复链头（0077 §6.5 判据）
const audit2 = new AuditChain(join(auditDir, 'events.jsonl'))
const beforeCount = audit2.count
await audit2.record({ kind: 'session-event', eventType: 'tool/result', sessionSeq: 200, time: 2000, data: {} })
ok('重启后接续旧链（count 从 ' + beforeCount + ' 继续 +1）', audit2.count, beforeCount + 1)

rmSync(auditDir, { recursive: true, force: true })

// ===== INVERT 模式（exit code 敏感）=====
if (INVERT) {
  console.log('\n[INVERT 模式] 故意失败以验证 exit code 敏感')
  FAIL.push({ name: 'INVERT 故意失败', actual: '失败', expected: '通过' })
  console.log('  FAIL INVERT 故意失败 => 失败 (期望 通过)')
}

// ===== 总结 =====
console.log('\n=== 总结 ===')
console.log('PASS ' + PASS.length + ' / FAIL ' + FAIL.length)
if (FAIL.length > 0) {
  console.log('FAILED:')
  for (const f of FAIL) console.log('  - ' + f.name + ': actual=' + f.actual + ' expected=' + f.expected)
  process.exit(1)
}
console.log('RESULT: PASS')
process.exit(0)
