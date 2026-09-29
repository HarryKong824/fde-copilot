import { writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const YAML = [
  'schema_version: 1',
  'output_boundary:',
  '  statement: "本工具输出不作为唯一诊断依据，须由执业人员复核后方可用于临床决策"',
  'review_chain:',
  '  reviewer: "Dr. Zhang"',
  '  reviewed_at: "2026-09-28"',
  '  conclusion: "approved"',
  '  original_snapshot_ref: "snap-001"',
  'data_policy:',
  '  masking_rule: "MRI 脱敏"',
  '  authorization_basis: "患者知情同意"',
  '  retention_period: "30d"',
  '  minimal_scope: "min"',
  'change_assessment:',
  '  classified: true',
  '  level: "L2"',
  '  assessed_at: "2026-09-28"',
  ''
].join('\n')

const PATH = 'E:/ontologyRoot/compliance.yaml'
writeFileSync(PATH, YAML, 'utf8')

const buf = readFileSync(PATH)
const sha = createHash('sha256').update(buf).digest('hex')
console.log('compliance.yaml restored:')
console.log('  bytes=' + buf.length + '  (expected ~608)')
console.log('  sha16=' + sha.slice(0, 16))

const files = [
  ['check-d5.js', 'dsh-fde-phase/lib/check-d5.js'],
  ['guard.js', 'dsh-fde-phase/lib/guard.js'],
  ['tools.js', 'dsh-fde-phase/lib/tools.js'],
  ['config.js', 'dsh-fde-phase/lib/config.js'],
  ['README.md', 'dsh-fde-phase/README.md'],
  ['_fde_d5_test.mjs', '_fde_d5_test.mjs'],
  ['_fde_d2d3_test.mjs', '_fde_d2d3_test.mjs'],
  ['compliance.yaml', 'E:/ontologyRoot/compliance.yaml']
]

console.log('\n=== SHA table (0067 final) ===')
for (const [name, p] of files) {
  try {
    const b = readFileSync(p)
    const s = createHash('sha256').update(b).digest('hex')
    console.log(name + ' | ' + b.length + ' bytes | sha16=' + s.slice(0, 16))
  } catch (e) {
    console.log(name + ' | READ FAILED: ' + e.code)
  }
}