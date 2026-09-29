import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const d = mkdtempSync(join(tmpdir(), 'fde-probe-'))
console.log('made temp dir', d)
