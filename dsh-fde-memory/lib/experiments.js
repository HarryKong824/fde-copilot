/**
 * experiments.js —— 探索沙箱（spec v3 §7「探索沙箱（experiments/）」）。
 *
 * spec 原文四条要求，逐条对应到本模块的一个设计点：
 *   ① 「沙箱里的内容不进入分层注入（不污染上下文）」
 *      → 注入面（`tools.js` 的 `fde_memory_context`）只读 `<projectRoot>/memory/**`，
 *        沙箱是 `<projectRoot>/experiments/`（`memory/` 的**兄弟**），故不在其内。
 *        这条不是靠"我们没写代码去读它"，而是靠 `_fde_e2_test.mjs` 的负面断言守着
 *        （往沙箱里塞一个看起来像 note 的文件，注入面输出必须逐字不变）。
 *   ② 「沙箱里的 ontology 草稿不参与 D1/D3 校验」
 *      → D1/D3 只读 `<ontologyRoot>` 下的固定四个文件名（objects/logic/actions/guards.yaml），
 *        沙箱不在 ontologyRoot 内 ⇒ 不参与。同样是负面断言守，不是"显然"。
 *   ③ 「验证成功后，通过正式变更通道（L0/L1/L2）合入正式 ontology」
 *      → 合入路径 = 模型读沙箱草稿 → 调 `fde_ontology_write` 写正式路径（自动分级）。
 *        本模块**不提供**任何"从沙箱提升到 ontology"的工具 —— 那会绕开 gate 的
 *        source 溯源与置信度门槛，正是 ② 要防的事。
 *   ④ 「沙箱内容无审计要求（你随便玩）」
 *      → 本模块**一次都不碰** `AuditChain`。这是刻意的：沙箱写入不落审计。
 *        ⚠️ 于是"链上没有沙箱记录"是**设计**，不是"审计坏了"—— 排查 absence 时先读这条。
 *
 * 🔴 本模块是"沙箱边界"的唯一实现处，冲它就等于绕过整个保护根。因此两处**必须**成立：
 *    ① **分段校验**：`name` 按 `/` 切段，每段都必须是非空、非 `.`、非 `..`、不含 `\`/`:`/NUL
 *       的单段名 ⇒ `..` 在结构上进不来（不是"我检查了 .."）；
 *    ② **沙箱内禁符号链接**：逐级 `lstat`，沙箱根**以内**任何一级是符号链接即拒。
 *       为什么必须有这条：分段校验挡不住 `<root>/evil -> ../memory` 这种链接，
 *       而 `writeFileSync` 会**跟随**它 ⇒ 实际写到 `memory/state.yaml`。
 *       为什么不照抄 gate 的 `canonicalizeSync`（解析 realpath 后判 isInside）：
 *       沙箱的语义是"随便玩"，需要符号链接的场景极少；直接**禁掉**换来判定简单、
 *       无歧义、可离线穷举。代价写明在 README 的诚实清单里。
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** 沙箱子目录名。⚠️ 必须与 gate 的 `sandboxSubdirs` 一致（由 `_fde_e2_test.mjs` 对部署配置对拍）。 */
export const EXPERIMENTS_SUBDIR = 'experiments'

/** 单个沙箱文件的内容上限（防一次写入把沙箱撑爆；超限 fail-closed 而不是截断）。 */
export const MAX_CONTENT_BYTES = 256 * 1024
/** `list` 的递归深度上限（相对沙箱根的层数）。 */
export const MAX_DEPTH = 4
/** `list` 的条目上限（超限如实报告"已截断"，不静默丢）。 */
export const MAX_ENTRIES = 200

/** 单段名：禁路径分隔符、盘符冒号、NUL。 */
const SEGMENT_RE = /^[^/\\:\u0000]+$/

/** 沙箱根（绝对路径）。projectRoot 由 config 给，本函数不做任何路径猜测。 */
export function experimentsRootOf(projectRoot) {
  return join(projectRoot, EXPERIMENTS_SUBDIR)
}

/**
 * 把沙箱内的相对名切成**安全的**路径段。任何一段不合法即抛错。
 *
 * @param {unknown} name - 调用方给的名字（如 `ontology-drafts/dose-draft.yaml`）
 * @returns {string[]} 已校验的路径段（至少一段）
 * @throws {Error} 形态非法
 */
function splitSafeSegments(name) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('沙箱文件名为空')
  }
  const raw = name.trim()
  if (isAbsolute(raw)) {
    throw new Error(`沙箱文件名必须是沙箱内的**相对**名，不得是绝对路径：${raw}`)
  }
  const segments = raw.split('/').flatMap((s) => (s.includes('\\') ? s.split('\\') : [s]))
  for (const seg of segments) {
    if (seg.length === 0) throw new Error(`沙箱文件名含空路径段：${raw}`)
    if (seg === '.' || seg === '..') {
      throw new Error(`沙箱文件名不得含 . 或 .. 路径段（沙箱边界不可穿越）：${raw}`)
    }
    if (!SEGMENT_RE.test(seg)) {
      throw new Error(`沙箱文件名的路径段含非法字符（禁 / \\ : 与 NUL）：${JSON.stringify(seg)}`)
    }
  }
  return segments
}

/**
 * 逐级检查沙箱根**以内**是否出现符号链接。
 *
 * 检查范围刻意从沙箱根**之下**开始：沙箱根本身允许是符号链接（那是部署方的目录布局选择），
 * 但沙箱内部不许有 —— 否则 `writeFileSync` 会跟随它写到保护根的其他地方。
 *
 * @param {string} root - 沙箱根（已 resolve）
 * @param {string} abs - 目标绝对路径（已 resolve）
 * @throws {Error} 沙箱内出现符号链接，或目标不在沙箱内
 */
function assertNoSymlinkInside(root, abs) {
  const prefix = root.endsWith(sep) ? root : root + sep
  if (abs !== root && !abs.startsWith(prefix)) {
    throw new Error(`沙箱路径逃逸：${abs} 不在沙箱 ${root} 内`)
  }
  const rel = abs === root ? '' : abs.slice(prefix.length)
  if (rel.length === 0) return

  let cur = root
  for (const seg of rel.split(sep)) {
    if (seg.length === 0) continue
    cur = join(cur, seg)
    // 不存在的段：其下的段也必然不存在，无需（也无法）再查。
    if (!existsSync(cur)) return
    if (lstatSync(cur).isSymbolicLink()) {
      throw new Error(`沙箱内不得出现符号链接（沙箱边界不可穿越）：${cur}`)
    }
  }
}

/**
 * 解析沙箱内的相对名为绝对路径（**唯一的路径解析入口**）。
 *
 * @param {string} projectRoot - 记忆系统根
 * @param {unknown} name - 沙箱内相对名
 * @returns {string} 绝对路径
 * @throws {Error} 形态非法 / 沙箱内符号链接 / 逃逸
 */
export function resolveExperimentPath(projectRoot, name) {
  const root = resolve(experimentsRootOf(projectRoot))
  const segments = splitSafeSegments(name)
  const abs = resolve(root, ...segments)
  assertNoSymlinkInside(root, abs)
  return abs
}

/**
 * 写一个沙箱文件（原子性无关紧要：沙箱无审计、无并发契约）。
 *
 * @param {string} projectRoot
 * @param {unknown} name
 * @param {unknown} content
 * @returns {{name: string, bytes: number}} 回执**不回显内容**
 * @throws {Error}
 */
export function writeExperiment(projectRoot, name, content) {
  if (typeof content !== 'string') {
    throw new Error('沙箱写入的 content 必须是字符串')
  }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_CONTENT_BYTES) {
    throw new Error(
      `沙箱单文件上限 ${MAX_CONTENT_BYTES} 字节，本次 ${bytes} 字节（fail-closed，不截断）`
    )
  }
  const abs = resolveExperimentPath(projectRoot, name)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  return { name: String(name).trim(), bytes }
}

/**
 * 读一个沙箱文件。
 *
 * @param {string} projectRoot
 * @param {unknown} name
 * @returns {{name: string, content: string}}
 * @throws {Error} 文件不存在 / 形态非法
 */
export function readExperiment(projectRoot, name) {
  const abs = resolveExperimentPath(projectRoot, name)
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error(`沙箱文件不存在：${String(name).trim()}`)
  }
  // 读取也设上限：写入有上限，但沙箱是模型可写的目录，手工塞进来的大文件同样存在。
  // 超限 fail-closed 而不是截断 —— 截断会让模型拿到"看起来完整"的半份草稿。
  const size = statSync(abs).size
  if (size > MAX_CONTENT_BYTES) {
    throw new Error(
      `沙箱文件 ${String(name).trim()} 为 ${size} 字节，超过读取上限 ${MAX_CONTENT_BYTES} 字节（fail-closed，不截断）`
    )
  }
  return { name: String(name).trim(), content: readFileSync(abs, 'utf8') }
}

/**
 * 列沙箱内容（递归，带深度与条数上限）。
 *
 * 沙箱不存在 ⇒ 返回空表（**不是错误**：刚开始玩的时候沙箱本来就该是空的）。
 * 截断时 `truncated: true` 显形，不静默丢条目。
 *
 * @param {string} projectRoot
 * @returns {{entries: Array<{name: string, bytes: number}>, truncated: boolean}}
 */
export function listExperiments(projectRoot) {
  const root = resolve(experimentsRootOf(projectRoot))
  /** @type {Array<{name: string, bytes: number}>} */
  const entries = []
  let truncated = false

  if (!existsSync(root)) return { entries, truncated }

  /** @param {string} dir @param {string} prefix @param {number} depth */
  const walk = (dir, prefix, depth) => {
    if (depth > MAX_DEPTH) return
    let names
    try {
      names = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const n of names) {
      if (truncated) return
      const full = join(dir, n)
      let st
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      // 沙箱内的符号链接一律**列出来但标注**，不跟随（跟随 = 把沙箱外的内容读进上下文）。
      if (st.isSymbolicLink()) {
        entries.push({ name: prefix + n, bytes: -1 })
        continue
      }
      if (st.isDirectory()) {
        walk(full, `${prefix}${n}/`, depth + 1)
        continue
      }
      if (entries.length >= MAX_ENTRIES) {
        truncated = true
        return
      }
      entries.push({ name: prefix + n, bytes: st.size })
    }
  }

  walk(root, '', 1)
  return { entries, truncated }
}
