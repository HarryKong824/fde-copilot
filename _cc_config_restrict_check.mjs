/**
 * _cc_config_restrict_check.mjs —— 独立核「活 cordis.patch.yml 里 restrict 那两项」。
 *
 * 为什么需要它：`_probe_yaml_anchor.mjs` 只检查 ①YAML 解析 ②条目顺序 ③锚点同源 ④落点存在，
 * **四项都与 protectedPhases / denyTools 无关** ⇒ 该探针会对 `[4, 6, 10]`（无引号）照样 PASS，
 * 而那种写法会让插件 fiberPhase: failed。本脚本补上这一档。
 *
 * 判法：把 YAML 解析出来的 config 对象**喂给插件自己的 normalizeConfig()**，
 * 看它抛不抛 —— 不自己复刻规则，直接用权威实现。
 *
 * 自带坏样本（纪律：检查器对坏样本必须判红，不然它自己 exit 1）。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const patchPath = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/cordis.patch.yml'
const pluginDir = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/node_modules/dsh-fde-phase'

// DSH 树里的真 js-yaml（带 !!js 的 schema 由探针负责，这里只需要 basic load）
let yaml
for (const p of ['E:/DSH-desktop/DeepSeek Harness/data/node_modules/js-yaml',
                 'C:/Users/DELL/WorkBuddy/2026-09-22-18-30-18/node_modules/js-yaml']) {
  try { yaml = require(p); break } catch { /* next */ }
}
if (!yaml) { console.log('🔴 找不到 js-yaml'); process.exit(1) }

const { normalizeConfig } = await import(pathToFileURL(`${pluginDir}/lib/config.js`).href)

const fails = []
const say = (ok, msg) => { console.log(`  ${ok ? '✅' : '🔴'} ${msg}`); if (!ok) fails.push(msg) }

function phaseCfgFrom(text) {
  const doc = yaml.load(text)
  for (const e of doc ?? []) {
    const hit = (e?.insert ?? []).find((i) => i.id === 'dsh-fde-phase')
    if (hit) return hit.config
  }
  return null
}

function checkText(label, text, wantPass) {
  const cfg = phaseCfgFrom(text)
  if (!cfg) { say(false, `${label}: 没找到 dsh-fde-phase 条目`); return }
  const pp = cfg.protectedPhases, dt = cfg.denyTools
  let threw = null
  try { normalizeConfig(cfg) } catch (e) { threw = String(e?.message ?? e) }
  const ok = wantPass ? threw === null : threw !== null
  say(ok, `${label}: protectedPhases=${JSON.stringify(pp)}(${(pp ?? []).map((v) => typeof v).join('/')}) ` +
          `denyTools=${JSON.stringify(dt)}(${(dt ?? []).map((v) => typeof v).join('/')}) ` +
          `⇒ normalizeConfig ${threw === null ? '通过' : '抛: ' + threw}`)
}

// ── 活文件（期望：通过）────────────────────────────────────────────
const live = readFileSync(patchPath, 'utf8')
console.log('== 活 cordis.patch.yml ==')
checkText('活文件', live, true)

// ── 坏样本：去掉 protectedPhases 的引号（期望：判红）────────────────
console.log('== 自证：坏样本必须判红 ==')
const noQuote = live.replace(/protectedPhases:\s*\[[^\]]*\]/, 'protectedPhases: [4, 6, 10]')
if (noQuote === live) { say(false, '坏样本 A 注入失败（锚点没匹配上）⇒ 本轮实验无效'); }
else checkText('坏样本 A（protectedPhases 去引号）', noQuote, false)

// 坏样本 B：denyTools 里塞非字符串
const badType = live.replace(/denyTools:\s*\[[^\]]*\]/, 'denyTools: [pwsh, 42]')
if (badType === live) { say(false, '坏样本 B 注入失败 ⇒ 本轮实验无效'); }
else checkText('坏样本 B（denyTools 含 number）', badType, false)

console.log(fails.length === 0 ? '\nALL-PASS（0 失败）' : `\nFAILED（${fails.length} 失败）`)
process.exitCode = fails.length > 0 ? 1 : 0
