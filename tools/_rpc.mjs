/** 通用只读 RPC 调用： node _rpc.mjs <method> '<jsonArgs>' */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'

const JAR = 'C:/Users/DELL/AppData/Local/Temp/dshjar.txt'
const BASE = 'http://127.0.0.1:3080'

function cookieHeader() {
  if (!existsSync(JAR)) return ''
  const parts = []
  for (const raw of readFileSync(JAR, 'utf8').split('\n')) {
    let line = raw.trim()
    if (!line) continue
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    else if (line.startsWith('#')) continue
    const cols = line.split('\t')
    if (cols.length < 7) continue
    parts.push(cols[5] + '=' + cols[6])
  }
  return parts.join('; ')
}

const method = process.argv[2]
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {}
if (!method) {
  console.error('用法: node _rpc.mjs <method> <jsonArgs>')
  process.exit(2)
}
const body = JSON.stringify({ type: 'client-request', rpcId: 'rpc1', method, payload: { args } })
const res = await fetch(BASE + '/api/' + method, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
  body
})
const j = await res.json()
if (j.result && j.result.ok === false) {
  console.error(method + ' 失败: ' + JSON.stringify(j.result.error))
  process.exit(1)
}
const value = j.result?.value
const text = JSON.stringify(value, null, 1)
writeFileSync('_rpc_out.txt', text + '\n', 'utf8')
console.log(text.slice(0, 20000))
