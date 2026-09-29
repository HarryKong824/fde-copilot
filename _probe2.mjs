import { normalizeConfig } from './dsh-fde-phase/lib/config.js'
import { PHASE_IDS, nextPhase, DENY_CHECKS, IMPLEMENTED_CHECKS } from './dsh-fde-phase/lib/phases.js'
import { AuditChain } from './dsh-fde-phase/lib/audit.js'
import { DEFAULT_STATE, serializeState, writeState, acquireLock } from './dsh-fde-phase/lib/state.js'
import { D1Mirror, sha256Text } from './dsh-fde-phase/lib/mirror.js'
import { evaluate } from './dsh-fde-phase/lib/guard.js'
console.log('imports ok', PHASE_IDS.length, nextPhase('0.1'), normalizeConfig({projectRoot:'p',ontologyRoot:'o'}).mode)
