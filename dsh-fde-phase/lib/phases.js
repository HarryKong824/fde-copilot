/**
 * 15 个 Phase 的权威表 + 门禁映射 + 推进规则。
 *
 * ⚠️ 这 15 个 Phase **从 spec v3 第二节原样搬**，不是自己编的（施工单 §5.2 硬约束）。
 * 来源：fde-copilot-design-spec-v3.html §2「Phase 结构」。
 * 任何"觉得该加/该改"的冲动都必须回到 spec 去改，不要在这里自作主张。
 */

/** Zone A/B/C/D 共 15 个阶段。id 即 spec 里的阶段标识。 */
export const PHASES = [
  // Zone A —— 连接与对齐（门禁全 ask）
  { id: '0.1', name: 'Connect', gate: 'ask' },
  { id: '0.2', name: 'Site Survey', gate: 'ask' },
  { id: '0.3', name: 'Stakeholder Map', gate: 'ask' },
  { id: '0.4', name: 'Success Criteria', gate: 'ask' },
  // Zone B —— Ontology 生命周期
  { id: '1', name: 'Bootcamp + 场景发现', gate: 'ask' },
  { id: '2', name: 'Demo 深化 + 数据接入', gate: 'D5-pre ask' },
  { id: '3', name: 'Ontology 完整定义', gate: 'D1 deny' },
  { id: '4', name: 'AIP 叠加', gate: 'D2 D3 deny' },
  // Zone C —— 交付与运营
  { id: '5', name: '交付与移交准备', gate: 'ask' },
  { id: '6', name: 'Deploy', gate: 'D5 deny' },
  { id: '7', name: 'Change Management', gate: 'ask' },
  { id: '8', name: 'Eval Flywheel', gate: 'ask' },
  { id: '9', name: 'Productize', gate: 'ask' },
  // Zone D —— 收尾
  { id: '10', name: 'Handoff', gate: 'D4 ask' },
  { id: '11', name: 'Disengage', gate: 'ask' }
]

/** 15 个 id，供 `fde_phase_advance` 的 `to` 参数 enum 使用。 */
export const PHASE_IDS = PHASES.map((p) => p.id)

/**
 * 门禁映射（spec 9.2 语义：在当前 Phase 里推进时，跑当前 Phase 的 deny 检查）。
 *
 * - Phase 3 ⇒ D1（`fde-run-guardrails-check`）
 * - Phase 4 ⇒ D2（`fde-run-audit-check`）+ D3（`fde-run-validation`）—— Stage 5.5 接线完成
 * - Phase 6 ⇒ D5（`fde-run-compliance-check`）—— Stage 5.6 接线完成
 * - Phase 10 ⇒ D4：v3 已把 D4 从 deny 降为 **ask**，不再进 deny 映射，改在
 *   `fde_phase_advance` 的 execute 层走 `approval.request`（施工单 0089）。
 */
export const DENY_CHECKS = {
  '3': ['D1'],
  '4': ['D2', 'D3'],
  '6': ['D5'] // Stage 5.6 已实现（compliance.yaml 存在性 + 非空）
}

/**
 * 真正实现了检查逻辑的项。不在表内的 deny 项一律"明确不拦 + 写审计说明"。
 *
 * ⚠️ 往这里加一项之前，必须确认 `guard.js` 的 `runDenyChecks` 里有它的分支 ——
 * 没有分支时它会被判成"失败"并拒绝推进（fail-closed），**不会**被悄悄跳过。
 * 这条语义由 `_fde_d2d3_test.mjs` 的"未知 implemented check ⇒ fail-closed"用例钉住。
 */
export const IMPLEMENTED_CHECKS = { D1: true, D2: true, D3: true, D5: true }

export function getPhase(id) {
  return PHASES.find((p) => p.id === id)
}

/**
 * 推进规则：只允许 `current → next`（+1），不允许跳跃。
 *
 * 理由：跳过 Phase 3 就等于跳过 D1，那是门禁漏洞。越级请求 → 工具拒绝并给出
 * "下一个合法 Phase 是 X"。返回 undefined 表示已是最后一个阶段（无 next）。
 *
 * @param {string} id - 当前阶段 id
 * @returns {string | undefined}
 */
export function nextPhase(id) {
  const idx = PHASES.findIndex((p) => p.id === id)
  if (idx < 0 || idx + 1 >= PHASES.length) return undefined
  return PHASES[idx + 1].id
}
