/**
 * 受控区夹具的 D1 探针 —— 确认 E:\ontologyRoot\{actions,guards}.yaml 能让 D1 通过。
 * 只有 D1 过了，活验判据⑥（D1 过 → 放行）才有得做。
 *
 * 输出走文件，不走控制台（Windows 代码页乱码规避，本项目既有纪律）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { checkD1 } from '../dsh-fde-dsl/lib/check-d1.js'

const AP = 'E:/ontologyRoot/actions.yaml'
const GP = 'E:/ontologyRoot/guards.yaml'

const actionsText = readFileSync(AP, 'utf8')
const guardsText = readFileSync(GP, 'utf8')

const { passed, failures } = checkD1(actionsText, guardsText)

const anchor = createHash('sha256').update(actionsText).digest('hex')

const lines = [
  `D1 passed: ${passed}`,
  `failures: ${failures.length}`,
  ...failures.map((f) => `  [${f.code}] ${f.where} :: ${f.message}`),
  `anchor(actions.yaml) = ${anchor}`,
  `sha256(guards.yaml)  = ${createHash('sha256').update(guardsText).digest('hex')}`,
  `RESULT: ${passed ? 'D1-PASS' : 'D1-FAIL'}`
]
writeFileSync('_d1_fixture_out.txt', lines.join('\n') + '\n', 'utf8')
process.exitCode = passed ? 0 : 1
