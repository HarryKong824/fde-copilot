/**
 * _fde_memory_a3_test.mjs —— dsh-fde-memory A3 离线回归
 *
 * 覆盖（0082 §3.3 + §5 验证表 + 0084 §3.2 patch）：
 *   1. assertPhaseId：15 合法 phase id 全过 + 6 非法逐个抛（双向判据）
 *   2. readDecision：phase 为 number / 内容不符 / seq 不符 ⇒ 各自抛
 *   3. listDecisions：坏文件进 bad 而非消失（签名 {items, bad}）
 *   4. confidence：psr='3' / psr=1.5 ⇒ 抛；psr=null ⇒ 走默认 0（不抛）
 *   5. maturity：locked→draft 无 reason ⇒ 抛；有 reason ⇒ OK + history 留痕
 *   6. change_log：追加 7 条 ⇒ readRecentChanges(5) 返回最后 5 条顺序正确（倒序）
 *      0084 §3.2 patch：readRecentChanges 改签名 {items, bad}；坏行进 bad 而非消失
 *   7. checklist 基础：read/write + 整文件重写（同一 phase 写两次不重号）
 *   8. stakeholders 基础：read/write（insert + update） + summarize 4 字段
 *   9. maturity historyOf + forward transition（draft→verified→locked）
 *  10. assertPhaseId 在 4 个入口（writeDecision/readDecision/nextSeq/listDecisions）均被调用
 *  11. 0084 §3.4：maturity 读回非法 status ⇒ 抛（fail-closed）
 *
 * 退出码 0 = 全绿；非 0 = 有失败。
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MEM_ROOT = ROOT + '/dsh-fde-memory'

const decisionsUrl = pathToFileURL(MEM_ROOT + '/lib/decisions.js').href
const confidenceUrl = pathToFileURL(MEM_ROOT + '/lib/confidence.js').href
const checklistUrl = pathToFileURL(MEM_ROOT + '/lib/checklist.js').href
const stakeholdersUrl = pathToFileURL(MEM_ROOT + '/lib/stakeholders.js').href
const maturityUrl = pathToFileURL(MEM_ROOT + '/lib/maturity.js').href
const changeLogUrl = pathToFileURL(MEM_ROOT + '/lib/change-log.js').href

const decisionsMod = await import(decisionsUrl)
const { writeDecision, readDecision, listDecisions, nextSeq, assertPhaseId } = decisionsMod
const { deriveConfidence } = await import(confidenceUrl)
const { readChecklist, writeChecklist } = await import(checklistUrl)
const { readStakeholders, writeStakeholder, summarize } = await import(stakeholdersUrl)
const { readMaturity, setMaturity, historyOf } = await import(maturityUrl)
const { appendChange, readRecentChanges } = await import(changeLogUrl)

const PASS = []
const FAIL = []

function ok(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = expected === undefined ? undefined : JSON.stringify(expected)
  if (e === undefined || a === e) {
    PASS.push(name)
    console.log('  OK ' + name + (expected !== undefined ? ' => ' + a : ''))
  } else {
    FAIL.push({ name: name, actual: a, expected: e })
    console.log('  FAIL ' + name + ' => ' + a + ' (期望 ' + e + ')')
  }
}

function okThrows(name, fn, msgContains) {
  try {
    fn()
    FAIL.push({ name: name, actual: 'no throw', expected: 'throw' })
    console.log('  FAIL ' + name + ' => 没 throw (期望 throw)')
  } catch (e) {
    const msg = String(e && e.message ? e.message : e)
    if (msgContains && !msg.includes(msgContains)) {
      FAIL.push({ name: name, actual: msg, expected: '包含 "' + msgContains + '"' })
      console.log('  FAIL ' + name + ' => throw 但消息不对: ' + msg)
    } else {
      PASS.push(name)
      console.log('  OK ' + name + ' => throw: ' + msg.slice(0, 80))
    }
  }
}

const INVERT = process.env.FDE_INVERT === '1'

// ===== 1. assertPhaseId：15 合法 + 6 非法 =====
console.log('\n[assertPhaseId §2.3 双向判据]')

const VALID_PHASES = ['0.1', '0.2', '0.3', '0.4', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']
for (const p of VALID_PHASES) {
  try {
    assertPhaseId(p)
    PASS.push('§2.3 合法 phase: ' + p)
    console.log('  OK §2.3 合法 phase: ' + p)
  } catch (e) {
    FAIL.push({ name: '§2.3 合法 phase: ' + p, actual: 'throw', expected: 'pass' })
    console.log('  FAIL §2.3 合法 phase: ' + p + ' => 不该抛')
  }
}

const INVALID_PHASES = ['../x', '/abs', 'a/b', '0.1/../..', '', null, undefined, 123, 'abc', '0.1.2']
for (const p of INVALID_PHASES) {
  okThrows('§2.3 非法 phase: ' + JSON.stringify(p), () => assertPhaseId(p), 'phase 只能是')
}

// ===== 2. readDecision：3 种坏样本（phase 为 number / 内容不符 / seq 不符）=====
console.log('\n[readDecision §2.2 双向断言]')

{
  const tmpBase = mkdtempSync(join(tmpdir(), 'fde-A3-read-'))
  const dir = join(tmpBase, 'memory', 'decisions')
  mkdirSync(dir, { recursive: true })

  // 坏 1：phase 为 number（手写文件未加引号，YAML 把 0.1 解析成 number）
  writeFileSync(join(dir, '3-1.yaml'), 'phase: 0.1\nseq: 1\ndecision: "bad"\nsource: fde_confirmed\n', 'utf8')
  okThrows('§2.2 readDecision(3,1) phase 为 number => throw', () => readDecision(tmpBase, '3', 1), 'phase 必须是字符串')

  // 坏 2：内容 phase 与文件名不符
  writeFileSync(join(dir, '4-1.yaml'), 'phase: "5"\nseq: 1\ndecision: "bad"\nsource: fde_confirmed\n', 'utf8')
  okThrows('§2.2 readDecision(4,1) phase 与文件名不符 => throw', () => readDecision(tmpBase, '4', 1), '与文件名不符')

  // 坏 3：seq 不符
  writeFileSync(join(dir, '5-1.yaml'), 'phase: "5"\nseq: 99\ndecision: "bad"\nsource: fde_confirmed\n', 'utf8')
  okThrows('§2.2 readDecision(5,1) seq 不符 => throw', () => readDecision(tmpBase, '5', 1), '与文件名不符')

  // 好样本：phase 加引号 + seq 匹配
  writeFileSync(join(dir, '6-1.yaml'), 'phase: "6"\nseq: 1\ndecision: "good"\nsource: fde_confirmed\n', 'utf8')
  const good = readDecision(tmpBase, '6', 1)
  ok('§2.2 readDecision(6,1) 好样本 phase="6" (string)', good.phase, '6')
  ok('§2.2 readDecision(6,1) 好样本 seq=1', good.seq, 1)

  // seq 非整数 ⇒ 抛（防御性）
  okThrows('§2.2 readDecision(6, 1.5) seq 非整数 => throw', () => readDecision(tmpBase, '6', 1.5), 'seq 必须是整数')

  rmSync(tmpBase, { recursive: true, force: true })
}

// ===== 3. listDecisions：坏文件进 bad =====
console.log('\n[listDecisions §2.2 坏文件不消失]')

{
  const tmpBase = mkdtempSync(join(tmpdir(), 'fde-A3-list-'))
  const dir = join(tmpBase, 'memory', 'decisions')
  mkdirSync(dir, { recursive: true })

  // 3 个好文件 + 2 个坏文件（混在一起）
  writeFileSync(join(dir, '7-1.yaml'), 'phase: "7"\nseq: 1\ndecision: "good1"\nsource: fde_confirmed\n', 'utf8')
  writeFileSync(join(dir, '7-2.yaml'), 'phase: 0.1\nseq: 2\ndecision: "bad"\nsource: fde_confirmed\n', 'utf8')
  writeFileSync(join(dir, '7-3.yaml'), 'phase: "7"\nseq: 3\ndecision: "good3"\nsource: fde_confirmed\n', 'utf8')
  writeFileSync(join(dir, '7-4.yaml'), 'phase: "999"\nseq: 4\ndecision: "bad2"\nsource: fde_confirmed\n', 'utf8')

  const result = listDecisions(tmpBase, '7')
  ok('§2.2 listDecisions items 数量=2（坏的不进 items）', result.items.length, 2)
  ok('§2.2 listDecisions bad 数量=2（坏的不消失）', result.bad.length, 2)
  ok('§2.2 listDecisions items 升序', JSON.stringify(result.items.map((x) => x._seq)), JSON.stringify([1, 3]))
  ok('§2.2 listDecisions bad[0].file 含文件名', result.bad[0].file.includes('7-'), true)
  ok('§2.2 listDecisions bad[0].error 含错误描述', typeof result.bad[0].error, 'string')

  // 空目录
  const empty = listDecisions(tmpBase, '999')
  ok('§2.2 listDecisions 空目录 items=[]', empty.items.length, 0)
  ok('§2.2 listDecisions 空目录 bad=[]', empty.bad.length, 0)

  rmSync(tmpBase, { recursive: true, force: true })
}

// ===== 4. confidence：psr 三种 =====
console.log('\n[confidence §2.1 psr 校验]')

okThrows('§2.1 psr="3" (字符串) => throw', () =>
  deriveConfidence({ source: 'client_stated', fde_confirmed: true, data_verified: true, phases_since_review: '3', last_reviewed: '2026-09-28T00:00:00.000Z', derived_from_confidence: null }), 'phases_since_review 必须是整数')

okThrows('§2.1 psr=1.5 (浮点) => throw', () =>
  deriveConfidence({ source: 'client_stated', fde_confirmed: true, data_verified: true, phases_since_review: 1.5, last_reviewed: '2026-09-28T00:00:00.000Z', derived_from_confidence: null }), 'phases_since_review 必须是整数')

// null 走默认 0（不抛）
ok('§2.1 psr=null => 走默认 0 不抛，结果 high', deriveConfidence({
  source: 'client_stated', fde_confirmed: true, data_verified: true, phases_since_review: null, last_reviewed: '2026-09-28T00:00:00.000Z', derived_from_confidence: null
}), 'high')

// undefined 走默认 0（不抛）
ok('§2.1 psr=undefined => 走默认 0 不抛，结果 high', deriveConfidence({
  source: 'client_stated', fde_confirmed: true, data_verified: true, last_reviewed: '2026-09-28T00:00:00.000Z', derived_from_confidence: null
}), 'high')

// 回归：原 fail-open 反例现在 fail-closed（§2.1 实测反例）
okThrows('§2.1 回归反例 psr="3" + last_reviewed=null => throw（不再静默当 0）', () =>
  deriveConfidence({ source: 'client_stated', fde_confirmed: true, data_verified: true, phases_since_review: '3', last_reviewed: null, derived_from_confidence: null }), 'phases_since_review 必须是整数')

// ===== 5. maturity：locked→draft 单向规则 =====
console.log('\n[maturity §3.2 单向规则]')

{
  const tmpBase = mkdtempSync(join(tmpdir(), 'fde-A3-mat-'))

  // 前进路径：draft → verified → locked
  const r1 = setMaturity(tmpBase, 'node-A', 'draft', { by: 'alice', reason: '新建' })
  ok('§3.2 maturity draft 新建 from=null', r1.from, null)
  ok('§3.2 maturity draft 新建 to=draft', r1.to, 'draft')

  const r2 = setMaturity(tmpBase, 'node-A', 'verified', { by: 'bob', reason: '已核验' })
  ok('§3.2 maturity verified from=draft', r2.from, 'draft')
  ok('§3.2 maturity verified to=verified', r2.to, 'verified')

  const r3 = setMaturity(tmpBase, 'node-A', 'locked', { by: 'carol', reason: '已锁定' })
  ok('§3.2 maturity locked from=verified', r3.from, 'verified')
  ok('§3.2 maturity locked to=locked', r3.to, 'locked')

  // locked → draft 无 reason ⇒ 抛
  okThrows('§3.2 maturity locked→draft 无 reason => throw', () =>
    setMaturity(tmpBase, 'node-A', 'draft'), '从 locked 回退到 draft 必须显式 reason')

  // locked → draft 有 reason ⇒ OK
  const r4 = setMaturity(tmpBase, 'node-A', 'draft', { by: 'dave', reason: '重新评估' })
  ok('§3.2 maturity locked→draft 有 reason from=locked', r4.from, 'locked')
  ok('§3.2 maturity locked→draft 有 reason to=draft', r4.to, 'draft')

  // history 留痕：4 条
  const hist = historyOf(tmpBase, 'node-A')
  ok('§3.2 maturity history 长度=4', hist.length, 4)
  ok('§3.2 maturity history[0].from=null', hist[0].from, null)
  ok('§3.2 maturity history[0].to=draft', hist[0].to, 'draft')
  ok('§3.2 maturity history[3].from=locked', hist[3].from, 'locked')
  ok('§3.2 maturity history[3].to=draft', hist[3].to, 'draft')
  ok('§3.2 maturity history[3].reason=重新评估', hist[3].reason, '重新评估')

  // 同 rank no-op
  const r5 = setMaturity(tmpBase, 'node-A', 'draft', { by: 'eve', reason: '重复' })
  ok('§3.2 maturity 同 rank no-op changeLine=0', r5.changeLine, 0)

  // readMaturity 不存在 ⇒ null
  ok('§3.2 readMaturity 不存在 => null', readMaturity(tmpBase, 'no-such-node'), null)

  // status 非法 ⇒ 抛
  okThrows('§3.2 setMaturity 非法 status => throw', () =>
    setMaturity(tmpBase, 'node-B', 'invalid'), 'status 必须是 draft|verified|locked')

  // nodeId 非字符串 ⇒ 抛
  okThrows('§3.2 setMaturity nodeId 空串 => throw', () =>
    setMaturity(tmpBase, '', 'draft'), 'nodeId 必须是非空字符串')

  // 0084 §3.4：读回的非法 status ⇒ 抛（fail-closed）
  // 手改 maturity.yaml，把当前 status 改成非法值 3（当前可能是 draft/verified/locked 之一）
  // 注意：serializeYaml 把 records 数组元素序列化成行内 JSON（"status":"draft"），不是 status: draft
  const matPath = join(tmpBase, 'memory', 'ontology', 'maturity.yaml')
  const matText = readFileSync(matPath, 'utf8')
  // 替换第一个 "status":"<word>" 为 "status":3（number，非合法 status）
  const tampered = matText.replace(/"status":"[a-z]+"/, '"status":3')
  writeFileSync(matPath, tampered, 'utf8')
  okThrows('§3.4 readMaturity 读回非法 status=3 => throw', () =>
    readMaturity(tmpBase, 'node-A'), '非法')
  okThrows('§3.4 setMaturity 读回非法 status=3 => throw', () =>
    setMaturity(tmpBase, 'node-A', 'verified', { reason: '测' }), '非法')

  rmSync(tmpBase, { recursive: true, force: true })
}

// ===== 6. change_log：追加 7 条 ⇒ readRecentChanges(5) 返回最后 5 条倒序 =====
// 0084 §3.2 patch：readRecentChanges 改签名 {items, bad}；坏行进 bad 而非消失
console.log('\n[change_log §3.3 readRecentChanges 顺序 + §3.2 坏行进 bad]')

{
  const tmpBase = mkdtempSync(join(tmpdir(), 'fde-A3-cl-'))

  // 追加 7 条（带显式 at 以保证顺序可断言）
  const base = new Date('2026-09-28T00:00:00.000Z').getTime()
  for (let i = 0; i < 7; i += 1) {
    const at = new Date(base + i * 1000).toISOString()
    appendChange(tmpBase, { at, kind: 'decision', target: 'p-' + i, summary: '决策 ' + i })
  }

  // 读最近 5 条：应为 [p-6, p-5, p-4, p-3, p-2]（倒序，最新在前）
  const recent = readRecentChanges(tmpBase, 5)
  ok('§3.3 readRecentChanges(5) items 数量=5', recent.items.length, 5)
  ok('§3.3 readRecentChanges(5) bad 数量=0', recent.bad.length, 0)
  ok('§3.3 readRecentChanges(5)[0].target=p-6（最新）', recent.items[0].target, 'p-6')
  ok('§3.3 readRecentChanges(5)[4].target=p-2（最旧）', recent.items[4].target, 'p-2')
  ok('§3.3 readRecentChanges 倒序 targets', JSON.stringify(recent.items.map((r) => r.target)), JSON.stringify(['p-6', 'p-5', 'p-4', 'p-3', 'p-2']))

  // 0084 §3.2 新断言：造一行坏 JSON ⇒ 它出现在 bad 里（不是消失）
  appendChange(tmpBase, { kind: 'decision', target: 'p-7', summary: '决策 7' })
  // 手写一条坏 JSON 行到 change_log.jsonl
  const clPath = join(tmpBase, 'memory', 'change_log.jsonl')
  appendFileSync(clPath, '{ this is not valid json\n', 'utf8')
  const withBad = readRecentChanges(tmpBase, 100)
  ok('§3.2 readRecentChanges 坏行进 bad 数量=1', withBad.bad.length, 1)
  ok('§3.2 readRecentChanges bad[0].line 是数字', typeof withBad.bad[0].line, 'number')
  ok('§3.2 readRecentChanges bad[0].error 是字符串', typeof withBad.bad[0].error, 'string')
  // 好的 8 条都进 items（坏的不进 items）
  ok('§3.2 readRecentChanges 坏行不进 items 数量=8', withBad.items.length, 8)
  ok('§3.2 readRecentChanges items[0].target=p-7（最新）', withBad.items[0].target, 'p-7')

  // 边界：limit=0
  ok('§3.3 readRecentChanges(0) items=[]', readRecentChanges(tmpBase, 0).items.length, 0)

  // 边界：limit 大于总条数
  const all = readRecentChanges(tmpBase, 100)
  ok('§3.3 readRecentChanges(100) items 数量=8（不会多）', all.items.length, 8)

  // 非法 kind ⇒ 抛
  okThrows('§3.3 appendChange 非法 kind => throw', () =>
    appendChange(tmpBase, { kind: 'invalid', target: 'x', summary: 's' }), 'kind 必须是')

  // 空 target ⇒ 抛
  okThrows('§3.3 appendChange 空 target => throw', () =>
    appendChange(tmpBase, { kind: 'decision', target: '', summary: 's' }), 'target 必须是非空字符串')

  // 非整数 limit ⇒ 抛
  okThrows('§3.3 readRecentChanges 非整数 limit => throw', () =>
    readRecentChanges(tmpBase, 1.5), 'limit 必须是非负整数')

  rmSync(tmpBase, { recursive: true, force: true })
}

// ===== 7. checklist 基础 + assertPhaseId =====
console.log('\n[checklist §3.2 基础]')

{
  const tmpBase = mkdtempSync(join(tmpdir(), 'fde-A3-cl-'))

  // assertPhaseId 在 writeChecklist 也被调用
  okThrows('§2.3 writeChecklist 非法 phase => throw', () =>
    writeChecklist(tmpBase, '../x', [{ id: '1', text: 'x', done: false }]), 'phase 只能是')

  const r = writeChecklist(tmpBase, '3', [
    { id: 'c1', text: '完成 X 设计', done: false },
    { id: 'c2', text: '核验数据', done: true, evidence: 'docs/x.md' }
  ])
  ok('§3.2 writeChecklist 文件名 3.yaml', r.file, '3.yaml')
  ok('§3.2 writeChecklist changeLine > 0', r.changeLine > 0, true)

  // 读回
  const cl = readChecklist(tmpBase, '3')
  ok('§3.2 readChecklist phase="3"', cl.phase, '3')
  ok('§3.2 readChecklist items 数量=2', cl.items.length, 2)
  ok('§3.2 readChecklist items[0].id=c1', cl.items[0].id, 'c1')
  ok('§3.2 readChecklist items[1].done=true', cl.items[1].done, true)
  ok('§3.2 readChecklist items[1].evidence', cl.items[1].evidence, 'docs/x.md')

  // 整文件重写：再写一次同 phase，旧内容被覆盖
  writeChecklist(tmpBase, '3', [{ id: 'c3', text: '新任务', done: false }])
  const cl2 = readChecklist(tmpBase, '3')
  ok('§3.2 writeChecklist 重写后 items 数量=1', cl2.items.length, 1)
  ok('§3.2 writeChecklist 重写后 items[0].id=c3', cl2.items[0].id, 'c3')

  // 不存在 ⇒ null（不抛）
  ok('§3.2 readChecklist 不存在 => null', readChecklist(tmpBase, '999'), null)

  // item 字段校验
  okThrows('§3.2 writeChecklist item.id 空 => throw', () =>
    writeChecklist(tmpBase, '3', [{ id: '', text: 'x', done: false }]), 'item.id 必须是非空字符串')

  okThrows('§3.2 writeChecklist item.done 非布尔 => throw', () =>
    writeChecklist(tmpBase, '3', [{ id: 'x', text: 'x', done: 'yes' }]), 'item.done 必须是布尔')

  rmSync(tmpBase, { recursive: true, force: true })
}

// ===== 8. stakeholders 基础 + summarize =====
console.log('\n[stakeholders §3.2 基础 + §3.0 5.2a summarize]')

{
  const tmpBase = mkdtempSync(join(tmpdir(), 'fde-A3-sh-'))

  // 空 ⇒ []
  ok('§3.2 readStakeholders 空 => []', readStakeholders(tmpBase).length, 0)

  // insert
  const r1 = writeStakeholder(tmpBase, {
    id: 's1', name: '张三', role: 'PM', org: 'OrgA', influence: 'high', contact: 'zhang@example.com', notes: '关键决策者'
  })
  ok('§3.2 writeStakeholder insert mode=insert', r1.mode, 'insert')

  // update（同 id）
  const r2 = writeStakeholder(tmpBase, {
    id: 's1', name: '张三 (更新)', role: 'PM', org: 'OrgA', influence: 'medium'
  })
  ok('§3.2 writeStakeholder update mode=update', r2.mode, 'update')

  // 加另一个
  writeStakeholder(tmpBase, {
    id: 's2', name: '李四', role: 'Eng', org: 'OrgB', influence: 'low'
  })

  // 读回
  const all = readStakeholders(tmpBase)
  ok('§3.2 readStakeholders 数量=2', all.length, 2)
  ok('§3.2 readStakeholders s1.name=张三 (更新)', all[0].name, '张三 (更新)')
  ok('§3.2 readStakeholders s1.influence=medium（被更新）', all[0].influence, 'medium')

  // summarize 4 字段
  const summary = summarize(all)
  ok('§3.0 summarize 数量=2', summary.length, 2)
  ok('§3.0 summarize[0] keys=name/role/org/influence', JSON.stringify(Object.keys(summary[0]).sort()), JSON.stringify(['influence', 'name', 'org', 'role']))
  ok('§3.0 summarize 不含 contact', summary[0].contact, undefined)
  ok('§3.0 summarize 不含 notes', summary[0].notes, undefined)
  ok('§3.0 summarize[0].influence=medium', summary[0].influence, 'medium')

  // 非法 influence ⇒ 抛
  okThrows('§3.2 writeStakeholder 非法 influence => throw', () =>
    writeStakeholder(tmpBase, { id: 'x', name: 'x', role: 'x', org: 'x', influence: 'invalid' }), 'influence 必须是')

  // 空 id ⇒ 抛
  okThrows('§3.2 writeStakeholder 空 id => throw', () =>
    writeStakeholder(tmpBase, { id: '', name: 'x', role: 'x', org: 'x', influence: 'high' }), 'id 必须是非空字符串')

  rmSync(tmpBase, { recursive: true, force: true })
}

// ===== 9. assertPhaseId 在 4 个入口均被调用（writeDecision/readDecision/nextSeq/listDecisions）=====
console.log('\n[§2.3 assertPhaseId 在 4 个入口]')

{
  const tmpBase = mkdtempSync(join(tmpdir(), 'fde-A3-entry-'))

  okThrows('§2.3 writeDecision 非法 phase => throw', () =>
    writeDecision(tmpBase, { phase: '../x', decision: 'd', source: 'fde_confirmed' }), 'phase 只能是')

  okThrows('§2.3 readDecision 非法 phase => throw', () =>
    readDecision(tmpBase, '../x', 1), 'phase 只能是')

  okThrows('§2.3 nextSeq 非法 phase => throw', () =>
    nextSeq(tmpBase, '../x'), 'phase 只能是')

  okThrows('§2.3 listDecisions 非法 phase => throw', () =>
    listDecisions(tmpBase, '../x'), 'phase 只能是')

  // 0082 §2.3 实测反例：路径穿越
  // 现在被 assertPhaseId 挡住，不会写出 memory/ 之外
  okThrows('§2.3 路径穿越反例 ../escaped 被 assertPhaseId 挡住', () =>
    writeDecision(tmpBase, { phase: '../../escaped', decision: 'x', source: 'fde_confirmed' }), 'phase 只能是')

  // 验证未写出 memory/ 外的文件
  const escapedPath = join(tmpBase, 'memory', 'decisions', '..', '..', '..', 'escaped-1.yaml')
  ok('§2.3 路径穿越被挡，无文件外漏', existsSync(escapedPath), false)

  rmSync(tmpBase, { recursive: true, force: true })
}

// ===== 10. change_log 由三个写入器自动追加（决策不算 —— decisions.js 不接 change_log）=====
console.log('\n[§3.2 三个写入器都追加 change_log]')

{
  const tmpBase = mkdtempSync(join(tmpdir(), 'fde-A3-cl-chain-'))

  // checklist 写完应自动 appendChange
  writeChecklist(tmpBase, '3', [{ id: 'c1', text: 'x', done: false }])
  // stakeholder 写完应自动 appendChange
  writeStakeholder(tmpBase, { id: 's1', name: '张三', role: 'PM', org: 'A', influence: 'high' })
  // maturity 写完应自动 appendChange
  setMaturity(tmpBase, 'node-X', 'draft', { by: 'test', reason: '新建' })

  // 现在 change_log 应有 3 条（按写入顺序：checklist, stakeholder, maturity）
  const recent = readRecentChanges(tmpBase, 10)
  ok('§3.2 三写入器自动 appendChange 数量=3', recent.items.length, 3)
  ok('§3.2 第一条 kind=checklist', recent.items[2].kind, 'checklist') // 最旧 = 第一条 = checklist
  ok('§3.2 第二条 kind=stakeholder', recent.items[1].kind, 'stakeholder')
  ok('§3.2 第三条 kind=maturity', recent.items[0].kind, 'maturity')

  rmSync(tmpBase, { recursive: true, force: true })
}

// ===== 不动既有状态 =====
console.log('\n[不动既有状态]')
{
  if (existsSync(MEM_ROOT + '/SCHEMA_VERSION')) {
    const sv = readFileSync(MEM_ROOT + '/SCHEMA_VERSION', 'utf8')
    ok('§5.5 dsh-fde-memory/SCHEMA_VERSION 仍是 "1\\n"', sv, '1\n')
  }
}

// ===== INVERT 模式（exit code 敏感）=====
if (INVERT) {
  console.log('\n[INVERT 模式] 故意失败以验证 exit code 敏感')
  FAIL.push({ name: 'INVERT 故意失败', actual: '失败', expected: '通过' })
  console.log('  FAIL INVERT 故意失败 => 失败 (期望 通过)')
}

// ===== 总结 =====
console.log('\n=== 总结 ===')
console.log('PASS ' + PASS.length + ' / FAIL ' + FAIL.length)
if (FAIL.length > 0) {
  console.log('FAILED:')
  for (const f of FAIL) console.log('  - ' + f.name + ': actual=' + f.actual + ' expected=' + f.expected)
  process.exit(1)
}
console.log('RESULT: PASS')
process.exit(0)
