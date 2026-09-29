# 功能清单与需求完成对照表 · FDE Copilot

> **本文的用途**：回答「当初说要做的，最后到底做了没有、做到什么程度」。
>
> **本文的证据规则**（沿用本项目全程的纪律）：
> 1. **每一项都必须带可复算的证据坐标**——`文件:行号` + 测试套件 + 活验引用（审计链序号或回执文件）；
> 2. **grep 命中 ≠ 实现**——注释里写「本单不做」也会命中关键词，必须打开源码确认有可执行逻辑；
> 3. **「未验」与「未做」是两回事**，本文分列，不混为一谈。

---

## 一、完成度总览

| 口径 | 数量 | 说明 |
|---|---|---|
| spec v3 要求的已实现项 | **19** | 逐条见 §3 |
| 其中**完整活验**（真进程内验证过） | **15** | — |
| 其中**部分活验**（接线已验，核心判据仅离线） | **2** | D3 铁律、A2 锁 |
| 其中**部分未验**（功能已实现，某条路径未在真进程跑过） | **2** | E3 调用层、D1 端到端 |
| **功能层面「未实现」的项** | **0** | — |
| **设计偏离**（有意不照 spec 做，已记录理由） | **3** | F1 / F2 / F3 |
| **PoC 降级**（实现方式弱于 spec 要求） | **2** | 见 §5 |
| 离线回归套件 | **41 套，全绿** | `tests/_run_all_tests.sh` → `ALL-TESTS-GREEN` |

> ⚠️ **请特别注意这个区分**：本项目**没有「功能没做完」的项**。剩下的 4 项（2 部分活验 + 2 部分未验）都是**验证证据不全**，而不是**功能缺失**。每一条的具体原因见 §4。

---

## 二、完整功能模块列表（按插件二级拆分）

### 2.1 `dsh-fde-ontology-gate` · 本体门禁

| 一级 | 二级功能 | 状态 |
|---|---|---|
| **入口管控** | 写本体的唯一入口 `fde_ontology_write` | ✅ |
| | 自定义路径兜底拦截（绕过标准路径写本体也会被拦） | ✅ |
| | 保留工具名保护（`run_code` 等不许被限制/占用） | ✅ |
| **变更分级** | L0 / L1 / L2 三级分类（按**语义载荷**判定，不按文件名） | ✅ |
| | 分级结果驱动后续流程差异 | ✅ |
| **影子模式** | `shadow`（只记不拦）与 `enforce`（真拦）双模式 | ✅ |
| | 影子模式准确率指标（误拦率 / 漏拦率） | ✅ |
| | `enforce` 准入门（双阈值，达标才许切到真拦） | ✅ |
| **审计** | 本地审计链（哈希链，可重放验真伪） | ✅ |
| | 拒绝留痕（含 `deny` 原因与序号） | ✅ |
| | 遥测指标采集（spec §14 六指标） | ✅ |
| | 逃生门（break-glass）独立留痕 | ✅ |
| **跨插件** | 本体文件解析（4 个受控 YAML 的结构校验） | ✅ |
| | 探索沙箱豁免（`experiments/` 不进分层注入） | ✅ |

### 2.2 `dsh-fde-dsl` · 受限 DSL 校验

| 一级 | 二级功能 | 状态 |
|---|---|---|
| **规则可信度（D3）** | 规则可编译性校验 | ✅ |
| | 边界值反例用例集（每条规则必须有能证伪它的用例） | ✅ |
| | **`DraftReference` 铁律**：`deny` 规则不得引用未定稿属性 | ✅（核心判据仅离线，见 §4.1） |
| | 用例集指纹（内容变化可检测） | ✅ |
| **护栏绑定（D1）** | `guardrails[].ref` 必须解析到已注册条目 | ✅ |
| | 护栏实现必须可编译（纯字符串描述**一律不通过**） | ✅ |
| | 测试通过率必须 100% | ✅ |
| | 写操作分支必须被覆盖 | ✅ |
| | `writes: true` 的动作必须有 `deny` 级护栏 | ✅ |
| **广播** | 校验结论通过 `fde/check-result` 事件广播给 phase 插件 | ✅ |

### 2.3 `dsh-fde-phase` · 业务阶段机

| 一级 | 二级功能 | 状态 |
|---|---|---|
| **阶段状态机** | 15 个 Phase 的权威表（Zone A/B/C/D） | ✅ |
| | 推进规则 `current → next(+1)`（不许跳跃） | ✅ |
| | `fde_phase_advance` 唯一推进入口 | ✅ |
| | 守卫同步否决（拦在入口，不靠自觉） | ✅ |
| **门禁校验** | D1 护栏绑定（Phase 3） | ✅ |
| | D2 审计链完整性（Phase 4） | ✅ |
| | D3 规则反例（Phase 4） | ✅ |
| | D5 合规（Phase 6） | ✅ |
| | **结论哈希锚定**（被校验文件一改，旧结论自动失效） | ✅ |
| **并发控制** | 单写者锁（原子排他创建） | ✅ |
| | **锁残留检测**：超时 + PID 已死双条件才强夺 | ✅（2/3 分支活验，见 §4.2） |
| | 原子写（tmp + rename） | ✅ |
| | `revision` 乐观并发 | ✅ |
| **人工确认** | D4 客户验收（`ask`，Phase 10） | ✅ |
| | D5-pre 数据授权（`ask`，Phase 2） | ✅ |
| | `ctx.approval` 接线（拒绝/确认双向留痕） | ✅ |
| **变更闭环** | L0/L1/L2 各自流程 | ✅ |
| | 变更闭环判定 `fde_change_close`（fail-closed：判不出级别就拒绝） | ✅ |
| **回滚** | 回滚预授权（D5 第 5 键） | ✅ |
| | 独立回滚通道 `fde_rollback` | ✅ |
| | 24h 观察期冻结（期间禁止推进） | ✅ |
| **逃生门** | `fde-break-glass`（理由必填 + 三类分类 + 7 天补正期） | ✅ |
| **工具面过滤** | 受保护阶段隐藏 shell/code 类工具（`restrict`） | ✅ |
| **合规** | `compliance.yaml` 原子写入（只覆盖 `data_policy` 键） | ✅ |

### 2.4 `dsh-fde-memory` · 记忆系统

| 一级 | 二级功能 | 状态 |
|---|---|---|
| **决策记录** | 读上下文 `fde_memory_context` | ✅ |
| | 写决策 `fde_memory_write_decision` | ✅ |
| | **`source` 防污染**（防伪造来源） | ✅ |
| | 复核 `fde_memory_review` | ✅ |
| | 逐条确认 `fde_memory_confirm`（一句话理由**必填**） | ✅ |
| **成熟度** | `draft / verified / locked` 单向流转 | ✅ |
| | 变更历史 | ✅ |
| **置信度** | 规则化推导（**模型禁写**） | ✅ |
| **检查单** | 读写与摘要 | ✅ |
| **干系人** | 读写与摘要 | ✅ |
| **探索沙箱** | 实验写入 / 读取 / 列表 | ✅ |
| **SCHEMA 版本** | 版本链式迁移 | ✅ |
| | **迁移失败 ⇒ 降只读**（写入 fail-closed、读取照常） | ✅（调用层未验，见 §4.3） |
| **审计外置（L1–L4）** | **L1** 本地采集（哈希链 + 脱敏） | ✅ |
| | **L2** outbox 文件队列 | ✅ |
| | **L3** 自定义 TelemetryBackend | ✅ |
| | **L4** 交叉校验 | ✅ |
| | 离线降级模式 | ✅（端到端未验，见 §4.4） |

---

## 三、最初规划 → 最终落地：逐条对照

> **判据来源**：权威设计文档为 `fde-copilot-design-spec-v3.html`（v3，2026-09-22）。v3 相对 v2 有 **16 处修订**，这些修订本身构成了大部分差距项。

| # | spec 要求 | spec 节 | 最终落地 | 验证档 | 证据坐标 |
|---|---|---|---|---|---|
| 1 | deny 检查 D1/D2/D3/D5 四个门禁 | §3 | ✅ 全部实现 | 已实现+活验 | `dsh-fde-phase/lib/check-d2.js`、`check-d5.js`、`guard.js`；`tests/_fde_d2d3_test.mjs` 47/0 |
| 2 | D3 的 `DraftReference` 铁律 | §4 | ✅ 实现 | 已实现+**部分活验** | `dsh-fde-dsl/lib/`；`tests/_fde_dsl_test.mjs`；活验 phase 链 `seq=119` |
| 3 | 15 Phase 表 + `current → next(+1)` + 守卫单调否决 | §2/§9.3 | ✅ 实现 | 已实现+活验 | `dsh-fde-phase/lib/phases.js:36-73`；`tests/_fde_phase_test.mjs` 44/0 |
| 4 | maturity `draft/verified/locked` 单向 + 变更历史 | §4 | ✅ 实现 | 已实现+活验 | `dsh-fde-memory/lib/maturity.js`；`tests/_fde_memory_a4_test.mjs` 61/0 |
| 5 | confidence 规则化推导（模型禁写） | §6 | ✅ 实现 | 已实现+活验 | `dsh-fde-memory/lib/confidence.js`；`tests/_fde_memory_a3_test.mjs` 115/0 |
| 6 | 审计 L1 本地采集（哈希链 + 脱敏） | §8 | ✅ 实现 | 已实现+活验 | `dsh-fde-memory/lib/session-audit.js`（`redactValue`）、`lib/audit.js`；`tests/_fde_memory_session_audit_test.mjs` 23/0 |
| 7 | restrict 工具面过滤 | §9.2 | ✅ 实现 | 已实现+活验 | `dsh-fde-phase/lib/restrict.js`；`tests/_restrict_test.mjs` 38/0、`tests/_assert_restrict_live_test.mjs` 176/0 |
| 8 | **A1** D4 降 ask + Phase 2 D5-pre | §2/§3/§10.3 | ✅ 实现 | 已实现+活验 | `phases.js:24`；`lib/tools.js` D4 ask / D5-pre ask；链上 `phase-advance-d4-ask:confirmed/rejected` 各 1 |
| 9 | **A2** 锁残留检测 PID（超时 + PID 死 双条件） | §7 | ✅ 实现 | 已实现+**部分活验** | `dsh-fde-phase/lib/state.js`（`pidAlive`、`timedOut && holderDead`）；`tools/_lock_probe_live.mjs` 12/12 |
| 10 | **A3** `ctx.approval` 接线（ask 底座） | §9.5 | ✅ 实现 | 已实现+活验 | `dsh-fde-phase/lib/approval.js`、`dsh-fde-memory/lib/approval.js`；`tests/_fde_phase_approval_test.mjs` 12/0 |
| 11 | **B1** source 防污染 | §7 | ✅ 实现 | 已实现+活验 | `dsh-fde-memory/lib/decisions.js`；`tests/_fde_memory_source_test.mjs` 13/0；活验 `events.jsonl` `seq=169` `source-polluted` |
| 12 | **B2** R2 逐条确认（一句话理由必填） | §5 | ✅ 实现 | 已实现+活验 | `dsh-fde-memory/lib/tools.js:431-495`（三态，`unavailable` 时 fail-closed）；活验 `seq=99` |
| 13 | **B3** D5-pre + `compliance.yaml` 写入 | §10.3 | ✅ 实现 | 已实现+活验 | `dsh-fde-phase/lib/compliance-write.js`（tmp+rename 原子写、只覆盖 `data_policy`）；活验 `phase.jsonl:98` |
| 14 | L0/L1/L2 变更分级（语义载荷判定） | §4 | ✅ 实现 | 已实现+活验 | `dsh-fde-ontology-gate/lib/classify.js`；`tests/_fde_classify_test.mjs` 16/0、`tests/_fde_classify_exec_test.mjs` 3/0 |
| 15 | **C2** L0/L1/L2 各自流程（变更闭环判定） | §4 | ✅ 实现 | 已实现+活验（真 SDK 层） | `dsh-fde-phase/lib/change-flow.js`；`tests/_fde_c2_test.mjs` 30/0、`tools/_fde_c2_live.mjs` 6/0 |
| 16 | **C3** 回滚预授权（D5 第 5 键 + 独立通道 + 24h 观察期） | §10.4 | ✅ 实现 | 已实现+活验 | `check-d5.js` 第 5 键、`fde_rollback`、`state.js` `inObservation`；活验 `phase.jsonl:107` |
| 17 | **E3** schema 迁移失败 ⇒ 降只读 | §7 | ✅ 实现 | 已实现+**部分未验** | `dsh-fde-memory/lib/index.js:147-184`、`lib/tools.js` `assertWritable` |
| 18 | **E4** 影子模式准确率指标 + `enforce` 准入门 | §12/§14 | ✅ 实现 | 已实现+活验 | `lib/shadow-stats.js`（阈值 `ADMIT_PCT:46`/`OVERTURN_PCT:49`）、`lib/shadow-tools.js` |
| 19 | **D1** 审计外置 L2/L3/L4 + 离线降级模式 | §8 | ✅ 实现 | 已实现+**部分未验** | memory `lib/outbox.js`、`lib/telemetry-sink.js`；phase `lib/remote-state.js` |

> ⚠️ **同名不同物提醒**：第 1 行的「D1」是 spec §3 的**护栏绑定检查**；第 19 行的「D1」是 spec §8 的**审计外置**。两者缩写相同、含义无关。本项目文档中凡出现「D1」均会注明是哪一个。

---

## 四、未完整项及原因说明（**这是本文最关键的一节**）

> 下 4 项**功能都已实现**，缺的是**验证证据**。每一项都写明「为什么没验成」与「要不要紧」。

### 4.1 D3 `DraftReference` 铁律 —— 核心判据仅离线

| 项 | 内容 |
|---|---|
| **已验部分** | 真进程内调用 `fde-run-validation` → 通过，**规则 3 条 / 反例 29 条 / 失败 0 项**，审计链 `phase.jsonl` `seq=119` |
| **未验部分** | 「`deny` 规则引用了 `maturity: draft` 的属性 ⇒ **必须判失败**」这条铁律本身**没在真环境触发过** |
| **为什么没验成** | 两个独立原因，**缺一不可**：<br>① 真实本体（`E:\ontologyRoot\`）里**没有任何 `deny` 规则引用未定稿属性**——真数据上这条判据的正确行为就是「通过」，而「通过」分不清「判据跑了但没命中」与「判据根本没跑」；<br>② `fde-run-validation` 的参数面**只有 `reason` 一个**，路径写死读配置里的 `ontologyRoot`，**无法指向临时目录** |
| **要验需要什么代价** | 必须**改真实业务本体**（往 `logic.yaml` 里加一条引用 draft 属性的 `deny` 规则）。这会**真实推进业务状态**，违反本项目「不为验证而改业务数据」的纪律 |
| **要不要紧** | 判据逻辑**已在离线套件覆盖**（`tests/_fde_dsl_test.mjs`）。风险是「实现与测试同错」——但该判据是纯结构检查（比对 `maturity` 字段值），同错概率低 |

### 4.2 A2 锁残留检测 —— 3 个分支验了 2 个

| 分支 | 预期行为 | 验证状态 |
|---|---|---|
| 锁**未过期** | 拒绝 | ✅ **活验**（真 `projectRoot`） |
| 锁**已超时 + 持有 PID 活** | 拒绝（不抢活进程的锁） | ✅ **活验**（用本进程真 PID） |
| 锁**已超时 + 持有 PID 死** | 强夺 + 审计记 `lock-steal` | ⚠️ **仅离线** |

| 项 | 内容 |
|---|---|
| **为什么第 3 个分支没活验** | 强夺**成功**意味着 `writeState` 会真的写 `state.yaml`（改 `current_phase` / `revision` / `updated_at`）——那是**真实业务状态变更**，不可逆 |
| **活验时怎么保证安全** | ① 只走拒绝分支，`acquireLock` 抛错就根本到不了写盘；② 第二道防线：`mutator` 写成**抛错函数**，万一锁逻辑失效，它在写盘前拦住；③ 审计传 `null`，链上零字节写入；④ 跑前跑后比对 `state.yaml` 的 SHA-256 |
| **活验结果** | `tools/_lock_probe_live.mjs` **12/12 通过**，`state.yaml` sha 全程 `c1561b6e…` 未变 |
| **要不要紧** | 三分支里最关键的两个（拒绝类）已活验。强夺分支是「自愈」路径，出错的影响是「错误地接管了锁」——`tests/_fde_phase_test.mjs` 已有反例覆盖 |

### 4.3 E3 迁移失败降只读 —— 调用层未验

| 项 | 内容 |
|---|---|
| **已实现** | `lib/index.js:147-184`：迁移失败不再抛错，而是置 `readOnly` 并记 `schema-readonly` 审计；三个写工具的 `execute` 首行加 `assertWritable` 守卫 |
| **未验部分** | **没在真进程里实际触发过一次「迁移失败 ⇒ 降只读」的完整路径** |
| **为什么没验成** | 要触发它，得**构造一个坏的 schema 版本文件**送进真实记忆系统。这属于破坏性构造，风险高于收益 |
| **要不要紧** | 离线套件覆盖了该分支。风险同样在「实现与测试同错」 |

### 4.4 D1 审计外置 —— 端到端未验

| 项 | 内容 |
|---|---|
| **已实现** | L1 本地采集 + L2 outbox + L3 TelemetryBackend + L4 交叉校验 + 离线降级，**离线四层全绿**，另有**交付态活验 `live` 17/17** |
| **未验部分** | **端到端**：真实投递到远端 / 断网降级 / 恢复后补传 |
| **为什么没验成** | 配置读取**没有环境变量回退**（`normalizeConfig(raw = {})` 无 `process.env` 分支），唯一来源是 DSH 配置文件 ⇒ 要验端到端必须**改 `profiles/web/cordis.patch.yml` 并重启 DSH 两次** |
| **为什么不自己做** | 「终止正在运行的 DSH 进程 + 改写其配置文件」这个动作，被运行时的权限分类器判定为**干扰工作负载**并拒绝。本项目**不以任何形式绕过该拒绝**（包括换工具、拆步骤、改措辞） |
| **已验的替代证据** | 交付态活验确认：未配端点时**不多建文件**、记录读作「配置选择」而非「故障」、本地链完整、插件正常装载 |
| **要不要紧** | 离线四层 + 交付态接线都已验。**真正的残余风险只有「真实网络投递」这一段**，而它依赖外部端点，属于部署期验证范畴 |

---

## 五、PoC 降级项（实现方式弱于 spec 要求）

> **纪律**：以下降级**不得在任何交付文案里被说成「已按 spec 实现」**。

| # | spec 要求 | 本项目实现 | 降级理由 |
|---|---|---|---|
| **降1** | D1 的 `guardrails[].ref` 解析到**已注册的可执行函数** | 解析到**可编译的 DSL 表达式**（`{'>': [{'var': 'treatment.dose_mg'}, 100]}`） | ① 动态 `import()` 任意路径 = 开出**代码执行面**，是安全红线；② PoC 期没有真实代码库可绑 |
| **降2** | E3 存在**真实的 schema 迁移链** | `CHAIN = {}`（空）——生产环境走不到「有路径」分支 | 只有 v1 一种数据格式，**没有 v2 就没有「从 v1 到 v2 的迁移」**。凭空写一条迁移路径等于伪造一段没发生过的历史 |

---

## 六、设计偏离记录（F 组 —— 记录，非缺口）

| # | spec 写法 | 本项目做法 | 依据 |
|---|---|---|---|
| **F1** | 「Phase 流转基于 `workflowEngine`」 | 改用**专用工具 `fde_phase_advance` + 守卫钉入口** | 宿主 `workflow.phase` 是**进度叙述**（监听器返回值被丢弃），`goal.phase` 在事件提交后才发——**两者都拦不住任何东西**。spec §9.3 要的是「拦得住」，只能自建 |
| **F2** | L1 流程含「回 Phase 3 变更模式 → … → **自动回原 Phase**」 | **未实现「自动回原 Phase」** | Phase 状态机的不变量是 `current → next(+1)`（不许跳跃、不许回退——跳过 Phase 3 等于跳过 D1）。与「可回退的变更模式」**结构冲突**。落地口径：变更走独立通道，不改 `current_phase` |
| **F3** | E3 的迁移链 | `CHAIN = {}` 为空 | 同「降2」。**判定为设计记录而非缺口**——没有 v2 数据格式，就没有迁移可言 |

---

## 七、开发过程中发现并修复的既有缺陷（非 spec 差距）

> 这些不是「spec 要求但没做」，而是「做了但做错了，后来发现并改掉」。完整台账见 `docs/02-development/issue-log.md`。

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| 1 | 三个插件的 `HarnessError` 结构化错误码**静默丢失** | 写法为 `import * as dshTools` + `dshTools.HarnessError ?? Error`，但真 SDK **不 re-export** `HarnessError`（实测 `=== undefined`）⇒ 永远走 `?? Error` 兜底。**根因是 memory/phase README 里写的「事实」本身有误** | 三插件统一改为从正确来源导入 |
| 2 | 活体驱动脚本 `tools/_live_drive.mjs` **漏报整个新回合** | `waitSettle` 不设回合基线——续会话时**旧回合的 finish 仍在记录里**，循环第一次轮询就命中并返回，新回合被整个丢掉。**症状与「模型没调工具」完全一样** | 发问前先取基线，只认「新」事件 |
| 3 | `tests/_fde_d5_test.mjs` 曾是 **0 字节** | 空程序 ⇒ `node` 跑它必然**零断言 + EXIT=0** ⇒ 产物文件里写着 "PASS 9 / FAIL 0" 却**从未真跑过** | 补齐内容；`tests/_run_all_tests.sh` 增加「脚本 <400B 即预警」的检查 |

---

## 八、如何自行复核本文的每一条

```bash
# 1) 离线回归（41 套件）
bash tests/_run_all_tests.sh                  # 期望：ALL-TESTS-GREEN

# 2) 源 ↔ 部署副本一致性
node tests/_deploy_diff.mjs                   # 期望：ALL_MATCH

# 3) 审计链完整性（按 seq 重放）
node tools/_replay_phase_audit.mjs            # 期望：断链 0 处 / CHAIN-INTACT

# 4) 锁的三个分支中的两个（真 projectRoot）
node tools/_lock_probe_live.mjs               # 期望：12/12，且 state.yaml sha 不变

# 5) 逐条枚举完成度（不靠 grep 计数）
node tools/_count_0090_status.mjs             # 期望：活验完整 15 / 部分活验 2 / 部分未验 2 / 合计 19
```

> ⚠️ **重放审计链必须按 `seq` 排序，不能按文件行序**——同一毫秒的两个并发写者会分到相邻 `seq`，落盘次序可能被 OS 打乱（实测出现过第 224 行 `seq=223` 排在第 223 行 `seq=224` 之后）。按行序重放会报**假断链**。
