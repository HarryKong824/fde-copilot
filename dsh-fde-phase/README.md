# dsh-fde-phase

FDE Copilot v3 的 **Phase 状态机**插件：管理"现在处在哪个业务阶段、能不能推进"，并在推进前跑门禁检查。

> 这是三个 FDE 插件里的第三个，独立于已活验稳定的 `dsh-fde-ontology-gate` 与 `dsh-fde-dsl`。
> 改它不影响那两个；出事能单独看出是哪个插件 `failed`。

---

## 0. ⚠️ 使用前提：新建会话第一步切 `standard` preset

**每个新会话都要做；不做，本插件等于不存在。**

- DSH 的**默认 preset 是 `ptc`**，且 gate 侧 `denyRunCode: true`。该组合下
  **模型一个工具都调不到** —— 不是只调不到 `fde_phase_advance`，是**所有工具**都调不到。
- 所以**建会话后的第一件事**：把 preset 切到 **`standard`**。
  - UI：会话 / 智能体的 preset 下拉选 `standard`；
  - 服务端 / 脚本建会话：显式传 **`agentPreset: 'standard'`**。
- 切完先确认：让模型自报工具清单，必须含 `fde_phase_advance`（与 dsl 的 `fde-run-guardrails-check`）。
  **报不出来 = preset 没切对**，先解决这个再谈门禁判据。
- 本插件全部活验（判据 ③–⑦）都是在 `agentPreset: 'standard'` 下跑通的；
  `ptc` 下**一次都没跑通过**，不是偶发、不是超时重试能绕过的。

> 这是要写死在交付文档里的开箱约定（2026-09-24 拍板）：
> **不改默认 preset 配置，也不放开 gate 的 `denyRunCode`** —— 只要求用的人先切到 `standard`。

---

## 1. 它管什么 / 不管什么

| 插件 | 管什么 |
|---|---|
| `dsh-fde-ontology-gate` | **谁**能在什么条件下改 ontology |
| `dsh-fde-dsl` | 改出来的**规则**能不能信（D3）+ **护栏**绑没绑好（D1） |
| **`dsh-fde-phase`（本插件）** | 现在处在**哪个业务阶段**、能不能推进；一次 ontology 变更**改完之后闭环没闭环**（C2，按 L0/L1/L2 分级核验，见 §4.1.6） |

**能力边界（必须对客户讲清）**：本插件是**进程内软约束**——防的是模型无意的失误与漂移，不是有意的恶意绕过。绕过可见、可审计、可统计、可纠正，但不是"绝对拦死"。

---

## 2. 架构

```
                ┌───────────────────────────────────────┐
  E:\ontologyRoot│ actions.yaml + guards.yaml（D1 复合哈希锚定的来源）      │
                └───────────────────┬───────────────────┘
                                    │ 读（算两文件复合 sha256 比对锚点）
  dsh-fde-dsl                      │        dsh-fde-phase（本插件）
  fde-run-guardrails-check (D1)────┼─ emit('fde/check-result') ──→ 收下 → 写哈希链审计 + 更新内存镜像
                                    │
  fde_phase_advance（推进唯一入口）
    ├─ guard（同步，钉入口，enforce 下真拦）
    ├─ state.yaml 状态机 + 单写者锁
    ├─ D1 结论内存镜像（verify 同步重算 sha256 比对）
    └─ 落盘成功后 ⇒ restrict 全量对账（对所有存活 agent 重算工具面，见 §6）

  fde_rollback（C3 回滚独立通道）
    ├─ 验证 rollback_preauth.authorized（不重审 D5 的 5 键）
    └─ 落 rollback_at ⇒ 24h 观察期冻结推进（见 §4.1.5）
```

**四道关（前三道都集中在 `fde_phase_advance` 这一个入口）**：
1. **guard（同步否决）**：只做 `current → next(+1)` 的跳跃判定 + D1 结论比对。enforce 下返回非空字符串即拒绝。
2. **工具 execute（纵深防御）**：重读状态独立复算一遍；enforce 下不过就 `throw new HarnessError`（工具调用失败 = `isError`）。
3. **审计监听器（`tools/pre-execute` async）**：把"会拦 / 本拦 / 放过了哪些未实现项"记进哈希链。
4. **restrict 工具面过滤（第二批，`lib/restrict.js`）**：受保护 Phase 内对每个 agent 隐藏名单里的工具。
   它**不是** `fde_phase_advance` 的一道关，而是阶段变更的**派生副作用**（详见 §6）。

---

## 3. 15 个 Phase（从 spec v2 第二节原样搬）

| Zone | id | 名称 | 门禁 |
|---|---|---|---|
| A | `0.1` | Connect | ask |
| A | `0.2` | Site Survey | ask |
| A | `0.3` | Stakeholder Map | ask |
| A | `0.4` | Success Criteria | ask |
| B | `1` | Bootcamp + 场景发现 | ask |
| B | `2` | Demo 深化 + 数据接入 | **D5-pre ask** |
| B | `3` | Ontology 完整定义 | **D1 deny** |
| B | `4` | AIP 叠加 | D2 D3 deny |
| C | `5` | 交付与移交准备 | ask |
| C | `6` | Deploy | D5 deny |
| C | `7` | Change Management | ask |
| C | `8` | Eval Flywheel | ask |
| C | `9` | Productize | ask |
| D | `10` | Handoff | D4 ask |
| D | `11` | Disengage | ask |

**推进规则**：只允许 `current → next`（+1），不允许跳跃。跳过 Phase 3 就等于跳过 D1，那是门禁漏洞。

**门禁映射**（在当前 Phase 里推进时，跑当前 Phase 的 deny 检查）：
```js
const DENY_CHECKS = {
  '3': ['D1'],        // fde-run-guardrails-check
  '4': ['D2', 'D3'],  // fde-run-audit-check / fde-run-validation（Stage 5.5）
  '6': ['D5']         // fde-run-compliance-check（Stage 5.6）
}
// Phase 10 的 D4 不在 DENY_CHECKS 里 —— v3 已把 D4 从 deny 降为 ask，
// 改在 fde_phase_advance 的 execute 层走 approval.request（0089）。
// Phase 2 的 D5-pre 同理不在 DENY_CHECKS 里 —— 它是「数据接入前」的前置提醒，
// 也在 fde_phase_advance 的 execute 层走 approval.request，确认后写 compliance.yaml（B3/§4.1.4）。
```

---

## 4. 🔴 诚实缺口清单（必读）

> 下面的每一项都是**有意的、已记录的**缺口，不是 bug、也不是"假装实现了"。

### 4.1 门禁实现状态（deny 项已全实现，D4 已降 ask）

| check | 阶段 | 状态 |
|---|---|---|
| D1 | Phase 3 | ✅ 已拦（`fde-run-guardrails-check`，锚 `actions+guards`） |
| D2 | Phase 4 | ✅ **Stage 5.5 已接线**（`fde-run-audit-check`，锚 `gate` 链的 `行数+链头`） |
| D3 | Phase 4 | ✅ **Stage 5.5 已接线**（`fde-run-validation`，锚 `objects+logic`） |
| D4 | Phase 10 | ✅ **已降 ask（0089）**：v3 把 D4 从 deny 降为 ask，改在 `fde_phase_advance` 的 execute 层走 `approval.request`（见 §4.1.0） |
| D5 | Phase 6 | ✅ **Stage 5.6 已实现**（`fde-run-compliance-check`，锚 `compliance.yaml` 的 `sha256+行数+非空键数`；启用判据见 §4.1.3） |
| D5-pre | Phase 2 | ✅ **B3 已实现（0090）**：数据接入前 `approval.request` 提醒「确认授权 + 脱敏方案」，确认后写 `compliance.yaml` 的 `data_policy`（见 §4.1.4） |

> 未实现的 deny 项（若将来又出现）：审计里写 `type: 'check-skipped'` 记录，列出被跳过项与「本轮不拦，仅记录说明」的注释。**绝不**挂桩返回 `passed: true`——那等于假装拦住了，是合规欺诈。v3 后 `DENY_CHECKS` 各项均已实现，此通道当前恒空。

#### 4.1.0 D4 签字提醒（0089：从 deny 降为 ask）

v3 §2/§3 把 D4 从 deny 降为 ask —— 签字不重要，提醒到位即可。落地方式：

- **触发**：`fde_phase_advance` 推进离开 Phase 10（`current=10 → to=11`）时，execute 层调 `ctx.get('approval').request(...)` 弹窗「确认客户已验收」。
- **三态**：
  - `allowed-once` ⇒ 继续推进，审计记 `phase-advance-d4-ask outcome=confirmed`；
  - `rejected` ⇒ `throw HarnessError('D4_REJECTED')`（用户明确拒绝），审计记 `outcome=rejected`；
  - `unavailable` / `cancelled` ⇒ **降级放行 + 记审计**（`outcome=degraded`，提醒未送达）。
- 🔴 **ask 的 fail-open 与 deny 的 fail-closed 相反，是刻意的**：v3 的 fail-closed（§10）只约束合规门/deny；D4 是「签字不重要」的提醒，通道不可用硬卡死违背 v3 定位。但**必须留痕**——`degraded` 只说明「提醒没送到」，**不等于**「客户已验收」。
- 回执字段 `d4Approval`：`'n/a'`（未触发）/ `'confirmed'` / `'degraded'`（`rejected` 时 throw 不返回）。
- **两条审计链**：approval 的 `approval/asked`+`approval/decided` 落 session log（自动）；本插件的 `audit` 链落 `phase-advance-d4-ask`（本单写）。二者不合并。

#### 4.1.3 D5 合规边界检查（Stage 5.6 已实现）

**启用判据**（spec `:246`「非受监管行业自动关闭」）：`isRegulatedIndustry(cfg.industry)`
- `medical-*`（如 `medical-aesthetics`）⇒ **启用** D5
- 其余（含 `retail` / `未声明` / 空串）⇒ **自动关闭**，guard 分支 `continue`（不拦、不算失败），推进时以 `notApplicable` 留痕

🔴 **industry 落部署 config，不落 compliance.yaml**：被检查对象自报行业 = 可改"无行业"绕过。
🔴 **`未声明` 是哨兵值不是行业名**：在布尔语境里是真值字符串，`if (!cfg.industry)` 会判错 ⇒ 任何"是否适用 D5"的判定都必须走 `isRegulatedIndustry()`，不许直接字符串比较。

**D5 判定**（`verifyComplianceText`）：`ontologyRoot/compliance.yaml` 的**存在性 + 结构**（不判定内容，spec `:257`）：
1. 文件必须存在（不存在 ⇒ `unreadable`）
2. 必须是合法 YAML 子集（垃圾行 ⇒ `parse-error`，**不是** 5 键全 `missing-key` —— 0066 缺陷 D 修复：解析器真能报错）
3. 5 个顶层键齐全：`output_boundary` / `review_chain` / `data_policy` / `change_assessment` / `rollback_preauth`（缺 ⇒ `missing-key`，**只点缺失的那一项**，不把 5 键全报红）
4. 每个键非空（非空字符串 / 非空数组 / 非空对象）
5. 对象值的**字符串子字段非空**（`reviewer: ""` ⇒ `empty-subfield` —— 施工单 §4「子字段都是非空字符串」）
6. `change_assessment.classified === true`（`false` / 缺失 / 非布尔 ⇒ `not-classified` —— 0066 缺陷 E 修复：这是"是否已做合规分级评估"的存在性判定，不是"评估得好不好"的内容判定）
7. `rollback_preauth.authorized === true`（`false` / 缺失 / 非布尔 ⇒ `not-authorized` —— C3：这是"部署审批包含紧急回滚授权路径"的存在性判定，不是"回滚方案好不好"的内容判定）

工具：`fde-run-compliance-check`（由本插件提供，与 D2 同构：工具深验 + guard 同步比对锚点）。

⚠️ 反过来也要记住：**只加 `IMPLEMENTED_CHECKS` 而不在 `runDenyChecks` 里补分支 ⇒ 会被判失败并拒推进**（fail-closed），不会被悄悄跳过 —— 有专门的离线用例钉住这条。

#### 4.1.4 D5-pre 数据接入前置提醒（B3 / 0090：Phase 2 确认授权 + 脱敏方案）

Phase 6 的 D5 要求 `compliance.yaml` 里 `data_policy` 非空，但**谁来写这个键**在 spec v3 §10.3 里落在 Phase 2 数据接入前 —— 这就是 D5-pre。落地方式：

- **触发**：`fde_phase_advance` 推进离开 Phase 2（`current=2 → to=3`）时，execute 层调 `ctx.get('approval').request(...)` 弹窗「确认已获得数据授权并制定脱敏方案」。
- **必带参数**：`data_authorization`（授权依据）+ `deidentification_plan`（脱敏方案），二者缺一即 `throw D5PRE_MISSING_FIELDS`（**还没问 approval 就拒**，不给"没写脱敏方案也放行"的口子）。
- **三态**（与 D4 ask 同构）：
  - `allowed-once` ⇒ 把 `data_policy: { authorization, deidentification }` 写进 `ontologyRoot/compliance.yaml`，审计记 `phase-advance-d5pre outcome=confirmed`，回执 `d5PreApproval='confirmed'`；
  - `rejected` ⇒ `throw D5PRE_REJECTED`（用户明确拒绝），不写文件、不推进；
  - `unavailable` / `cancelled` ⇒ **降级放行 + 记审计**（`outcome=degraded`），不写 `compliance.yaml` —— Phase 6 的 D5 会因 `data_policy` 缺失兜底拦下（见 §4.1.3）。
- 🔴 **fail-open 与 deny 的 fail-closed 相反，是刻意的**：D5-pre 与 D4 同属 ask（提醒到位即可）；通道不可用硬卡死违背 v3 定位。但**必须留痕**——`degraded` 只说明「提醒没送到」，**不等于**「授权已确认」；真正的兜底是 Phase 6 D5 的 `missing-key: data_policy`。
- 🔴 **写盘 fail-closed**：现有 `compliance.yaml` 若**解析不了**（`parseComplianceYaml` 报错），拒绝覆盖——现有合规证据比"补写 data_policy"更值钱（见 `compliance-write.js` 文件头注释）。
- 回执字段 `d5PreApproval`：`'n/a'`（未触发，非 Phase 2）/ `'confirmed'` / `'degraded'`（`rejected` 时 throw 不返回）。
- **与 D5 的关系**：D5-pre 只写 `data_policy` 一个键；`output_boundary` / `review_chain` / `change_assessment` / `rollback_preauth` 四键留待 Phase 6 前补全（D5-pre 不替它们占位）。

#### 4.1.5 C3 回滚预授权（spec §10.4，2026-09-28 已实现）

spec 治理动机：部署出问题要回滚，但 D5 说"任何改动都要合规评估"——回滚算不算改动？若算，紧急回滚被合规门卡死，越拖越大。回滚预授权 = **部署审批时一起把"出问题可以回滚"也批了**，回滚时走预授权通道不重审。

四件事的落地：

1. **`rollback_preauth` 是 D5 第 5 个 deny 键**（§10.1 表）：`compliance.yaml` 里 `rollback_preauth.authorized === true`，缺失/非 true 判 `not-authorized`，D5 不通过。这是"部署审批包含紧急回滚授权路径"的存在性声明。
2. **部署时同步记录"允许回滚至版本 X"**：`fde_phase_advance` 推进到 Phase 6（Deploy）时，`phase-advance` 审计带 `rollback_preauth: { authorized: true, target_version: 'rev-<部署前 revision>' }`。
3. **回滚走独立通道 `fde_rollback`**（不重审 D5 的 5 键）：验证 `rollback_preauth.authorized === true` 后直接回滚。无预授权 ⇒ `ROLLBACK_NO_PREAUTH`；已观察期内 ⇒ `ROLLBACK_ALREADY_OBSERVING`。回滚事件写 `type: 'rollback'` 审计。
4. **24h 观察期**：回滚后 `state.rollback_at` 记录起点，观察期内（`inObservation()`）`fde_phase_advance` 被双向冻结（guard `evaluate` + execute 纵深防御都拒，理由「回滚观察期内」）。观察期结束后恢复推进，届时确认是否重新部署。

🔴 **PoC 降级（诚实写死，不得说成"已按 spec 实现"）**：

- **无 ontology 版本快照**：PoC 没有 `memory/ontology` 的历史版本，"版本 X"仅以 `state.revision` 作标识（部署前 revision / 回滚前 revision），**不恢复真实 ontology 内容**——回滚只记录回滚意图 + 进入观察期。
- **"确认是否重新部署"的 ask 未实现**：PoC 状态机单调前进（F1 偏离），"重新部署"没有对应动作；观察期结束 = 自动恢复推进，不做额外确认弹窗。
- **观察期冻结是"任何推进"**（不只"推进到 Phase 6"）：因为单调状态机里"重新部署"结构上不会再次触发，冻结全部推进才是忠实、可测的落地。

#### 4.1.6 C2 · L0/L1/L2 各自流程（spec §4，2026-09-29 已实现）

C1（`dsh-fde-ontology-gate/lib/classify.js`）能判出变更级别，但**判出来给谁用**曾是缺口：级别只是写进审计的"死数据"。C2 补上消费者 —— 把 spec §4 三支流程机器化成"必需检查清单"，并在变更闭环时逐项核验。

| 级别 | spec §4 流程 | 本插件的机器化判据 |
|---|---|---|
| **L0** 补充 | 记录理由 → 重生成用例 → 重跑 D3 | 闭环时 **D3** 新鲜通过 |
| **L1** 修正 | 回 Phase 3 变更模式 → 改规则 → 重生成用例 → 重跑 D1+D3 → 标记下游 → 自动回原 Phase | 闭环时 **D1 + D3** 新鲜通过 |
| **L2** 受监管 | L1 全流程 + D5 合规分级评估 + 外部审批人确认 | 闭环时 **D1 + D3 + D5** 新鲜通过 **且** `approval.request` 返回 `allowed-once` |

**工具**：`fde_change_close(reason)` —— 一次 ontology 变更改完之后调用，闭环它。

🔴 **级别由本工具自己从 gate 审计链读，不由调用方传**（`change-flow.js` 的 `readLatestChange`）。spec §4 说级别是**插件自动判、FDE 只能升级不能降级**；若让模型在闭环时自报级别，模型报 `L0` 就能省掉 D1 与 D5 —— 那等于把门禁敞开。gate 链是级别判定结果的**唯一权威落盘处**（`fde_ontology_write` 的 `allow` 记录带 `level`/`autoLevel`），且是哈希链、改不动。

**"新鲜"的含义**：复用 `D1Mirror.verify` —— 与 `fde_phase_advance` 推进时**同一套锚点判据**（有没有结论 / 上次是否通过 / anchor.alg 对不对 / 与当前文件内容是否一致）。所以"改了 `actions.yaml` 但没重跑 D1"必然被判未通过，与 guard 的行为一致。

**审计事件**（本插件自己的哈希链）：

| `type` | 何时 | 关键字段 |
|---|---|---|
| `change-closed` | 闭环成功 | `level` / `target` / `change_seq` / `change_ts` / `required` / `checks` / `approval` |
| `change-close-denied` | 任一环节拒绝 | `outcome`（`no-change`/`no-level`/`unreadable`/`checks-incomplete`/`approval-rejected`/`approval-unavailable`/…）+ `level` / `failed` |

**拒绝码**（`HarnessError.code`）：`CHANGE_NONE` / `CHANGE_NO_LEVEL` / `CHANGE_CHAIN_UNREADABLE` / `CHANGE_FLOW_INCOMPLETE` / `CHANGE_APPROVAL_REQUIRED`。

🔴 **L2 的审批是 fail-closed，与 D4 ask 的三态相反**（这个差异是刻意的，别以为是写漏了）：D4 是"签字不重要、提醒到位即可"，通道不可用降级放行；L2 是**受监管变更的合规门**，`rejected` / `cancelled` / `unavailable` **一律拒绝闭环**（只区分审计 `outcome`）。

**跨包边界**：`fde_change_close` 注册在 **phase** 插件（它持审计链与 `D1Mirror`），级别从 **gate** 插件的审计文件里读 —— 两个插件之间**没有 import、只有一个文件路径（`cfg.gateAuditPath`）**，与 D2 的取法一致。

**验证（分三层，别混）**：

| 层 | 仪器 | 结果 | 覆盖什么 |
|---|---|---|---|
| 离线单测 | `tests/_fde_c2_test.mjs` | 30/0 | 三支流程分派、拒绝码、审批三态、锚点失效 |
| 变异注入 | `tools/_fde_c2_mut.mjs` | **9/9 具名断言抓住**（`ALL-MUTANTS-CAUGHT`） | 证明上面那 30 条断言**不是恒真** |
| 真 SDK 注册 | `precheck.mjs` | OK（且对两个坏样本判红） | `defineTool` 构造 + `output.schema` 过真 SDK 校验 |
| 真 SDK + 真数据 | `tools/_fde_c2_live.mjs` | 6/0 | 真 `gate.jsonl`（只读）+ 真 `E:/ontologyRoot` 上的判定 |
| **DSH 进程内 · 注册层** | 跨会话 `request/header` 逐名 diff | `fde_change_close` 属**新增**项、非 fde 工具面逐字未变 | 工具真的挂进了 DSH 的工具面 |
| **DSH 进程内 · 调用层** | `tools/_c2_live_drive.mjs`（`baseline`→`drive`→`verify`） | **7 条判据 0 失败**（2026-09-29） | 模型在真进程里**真调了一次** `fde_change_close` |

✅ **调用层怎么验的**（2026-09-29 补上）：`tools/_live_drive.mjs --new` 起一个 `standard` preset 会话，prompt 只让它调一次 `fde_change_close`、`reason` 写**如实的活验说明**（不编业务理由）。结果：模型真的调了（args 完整）⇒ 工具 **fail-closed 拒绝**，文案「最近一次变更的记录里没有级别信息：gate.jsonl seq=5…本插件不猜级别」。**拒得对**：`fde-audit/phase.jsonl` `seq=116` `type=change-close-denied`、**`outcome=no-level`**（= 离线期望的 `CHANGE_NO_LEVEL`）、带 `callId`、`prevHash` 接得上前一条。**零副作用**：`memory/state.yaml` **sha 未变**、gate 链 **Δ0**、三条链新增行里**都没有**"放行/闭环成功"类记录（phase 链另一条 +1 是新会话的 `restrict-applied`，正常）。
⚠️ 如实说明两处：① 活体里**模型看不到错误码**（只见 `Error: <message>`，码在 `error.info.code` 由宿主拿）—— SDK 的既定形状，不是缺陷；码的落点在链上（`outcome`）。② 这一次的 `outcome` 落在**真链**上、但它是**拒绝**路径（fail-closed），**没有推进任何业务状态**。

🔴 **`tools/_fde_c2_live.mjs` 验的是"真 SDK + 真数据路径"，不是"DSH 进程内"** —— 它在独立 node 进程里 import 已安装副本的 `lib/`，所以真 SDK 的 `defineTool`/`HarnessError` 都真的被构造了。**"DSH 进程内"那两层**（工具注册进 fiber、模型真调得到）**要另验**，见上表最后两行。这一层边界必须分开写。

**真链上验到的是哪条路径（诚实）**：`tools/_fde_c2_live.mjs` 的场景 1 读**真 `gate.jsonl`**（当前实况：17 条记录、`fde_ontology_write` 4 条、其中 `allow` 2 条 = seq=4/5，**都早于 C1 落地、都没有 `level`**，最新的 allow 是 seq=5）⇒ 真链上验到的是 **`CHANGE_NO_LEVEL`（fail-closed 不猜级别）** 这条路径。**成功路径（L0/L1/L2 闭环）与 L2 审批走的是隔离链**（写在临时目录，不碰真链、不碰真 ontology）—— 因为真链里根本没有带 level 的 allow 记录（要造一条就得真的改 ontology，那是业务动作，不为验证而做）。

⚠️ **诚实缺口（C2 范围内未做，不得说成已按 spec 实现）**：

1. **「标记下游」未实现**（L1/L2 流程的一环）：spec 要求变更后标记受影响的下游产物。本项目尚无"受影响下游清单"这一概念，故**不假装做了** —— 闭环判定里没有这一项。
2. **「自动回原 Phase」未实现**：spec 的 L1 流程含"回 Phase 3 变更模式 → … → 自动回原 Phase"。本项目的 Phase 状态机不变量是 `current → next(+1)`（不许跳跃、不许回退，跳过 Phase 3 就等于跳过 D1），与"可回退的变更模式"结构冲突。**落地方式**：变更期间**不动 `current_phase`**，"变更模式"的语义由「未闭环变更的可判定性」承载（即 `readLatestChange` 能随时读出"最近一次变更还没闭环"），而不是由一个可回退的 phase 承载。**这是设计偏离，不是漏做**（与 F1 同类，已在差距清单记录为 C2 的落地口径）。
3. **旧记录无 `level` ⇒ 不猜，直接拒**（`CHANGE_NO_LEVEL`）：C1 落地（2026-09-28）之前的 `fde_ontology_write` allow 记录没有 `level` 字段（实测 `gate.jsonl` seq=4/5 是 09-26 的）。对这些记录闭环会失败并指出是哪一条 —— 这是有意的 fail-closed，不去"推测"一个级别。

#### 4.1.1 🔴 D2 的"链必须静止"（会让人以为它坏了，所以写在这里）

D2 的锚点是 `(行数, 链头 hash)` ⇒ **从你跑完工具到你真正推进，中间只要有任何一条新记录写进 `gate.jsonl`，结论就过期，必须重跑**。

- 这是**刻意**的，与 D1 的"改了文件就失效"同构：D2 要证明的是「**在推进这一刻**，链是完整的」；一小时前完整不等于现在完整。
- 判据 5 那种"向 gate 链追加一行 ⇒ 被拒"的写法，正是这一性质的**预期表现**，不是缺陷。
- 配套动作：重跑 `fde-run-audit-check` 即得到新锚点 ⇒ 放行（"强制重跑"，不是永久卡死）。

#### 4.1.2 ✅ 历史 gate 链的 2 处 GENESIS 断层 —— **已处置并已活体验证（2026-09-28）**

原链（79 行 / 36124 B，含 2 处 `prevHash = GENESIS` 接缝）已**原样归档**：
- `fde-audit/gate.jsonl.2026-09-26T10-18-10-793Z`（36124 B，与归档前逐字一致）
- 同名 `.manifest.md`

处置方式：归档 + 原地起新链，**新链起点记录由 gate 自己的 `AuditChain` 写入**（不另抄 `linkHash`）。

**活体验证（2026-09-28，0060）**：在 Phase 4 上跑 `fde-run-audit-check` +
`fde-run-validation` 后 `fde_phase_advance(to="5")` **放行**；
`state.yaml` 的 `current_phase` 由 `4` 变 `5`、`revision` 48→49，
审计链落 `phase-advance from=4 to=5 checks=["D2","D3"] skipped=[]`。
⇒ **D2 不再被历史链阻断，且已实测能通过。**

⚠️ **未验边界（诚实）**：「链在推进前一刻被人动过 ⇒ D2 过期 ⇒ 被拒」这一支**只有离线断言覆盖**
（`tests/_fde_d2d3_test.mjs:363`）。活体做它必须往 `gate.jsonl` 真写测试记录（不可逆），故未做。

### 4.2 D1 的 PoC 降级（impl 是 DSL 表达式，不是真函数）

spec 要求 `ref` 解析到**已注册的可执行函数**。本轮 D1 的 `impl` 是 **DSL 表达式**（如 `{'>': [{'var':'treatment.dose_mg'}, 100]}`），由 `dsh-fde-dsl` 的 `compileRuleCondition` / `evaluate` 求值，**不是**真 JS/TS 函数。

降级理由（写进交付文案）：动态 `import()` 任意路径等于开出代码执行面，且 PoC 期没有真实代码库可绑。**这条降级不得在任何交付文案里被说成"已按 spec 实现"。**

### 4.3 其余未做（本轮范围外）

- SCHEMA 迁移、decisions / checklist / stakeholders 记忆系统其余部分。
- state.yaml 只放状态机（7 字段），不塞 decisions/checklist。

### 4.4 `HarnessError` 正确来源是 `@deepseek-ai/dsh-llm`（已修复丢 code 缺陷）

`dsh-tools` **没有** re-export `HarnessError`（它定义在 `@deepseek-ai/dsh-llm`，`dsh-tools` 只是 import 进来给 `ToolNotFoundError extends` 用）。旧写法 `import * as dshTools` + `const HarnessError = dshTools.HarnessError ?? Error` 在真 SDK 下 `dshTools.HarnessError === undefined`，永远走 `?? Error` 兜底分支 ⇒ 结构化 `code`（`PHASE_D1_DENIED` / `PHASE_JUMP_DENIED` / `ROLLBACK_NO_PREAUTH` 等）静默丢失，只剩裸 `Error`。

**已修复（2026-09-28）**：三插件（phase / memory / ontology-gate）统一改为 `import { HarnessError } from '@deepseek-ai/dsh-llm'`（具名 import，code 存 `error.code`）。离线测试加 `threw.code === '...'` 断言；活验脚本 `tools/_fde_c3_live.mjs` 真 SDK 下 13/0 全绿、code 全正确。真 SDK 有 `@deepseek-ai/dsh-llm` 可解析；工作区离线桩用 `node_modules/@deepseek-ai/dsh-llm/index.mjs` 补齐同形状类，离线不崩。

### 4.5 `projectRoot` 在工作区外 ≠ 模型够不着（诚实边界）

拍板把 `projectRoot` 放在工作区之外的 `E:\DSH-desktop\...\fde-state`，本意是"不让 state.yaml 落在模型可写区"。但活验证明：模型用通用 `read` 工具**能走绝对路径读到** `E:\DSH-desktop\...\fde-state\memory\state.yaml`（gate 只保护 `E:\ontologyRoot`，不保护这条路径）。

所以"放在工作区外"只意味着"不在工作区里"，**不等于模型够不着**。要真保护这条状态路径，需要让 ontology-gate 把 `fde-state` 也纳入受保护区——这是下一步，已另立 TODO。

**进展（2026-09-26，0022）**：ontology-gate 的受保护集已扩为 `[ontologyRoot, dirname(auditPath)]`
⇒ **审计链**终于在门禁之内了；但 **`state.yaml` / `.state.lock` 仍然不在**（A2 / A3，见 §4.9）。

⚠️ A2 是当前唯一"改了不会被任何东西发现"的路径：A1（审计链）被改还能由 D2 事后发现不一致，
`state.yaml` 被改则**没有任何检测** —— 一次 `write` 把 `current_phase` 设到任意值，
`fde_phase_advance` 的 deny 检查**一次都不会跑到**（门禁不是被绕过，是被整个跳过）。

### 4.9 🟡 已知未修：`state.yaml` / `.state.lock` 不在任何保护根内（A2 / A3；**已拍板走 X，gate 侧已实现，待配置填值**）

**为什么它比审计链那条更难**：gate 的 cfg 里**没有** `projectRoot`，它不知道 state 落点
⇒ 只能由 **phase 侧**保护；而 phase 侧**完全没有路径判定**（`isInside` / `collectCandidates` /
`sessionCwdOf` 三件套 grep 零命中，`guard.js:68` 只对 `fde_phase_advance` 生效）。

⇒ 卡点不是"加一行"，而是**三件套怎么给 phase 用**（0022 P0-3 的勘察结论）：

| 方案 | 做法 | 代价 |
|---|---|---|
| **X 最小面** | 给 gate 加 `protectedExtraRoots: ['E:\…\fde-state\memory']`，A1+A2+A3 一处堵全 | 路径在两份配置里各写一次（与 `projectRoot` 重复表达同一事实 ⇒ **漂移风险**） |
| **Y 正路** | 抽共享包（如 `dsh-fde-pathkit`），两侧都 import；phase 自建守卫 | 新包 + 部署 + 要导出 `collectCandidates` / `shellPathTokens`（现为 gate 私有） |
| ~~复制一份到 phase~~ | — | ❌ 违反"生产实现收敛到一份"（`shellPathTokens` 那两条兜法是活体踩出来的，复制品必然漂移） |

**拍板（2026-09-26 / 0023 §4）：走 X。**

- Y 的"单一事实源"收益是真的，但它要新建包 + 搬迁 `collectCandidates` / `shellPathTokens`
  —— 这两个函数正是"兜法①②"在活体上踩出来的，搬迁过程本身就是漂移风险 ⇒ Y 排后续。
- 已实现（gate 侧）：`protectedExtraRoots` 配置项 + `protectedRootsOf(cfg)` 单一定义处
  （判定与启动打印共用）+ 配错即加载失败。**phase 侧零代码改动**。

**⚠️ 但代码 ≠ 生效**：`protectedExtraRoots` 必须在 `cordis.patch.yml` 里给 gate 填值，
A2/A3 才真被堵上。填值前，它们仍只靠 sandbox + approval 两层**非门禁**设施挡着。
（漂移风险的处置见 gate README「受保护集已配置化」一节：启动期打印 + 配置里用 YAML 锚点
让 `projectRoot` 与 `protectedExtraRoots` 字面同源。）

**⚠️ 生效后的副作用（P1-7）：`fde-state` 内「读」也被拒。** gate 第 ③ 段按路径判定、
不区分读写 ⇒ 模型在 DSH 里 `read` `state.yaml` 同样被拒（2026-09-27 活验确认）。
⇒ **要核对阶段请退出 DSH** 用外部编辑器读，或临时切 `shadow`。
这不是故障；「agent 不自查阶段、阶段由操作者掌握」的判定与现成试探通道见 §4.9.1。

### 4.9.1 模型如何知道"当前是哪个阶段"（0024 §7 的问句 —— 判定：**有意设计，不是缺口**）

**结论：不新增"查询当前阶段"的只读工具。** 三条理由：

1. **角色分工就是如此**：阶段由操作者 / 编排层掌握，agent 是被门禁审计的一方 ——
   给它一条自查入口，等于把"我能不能过"的判定权部分交出去；
2. **新工具 = 新攻击面**：一条只读入口也得有自己的审计口径与 restrict 归属，
   而它的收益只是"少一次试探"；
3. **信息需求其实已经被覆盖** —— 见下。

**现成的安全试探通道（已存在，此前只是没写进文档）**：

> 调 `fde_phase_advance`，**`to` 填 `"0.1"`**（首阶段），`reason` 随便写一句。

依据（`phases.js` / `guard.js` / `tools.js` 三处，均可自核）：

- `nextPhase(id)` 恒返回 `PHASES[idx + 1]`（`phases.js:71-75`），而 `0.1` 是 `PHASES[0]`
  ⇒ **`nextPhase(任何值) === '0.1'` 在任何 `current` 下都不可能成立**；
- ⇒ `guard.js:87` 的 `to !== want` 与 `tools.js:118` 的同款纵深判定**都必然命中**，
  回执给出「当前 **X**，下一个合法阶段是 **Y**」；
- `evaluate()` 只读 state、不写 state ⇒ **一次不改状态的调用就能读到当前阶段与下一合法阶段**。

**为什么是 `0.1` 而不是"不带 `to`"**（0025 §3 的更正，含一处**我自己先前写错的理由**）：

| 场景 | 不带 `to`（旧写法） | `to: "0.1"`（现写法） |
|---|---|---|
| **enforce**（本机活体） | ✅ 到 `guard.js:87`，拿到回执 | ✅ 同上 |
| **shadow** | 🔴 **拿不到**：shadow 不拦 ⇒ 调用继续走到 `execute`，而 `to` 是 `required: true`（`tools.js:73`），参数校验先炸 ⇒ 回执是 `missing required property "to"`，**没有阶段信息** | ✅ 过校验 ⇒ `tools.js:118` 抛**同样的** `PHASE_JUMP_DENIED` 文案 |
| **末阶段**（如现在 11） | ✅ 走 `guard.js:80`，仍读出当前阶段 | ✅ 同左 |
| **会不会变成真推进** | 🔴 靠调用方纪律（`to` 恰好填对 + 门禁全过 = 真写 state） | ✅ **代码兜得住**：`to` 恒 ≠ `want`，物理上不可能推进 |

⚠️ **订正一处我 0024 写错的因果**：我当时说 shadow 拿不到回执是因为"不拦 ⇒ 没有拒绝文案"。
**不成立** —— shadow 下 `execute` 自己还有一道同款判定（`tools.js:118-124`，文案一字不差），
按我那句推论本该拿得到。真因在更前面：**`to` 是 `required`，缺参在 `execute` 的参数校验处先被拒**，
根本没走到那道判定。结论碰巧对，理由错 —— 正是"断言域 ≠ 验证域"那族的又一次。

**剩下两条限制**：

| # | 限制 |
|---|---|
| ⚠️ | **每次试探往 `phase.jsonl` 写一行 `deny`** ⇒ 阶段链会被查询噪音淹没；真需要频繁查时，应改走"操作者告知"，而不是拿它当查询 API |
| ⚠️ | `current` 已是末阶段时，回执是「当前已是最后一个阶段（11），不能再推进」—— **同样读出了当前阶段**，只是不给"下一合法阶段" |

**⇒ 待办（P1-8，只改文档）**：把上面这张表写进活验卡/操作手册
（"查阶段 = `to` 填 `0.1` 调一次 advance" 这条人人都用得着）。
若将来噪音真的不可接受，再考虑只读入口 —— 且它必须与 `evaluate()` 共用 `readStateGradedSync`
（2026-09-29 起 `evaluate()` 用的就是它；此前是 `readStateSync`，那个回落语义会让"查阶段"在
状态文件坏掉时**报出一个假的阶段值**），**不许**另开一套读 state 的实现（否则又是"两处读同一事实"的漂移）。

### 4.10 结论恢复依赖尾部 64 KiB 窗口

`mirror.restoreSync()` 只读 `phase.jsonl` 的**尾部 64 KiB**（`TAIL_BYTES`）来重建内存镜像。
实际数据规模下够用（27.9 KiB 时一次读全，2026-09-26 活验实测跨重启重建成功）；
**但文件超过 64 KiB 后，早于窗口的结论就恢复不出来** ⇒ 重启后会表现为"无结论 ⇒ deny"（fail-closed，不是放行）。
链长到那个量级时请归档轮转（做法见 gate 的 `tools/_d2_rotate_chain.mjs`）。

### 4.6 restrict 的三条边界（第二批）

1. **「被隐藏的工具调不到」这件事，活体上看不见。** 原因是 restrict 热生效（§6）：模型看不见就不会去调它，
   于是永远不会产出 `UNKNOWN_TOOL` 那条 `tool/result`。这层由**离线**承担 ——
   `tools/_restrict_dispatch_probe.mjs`（真 `dsh-tools` + 真 `dsh-system-prompt` + 真 cordis，10/10 ALL-PASS）
   已证 `get(name, agent)` 与工具清单**同源同一个 `view(scope)`**。
   **任何交付文案都不得写成"活体验证了 UNKNOWN_TOOL"** —— 那句话在这个架构下不成立。
2. **点不上的名字不是"拦住了"，是"没有拦"。** 平台差异（win32 只有 `pwsh`，没有 `bash`）、preset 差异都会让名单里的名字不存在。
   本实现把这批名字记进审计的 `skipped` 字段、回执里也如实标注；若**全名单**都点不上则记 `restrict-degraded`
   （比 `restrict-applied` 醒目一级），因为它意味着保护**完全**失效。
3. ~~**state.yaml 存在但内容不可解析 ⇒ 会摘掉已挂的限制（fail-open）。**~~ —— **已于 2026-09-25（第二批补丁 1）修复**，
   改为"读不出来 ⇒ 什么都不做"，详见 §6.5。
   ⇒ guard 侧的**同类**问题也**已于 2026-09-29 修复**（分档读 + 不可信即拒绝），见 §4.7。

### 4.7 ~~🔴 已知未修：guard 侧的同类回落（fail-open）~~ ✅ **已修（2026-09-29）**

**原状**（保留，因为它记的是当时的真实判断）：
restrict 侧那个 fail-open 已修（§6.5），但同一个根因在 guard 侧仍然存在、当时刻意没动 ——
`guard.js` 用 `readStateSync()` 取 `current_phase` 做门禁判定，而它对任何读失败都回落
`DEFAULT_STATE`（`current_phase: '0.1'`）⇒ `state.yaml` 不可解析时门禁会把当前阶段当成 `'0.1'`
（该阶段无 deny 检查）⇒ 放行 `fde_phase_advance`。
当时写的"为什么不一起修"：`readStateSync` 的回落语义是第一批已验收的，改它要重跑第一批全部判据；
且会与"推进后 `writeState` 顺手把坏文件重写成好文件"相互作用。**当时给的方向是对的** ——
"在 `guard.js` 里改用严格读并对不可知情形拒绝推进"。

#### ✅ 现在怎么修的

**新增 `state.js` 的 `readStateGradedSync()`（分档读），guard 与审计监听器都改用它**
（取值口径与 `dsh-fde-memory/lib/outbox.js` 的 `readStateSync` **同一套**：
`enoent` / `empty` / `bad` / `schema` —— 那个函数的注释里本来就写着"**尤其 phase 的 guard**
不许把 `present:false` 当成'没有中断'"，本插件此前恰好违反了这一条）。

| 档 | 语义 | guard 的动作 |
|---|---|---|
| `enoent`（文件不在） | **首次运行**，语义明确是初始阶段 | 回落 `{...DEFAULT_STATE}`，**照旧放行**（这一档是刻意的例外） |
| `empty` / `bad` / `schema` | **这份状态不可信**（不是"没有状态"） | **拒绝推进**，文案写明档位、文件路径、原因与恢复动作 |

**三处要点**（都是修的时候才看清的）：

1. 🔴 **只改 `catch` 修不掉**。现实里最常见的意外（写到一半被截断 / 编码坏 / 二进制垃圾）里
   `readFileSync` 是**成功**的，而 `parseState` **从不抛异常**（逐行 `continue`）⇒ **`catch` 根本进不去**。
   实测 `parseState('\u0000\u0001binary garbage')` 返回的默认值对象与"真读到"**一个字段不差**。
   ⇒ 判据必须落在"**文件里到底有没有我们关心的键**"上（`parseStateStrict`），不能落在"有没有抛错"上。
2. **`enoent` 档照样把 `state` 带回去**，所以"首次运行"这条路径的行为与修前**逐字不变**（见第 3 点前的反向对照判据）。
3. 审计监听器同步改用它：状态不可信时 `from` 写 **`'(不可知)'`** 而不是 `0.1` ——
   否则审计链会自己伪造一个"当时在出生阶段"的事实。`enoent` 仍写 `0.1`（首次运行确实是）。
   已核对：没有任何脚本把 `from` 当阶段 id 解析（`tools/_audit_replay.mjs`、`_d2_live_verify.mjs` 只是打印）。

#### 🔴 修了之后**没有**"顺手改掉"的那个既有行为

原担心"推进后 `writeState` 会把坏文件重写成好文件" ⇒ 修完之后**这个交互不存在了**：
推进被拒 ⇒ `execute` 根本不会跑 ⇒ 坏文件不会被重写，事故痕迹保留。**这正是要的性质**，
但它意味着**修前已经发生过的"坏文件被就地重写"是不可逆的**（那份进度已经变成 `0.2` 了）——
所以这条修复**不追溯**，只在链上往后生效。

#### 🧪 判据与验证强度（**"会拦"目前仅离线**）

`tests/_fde_phase_test.mjs` 新增 8 条（见 `_phase_test_out.txt` 的「状态文件不可信 ⇒ fail-closed」与
「readStateGradedSync 分档」两段）：两条对照（观察期冻结 / 跳跃拦阻各自成立）+ **5 条不可信档各一条**
（二进制垃圾 / 空文件 / 缺 `current_phase` / `current_phase` 是空串 / `schema_version` 不认）
+ **1 条反向对照**（文件不存在 ⇒ 仍必须放行，防"修过头"）+ 分档函数本身四档互不混淆
（并断言：只有 `enoent` 档带 `state`，其余三档**不许**带 —— 带了就等于留了回落的口子）。

**变异验证（含一次失败记录）**：把 5 个"不可信"分支**逐个**改成宽容 ⇒ 对应 5 条具名断言**逐条变红**、
两条对照与反向对照**仍绿**、无崩溃、`EXIT=1`。
⚠️ 中途有一次变异**打太宽**（把整个 guard 打坏 ⇒ 红了 14 条），归因不干净 ⇒ 作废重做，改成
只打中单个分支（红了 2 条）再逐支打。**"变异打不中分支"和"打太宽"都要记一笔**，
否则"我验过了"是一句没有内容的话。

> ⚠️ **强度如实**：以上全部是**离线**验证（`guard.evaluate` 是纯同步函数，离线可全覆盖）。
> **真进程里"坏文件 ⇒ 模型收到拒绝"这一步尚未活验** —— 活验需重启 DSH，本轮未做。
> 参照 §6.5 的写法：**"能过"已活验、"会拦"仅离线**，两者必须分开写。

#### 第一批判据（⑤–⑧）需要重跑吗？

原话是"改它必须重跑第一批全部判据（⑤⑥⑦⑧）"。实际做法是**把第一批那几条以断言形式钉在回归里**
（跳跃被拒 / 末阶段 / D1 未过被拒 / D1 已过放行 / 锚点失效重拒 / Phase2 无检查放行 /
Phase4 真拦 / shadow 仍判定 —— 全在 `_fde_phase_test.mjs` 的 `[guard.evaluate]` 段），
本次改动后**全套 41 个套件全绿**，所以"重跑"是**被自动化代替**的，不是被跳过。

### 4.8 第四/五批：审计可判别性（五个静默点已修，不再静默）

| 之前的静默点 | 现在 |
|---|---|
| 连续两条 `applied` ⇒ 分不清"叠加"还是"接续" | `restored` + `from`（§6.3.1 规则表） |
| 名单被替换 ⇒ 与"首次挂载"同形 | `replaced` + `from` / `to`（方案 A，仅离线可达） |
| agent 销毁 ⇒ `untrack()` 一个字节都不写 | `restrict-untracked` + `from`（§6.6 三条边界） |
| 尾部窗口外的历史查不到 ⇒ 与"本来就没有"同形 | `restrict-history-miss`（聚合，一条/reconcile；**活体永不触发**） |
| 重启后限制"没了"但链上看不见（0007 §3） | 跨进程 `lifted` + **`via: 'index'`**（第五批，§6.3.4；与 `via: 'ledger'` 可判别） |

### 4.11 restrict 第二批缺口结论（Stage 5 第二批收尾）

| 项 | 结论 |
|---|---|
| `full-reconcile` | 落链条件 = 装载时 `agents.list()` 非空 **且**（某 agent 状态需变更 ∨ 阶段不可知 ∨ 有盲区）。链上没有它 ⇒ 条件未同时满足 ⇒ **正确行为，非缺陷** |
| `agent-disposed` | **已知够不着**（DSH 只有"归档"无"关闭会话"，退出也不落盘）⇒ 该 trigger 值**不设验收目标** |
| 重开已存在会话（`restored` 分支） | 已由链上 `#22` 覆盖 |
| `state.yaml` 的 `current_phase` | 本项目的**活验用值**，非真实业务阶段；本部署审计链自 `#1` 起即测试数据 ⇒ "真实业务阶段"在此**无定义**。2026-09-28 曾临时置为 `"4"` 以做实 D2 活体验证（见 `0060`），验证后已复原为 `"10"` |

### 4.12 break-glass 的降级与缺口（E1，spec §11）

| # | 项 | 影响 / 诚实边界 |
|---|---|---|
| a | 🔴 **恢复只覆盖链尾 64 KiB** | `bg.restoreSync()` 与 `D1Mirror` / `AuditChain` 同一个 `TAIL_BYTES` 窗口。**窗口外的 `break-glass` 重启后读不到 ⇒ 那条放行静默失效**。方向**保守**（少放行 = 更难绕过），但"重启前后行为不同"必须让客户知道。窗口内的 `break-glass-resolved` 一定读得到（它比 open 晚）⇒ 不会出现"已补正却被当成还开着" |
| b | 🔴 **广播失败 ⇒ gate 不会知道这次补正，且无自动恢复路径** | 自动补正里 `ctx.emit('fde/break-glass', {resolved:true})` 被 try/catch 吞掉（理由：监听器同步抛错会冒泡、绝不能把补正流程搞失败）。而 gate **只从自己的链恢复**，那条写的是 **phase** 的链 ⇒ 症状是"phase 说已补正、gate 还在放行"，且**只在重启后才看得出来**。补救 = 再砸一次玻璃（新 id，旧记录留作证据）或人工核对两条链。触发条件窄（`emit` 监听器同步抛错），但不假装它不存在 |
| c | 🟡 **`GATE-*` 不会被自动补正** | 补正候选的判据是 `checks.includes(r.denyId)`，而 `checks` 只来自 `DENY_CHECKS`∩`IMPLEMENTED` = `D1/D2/D3/D5` ⇒ `GATE-CLASSIFY`/`GATE-PATH` **永远不在候选里**，`fde-break-glass` 也只开不补 ⇒ 其放行只能人工收口。设计取舍（那两道门在 gate 插件里，phase 复算不了 ⇒ `SELF_CHECKABLE` 也不含它们），但必须可见 |
| d | 🟡 **`GATE-*` 与 `D2` 不带内容锚点** | 带锚的 `D1/D3/D5` 在内容变化时**放行自动失效**；`GATE-*`（载荷语义）与 `D2`（审计链 len+head，本就会增长）没有可锚的文件 ⇒ 只按 `deny-id` 比对。交付文案不可写"放行一律与内容绑定" |
| e | 🟡 **超期不撤销放行** | R7 只说"持续红色警告 + 计入指标"，**没说撤销**。撤销会让 FDE 在客户现场**再次被卡死**，与 break-glass 的立意相悖。代价 = "永远被记着 + 红色"，那是这个机制要的。`overdueRecords()` 是派生量、不写盘 |
| f | ⚠️ **`memory/break-glass.json` 可被手改** | 放行表的事实源是一个明文 JSON。这是**进程内软约束**的固有边界（同"手改 yaml 绕过 deny"）。消费侧已把"哪些 id 可绕"钉在 `bg-mirror.js::isBypassed()` 第一行（不再依赖"表里恰好没有"），但"表里的记录本身"仍只能靠审计链对账发现 |
| g | ⚠️ **`unavailable` 一律中止** | 与 D4 的 ask **方向相反**：D4 是"放行前问一声"（拿不到回答时放行是安全的），这里是"要一个明确的人工结论才允许绕过一个否决" ⇒ `rejected` / `cancelled` / `unavailable` **全部保持拦住**（fail-closed） |

### 4.13 L4 交叉校验的缺口与诚实边界（D1，spec §8）

| # | 项 | 影响 / 诚实边界 |
|---|---|---|
| a | 🔴 **降级降低审计保证强度** | spec §8 原文要求写明。降级期间 D2 通过**只**依赖"本地链完整"，"远端存在"这一条被显式豁免。⇒ 通过时带 `degraded: true`，回执正文点明，审计留痕 ⇒ **可事后按窗口筛出来复核**。**不得**在任何文案里说"降级和正常一样安全" |
| b | 🔴 **`state.json` 是**明文文件、可被手改** | 与 `memory/break-glass.json` 同族边界（本条清单 4.12 f）：把 `outageSince` 改早 ⇒ 立刻"降级通过"。消费侧的反制只有"阈值必须为正有限数"与"schema 必须匹配"两道形态校验（`readRemoteStateSync`），**挡不住有意的手改**。⇒ 属"进程内软约束"的固有边界，不是本实现的选择 |
| c | 🟡 **`state.json` 的写者是别的插件** | 本插件只读。若 memory 插件未装 / 未配端点 ⇒ 路径为空 ⇒ L4 **不适用**（不拦）。这是**设计**（见 §5.2），但意味着"L4 生效"这件事**依赖另一个插件的存在**，而本插件**无法验证对方真的在写**（只能看到"那个文件在不在、格式对不对"） |
| d | 🟡 **降级期的 `degraded` 只在**跑 D2 的阶段**才有** | `DENY_CHECKS` 里只有 Phase 4 跑 D2 ⇒ 其余阶段不跑 D2 ⇒ 括号**不适用** ⇒ 那些阶段的通过**不带** `degraded` 标记。这不是漏记：那些阶段本来就不受这条括号约束；但也意味着**"降级期间发生了多少次通过"只能从 Phase 4 的记录里数** |
| e | ⚠️ **`evaluateRemote` 两边同解靠测试、不靠类型** | 跨包不 import（0076 §3.3）⇒ 两份实现是**复制**关系。`tests/_fde_d1_test.mjs` 的 F 组用 20 组输入对拍 + 变异 M23（只改一侧）钉住；但**新增第三个消费方时不会自动被覆盖**，必须自己加进对拍集 |
| f | ⚠️ **阈值改动不会追溯已有记录** | `degradeAfterMs` 存在 `state.json` 里，由 memory 在每次 `apply()` 用**当时 config** 覆写（config 是权威）。⇒ 改小阈值后，**过去那段中断**会按新阈值重算 ⇒ 可能"一觉醒来就降级了"。这是"现算"的必然代价，换来的是不会过期（见 §5.2 末） |

---

## 5. 配置

```yaml
dsh-fde-phase:
  projectRoot: "E:\\fde-project"          # 必填：state.yaml 落点 <projectRoot>/memory/state.yaml
  ontologyRoot: "E:\\ontologyRoot"        # 必填：D1 哈希锚定的 actions.yaml 来源
  mode: shadow                            # shadow | enforce，默认 shadow
  auditPath: ""                           # 哈希链审计 JSONL 落盘路径；留空=仅内存
  lockTtlMs: 30000                        # 单写者锁过期阈值（毫秒）
  gateAuditPath: 'E:\...\fde-audit\gate.jsonl'   # Stage 5.5 起必填：D2 要验的 gate 审计链
  telemetryStatePath: ''                  # D1/L4：外置审计降级状态 state.json 的路径。**留空 = L4 不适用**
  protectedPhases: ["4", "6", "10"]       # 受保护阶段（第二批，默认 = 方案 B，见 §6）
  denyTools: ["pwsh"]                     # 受保护阶段内隐藏的全局工具名（默认 = 方案 B）
```

### 5.1 `gateAuditPath`（Stage 5.5 新增，必填）

D2 要验 gate 审计链的完整性，**就必须知道那条链在哪**。它与 `projectRoot` / `ontologyRoot` 同性质 ——
都是这个项目的合规证据文件的位置。**gate 只是它的生产者，不是它的所有者**，
所以沿用既定模式：**由配置显式给，插件不猜**；缺失 / 空串 / 非字符串 ⇒ `normalizeConfig()` 抛错（fail-closed），
宁可插件不起来，也不带着"验不了但假装能验"的配置运行。

⚠️ 加这个字段意味着：**升级后必须同步改 `cordis.patch.yml`**，否则下次 DSH 启动时插件会在 `apply()` 里抛错
（`fiberPhase: failed`，工具全部不可用）。这是 fail-closed 的预期代价，不是 bug。

⚠️ `denyTools` 里**不得出现 `run_code`**：它是 PTC 模式的呈现层传输保留名，`restrict()` 点名必抛、
且**无法像未知名那样跳过**。所以 `normalizeConfig()` 在配置层就 fail-closed 拒掉（带明确报错），
不留到运行时才发现"保护根本没挂上"。

名单对未来部署差异是**容错**的：点不上的名字（如 win32 上点 `bash`）只会让那一个名字失效，
其余照挂，并把被跳过的名字写进审计 `skipped`（详见 §6 第 4 点）。

`normalizeConfig()`（config.js）是 fail-closed 唯一权威：`projectRoot` / `ontologyRoot` 缺失即抛错。
config-schema.js 仅供 DSH 配置面板提示，不承担安全职责。

⚠️ **`$DSH_HOME/projects/{project}/` 在真 SDK 里不存在**（spec 第七节假设的路径形态与实际不符）。所以 state.yaml 的位置**必须由 config 显式给**，插件不做任何路径猜测。

### 5.2 `telemetryStatePath` 与 L4 交叉校验（D1 新增，spec §8）

spec §8 的 L4 原文：**`deny 校验 = 本地链完整 AND（远端存在 OR 降级模式）`**。
前半个括号就是 **D2**（本插件已有），本节补的是**后半个括号**，落在 `lib/remote-state.js`。

**判据只看一个文件**：`<projectRoot>/memory/outbox/state.json`（写者是 `dsh-fde-memory`，见它 README §1.11）。
本插件**不 import memory 的任何文件**（0076 §3.3：插件独立安装，跨包 import 会互相拖垮；先例 `deny-ids.js` / `ANCHOR_ALGS` / `EXPERIMENTS_SUBDIR`），
只共享**文件格式**；两边一致性由 `tests/_fde_d1_test.mjs` 的 F 组**逐字对拍字面量 + 20 组输入对拍判定**钉住。

| 情形 | `applicable` | `status` | D2 判定 |
|---|---|---|---|
| `telemetryStatePath` **为空** | `false` | （不参与） | **不拦** —— 部署方本来就没接外置审计 |
| 路径给了，读到 `present` | `true` | `present` | 不拦 |
| 路径给了，读到 `degraded`（中断 ≥ 阈值） | `true` | `degraded` | **不拦**，但本次通过带 `degraded: true` |
| 路径给了，读到 `missing`（含"从未投递过"） | `true` | `missing` | **拦**（fail-closed） |
| 路径给了，**读不出来**（坏 JSON / schema 不认 / 空文件 / 文件不在） | `true` | `missing` | **拦**（fail-closed） |

🔴 **「没配」判成"不适用"而不是"不满足"，是刻意的**：把"没配"判成不满足会让**所有没接远端审计的部署在 Phase 4 永久卡死** ——
那正是 spec §8 要修的死锁形态（v2 的 D4「远端不可达 = 永远不过」）。反过来，「给了路径但读不到」必须**拦**：
"读不到"绝不能当成"没问题"，那会把盲区说成事实。两条各有反例钉住（E1/E1b 与 E2/E2b）。

**降级不是"和正常一样安全"**（spec §8 诚实边界）。所以 `degraded: true` 时：
① 审计记录带 `degraded` 与 `remote` 两个字段；② **回执正文**打印那段中文说明（不是只把标记留在审计里 ——
只留标记，模型与用户就会以为"和正常通过一样"）。回执 schema 只放**布尔** `degraded`
（`output.schema` 的 DSL 没有 `null`）⇒ 三分（不适用 / present / degraded）由**审计记录里的 `remote`** 承担。

⚠️ **阈值不在本插件配**：`state.json` 里的 `degradeAfterMs` 是唯一真源，本插件**现算** `degraded`。
理由：「24h 那一刻没有任何写入动作」—— 缓存成布尔必然过期。

---

## 6. restrict 工具面过滤（第二批）

受保护 Phase 内，对本部署**每一个 agent** 隐藏 `denyTools` 名单里的全局工具。口径（用户已拍板 **= 方案 B**）：

| 项 | 值 | 理由 |
|---|---|---|
| 受保护 Phase | `4` AIP 叠加、`6` Deploy、`10` Handoff | 与 `DENY_CHECKS` 已覆盖的 4/6/10 对齐 —— 这三个是"改生产 / 改交付物"的关口 |
| 名单 | `pwsh`（win32 的 shell 工具） | PoC 只收 shell；`write` / `edit` / `subagent` 暂不收 |

⚠️ **这是 PoC 口径，不是安全边界**：本插件（连同这三道防线）都是**进程内软约束**，防的是模型无意失误与漂移，不是有意绕过。
口径写在 **config**（`protectedPhases` / `denyTools`）而不是代码里 —— 将来收窄/放宽只改配置、不必动 `lib/`。

### 6.1 四件必须写清的事

**① 被隐藏的工具仍会先过 `pre-execute` + `guard`，之后才以 `UNKNOWN_TOOL` 失败。**

`prepareExecution` 的顺序是 `tools/pre-execute` waterfall → `guardReason(exec)` → dispatch（`dsh-tools/lib/index.js:3106-3135`），
而"不可见工具"的判定在更后面的 `resolveExecution`（`:2907-2911`）。
⇒ **隐藏 ≠ 静默丢弃**：审计监听器照样看得到这次尝试。这条对我们有利，但读代码的人容易误判，所以写在这里。

**② 限制是每 agent 的，阶段是全局的 ⇒ 阶段一变要对所有存活 agent 对账。**

`state.yaml` 里只有**一个** `current_phase`，而 `restrict()` 是**带 scope** 的（每个 agent 一份）。
所以只监听 `agent/session-start` 会漏掉"推进之前就已经开着"的会话。本实现的三条补路：

- `agent/session-start` → 新会话建立当下按当前阶段算一次；
- `agent/disposed` → 清台账（限制由 agent 的 fiber 自动撤销，不必手工 dispose）；
- **每次 `fde_phase_advance` 落盘成功后 → `ctx.agents.list()` 全量对账**（含插件装载之前就存在的会话）。

最后那条是判据 5 唯一考察的东西，也是本批最容易漏的一环。

**③ restrict 是热生效的：模型每一次请求的工具清单都是当刻重算的。**

证据链四跳：`ToolsRuntime` 注册 systemPrompt 的 tools provider（`dsh-tools:2609`）→
`wireSchemas` 每次现算 `view(scope)`（`:2726`）→ `SystemPrompt.assemble()` 每次逐个 invoke provider（`:299-318`）→
调用点在 `AgentLoop.preStep()`，位于 `turn()` 的 `while(true)` 里（`dsh-agent-loop:502`）。

⇒ 推进生效后，**同一会话的下一回合**就看不到了，不需要新开会话、不需要重启（`dsh-agent-loop` 也压根不监听 `tools/change`）。
附带推论：不存在"模型被告知有某个工具却调不到"的窗口 —— 唯一例外是"请求已发出、模型正在生成"那一瞬，
此时隐藏的工具会以 `UNKNOWN_TOOL` 失败，这是正确行为。
**这也是 §4.6 第 1 条那个"活体测不到"的直接原因。**

**④ 点不上的名字进审计 `skipped`，绝不会被粉饰成"拦住了"。**

`restrict()` 会抛 `names unknown global tool "x"; known global tools: …`。处理是：
先全名单试 → 从错误原文解析出 unknown → 用**剩下的**名字重挂 → 把跳过的名字记进审计 `skipped`。
若全名单都点不上 ⇒ 保护**完全**失效 ⇒ 记 `restrict-degraded`（不记 `restrict-applied`）。

### 6.2 幂等：必须先 dispose 旧的，再挂新的

`restrict()` 每次调用都往 layers 里 **append 一条 filter**（`:2805`），而多条 filter 是**交集**语义
⇒ 想"放宽"必须调用上一次**返回的那个 disposer**，否则限制只会越叠越窄、永远回不来。

本实现给每个 agent 记 `{ desired, applied, dispose }`：`desired`（**期望**名单，不是生效名单）用于判幂等 ——
期望没变就一个字节都不动（含不写审计），期望变了才 dispose + 重挂。
↳ 拿 `applied` 做比较会怎样？`['pwsh','bash']` 里 `bash` 点不上时 `applied` 恒为 `['pwsh']`，
于是每次重算都判定"名单变了" ⇒ 反复重挂 + 反复刷 `skipped` 审计。这条已钉进离线回归。

### 6.3 审计事件（`type: 'restrict'`，复用本插件的哈希链，不新开文件）

| `decision` | 含义 |
|---|---|
| `restrict-applied` | 已对该 agent 挂上限制；`denied` = 真正拦住的名字；`skipped` = 点不上而放弃的名字（可能有） |
| `restrict-restored` | 本进程首次见到它，但链上最近一条是同名单的 `applied`（或 `restored` / `untracked`）⇒ **接续，不是叠加**；`from` = 被接续的**那条 `applied`** 的 `seq`（第四批；`from` 取法见 §6.3.2） |
| `restrict-replaced` | 前后名单**都非空且不同** ⇒ 名单被替换；`from` / `to` 两个名单齐全（第四批，方案 A） |
| `restrict-untracked` | agent 已销毁 ⇒ 台账终结；`from` = 被终结那条 `applied` 的 `seq`（第四批） |
| `restrict-history-miss` | 尾部窗口未覆盖全链 ⇒ 这些 agent 的"最近一条决策"查不到 ⇒ 本次判断不可信。**与 `want` 的空/非空无关**（0008 §4 对齐）；`branch` 标明影响面（`'want-nonempty'` = 可能多挂 / `'want-empty'` = 可能漏记摘除）；**聚合**：每条 `reconcile()` 最多一条，`agents` 是数组；**进程内每个 agent 最多报一次**（第四批 + 第五批） |
| `restrict-degraded` | 名单里的名字**一个都没挂上** ⇒ 保护完全失效，`denied` 为空 |
| `restrict-lifted` | 限制已不再生效，工具重新可见。**必须**带 `via` 字段区分两种来源（第五批，见 §6.3.4）：`via: 'ledger'` = 本进程真摘除；`via: 'index'` = 跨进程推断（本进程从未挂过，靠链上索引判定） |
| `restrict-error` | 挂限制时抛出非"点名失败"的错误（如 `requires a scoped context`）⇒ **没有挂上**，不得写成 applied |
| `restrict-undetermined` | 读不到 `state.yaml` ⇒ 阶段不可知 ⇒ 本次**不变更**任何限制（既不挂也不摘） |

⚠️ `sync()` 的**返回值**里没有 `restored` / `replaced`：那两个只是审计 `decision`。
返回值仍是 `applied` / `lifted` / `degraded` / `unchanged` / `undetermined` / `error` ——
刻意不改，否则第二/三批以返回值为断言的已验收证据会一起被改掉形态。

回执**不回显工具清单**（"你现在没有 X 了"这种话会诱导模型去找替代通道，与"不回显 state.yaml 全文"同源红线）。
被隐藏的工具自己会以 `UNKNOWN_TOOL` 说话。

### 6.3.1 `restored` 判据：必须收紧到「最近一条」（第四批）

链上出现**连续两条 `restrict-applied` 而中间没有 `lifted`** 时（实测 `#15/#16`、`#35/#36`），
读者分不清第二条是"又叠了一层（filter 是交集 ⇒ 越叠越窄）"还是"重启/对象重建后的接续"——
两者链上形态完全一致。这是本模块此前最大的**静默点**，`restored` 就是为消掉它而加的。

判据只看该 agent 的**最近一条** restrict 决策 `D`（不是"存在任意一条 applied"，那会在 `#35` 上说谎：
`#35` 之前确有 `#25 applied`，但中间隔着 `#31 lifted` ⇒ 那是一次**真的**重新挂载）：

| 最近一条 `D` | 落什么 | 语义 |
|---|---|---|
| `applied` 且名单相同 | **`restored`** + `from` | 接续（重启 / agent 对象重建 / 插件 fiber 重建） |
| `restored` | **`restored`** + `from` | 连续多次重启/重建：仍是接续（**0005 §3 拍板**，此前是待拍板项） |
| `untracked` | **`restored`** + `from` | 台账曾终结、旧层已随 fiber 撤销 ⇒ 本次是接续 |
| `lifted` | `applied` | 限制真被摘过 ⇒ 真重新挂载（正是 `#35`） |
| `replaced` / `degraded` / `error` / 查不到 | `applied` | 首次，或状态不可接续 |

### 6.3.2 🔴 `from` 恒指「最后一条 `applied` 的 seq」，不是「前一条」（0005 §1.3 拍板）

`restored` 的语义是"**我接的是一条已存在的限制**"。这条限制的**唯一来源**是那条 `applied`，
中间的 `restored` 只是传递 ⇒ `from` 必须指源头，不能指前一条。否则连续重启会退化成链式：

```
#36 applied                    denied=["pwsh"]
#37 restored from=36           ← 第一次重启
#38 restored from=37           ← 第二次重启（链式 —— from 指向的是一条 restored，不是 applied）
```

链式会让判据 1（「重启后每条 `restored` 的 `from` 指向重启前最后一条 `applied`」）
**从第二次重启起就失效**，而判据 1 恰恰是要跑多次重启的那个判据 ⇒ 自相矛盾。
顺序本就由 `seq` 单调编码，`from` 再编码一遍是冗余 —— 它该编码的是"接续到**哪一层限制**"。

**期望形态**（`tests/_restrict_index_test.mjs` §8 的守门人用例）：

```
#36 applied                    denied=["pwsh"]
#37 restored from=36           ← 第一次重启
#38 restored from=36           ← 第二次重启（仍指 36，不链式）
```

三条连带规则：

1. **`from` 一律取索引的 `appliedSeq`** —— 该字段只被 `restrict-applied` 推进，`restored` / `untracked`
   等决策都沿用旧值（`AuditChain.#indexRestrict()`）。
2. **源头落在尾部窗口外 ⇒ `from` 显式 `null`，但 `decision` 仍是 `restored`。**
   是否接续只看「最近一条」，与能否找到源头无关；不得因为找不到 `applied` 就退化成 `applied` ——
   那会与 `restrict-history-miss` 的语义打架（"窗口不完整"由它报告，`restored` 不该因此改判）。
3. **索引条目缺 `appliedSeq`**（老链 / 假索引 / 兼容路径）⇒ `applied` 分支回落 `last.seq`
   （那条本身就是 applied）；`restored` / `untracked` 分支回落 `null`（不编造）。

> `untracked` 的 `from` 同口径：台账只记 `appliedSeq`，且**只在 `decision === 'restrict-applied'` 时更新**，
> `restored` 时沿用索引带回的源头 ⇒ 跨重启销毁时 `from` 仍指最初那条 `applied`（0005 §2）。

### 6.3.3 ⚠️ `from` 是**同名不同型**的字段（读链前先看这张表）

| `decision` | `from` 的含义 | 类型 | 出处 |
|---|---|---|---|
| `restrict-restored` | 接续到的那条 **`applied` 的 seq** | `number`（源头不可考时为 `null`） | `classifyRestore()` |
| `restrict-untracked` | 被终结的那条 **`applied` 的 seq** | `number`（同上） | `untrack()` |
| `restrict-replaced` | **旧名单**（不是 seq） | `string[]` | `sync()`（`to` = 新名单） |
| `restrict-lifted` | **"它曾带着限制"那条记录的 seq**（`via='index'`）；或最后一条 `applied` 的 seq（`via='ledger'`） | `number`（源头不可考时为 `null`） | `sync()`（第五批） |

四个 decision **互斥**，不会共存于一条记录 ⇒ 拿到一条记录后按 `decision` 查表即可，无歧义。
字段名刻意没拆成 `fromSeq` / `fromNames` —— 改名会波及第二/三批已验收的证据形态
（与 §6.3 里"`sync()` 返回值不含 `restored`/`replaced`"同一个取舍）。

`replaced` 走**方案 A**：只有"前后名单都非空且不同"才算替换。`[] → ['pwsh']`（离开受保护阶段再进入）
**仍是 `applied`** —— 上一状态已由 `lifted` 表达清楚，且 `restrict-applied` 是"当前是否受保护"的
核心检索键，不该被降级。代价：`replaced` 在活体上**不可达**（改名单必须改 config ⇒ 必重启 ⇒
重启后 `prev` 必缺失 ⇒ 走 `restored` 分支）⇒ **它的证据只能来自离线**。

### 6.3.4 第五批：跨进程 `lifted`（「限制何时失效」必须在链上可见）

**现象**：重启后，一个**曾经带着限制**的会话变成不带限制，但链上**没有任何记录** ——
`restored` 之后没有下文，读者无从判断这些限制还在不在（0007 §3）。

**为什么之前不落**：从**进程视角**，新进程**从来没挂过**这些限制 ⇒ 没有"从有到无"的转变可记，
记了反而是编造（0007 §2.2 这个判断是对的）。但**读者视角**的问题是真实的 —— 而审计链的读者不是进程。

**修法**：`want` 为空且本进程台账里没有"有过→无"的转变时，去查**索引**
（`latestRestrictByAgent()`，与 `restored` 同一份，**零额外 IO**）：
若链上最后一条显示它仍带着限制 ⇒ 落一条 `lifted`。

**🔴 硬要求：必须带 `via` 字段，二选一显式写出。** 省略它就分不清"被摘过"和"推断失效"，
那等于用一个静默点换掉另一个静默点 —— 正是第四批要消灭的东西。

| `via` | 含义 | 判定依据 | `denied` |
|---|---|---|---|
| `'ledger'` | 本进程**确实挂过又摘掉** | 台账 `prev.applied` 非空 | `[]` |
| `'index'` | 本进程**从未挂过**，靠链上索引推断（上一个进程退出时失效） | `isCarrying(索引最后一条)` | **旧名单**（`[...last.denied]`） |

**判据是 decision 白名单 + `denied` 非空**（`isCarrying()`）：

| 链上最后一条 | 带限制？ | 理由 |
|---|---|---|
| `applied` / `restored` / `replaced` | ✅ | 挂上了（`replaced` 只是名单换过） |
| `lifted` | ❌ | 已摘过 ⇒ 再落就是刷屏（**幂等靠这一行**） |
| `untracked` | ❌ | 台账终结、旧层已随 fiber 撤销 |
| `degraded` / `error` | ❌ | **没挂上** ⇒ 不存在"失效"这回事 |
| 无记录 | ❌ | 全新会话 ⇒ 落了就是审计噪声 |

> ⚠️ 判据**不能**写成"denied 非空"就落：`degraded` 和 `error` 的 `denied` 都可能是非空名单
> （`error` 直接写 `denied: want`），但它们**没挂上** —— 记成"限制已失效"就是编造。
> 这条由 `tests/_restrict_index_test.mjs` §9 的反向用例钉住。

**幂等天然成立**：落完之后 `record()` 会把索引增量更新成 `lifted` ⇒ 下次对账 `isCarrying()` 为假 ⇒ 不落。
⇒ 只在"退出受保护阶段后的第一次对账"落一批，**不会每次启动都刷**。

**第三道保护（白名单之外）**：`via:'index'` 的判据依赖"**索引里有该 agent**"，而索引只从链上建
⇒ **从没参与过的会话天然不会被编造一条 `lifted`**（活体实测：给新会话 `0a3c7421` 发消息 ⇒ 零新增）。

### 6.3.5 尾部窗口外的盲区：`history-miss` **与 `want` 的空/非空无关**（0008 §4 对齐）

"查不到历史"这件事与 `want` 的正负**没有关系** —— 前提只有一个：窗口没覆盖全链 ⇒ 查不到 ≠ 没有 ⇒ 本次判断不可信。

| | `want > 0` 时查不到 | `want = 0` 时查不到 |
|---|---|---|
| 后果 | 可能**多挂**一层（本该 `restored` 却落 `applied`） | 可能**漏记一次摘除**（本该 `lifted` 却什么都不落） |
| 可见性 | **看得见**：链上多一条 `applied`，读者至少能起疑 | **看不见**：链上什么都没有，读者不知道这里本该有记录 |
| 读者能否自救 | 能（对着 `denied` 与历史比对） | **不能** |

⇒ **后者才是真正的静默点**，两侧一视同仁地留痕。落盘时带 **`branch`** 字段（`'want-nonempty'` / `'want-empty'`），
让读者一眼知道影响面是"可能多挂"还是"可能漏记"（与 `via` 同一个取舍：判别靠**字段**，不靠读 `note`）。

**🔴 对齐之后必须补的那道闸（否则会刷屏）**：
`want > 0` 侧天然幂等 —— 落完 miss 后 `sync()` 会真的把限制挂上，`record()` 顺带把该 agent 写进索引
⇒ 下次 `history.has(id)` 为真 ⇒ 不再报。**`want = 0` 侧没有这个副作用**：既不挂限制也不落 `lifted`
⇒ 索引永远不会有它 ⇒ 每次 `reconcile()` 都会再报一条。

⇒ 加 **`#missedAgents`（进程内去重）**：每个进程对每个 agent **最多报一次**。
重启（新进程）会重新发现并再报一次 —— 那是对的，永久静默等于把盲区藏起来（用例已钉住两侧）。

**🔴 去重的时机：落盘**成功**之后才标记（0009 §3 补丁）**

```js
// ❌ 错：在循环里先标记 —— #note 吞掉写盘失败（不抛），标记照旧生效
missed.push(id); this.#missedAgents.add(id)
…
await this.#note({ decision: 'restrict-history-miss', … })

// ✅ 对：只有真的写进链了，才叫"报过"
const { persisted } = await this.#noteWithReceipt({ … })
if (persisted) for (const id of missed) this.#missedAgents.add(id)
```

> ⚠️ **注意 `#note()` 不抛异常** —— 它 `try/catch` 掉写盘错误后返回 `null`。
> 所以「把标记挪到 `await this.#note(...)` 之后」**并不解决问题**：那行永远会执行到。
> 必须看**回执**（`persisted`），这也是新增 `#noteWithReceipt()` 的原因；`#note()` 保持原签名不变（其余 9 处调用点不受影响）。
>
> 语义：`#missedAgents` = 「本进程**已经报告成功**的盲区 agent」。进了 outbox（等 `flush()` 重放）
> 算**没报过** —— 那一刻链上没有它，读者看不到。宁可下次重复报一条，不可此刻静默一次。

活体链 47 条 ≪ 窗口 ≈150 条 ⇒ **当前不可达**（只能靠离线长链构造）。

### 6.4 子 agent 口径（明确写出，不做沉默行为）

`ctx.agents.list()` **含子 agent**（`subagent` 也是 scope）。本实现**给子 agent 也挂**同样的限制 ——
子 agent 同样能调 shell，只管主 agent 等于留了个提权口子。若将来要区分，改 `sync()` 的候选集合即可。

### 6.5 阶段不可知 ⇒ **不挂也不摘**（fail-safe，2026-09-25 补丁 1）

`RestrictGovernor.currentPhase()` 读不出阶段时返回 `null`，此时 `reconcile()` / `sync()`
**一个字节都不动**：不 `restrict()`、不 dispose、不动台账，只落一条 `restrict-undetermined`。
理由是"乱挂一层 restriction"和"乱摘一层 restriction"一样糟 —— 拿不到判据时，保留现状是唯一诚实的动作。

**判「不可知」用的是 `readStateStrictSync()`（§7），不是 `readStateSync()`。** 四种形态都返回 `null`：

| 情形 | 旧行为（fail-open，已修） | 现行为 |
|---|---|---|
| 文件不存在 | `null`（靠 `existsSync` 先短路） | `null` |
| IO 错误（权限等） | 回落 `'0.1'` | `null` |
| 文件在但内容不可解析 | 🔴 回落 `'0.1'` ⇒ **摘掉已挂的限制** | `null` ⇒ 保留现状 |
| 合法但没写 `current_phase` / 写成空串 | 🔴 回落 `'0.1'` ⇒ 同上 | `null` ⇒ 保留现状 |

> ⚠️ 别把 `readStateStrictSync` 写成 `try { return parseState(...) } catch { return null }` ——
> **那样修不掉**：`parseState` 本身不抛异常，垃圾内容被它逐行跳过后照样返回一个写满默认值的对象。
> 判据必须是"**文件里到底有没有我们要的键**"，这也是该函数内部走 `parseStateStrict`（稀疏解析）的原因。
> 这条是被 `tests/_restrict_strictstate_test.mjs` 的"改前必须红"逼出来的：字面实现下 3 条用例全红。

### 6.6 第四批的已知边界（必须写死，否则将来会被误读成"没生效"）

1. 🔴 **`restrict-history-miss` 在活体上永远不会触发。**
   触发前提是"尾部窗口（64KiB ≈ 150 条）没覆盖全链"，而当前活体链只有 **36 条** ⇒ 窗口绰绰有余。
   ⇒ 它**只能靠离线合成长链构造**（`tests/_restrict_index_test.mjs` §5 已用 >64KiB 长链实跑）。
   看到"从没出现过"时，**不要**据此判它没生效。
2. 🔴 **`untracked` 的**发射端**在 DSH 现有版本下不可实测（活体上不出现属预期，不是缺陷）。**
   2026-09-26 活验结论：① **UI 没有「关闭会话」这个动作，只有「归档」**，而归档是纯 UI / 存储层操作，
   **不触发 `agent/disposed`**（实测归档一个正处于 `applied` 状态的会话 ⇒ 链上零 `untracked`）；
   ② 进程退出路径也被数据排除 —— `fde-audit/` 下**没有 outbox 文件**（只有 `gate.jsonl` / `phase.jsonl`），
   四次重启（09-25 12:02 / 13:28、09-26 10:05 / 10:14，重启前会话确实带着限制）**全都没有 `untracked`**。
   ⇒ 该决策的实现正确性**只能由离线用例覆盖**（`tests/_restrict_index_test.mjs` §3 / §8）。
   **看到"从来没出现过"不要判它坏了 —— 是没有可达路径。**
3. **查不到历史 ⇒ 一律退化成 `applied`，绝不退化成"不挂"。**
   宁可记错一个 decision，也不能因为查不到历史就不给 agent 挂限制（fail-safe 方向）。

另外：`untracked` 有**门** —— 只有"确实带着限制的会话"才落（与 `lifted` 同口径）。
从没挂过限制的会话被销毁**不落**，否则每个会话关闭都刷一条，真正的信号会被淹掉。

5. **「零 `lifted`」在第五批之后不再是默认期望。**
   第四批活验时判断"重启后零 `lifted` 是正确的"（本进程没挂过，没转变可记）——那是**当时**的正确行为；
   第五批落地后，同样场景下应落 **N 条 `via:'index'` 的 `lifted`**（N = 链上仍带着限制且本次进注册表的 agent 数）。
   ⇒ 判读链时**按 `via` 分**：`ledger` = 真摘除，`index` = 跨进程失效。**不要笼统统计 `lifted` 条数。**
6. **跨进程 `lifted` 在窗口未覆盖全链时同样会漏判** ⇒ 落 `history-miss` + `branch:'want-empty'`（§6.3.5）。
   活体链 47 条 ≪ 窗口 ≈150 条 ⇒ **当前不可达**，只能靠离线长链构造；**看到"从没出现过"不得据此判它没生效**。
   `history-miss` 的进程内去重（`#missedAgents`）只挡刷屏，**重启后会重新报告**（盲区仍在 ⇒ 该报）。
7. 🟡 **判读时不要拿 `AuditChain.pending == 0` 当"没丢过"的证据 —— 那是假阴性。**
   `#outbox`（`audit.js:51`）是**内存数组**，不是文件 ⇒ **进程退出即丢**。
   ⇒ `pending` 只在本进程存活期内有意义；**重启后再查它一定是 `0`，而这不能证明没丢过**
   （2026-09-26 §4 修订：早先这里写的是"若怀疑，查 `pending`"，那句话会把人引向假阴性 ——
   他去查了、看到 0、于是判"没丢过"，恰好是本条要防的那个错误，只是换了一层）。
   要判"重启前有没有丢过"，只能看**磁盘链本身有没有缺口**。

   **写盘失败本身是静默的（同族，已知未修，刻意）**：`#note()` 吞掉所有写盘错误，只以 `seq === null` 表达；
   `AuditChain.record()` 落盘失败时**照旧返回 `seq`**（只是 `persisted:false`）。
   ⇒ **"链上没看到某条 decision"不等于"没发生"，也可能是"没写进去"**。
   唯一例外是 §6.3.5 的盲区去重闸门：那处必须知道成败，走 `#noteWithReceipt()` 看 `persisted`。
   其余调用点（限制本身是否挂上）**不依赖审计成败** —— 那是刻意设计：记录属性失败不得让"限制"崩掉。

8. ✅ **假断链（写盘成功/失败交错）已修 —— 补丁 3，`AuditChain.#degraded` 排队闸（2026-09-26）。**
   形态：`record()` 里 `#head` **无条件前进**，失败的只进 outbox ⇒ 若下一条抢先写盘成功，
   磁盘上出现 `A → C`，而 `C.prevHash` 指向**磁盘上从未存在**的 `HB`（实测：`disk = ['A','C']`）；
   `flush()` 把 B 追加到**链尾** ⇒ 变成 `A, C, B`，**顺序反了，仍然断**（两种形态均已在离线下复现）。

   > 🔴 **运行时不会报**：`#restoreFromTail()` 只找"最后一条 hash 合法的行"，**不校验 `prevHash`**
   > ⇒ 它静默采纳，一声不吭。**只有外部校验器（逐条查 `prevHash === 前一条 hash`）会红。**
   > 更糟的一层：`flush()` 之后磁盘末行是 B ⇒ 重启恢复把 `#head` **退回到 `HB`**，
   > 后续记录挂到 B 下面 —— 而 C 也是 B 的孩子 ⇒ **真分叉**（两条同父记录）。
   >
   > **⇒ 若将来见审计链报断链，先排除"写盘交错"，不要立刻判篡改/损坏。** 不是本批引入的
   > （`lib/audit.js` 格式照搬 gate，从第一批就在），但**这与本批主题同源**：链式字段的连续性
   > 假设在失败路径下不成立（与 `dsh-audit-chain-fork-trap` 同一个根）。

   **修法**：`#degraded` —— 上一条没写进磁盘 ⇒ **后续记录一律进 outbox**，不再尝试写盘，直到 `flush()` 成功；
   `flush()` 把失败的按**原序**放回队首。⇒ 磁盘要么停在 A（`A` 连续），要么 flush 后是 `A,B,C`（连续），**永不错序**。
   副作用（刻意的）：写盘持续失败期间**所有**记录都在内存里 ⇒ `pending` 单调涨，链停在最后一个成功点。
   ~~⚠️ **同一个缺陷在 `dsh-fde-ontology-gate/lib/audit.js` 里存在（源码逐行对照一致）**，按边界（不动门禁实现）**未改**，待单独立项。~~
   > ✅ **已订正（2026-09-29）**：这段话**已过时**。gate 侧**同一道闸已在位** ——
   > `dsh-fde-ontology-gate/lib/audit.js:55` 有 `#degraded = false`，`:170-189` 是排队闸
   > （注释自述「2026-09-26，移植自 phase 补丁 3」，`:180` 的拒绝理由为「前一条尚未落盘 ⇒ 本条一并排队（保序）」）。
   > ⇒ **不是"未改、待立项"，是"已于 2026-09-26 移植过去"**。

4. **「打开会话」在 DSH 上没有"只看不碰"的路径，且常常不必做。**
   端点清单里**没有** `session/open` / `resume` / `load`（只有 `list` / `page` / `prompt` …）
   ⇒ 让一个**冷**会话被构造的唯一途径是 `session/prompt`（发一条消息），那必然触发一个模型回合。
   但 **DSH 启动会把"上次活跃"的会话 replay 进内存** ⇒ 判据 2 的 `restored` 常常在**开机 6 秒内自动落**
   （实测 `#37` @启动后 6s），**不需要人工打开会话**。写活验操作序时：先 `list` / 先读链，再决定是否要发消息。

### 6.7 索引的读取路径（单一，不新开第二条）

`AuditChain` 里只有 **`#readTailLines()`** 一处尾部读取：链头恢复（`#restoreFromTail()`）与
「agent → 最近一条 restrict 决策」索引共用它。索引在**构造期**从尾部窗口建，`record()` **增量更新**
⇒ 零额外 IO。上层（`RestrictGovernor`）用可选接口 + duck typing 取：

```js
this.#audit?.latestRestrictByAgent?.()   // 不存在 ⇒ null ⇒ 退化为 applied（fail-safe）
```

`get tailTruncated` 说明窗口是否**未覆盖全链**（`size > TAIL_BYTES`，或窗口内第一行可解析记录的
`prevHash !== GENESIS`）——"查不到"到底是"没有历史"还是"盲区"，靠它区分。

---

## 7. state.yaml 与单写者锁

落点：`<projectRoot>/memory/state.yaml`（文件不存在时由插件首次创建，不报错）。

```yaml
schema_version: 1
current_phase: "0.1"
phase_status: in_progress      # in_progress | done
ontology_version: 1
revision: 0                    # 每次成功写入 +1（乐观并发）
updated_at: "2026-09-24T…Z"
rollback_at: ""                # C3：回滚观察期起点（ISO），空串=不在观察期
```

**两种同步读，语义不同、不可互换**（这是 §4.7 与 §6.5 那两个问题的根）：

| 函数 | 读失败时 | 给谁用 |
|---|---|---|
| `readStateSync()` | 回落 `{...DEFAULT_STATE}`（`current_phase: '0.1'`） | **guard** 的门禁判定 —— 它需要"文件不在就用初始状态"这个语义（第一批已验收，别动它） |
| `readStateStrictSync()` | 一律 `null` | **restrict 治理器** —— 它拿"当前阶段"决定要不要**撤掉**保护，读失败必须等价于"不可知"（§6.5） |

> 🔴 一句话记住差别：**要**乐观回落的用 `readStateSync`；**绝不能**把"读不出来"误当成某个具体阶段的用 `readStateStrictSync`。

**锁**：`<projectRoot>/memory/.state.lock`
- 获取：`open('wx')` 原子排他；抢不到且「超过 `lockTtlMs` **且** 持有 PID 已不存在」→ 强夺并写审计（`decision: 'lock-steal'`，`oldPid` = 被抢走的那个）；否则 fail-closed 抛错（不重试等待）。
- ⚠️ **A2（锁残留 PID 检测）**：自动释放是**双条件** —— `now - at > ttlMs` 只是其一，还必须 `process.kill(pid, 0)` 探不到持有进程（`ESRCH`）。进程还活着就**不抢**（可能在做长任务，锁仍有效），只有进程死了的**残留锁**才自动释放。pid 缺失 / 非法 / 非正整数 → 判「无法确认已死」→ **不抢**（fail-closed，与"坏锁不判过期"同一方向）。
- 竞争被拒**也留痕**：拒绝前落一条 `decision: 'lock-contended'`（`holderPid` = 仍持有者；`holderAt` / `ttlMs` 供审读者自己复算"当时过没过期"；**`parseable`** = 锁文件是否能解析，`false` 即"读不出"，**这是区分"真未过期"与"锁坏了"最干净的判据**），并把审计号拼进错误文案 —— 与 D1 被拒同形态，模型拿得到定位锚。审计写失败用 `.catch` 吞掉：**拒绝是安全属性，记录失败不能把 fail-closed 变成 fail-open**。
- 错误文案**按三分支**，因为三条路径的**事实与补救动作完全不同**：
  - `parseable: true` 且未过期 → 「锁未过期。稍后重试，或确认没有并发写。」+ 持有者 pid + 审计号。
  - `parseable: true` 且超时、但持有进程仍存活 → 「锁已超时，但持有进程（pid=…）仍存活，不自动释放。」+ 审计号（**A2 后新增的一支**：超时不再等于"可抢"，进程活着就不抢，先确认真相）。
  - `parseable: false` → 「锁文件不可解析：半写/损坏，无法判定是否过期。**该锁不会自行过期** —— 请确认没有并发写后，手工删除 `<锁路径>` 再重试。」+ 审计号（**不出现**「未过期」二字，也不拼"持有者 pid"那段，否则是半截句）。
  - ⚠️ 不可解析时 `at = NaN` → `stale` 被短路为 `false`，**"过没过期"这个判断根本没做出** —— 文案若沿用"未过期。稍后重试"就是说谎，且会把模型推向等待（活体实测：模型据此提出"等到过期时间"），违反"不重试等待"的纪律。
- 写入：写前重读 → `revision +1` → 写 `.tmp` → `rename()` 原子覆盖。释放放 `finally`。
- ⚠️ `acquireLock` 必须留在 `writeState` 的 `try` **之外**：挪进 `try` 会让 `finally` 的 `releaseLock` 顺手**删掉别人的锁**。`tests/_fde_phase_test.mjs` 有专门一条断言拦这个退化。

**运维须知（两条，都是"看起来像故障、其实不是/是"的分水岭）**

1. **A2 之后，强夺只发生在「超时 + 持有进程已死」双条件齐备时** —— 也就是**残留锁**（最常见：进程崩溃 / 被 kill / 机器重启后留下的孤儿锁）。**正常并发写**（另一进程还活着）即使超过 `lockTtlMs` 也**不会被抢**，会走「锁已超时但持有进程仍存活」分支拒绝并提示先确认真相。`lock-steal` 记录是"自动清掉了一个残留锁"的凭证，**不是告警**。`lockTtlMs` 默认 `30000`：它现在决定的是"多久没动静 + 进程已死"才自动释放，而不是"到点就抢"。
2. **锁文件不可解析 = 判为「不可解析」并拒绝**（半写 / 损坏 → `JSON.parse` 失败 → **`at = NaN`，"过没过期"这个判断根本没做出** —— **不是**判它过期）。两条路径虽然共用同一个拒绝出口，但**事实与补救完全不同**：真未过期要"等它释放"，坏锁**永远不会自行过期**。后果是**一个坏锁会把后续所有写入挡在门外**；审计里 `parseable: false` 就是这条分支的判据（`holderPid` / `holderAt` 为 `null` 表示"读不出"，而非"没有持有者"）。**恢复手段只有一条：确认没有并发写后，手工删除 `.state.lock`** —— 等它过期是无效的。

---

## 8. 跨插件事件契约（与 dsl 共用）

```
事件名：fde/check-result        ← 不带 internal/ 前缀
payload：{ check: 'D1'|'D2'|'D3'|'D4'|'D5', passed: boolean, anchor: {...}, detail: string, at: string }
```

**⚠️ `anchor` 的形态由 `check` 决定（Stage 5.5 起）** —— 三种 check 各自锚自己的文件：

| check | 生产者 | alg | anchor 形态 |
|---|---|---|---|
| D1 | dsl `fde-run-guardrails-check` | `sha256(actions+\u0000+guards)@v2` | `{alg, files:[actions.yaml, guards.yaml], sha256}` |
| D3 | dsl `fde-run-validation` | `sha256(objects+\u0000+logic)@v1` | `{alg, files:[objects.yaml, logic.yaml], sha256}` |
| D2 | **本插件** `fde-run-audit-check` | `audit-chain(len+head)@v1` | `{alg, files:[gateAuditPath], len, sha256}` |

alg 表在 **phase `lib/mirror.js` 与 dsl `lib/tools.js` 各有一份**（两个独立安装的包，不能跨 import，
否则一个包没装会拖垮另一个）⇒ 一致性由 `tests/_fde_d2d3_test.mjs` 的"两侧逐项相同"用例机器钉住。

**为什么要分派**（这条是这批改动的根）：早期实现里 `verify()` 恒拿 D1 的 alg 比 ⇒
D3 的结论会被 D1 的判定口径判过期、或反过来永远新鲜。**每个 check 锚自己的文件，就必须按 check 取 alg。**
分派的两个直接后果：
- 改 `objects.yaml` ⇒ **只有 D3 失效**，D1 / D2 结论照旧（反之亦然）——完成判据 #3/4 是一对，必须两条都测。
- D3 挂着 D1 的 alg ⇒ **fail-closed 拒绝**，不会被当成"形态兼容"放行。

- **dsl 负责算 D1 / D3**：跑校验 → 算复合 sha256 → `ctx.emit('fde/check-result', …)`。**dsl 不写任何状态文件、不持审计链。**
- **本插件负责算 D2**：`fde-run-audit-check` 全量读 `gate.jsonl` 逐条验接续 → 广播 `{len, 链头 hash}`。
  为什么 D2 的工具在本插件而不是 gate：它要判的是"能不能推进"，这个动作在这里。
- **phase 负责记 + 判**：`ctx.on('fde/check-result')` 收下 → 写自己的哈希链 → 更新内存镜像。
  guard 只**同步**比对内存镜像（`guard.js` 的 `runDenyChecks`）：D1/D3 重算文件复合哈希，D2 比 `len` + 链头 —— 都不读全链。
- **phase 负责记 + 判**：`ctx.on('fde/check-result')` 收下 → 写进 phase 自己的哈希链审计 → 更新内存镜像。guard 只读内存镜像，并**同步**重算当前 `actions.yaml` + `guards.yaml` 的复合 sha256 与镜像里的 `anchor` 比对；不一致或镜像为空或 `alg` 过期 → **deny（fail-closed）**。
- **重启后**：phase 在 `apply()` 期用**同步 fs 读**审计文件尾部重建镜像。所以重启不丢结论，但**改了 actions.yaml / guards.yaml 任一文件结论必然失效**——这正是要的性质（堵住"只改 guards 放宽 impl"的绕过）。
- ⚠️ **广播方（dsl）必须 try/catch 包住 emit**，不能让校验因为广播失败而失败。接收方（本插件）也用同步函数 + `.catch` 兜底，避免异步 reject 变 unhandled rejection。

**为什么 guard 里敢做同步 IO**：只读一个 <1KB 的 yaml 算哈希。这是"结论绑定当前 ontology 内容"的唯一可行办法，代价明确、可接受。

---

## 9. 安装 runbook

1. 复制本插件到 DSH 已安装副本目录：
   ```
   E:\DSH-desktop\DeepSeek Harness\data\dsh-home\profiles\web\node_modules\dsh-fde-phase\
   ```
   **⚠️ 还必须在本 preset 的 `cordis.patch.yml` 里登记装载项**，否则 loader 不会扫描该目录、插件根本不会被装载（活验踩过的坑：文件进了 node_modules 但 `fiberPhase` 列表里查无此插件）。`insert:` 里加：
   ```yaml
   - id: dsh-fde-phase
     name: 'dsh-fde-phase'
     config:
       projectRoot: 'E:\DSH-desktop\DeepSeek Harness\data\dsh-home\fde-state'
       ontologyRoot: 'E:\ontologyRoot'
       mode: enforce
       auditPath: 'E:\DSH-desktop\DeepSeek Harness\data\dsh-home\fde-audit\phase.jsonl'
       lockTtlMs: 30000
   ```
   改 `cordis.patch.yml` 是**热生效**，无需重启即可看到 `fiberPhase: active`、`failed: 0`。
2. 配置 `projectRoot` / `ontologyRoot` / `mode`（也可直接写在上面的 `cordis.patch.yml` 里，先 `shadow` 跑观察，准确率够了再切 `enforce`）。
3. 跑预检（**必须在已安装副本目录里跑**，才能解析到真 SDK）：
   ```powershell
   cd "E:\DSH-desktop\DeepSeek Harness\data\dsh-home\profiles\web\node_modules\dsh-fde-phase"
   & "C:\Users\DELL\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" precheck.mjs
   ```
   - 退出码 `0` 通过；`2` 跑在桩环境（位置不对）；`3` 注册/校验失败。
4. **重启 DSH**（改 `lib/*.js` 只重启进程有效，翻 mode 无效）。launch token 每次启动变。
5. **新建会话 → 第一步切 `standard` preset**（见 §0：默认 `ptc` 下模型无工具可用），再验证：让模型自报工具清单 → 含 `fde_phase_advance`（与 dsl 的 `fde-run-guardrails-check`）；`pluginInventory` → `dsh-fde-phase` `fiberPhase: "active"`、`failed: 0`。
6. 端到端验收（与 dsl 联动）：
   - 无 D1 记录时 advance → `tool/result.isError === true`，文案含审计号；审计流找 `seq === NN` 的 `decision === "deny"`。
   - 先跑 `fde-run-guardrails-check`（过）→ 再 advance → 成功，`state.yaml` 的 `current_phase` 变化、`revision +1`。
   - 改 `actions.yaml`（走 `fde_ontology_write`）→ 再 advance → **重新 deny**（"D1 结论与当前 ontology 不符"）。
   - 手工造一个**未过期**的 `.state.lock` → advance 被拒、文案含「**未过期**」+ 持有者 pid + 审计号；审计流有 `decision === "lock-contended"` 且 `parseable: true`；**锁文件原样保留**（不得被删）。
     ⚠️ 时序陷阱：`lockTtlMs=30000` 而一次模型回合 30–90 秒，只写一次时间戳会被判过期、测成"强夺成功"。要么用持续刷新的持有者，要么用离线用例覆盖这半。
   - 造一个**过期**的 `.state.lock` → 强夺成功，审计有 `decision === "lock-steal"`（`oldPid` = 被抢走的那个）。
   - 往 `.state.lock` 写 `'not json'` → advance 被拒，文案**含「不可解析」且不含「未过期」**、带审计号、给出手工删锁路径；审计有 `lock-contended` 且 `parseable: false`、`holderPid === null`；锁未被删、`state.yaml` 未变。
7. **break-glass 端到端验收（E1，spec §11）** —— 先取工具面基线，再逐条：
   - **工具面**：重启后开新会话，对 `request/header` 做**逐名 diff**（**不能只看总数**：新工具注册会让总数不降反升）。
     期望恰为 `新增 ["fde-break-glass"]`、`移除 []`。
   - **正面**：在**确实被拦**的门禁上（如阶段 3 的 D1）真调一次 `fde-break-glass` → 通过后同一发 advance **放行**；
     审计流里 `phase.jsonl` 有 `break-glass`（open）与随后的 `break-glass-bypass`（`callAllowed` 如实），
     `gate.jsonl` 有**同一 id** 的 `break-glass`（证明"各写各的链"这条接线真的在跑）。
   - **负面（方向不能反）**：approval 拿不到回答（无 answerer ⇒ `unavailable`）时**必须被拒**（`BG_NOT_CONFIRMED`），
     且**不得**留下 open 记录 —— 这是与 D4 ask 相反的那一半，只能在这里验。
   - **纵深防御**：对**没在被拦**的门禁砸玻璃 → 被拒（挡"预防性砸玻璃"）。
   - **零污染**：以上对**真链**的所有改动都应来自真实调用；验收前后核对真链行数 / 字节 / sha256，
     不应出现"只为测试而写的行"。

---

## 10. 文件约定

| 文件 | 职责 |
|---|---|
| `lib/config.js` | 纯 JS 零依赖的 `normalizeConfig()` + `DEFAULTS`（fail-closed 唯一权威） |
| `lib/config-schema.js` | schemastery，仅供 DSH 配置面板提示 |
| `lib/deny-ids.js` | break-glass 的 deny-id 权威表（`BYPASSABLE_*` / `ANCHORED_*` / 分类 / `makeEventId`）。**与 gate 同名文件逐字相同**（跨包不能 import，`tests/_fde_e1_crosspkg_test.mjs` sha256 对拍） |
| `lib/bg-mirror.js` | break-glass 放行表**内存镜像**（`restoreSync` / `update` / `isBypassed` / `openRecords` / `overdueRecords`）。同上，与 gate 副本逐字相同 |
| `lib/break-glass.js` | 放行表**持久化**（`memory/break-glass.json`，原子写）+ 同步锚点 `currentAnchorSync()`。**只在 phase**（gate 不持有这张表） |
| `lib/break-glass-tool.js` | 工具 `fde-break-glass`：硬校验 → approval → 写文件 → 写链 → 更新镜像 → 广播（顺序见 §11） |
| `lib/break-glass-notify.js` | `agent/session-start` 提醒"有 N 条待补正"（R6）；塞不进 inbox **不许静默**（落 `break-glass-notify-failed`） |
| `lib/audit-listener.js` | `tools/pre-execute` 审计监听（deny / shadow-deny / `check-skipped` / **break-glass 的 bypass 留痕与自动补正**）。⚠️ 从 `index.js` 抽出，理由见该文件头（index.js 要 schemastery ⇒ 离线测不到） |
| `lib/phases.js` | 15 个 Phase 权威表 + `DENY_CHECKS` 映射 + `nextPhase()` + `IMPLEMENTED_CHECKS` |
| `lib/audit.js` | 哈希链审计（格式照搬 gate） |
| `lib/approval.js` | `askApproval(ctx, exec, reason)` —— approval 底座（D4 ask / D5-pre 共用，0089） |
| `lib/state.js` | state.yaml 读写 + 单写者锁 + 原子 rename + revision + `rollback_at` 观察期（`inObservation`） |
| `lib/mirror.js` | D1 结论内存镜像（`restoreSync` / `update` / `verify`） |
| `lib/guard.js` | 同步判定纯函数 `evaluate` + `installGuard` |
| `lib/check-d2.js` | D2 检查（`fde-run-audit-check`，Stage 5.5） |
| `lib/remote-state.js` | D1/L4：读 `<projectRoot>/memory/outbox/state.json`（**别的插件写的**）+ `evaluateRemote` 纯判据 —— 与 memory 侧**逐字同解**，靠 `tests/_fde_d1_test.mjs` F 组对拍（§5.2） |
| `lib/check-d5.js` | D5 检查（`fde-run-compliance-check` + `verifyComplianceText`，Stage 5.6） |
| `lib/compliance-write.js` | `writeComplianceDataPolicy` —— D5-pre 确认后写 `compliance.yaml` 的 `data_policy`（B3） |
| `lib/change-flow.js` | C2：`REQUIRED_CHECKS` / `NEEDS_APPROVAL` 表 + `readLatestChange`（读 gate 链取级别）+ `verifyRequiredChecks` + `describeIncomplete` |
| `lib/tools.js` | 注册 `fde_phase_advance` + `fde_rollback`（C3 回滚独立通道）+ `fde_change_close`（C2 变更闭环）；落盘成功后触发 restrict 全量对账（§6 第 ② 点） |
| `lib/restrict.js` | `desiredDeny()` / `parseUnknownNames()` 纯函数 + `RestrictGovernor` 生命周期治理（§6） |
| `lib/index.js` | `apply()`：装配 restrict / guard / 工具 / 审计监听 / `fde/check-result` 监听 / **D1 镜像与 break-glass 放行表的恢复** |
| `precheck.mjs` | 用真 SDK 跑注册 + schema 校验 |

---

## 11. break-glass 逃生门（E1，spec §11）

紧急逃生门：当门禁**本身判错**、遇到**规则没覆盖的现场边界**、或 FDE 为了赶事故必须绕过时，
给一条**留痕的**绕行通道。它**不是**"谁都能翻案的后门"—— 放行只能开在门禁自己的判定里。

### 11.1 一次砸玻璃的完整链路（顺序不可换）

1. **硬校验**（与用户回答无关，全过了才弹窗）：`deny_id` 合法且**当前确实在拦** / 理由非空 / 分类合法。
   先弹窗后校验是错的形态：用户先答了"确认绕过"才被告知"你填的 D9 不存在"—— 白打扰，
   而且会让人以为"多试几次就能绕"。
2. **approval**：`allowed-once` 才继续；`rejected` / `cancelled` / **`unavailable` 一律中止**（§4.12 g）。
3. **写文件** `<projectRoot>/memory/break-glass.json`（durable、可失败、**失败即拒**）。
4. **写链** `phase.jsonl` 的 `break-glass`。
5. **更新内存镜像** ⇒ 放行**立即**生效。
6. **广播** `ctx.emit('fde/break-glass', …)` ⇒ gate 更新自己的镜像并写**自己的**链。

⚠️ 第 3 步先于第 4 步是**有意**的：链写失败是 fail-open（`audit.record` 内部吞），于是会出现
"文件里有、链上没有"；重启后镜像从**链**恢复 ⇒ 那条放行消失。**这正是要的**：
放行与记录**同生共死**，不会出现"绕过了但查不到是谁放的"。

### 11.2 三类分类（`deny_defect` / `scope_edge` / `evasion`）

spec §11 给了三类的含义与优先级，但**没给自动判据**（"理由充不充分"是语义判断）
⇒ 本项目**只记录、不自动判级**，由发起人自选，指标里按类分列。

### 11.3 补正期与超期（R5 / R7）

- **R5 自动补正**：每轮推进时，某条 open 记录对应的门禁**这一轮通过了** ⇒ 文件 + 镜像 + 链三处一起标
  `resolved`，并广播给 gate。判据只覆盖本阶段**真跑了的、已实现的** check（`D1/D2/D3/D5`）
  —— 没跑的检查谈不上"通过了"。
- **R7 超期**：7 天补正期到了**不撤销放行**，只持续红色警告 + 计入指标（理由见 §4.12 e）。
  `overdueRecords()` 是 `now` 的函数、**不写盘**。

### 11.4 与 gate 的分工（一句话）

**phase 生产放行 + 写自己的链；gate 消费放行 + 写自己的链**。两条链都各含一对
`break-glass` / `break-glass-resolved`，所以**两个插件的重启顺序无关**。
细节（含"哪些 deny-id 可绕"钉在哪一行）见 gate README 的「break-glass 逃生门」节。

### 11.5 验收（离线四层 + 活验一层）

| 层 | 套件 | 覆盖 |
|---|---|---|
| 离线 | `tests/_fde_e1_test.mjs`（62 断言） | deny-id 表 / 镜像 / 持久化 / 两个 guard 的放行 / 五道闸门 / 提醒 / 两个监听器 |
| 跨包 | `tests/_fde_e1_crosspkg_test.mjs`（7） | `deny-ids.js` / `bg-mirror.js` 两份副本 **sha256 逐字相同** + 行为等价抽查 |
| 变异 | `tools/_fde_e1_mut.mjs`（20）/ `tools/_fde_e1_wiring_mut.mjs`（6） | 每条断言都被**期望的具名断言**抓住（RED 26 / GREEN 0 / INVALID 0） |
| 接线 | `tests/_fde_e1_wiring_test.mjs`（19，**import 部署副本**） | "重启后从**自己**的链恢复出放行"这条端到端主张、`P0-1` 同型（监听器被当场注销）、阶段 3 的 D1 放行与锚点失效 |
| 活验 | 见 §9 第 6 步 | 工具面 diff 恰为 `+fde-break-glass`；真调一次；无 answerer ⇒ 拒 |

**D1/L4 的验收**（在 memory README §2.3 亦有索引，因为套件是**跨包**的）：

| 层 | 套件 | 覆盖 |
|---|---|---|
| 离线（跨包） | `tests/_fde_d1_test.mjs`（107 断言） | E 组 = L4 判据五个分支（不适用 / present / degraded / missing / 读不到）+ 两个反例；F 组 = 跨包字面量与 `evaluateRemote` 20 组对拍；G 组 = 回执双向 |
| 变异（跨包） | `tests/_fde_d1_mut.mjs`（26 条） | 每条断言都被**期望的具名断言**抓住（含 M21「L4 不通过却放行」、M22「链不完整也被忽略」、M23「只改一侧」、M24/M25「回执不说 / 无条件说」） |
| 活验①**交付态**（✅ **已做**，2026-09-29） | `tools/_fde_d1_live.mjs live`（**纯只读**，用户手动重启 DSH 后跑） | **17/17 全绿**。验的是：D1 代码在真进程里 apply 成功（写出 `telemetry-disabled`，`seq=433`，且链上 `telemetry-*` 只有这一种）/ 该记录读作"配置选择不是故障" / **L4「本地链完整」在活体上真算过**（434 条按 `seq` 重放：断链 0、哈希不符 0、无重号无缺号、链尾 head == 末行 hash；含负向自证 `C7`）/ 未配端点 ⇒ `outbox/` 与 `state.json` 都不存在 / 四个 fde 插件全 `fiberPhase: active` |
| 活验②**端到端**（🔴 **未做**，PoC 内放弃） | `prep` → `v1`–`v5` → `restore` ＋ 桩 `tools/_fde_d1_stub.mjs` | **未验的**：真进程里的心跳投递 / 入队出队 / 降级三档 / 恢复补传 / `crossCheckRemoteSync` 对**真实** `state.json`（由真进程写的）的判定。**为什么没做**：要改 `cordis.patch.yml` 并重启 DSH **两次**，超出"只读活验"范围。⇒ ⚠️ 交付文案只可写"L2/L3 有离线证据（注入 `fetchImpl`）与本地桩设计，**未在真实进程里跑过**" |
