import { complianceFingerprintSync, runD5Check, verifyComplianceText } from '../dsh-fde-phase/lib/check-d5.js'
import { readFileSync } from 'node:fs'

const path = 'E:/ontologyRoot/compliance.yaml'

const fp = complianceFingerprintSync(path)
console.log('fingerprint:', JSON.stringify(fp))

const text = readFileSync(path, 'utf8')
const v = verifyComplianceText(text)
console.log('verify.passed:', v.passed, 'failures:', v.failures.length)

const r = await runD5Check(path)
console.log('runD5Check.passed:', r.passed, 'keyCount:', r.keyCount, 'nonemptyCount:', r.nonemptyCount)
