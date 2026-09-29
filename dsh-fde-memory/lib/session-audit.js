/**
 * session-audit.js —— 0077 B 单：审计外置 L1（本地采集）。
 *
 * 监听 session/event → 脱敏 → 落 <projectRoot>/memory/audit/events.jsonl（自带哈希链，
 * 复用 lib/audit.js 的 AuditChain：seq + prevHash + hash + 尾部恢复 + outbox 重放）。
 *
 * 设计（0077 §3）：L1 不实现 SessionTelemetryBackend —— 那个 seam 的语义是「对外上报」
 * （`sharing` 披露的就是"会话是否被共享给外部"），且 `ctx.sessionTelemetry` 只有一个位
 * （重复注册抛错）。L1 是本地落盘，走 `ctx.on('session/event')`（cordis 基础面，零额外依赖）。
 * ⚠️ **订正（D1，2026-09-29）**：本行原文是「L2（外置远端）才实现 SessionTelemetryBackend，
 *   本单只留接口位」—— 那句话**已经不成立**。D1 把 L2/L3 做出来了（`lib/telemetry-sink.js`
 *   + `lib/outbox.js`），但**没有**实现 `SessionTelemetryBackend`：那个 seam 在本部署下
 *   结构上撞墙（槽位被 otel 占 + otel 跑 DISABLED ⇒ waterfall 永不派发）。偏离的实测依据
 *   与代价写在 `telemetry-sink.js` 的头注与 `README.md` §12.1，别按本行旧话去那儿找 Backend 实现。
 *
 * 🔴 脱敏红线（0077 §4 B3）：session 事件实测含凭据（launch token / bearer / cookie / api key）。
 *   seam 不内置脱敏 ⇒ 落盘前必须自己脱敏，否则凭据明文进 events.jsonl。
 *
 * 不阻塞（0077 §4 B2）：监听器同步入队后立刻返回（零 IO）；落盘由异步串行 writer 完成。
 * 监听器抛错会冒泡给调用方 ⇒ 必须 try/catch 包住，绝不能让审计失败拖垮会话。
 */

// ── 脱敏规则表（0077 §4 B3 第 9 条）──
/** 键名命中这些模式 ⇒ 整值替换 [REDACTED]（宁多不漏）。 */
const REDACT_KEY_RE = /(token|secret|password|passwd|credential|authorization|cookie|api[_-]?key|jwt|bearer|signature)/i
/** 值命中 bearer token 样式。 */
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
/** 值命中 OpenAI 风格 key（sk- 开头 + 16 位以上）。 */
const SK_RE = /\bsk-[A-Za-z0-9]{16,}/g
/** 值命中 JWT 三段样式（eyJ 开头，两段 base64url + 签名）。 */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g

const MAX_DEPTH = 30

/** 不采集的事件类型（token 级流式 chunk，量极大且内容汇总到同 turn/step 的 assistant/message）。 */
export const SKIP_EVENT_TYPES = new Set(['assistant/chunk'])

/**
 * 递归脱敏一个 JSON 值（0077 §4 B3）。返回**新对象**，不原地改。
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown} 脱敏后的值
 */
export function redactValue(value, depth = 0) {
  if (depth > MAX_DEPTH) return '[REDACTED:depth]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      // 键名命中敏感词 ⇒ 整值脱敏（值里的内容不再递归，直接丢弃）
      if (REDACT_KEY_RE.test(k)) out[k] = '[REDACTED]'
      else out[k] = redactValue(v, depth + 1)
    }
    return out
  }
  return value
}

function redactString(s) {
  let out = s
  out = out.replace(BEARER_RE, '[REDACTED:bearer]')
  out = out.replace(SK_RE, '[REDACTED:sk]')
  out = out.replace(JWT_RE, '[REDACTED:jwt]')
  return out
}

/**
 * 安装 session 审计监听器（0077 §4 B2）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg - 已规范化配置（含 projectRoot）
 * @param {import('./audit.js').AuditChain} audit - 已指向 memory/audit/events.jsonl 的链
 * @param {{enqueue?: (rec: {seq:number, hash:string, entry:object}) => void}} [sink]
 *   L3 投递器（spec §8）。**入队时机刻意排在链写入之后**：这样 `outbox/{seq}.json` 的 seq
 *   与链上那行的 seq **是同一个号**，幂等键（seq + chainHash）天然成立，
 *   不用再造一套编号（两套编号迟早对不上，而对不上的表现是"远端收到了却没记录能对上"）。
 * @returns {() => void} 注销器
 */
export function installSessionAudit(ctx, cfg, audit, sink) {
  const queue = []
  let draining = false

  /** 异步串行 writer：保序落盘（0077 §5.b 拍定「每条一行、串行 writer」）。 */
  async function drain() {
    if (draining) return
    draining = true
    try {
      while (queue.length > 0) {
        const entry = queue.shift()
        let res = null
        try {
          res = await audit.record(entry)
        } catch {
          // 审计故障不该拖垮会话（fail-open on audit，见 audit.js 头注）
        }
        // 落盘失败（persisted:false，进了 L1 的内存缓冲）**也照样进 L2 队列** ——
        // L2 是文件队列，比 L1 的内存缓冲耐用；反过来"因为本地写失败就不外置"会让两份都丢。
        try {
          if (sink && res && Number.isInteger(res.seq)) {
            sink.enqueue({ seq: res.seq, hash: String(res.hash ?? ''), entry })
          }
        } catch {
          // 投递侧的任何异常都不许冒泡回会话路径
        }
      }
    } finally {
      draining = false
    }
  }

  /** 同步入队 + 触发异步落盘。 */
  function enqueue(entry) {
    queue.push(entry)
    setImmediate(drain)
  }

  // 主监听：session 事件。同步入队（零 IO），异步落盘。
  const offEvent = ctx.on('session/event', (session, event) => {
    try {
      if (!event || typeof event !== 'object') return
      if (SKIP_EVENT_TYPES.has(event.type)) return
      const data = event.data === undefined ? undefined : redactValue(event.data)
      enqueue({
        kind: 'session-event',
        eventType: typeof event.type === 'string' ? event.type : String(event.type ?? ''),
        sessionSeq: event.seq,
        time: event.time,
        data
      })
    } catch {
      // 监听器抛错会冒泡给调用方 ⇒ 绝不能拖垮会话（0077 §4 B2）
    }
  })

  // 生命周期标记（0077 §4 B2 第 7 条：建链起点/终点可判）。
  const offCreated = ctx.on('session/created', (session) => {
    try {
      enqueue({ kind: 'session-created', sessionId: session?.id ?? null, time: Date.now() })
    } catch {}
  })

  const offDisposed = ctx.on('session/disposed', (session) => {
    try {
      enqueue({ kind: 'session-disposed', sessionId: session?.id ?? null, time: Date.now() })
    } catch {}
  })

  // 被动 flush：上游触发 session/flush 时，把 outbox 落盘（同 phase 的做法，0077 §5.a 拍定）。
  const offFlush = ctx.on('session/flush', async () => {
    try {
      await audit.flush()
    } catch {}
  })

  return () => {
    offEvent()
    offCreated()
    offDisposed()
    offFlush()
  }
}
