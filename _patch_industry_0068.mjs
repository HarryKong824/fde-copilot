import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const PATH = 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/profiles/web/cordis.patch.yml'
const TO = process.argv[2]  // 'medical-aesthetics' 或 '未声明'

let src = readFileSync(PATH, 'utf8')
const OLD_VAL = TO === 'medical-aesthetics' ? "industry: '未声明'" : "industry: 'medical-aesthetics'"
const NEW_VAL = TO === 'medical-aesthetics' ? "industry: 'medical-aesthetics'" : "industry: '未声明'"

if (!src.includes(OLD_VAL)) {
  console.error('FAIL: 旧值未找到，当前可能已是目标值。读 line 120 看实际内容。')
  console.error('期望旧值: ' + OLD_VAL)
  process.exit(1)
}

src = src.replace(OLD_VAL, NEW_VAL)
writeFileSync(PATH, src, 'utf8')

const buf = readFileSync(PATH)
const sha = createHash('sha256').update(buf).digest('hex')
const lines = src.split('\n')
console.log('OK cordis.patch.yml industry => ' + TO)
console.log('  line120: ' + lines[119].trim())
console.log('  bytes=' + buf.length + ' sha16=' + sha.slice(0, 16))