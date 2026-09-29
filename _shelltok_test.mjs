// shell 路径 token 提取回归（2026-09-23）
// 覆盖：引号串内嵌路径漏报的修复 + 不得引入假阳性。
//
// 跑法：`node _shelltok_test.mjs`（在工作区根）
// 依赖：`node_modules/@deepseek-ai/dsh-tools/` —— 本仓库自带的**测试桩**（只导出
//   RUN_CODE_NAME / defineTool），不是真 SDK。guard.js 的 import 靠它才能在
//   无 DSH 环境下加载。桩在工作区根、**不在插件目录内**，故不影响
//   源 ↔ 安装副本的 MATCH 不变量。真 SDK 在 E:\DSH-desktop\...\data\node_modules\。
import { evaluate } from './dsh-fde-ontology-gate/lib/guard.js'

const cfg = {
  ontologyRoot: 'E:\\ontologyRoot',
  workspaceRoot: 'E:\\DSH-workspace',
  allowedWriteSources: ['user', 'model'],
  minConfidence: 70,
  denyRunCode: true
}

/** @type {{name:string, cmd:string, want:'deny'|'allow', why:string}[]} */
const CASES = [
  // —— 应当拒绝（命中 ontology）——
  { name: '裸 token · 正斜杠', cmd: 'Get-Content E:/ontologyRoot/poc-t2.md', want: 'deny', why: '基线，修前就拦得住' },
  { name: '裸 token · 反斜杠', cmd: 'type E:\\ontologyRoot\\poc-t2.md', want: 'deny', why: '基线' },
  { name: '裸根目录', cmd: 'Get-ChildItem E:/ontologyRoot', want: 'deny', why: '列目录会泄露文件名' },
  { name: '引号内只有路径', cmd: `Get-Item -LiteralPath 'E:/ontologyRoot/poc-t3.md'`, want: 'deny', why: '基线' },
  { name: '🔴 路径嵌在长引号串', cmd: 'cmd /c "type E:\\ontologyRoot\\poc-t5.md"', want: 'deny', why: '本次修的 bug —— 修前漏且不落审计' },
  { name: '🔴 嵌套引号', cmd: `pwsh -Command "Get-Content 'E:/ontologyRoot/poc-t2.md'"`, want: 'deny', why: '本次修的 bug' },
  { name: '🔴 内嵌路径 · 混中文前缀（无空白）', cmd: `Write-Output "说明：E:/ontologyRoot/poc-t2.md"`, want: 'deny', why: '路径被粘在非路径前缀上，兜法 ② 覆盖' },
  { name: '🔴 路径粘在等号参数上', cmd: 'prog --file=E:\\ontologyRoot\\poc-t2.md', want: 'deny', why: '同上' },
  { name: '🔴 路径粘在括号/通配符里', cmd: 'cmd /c for %f in (E:\\ontologyRoot\\*) do @type %f', want: 'deny', why: '同上；通配符后缀不影响判定' },
  { name: '🔴 相对路径越出工作区', cmd: 'cmd /c "type ..\\ontologyRoot\\poc-t2.md"', want: 'deny', why: '兜法 ①；多基准解析，任一命中即拒' },
  { name: '⚖️ 纯回显路径（已接受的假阳性）', cmd: `Write-Output '路径是 E:/ontologyRoot'`, want: 'deny', why: '代价：不访问文件也被拒；fail-closed 可接受，必须写进交付说明' },

  // —— 应当放行（不得误伤）——
  { name: '无路径命令', cmd: 'echo hello', want: 'allow', why: '零干扰' },
  { name: '工作区文件 · 裸 token', cmd: 'Get-Content E:/DSH-workspace/notes.md', want: 'allow', why: '工作区不受管辖' },
  { name: '⚠️ 工作区里名字含 ontology 的文件', cmd: 'Get-Content E:/DSH-workspace/ontology-notes.md', want: 'allow', why: '判定必须是路径归一，不是字符串包含' },
  { name: '刚提到的名字含 ontology 的文件（引号形式）', cmd: `Get-Content "E:/DSH-workspace/ontology-notes.md"`, want: 'allow', why: '同上，且走引号分支' },
  { name: '只是文字里出现 ontology 一词', cmd: `Write-Output 'ontology 目录受门禁保护'`, want: 'allow', why: '无路径 → 不应命中' },
  { name: '常见构建命令', cmd: 'npm run build --silent', want: 'allow', why: '零干扰' },
  { name: '相对路径指向工作区内', cmd: 'cat ./docs/readme.md', want: 'allow', why: '相对路径按多个基准解析，均落在区内' }
]

let pass = 0
const fails = []
for (const c of CASES) {
  const r = evaluate({ name: 'pwsh', arguments: { command: c.cmd } }, cfg, true)
  const got = r.deny ? 'deny' : 'allow'
  const ok = got === c.want
  if (ok) pass++
  else fails.push(c)
  console.log(`${ok ? '✅' : '❌'} [${got.padEnd(5)}/${c.want.padEnd(5)}] ${c.name}`)
  if (ok && got === 'deny') console.log(`        ↳ ${r.deny}`)
  if (!ok) console.log(`        ↳ cmd: ${c.cmd}\n        ↳ 期望 ${c.want}，实际 ${got}${r.deny ? ' | ' + r.deny : ''}`)
}

// 故意反一次以验证退出码会变红（手册 §8 纪律：所有回归一视同仁，无"只管新增"豁免）。
// 本钩子属第二批补上（此前本套件不响应 FDE_INVERT）。
if (process.env.FDE_INVERT === '1') {
  fails.push({ name: '[INVERT] 故意失败以验证退出码敏感', why: 'injected by FDE_INVERT' })
}

console.log(`\n${pass}/${CASES.length} 通过`)
if (fails.length) {
  console.log('失败用例：')
  for (const f of fails) console.log(`  - ${f.name}（${f.why}）`)
  process.exitCode = 1
}
