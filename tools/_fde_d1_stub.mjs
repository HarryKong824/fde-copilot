/**
 * D1 活验用的**远端审计只写端点桩**（独立进程，被 `_fde_d1_live.mjs` spawn）。
 *
 * 它是一个**只写端点**的仿真：只接受 POST，把收到的每一条追加到 `_d1_live_stub.jsonl`，
 * 回 202。**不解析、不回应业务语义** —— 因为被测实现（`telemetry-sink.js`）本来就
 * 「只看状态码，不解析响应体」，桩要是回一个花哨的 JSON 反而会给"它其实读了响应体"留出误判空间。
 *
 * 运行时切换可达性（活验要制造"远端中断"）：
 *   POST /__mode  {"mode":"ok"|"fail"}   → fail 时所有投递回 500
 *
 * 端口 3099：不占用 DSH 的 3080。
 * 证据文件 `_d1_live_stub.jsonl` 每行一条：
 *   {t, method, url, auth, mode, status, body}
 * ⚠️ `auth` 记的是 **Authorization 头的原值**（活验要证明"配了 token ⇒ 带 Bearer"）。
 *    它只是本地活验的假 token，不是任何真实凭据。
 */
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG = join(HERE, '_d1_live_stub.jsonl')
const PORT = Number(process.env.D1_STUB_PORT ?? 3099)

let mode = 'ok'

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = null
    try {
      body = JSON.parse(raw)
    } catch {
      body = { __unparsable: raw.slice(0, 200) }
    }

    if (req.url === '/__mode') {
      const next = body?.mode
      if (next !== 'ok' && next !== 'fail') {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('mode must be ok|fail')
        return
      }
      mode = next
      appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), method: '__mode', mode }) + '\n', 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('mode=' + mode)
      return
    }

    const status = mode === 'ok' ? 202 : 500
    appendFileSync(
      LOG,
      JSON.stringify({
        t: new Date().toISOString(),
        method: req.method,
        url: req.url,
        auth: req.headers.authorization ?? null,
        mode,
        status,
        body
      }) + '\n',
      'utf8'
    )
    res.writeHead(status, { 'Content-Type': 'text/plain' })
    res.end(String(status))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  writeFileSync(join(HERE, '_d1_live_stub_ready.txt'), `listening ${PORT} at ${new Date().toISOString()}\n`, 'utf8')
  console.log(`[d1-stub] listening on 127.0.0.1:${PORT}, mode=${mode}, log=${LOG}`)
})
