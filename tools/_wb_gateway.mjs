/**
 * 测 WorkBuddy Remote Control 网关通道（**只发只读 GET**）。
 * 用法：node _wb_gateway.mjs <密码>
 * ⚠️ 密码值不进日志（只打印状态码与响应片段）。
 */
import { readFileSync, readdirSync } from 'node:fs'

const HOME = 'C:/Users/DELL/.workbuddy'
const pw = process.argv[2]
if (!pw) throw new Error('用法: node _wb_gateway.mjs <密码>')

// 找心跳最新的、带 endpoint 的会话元数据
const cs = []
for (const f of readdirSync(`${HOME}/sessions`)) {
  if (!f.endsWith('.json')) continue
  try {
    const j = JSON.parse(readFileSync(`${HOME}/sessions/${f}`, 'utf8'))
    if (j.endpoint) cs.push(j)
  } catch {}
}
if (!cs.length) throw new Error('没有带 endpoint 的会话元数据（--serve 没起来？）')
cs.sort((a, b) => (b.lastHeartbeat ?? 0) - (a.lastHeartbeat ?? 0))
const c = cs[0]
console.log(`pid=${c.pid}  endpoint=${c.endpoint}  心跳=${new Date(c.lastHeartbeat).toISOString()}`)
console.log(`mode=${c.mode}  kind=${c.kind}  version=${c.version}`)
console.log('')

const BASE = c.endpoint
const tries = [
  ['无头（基线，应 401）', `${BASE}/api/v1/status`, {}],
  ['Authorization: Bearer', `${BASE}/api/v1/status`, { Authorization: `Bearer ${pw}` }],
  ['?password= 查询串', `${BASE}/api/v1/status?password=${encodeURIComponent(pw)}`, {}],
  ['x-codebuddy-password 头', `${BASE}/api/v1/status`, { 'x-codebuddy-password': pw }]
]
for (const [name, url, h] of tries) {
  try {
    const r = await fetch(url, { headers: h, signal: AbortSignal.timeout(6000) })
    const t = await r.text()
    console.log(`${String(r.status).padEnd(4)} ${name.padEnd(26)} ${t.slice(0, 200)}`)
  } catch (e) {
    console.log(`ERR  ${name.padEnd(26)} ${e.message}`)
  }
}
