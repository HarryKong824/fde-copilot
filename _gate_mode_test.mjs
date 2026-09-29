// 缺陷 ① 回归测试：evaluate() 必须区分「mode 无关的真拦」与「仅 enforce 会拦」。
// 运行前提：工作区根 node_modules/@deepseek-ai/dsh-tools 为测试桩（跑完删除）。
// 运行：node _gate_mode_test.mjs
import { evaluate } from './dsh-fde-ontology-gate/lib/guard.js'

const fail = (msg) => { console.error('❌ ' + msg); process.exit(1) }
const ok = (msg) => console.log('✅ ' + msg)

const cfg = {
  mode: 'shadow',
  denyRunCode: true,
  allowedWriteSources: ['user', 'model'],
  minConfidence: 70,
  ontologyRoot: 'E:\\ontologyRoot',
  workspaceRoot: 'C:\\workspace'
}

// 1. run_code：shadow（applySemanticRules=false）下也要 deny + modeIndependent=true
const r1 = evaluate({ name: 'run_code', arguments: { code: 'console.log(1+1)' } }, cfg, false)
if (r1.deny === undefined) fail('run_code 在 shadow 下应被拒（判定在 applySemanticRules 早退之前）')
if (r1.modeIndependent !== true) fail('run_code 拒绝应带 modeIndependent: true —— pre-execute 的标签修复依赖它')
ok('run_code：shadow 下 deny + modeIndependent=true（审计标签将记 deny）')

// 2. 语义/路径规则：shadow 下不拦 —— 这才是 shadow-deny 的正确对象
const r2 = evaluate({ name: 'write', arguments: { file_path: 'E:\\ontologyRoot\\x.txt' } }, cfg, false)
if (r2.deny !== undefined) fail('shadow 下语义/路径规则不应真拦')
if (r2.modeIndependent !== undefined) fail('mode 相关规则不应带 modeIndependent')
ok('路径规则：shadow 下不拦（记 shadow-deny 的正确对象）')

// 3. enforce（applySemanticRules=true）下路径规则 deny，但非 modeIndependent
const r3 = evaluate({ name: 'write', arguments: { file_path: 'E:\\ontologyRoot\\x.txt' } }, cfg, true)
if (r3.deny === undefined) fail('enforce 下路径命中应拒')
if (r3.modeIndependent !== undefined) fail('路径规则与 mode 相关，不应带 modeIndependent')
ok('路径规则：enforce 下 deny，无 modeIndependent（标签按 cfg.mode 记）')

// 4. denyRunCode=false 时 run_code 放行
const r4 = evaluate({ name: 'run_code', arguments: {} }, { ...cfg, denyRunCode: false }, true)
if (r4.deny !== undefined) fail('denyRunCode=false 时应放行')
ok('denyRunCode=false：run_code 放行')

// 故意反一次以验证退出码会变红（手册 §8 纪律）：**不能变红的套件不可证伪**，
// 会把 FAILED 记成 PASS。⚠️ 本套件此前**不响应** FDE_INVERT ——
// 2026-09-26 全矩阵 INVERT 轮实测它 exit=0（唯独它没变红），属既有缺口，本轮补上。
if (process.env.FDE_INVERT === '1') {
  fail('[INVERT] 故意失败以验证退出码敏感')
}

console.log('全部通过：缺陷 ① 判定面回归 4/4（标签面为 pre-execute.js 一行改动）')
