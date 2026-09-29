# dsh-fde-memory — 记忆系统 v2

> **FDE Copilot v3 第 4 个插件**（与 gate/dsl/phase 同构：独立 fiber、独立快照、独立回归）
>
> **当前状态：A1 骨架 + SCHEMA_VERSION + A2 decisions/confidence/照抄件 + A3 checklist/stakeholders/maturity/change_log + 三条 A2 补丁 + A4 notes/过期降级/index.js import 化 + A5 分层注入与工具面 + B1 source 防污染 + B2 R2 逐条确认**（0076 §5 A1 完成；0079 §4 A2 完成；0082 §2-§3 A3 完成；0084 §2-§4 A4 完成；0086 §2-§4 A5 完成；0090 B1 §7 / B2 §5 完成）

## 1. 能力边界

### 1.1 A1 已实现
- **骨架幂等创建**：`apply()` 里幂等建 `<projectRoot>/memory/{ontology,decisions,checklist,notes,audit}/` 目录
- **SCHEMA_VERSION 链式迁移**：
  - `<projectRoot>/SCHEMA_VERSION` 单行文件，内容是整数版本号
  - **缺失** ⇒ 视为 v1 并写入（决策：本插件新引入，磁盘上不可能有更老版本）
  - **存在且 == CURRENT(=1)** ⇒ OK
  - **存在且 != CURRENT** ⇒ 走 `migrate()`；**无迁移路径 ⇒ apply 失败（fail-closed）**，不许"猜测兼容"
- **state.yaml 不动**：`memory/state.yaml` 是 phase 插件财产，本插件只读不写

### 1.2 A2 已实现（0079 §4）+ 0082 §2 三条补丁
- **`lib/decisions.js`**：决策落盘 + 序号独占 + 调用方不可写 confidence
  - 文件形态 `<projectRoot>/memory/decisions/{phase}-{seq}.yaml`，phase 可含 `.`（如 `0.1`），按最后一个 `-` 切分
  - 序号分配：`nextSeq` 扫目录取最大 + 1 + `openSync('wx')` 原子排他抢号（EEXIST 重试，上限 50 次）
  - 写盘：`tmp + fsync + rename` 覆盖 final（**比 dsh-fde-phase/lib/state.js 多一步 fsync**，数据先落盘再改名 —— 升级非照抄）
  - 失败清理：catch 块 `unlinkSync(tmp) + unlinkSync(final)`，**不许留空文件**（污染 nextSeq）
  - fail-closed 读：`readDecision` 空文件/坏 YAML ⇒ 抛，不静默返回 null
  - 调用方传 `confidence` 一律忽略（0076 §1.4 核心禁令）：写入前显式 `delete input.confidence`，再由 `deriveConfidence(facts)` 赋值
  - **测试钩子**：`process.env.FDE_INJECT_WRITE_FAIL='1'` 时模拟写盘失败（验证 catch 块清理逻辑，生产环境不设此变量即不触发）
  - **0082 §2.2 修复**：`readDecision` 加双向断言（phase 必须字符串 / phase==文件名 / seq==文件名）—— 防手写文件未加引号导致 YAML 把 `0.1` 解析成 number，破坏 phase 字符串语义
  - **0082 §2.2 改签名**：`listDecisions` 返回 `{ items, bad }` 而非 `object[]` —— 坏文件进 `bad` 列表而**不静默消失**（缺席第三层：整条记录缺席最易漏）。**当前无外部调用方**，故改签名不构成破坏性变更
  - **0082 §2.3 新增**：导出 `assertPhaseId` + `PHASE_ID_RE=/^[0-9]+(\.[0-9]+)?$/`，四个入口（`writeDecision`/`readDecision`/`nextSeq`/`listDecisions`）共用 —— 防路径穿越（`writeDecision(root, { phase:'../../escaped', ... })` 原未拦截会写出 `memory/`）。15 个合法 phase id 全部形如 `数字` 或 `数字.数字`（0.1 / 0.2 / 0.3 / 0.4 / 1..11）
- **`lib/confidence.js`**：置信度规则表（纯函数零 IO）
  - `deriveConfidence(facts) -> 'low' | 'medium' | 'high'`
  - **叠加顺序**（spec 未写清，本实现自定，写进代码注释）：
    - 第 0 步 入参校验：source ∉ {fde_confirmed, plugin_inferred, client_stated} ⇒ 抛；`phases_since_review` 非整数（且非 null/undefined）⇒ 抛（0082 §2.1 修复 fail-open：原静默当 0 致时效衰减整条失效）
    - 第 1 步 基础档（互斥，取第一条命中）：6 档（含 0079 补写档 `fde_confirmed + !data_verified => medium`）
    - 第 2 步 时效衰减（叠在基础档之上）：`last_reviewed==null && psr>=1` 降一档；`psr>=3` 直接压 low
    - 第 3 步 派生继承（叠加在最后）：`derived_from_confidence=='low'` ⇒ 结果上限 medium
- **三个照抄件**（0079 §4 A2-1，逐字照抄自 dsl/phase 包，独立安装避免跨包 import 互相拖垮）：
  - `lib/errors.js`（1573 B，逐字照抄自 `dsh-fde-dsl/lib/errors.js`）
  - `lib/yamlsubset.js`（7813 B，逐字照抄自 `dsh-fde-dsl/lib/yamlsubset.js`，**依赖 `./errors.js`** —— 0076 §3.3 漏写此项）
  - `lib/audit.js`（14566 B，照抄自 `dsh-fde-phase/lib/audit.js`，**唯一差异**：`function linkHash` 改为 `export function linkHash`，供离线回归直接对拍）
- **本批不接线**：`lib/audit.js` 已交付但无调用方（使用者是 0077 B1）；`lib/decisions.js` 的工具注册（`fde_memory_write_decision`）在 A5 才注册

### 1.3 A3 已实现（0082 §3）
- **`lib/yaml-write.js`**（A3 §3.1 提取）：把 `serializeYaml`/`formatValue`/`formatInline` 从 `decisions.js` 逐字搬迁并导出 —— 否则三个 A3 写入器各抄一份会出现漂移。搬迁后 `decisions.js` 改为 `import { serializeYaml } from './yaml-write.js'`，行为不变
- **`lib/change-log.js`**（A3 §3.0 5.2b 拍定）：append-only JSONL，文件 `memory/change_log.jsonl`（**spec 目录树之外的新增文件**，§3 必须披露）。`appendChange(entry)` + `readRecentChanges(limit)` 走"按行倒读、不全量解析"。entry 至少含 `{ at, kind, target, summary }`，`kind ∈ {decision, checklist, stakeholder, maturity, note}`
- **`lib/checklist.js`**（按 Phase 分片 = spec §5 债 2 第 ③ 条）：落 `memory/checklist/{phase}.yaml`，items `[{ id, text, done, evidence? }]`，整文件重写 + 原子写
- **`lib/stakeholders.js`**（A3 §3.0 5.2a 拍定）：落 `memory/stakeholders.yaml`，全量字段 `{ id, name, role, org, influence, contact?, notes? }`；`summarize()` 返回**4 字段摘要** `[{name, role, org, influence}]` —— 不含联系方式类字段（隐私 + 体积），A5 注入面直接调它
- **`lib/maturity.js`**：落 `memory/ontology/maturity.yaml`，status `{draft, verified, locked}` **单向**（draft→verified→locked），回退要显式 `reason`（否则抛）。每次变更 append `history: {at, from, to, by, reason}`。`historyOf(nodeId)` 按时间升序返回
- **三个写入器共有约定**（0082 §3.2）：① 走 `assertPhaseId`（凡带 phase 的 —— checklist 有，stakeholders/maturity 无）；② 写完 `appendChange` 追加一条 change_log；③ 原子写（tmp+fsync+rename）
- **本批不接线**：四个库的工具注册在 A5（`fde_memory_read_checklist` / `fde_memory_write_stakeholder` / `fde_memory_advance_maturity` 等）

### 1.4 A4 已实现（0084 §2-§4）
- **`lib/index.js` import 化**（0084 §2）：顶部静态 import 全部 10 个库 —— 让"插件仍加载"判据第一次有验证力（任一库坏掉 ⇒ fiber failed）。⚠️ **加载成功 ≠ 运行时正确**：active 只证明 10 个文件在进程内可解析；行为正确性靠离线断言（A1 67 + A2 47 + A3 108 + A4 N）。不改成动态 import()：动态 import 的失败可被 try/catch 吞掉，失去 fail-closed
- **`lib/notes.js`**（A4 §4.1）：6 API + slug 白名单 + frontmatter 强制 + 过期降级纯函数
  - `writeNote` 落 `memory/notes/{date}-{slug}.md`；**expires_at 由写入器按 TTL 算**（调用方传忽略覆盖，§4.0 a）；**confidence 由 deriveConfidence 推**（同 decisions 禁令，§4.0 b）；TTL 来源 = config 的 notesTtlDays（默认 90）/ informalCommitmentTtlDays（默认 30，§4.0 c）
  - `readNote` 缺 frontmatter / 字段不全 ⇒ 抛（fail-closed，不返回半成品）
  - `listNotes` 返回 `{items, bad}`（坏文件进 bad，同 §3.2 形状）
  - `isExpired` / `annotateForInjection`（过期文本含"历史备注（未复核）"+日期；**文件绝不改写**）
  - `reviewNote` 只更新 reviewed_at（原子写，A5 的 fde_memory_review 用它）
  - **slug 白名单 `/^[a-z0-9-]+/`**（挡 `../`/`/`/`:`/空格/大写，同 §2.3 assertPhaseId 精神）
- **§3 四条小修**：
  - §3.1 change-log 措辞改"全量读入 + 倒序取最后 N 条（只 parse N 条）；文件很大时内存仍 O(文件大小)，PoC 内接受"（方案 A，只改注释）
  - §3.2 `readRecentChanges` 改签名 `{items, bad}`（坏行进 bad 而非静默消失，与 listDecisions 同形）
  - §3.3 maturity 同 rank 注释删"仍追加 history 留痕"半句（明确幂等 no-op，不留痕不写盘）
  - §3.4 maturity `readMaturity` 加 fail-closed 校验：读回非法 status ⇒ 抛（防 RANK[非法]===undefined 绕过单向规则）

### 1.5 A5 已实现（0086 §4）
- **`lib/tools.js`**：注册三个工具（`fde_memory_context` / `fde_memory_write_decision` / `fde_memory_review`），下划线族（与 gate/phase 的写入类工具同族，`grep fde_memory` 零冲突）
  - ⚠️ **A5 当时是 3 个**；`fde_memory_confirm`（B2）与 E2 的三个沙箱工具都在此之后加的 ⇒ **当前共 7 个**（见 §1.8 / §1.10）。工具数的权威来源是 `tools.js` 的导出常量，**不是本文档里的任何数字**
- **`fde_memory_context`（只读，分层注入）**：六层各成段，段尾带计数（让最小 grep 面自我暴露）：
  | 层 | 内容 | 裁剪 |
  |---|---|---|
  | `[L1]` 本 Phase checklist | `readChecklist(root, phase)` | 全部 |
  | `[L2]` 本 Phase decisions | `listDecisions(root, phase)` | 全部（`bad` 非空显形） |
  | `[L3]` stakeholders 摘要 | `summarize()` 的 4 字段（name/role/org/influence） | 不是全文 |
  | `[L4]` 最近变更 | `readRecentChanges(root, cfg.injectChangeLogLimit)`（默认 5） | 恰好 N 条；`bad` 显形 |
  | `[L5]` notes | `listNotes` 按 date 倒序**最多 10 条** ⇒ 逐条 `annotateForInjection` | 段尾「共 N 条，其中过期 E 条」 |
  | `[L6]` 过期未复核队列 | `isExpired` 为真 且 `reviewed_at` 空，按 `expires_at` 升序**最多 20 条** | 只给文件名 + date + 过期天数 |
  - **红线**：不回显 `state.yaml` 全文；缺省 phase 取 `state.yaml` 的 `current_phase`
- **`fde_memory_write_decision`**：写决策；`confidence` 由 `deriveConfidence` 强制覆盖（调用方传了忽略）；`phase` 走 `assertPhaseId`；拒绝一律 `throw new HarnessError(msg, code)`；输出只给 `{file, seq, confidence}`
- **`fde_memory_review`**：复核 note（更新 `reviewed_at`，原子写 + `appendChange`）；`file` 走 `assertNoteFile` 白名单
- **`HarnessError` 拿法**（0086 §4.2 拍定 1，**2026-09-28 修订**）：`import { HarnessError } from '@deepseek-ai/dsh-llm'`（真 SDK 的 `dsh-tools` 不 re-export，旧写法 `dshTools.HarnessError ?? Error` 会静默降级丢 `code`；不用 `DslError` 顶替，语义不同）
- **`index.js` import 化扩展**：新增 `notes.js`（0086 §3）+ `tools.js`（A5）+ `session-audit.js`（0077）静态 import，共 **15 个相对库**

### 1.6 进程内软约束
本插件是**进程内软约束** —— 防的是模型无意的失误与漂移，不是有意的恶意绕过。`confidence` 不可由调用方写入（spec 第六节禁令，A2 已落地：`deriveConfidence` 纯函数 + `writeDecision` 强制 `delete input.confidence`）。

### 1.7 审计外置 L1（0077）已实现
监听 `ctx.on('session/event')` → **脱敏** → 落 `<projectRoot>/memory/audit/events.jsonl`（复用 A 单 `lib/audit.js` 哈希链：`seq` + `prevHash` + `hash`，重启从磁盘尾部恢复续接，不重开）。

- 🔴 **订正（2026-09-29，D1）**：本节原写「**不实现 L2（外置远端）**……不建空壳占位类」。**L2/L3 现已实现**（`lib/outbox.js` + `lib/telemetry-sink.js`，见 §1.11）。改口的**理由不是"改主意了"，是原判断所依据的事实站不住**：
  - 原文设想「L2 才实现 `SessionTelemetryBackend`（占 `ctx.sessionTelemetry` 唯一位）」—— 实测这条路**在本部署下是死的**：那个位**已经**被 `@deepseek-ai/dsh-session-telemetry-otel` 占着（活体 `pluginInventory/list` 实测 `fiberPhase: active`），重复注册**抛错**；且它跑的是默认 `mode: DISABLED`，而 DISABLED **不构造协调器** ⇒ `session-telemetry/record` waterfall **永不派发**。
  - ⇒ 本实现**不碰 seam 槽位**，把 L2/L3 建在**自己已有的 L1 采集**（`ctx.on('session/event')`）之上。**代价**（诚实写明）：拿不到 seam 的 `sharing` 披露与「每 (turn,step) 只发首块」投影，投递的是**本插件自己捕获的**（L1 已脱敏的）审计记录。**收益**：这条路真会跑，而不是挂一个永不触发的后端。
  - 原文「不建空壳占位类（死代码，无行为可验）」这条**依然成立**：`telemetry-sink.js` 不是占位 —— 它有 107 条离线断言 + 26 条变异 + 活验。
- **脱敏规则表**（键名命中 ⇒ `[REDACTED]`；值命中 Bearer/sk-/JWT ⇒ 打标记），落盘前必须脱敏 —— session 事件实测含凭据（launch token / bearer / cookie / api key），seam 不内置脱敏，见 §9.2。
- **不阻塞**：监听器同步入队后立刻返回（零 IO），异步串行 writer 落盘；`assistant/chunk`（token 级流式）不采集。
- **链完整性判据**：用**自己的** `prevHash`+`hash` 链，**绝不用** session 事件 `seq` 连续 —— 事件 seq 缺口是常态，用它判完整会造出永远为红的假告警（0077 §2.3③）。

### 1.8 B1 source 防污染 + B2 R2 逐条确认（0090 §7 / §5）

**source 三分标记**（B1，`lib/decisions.js` + `lib/tools.js`）：

| source | 谁写 | 必带字段 | 备注 |
|---|---|---|---|
| `plugin_inferred` | 模型默认 | 无 | 插件推断的事实，无出处要求 |
| `client_stated` | 模型 | `provenance`（来源出处：文档路径/session ID/对话引用） | 缺 `provenance` ⇒ 写入器拒绝（`MEMORY_BAD_PROVENANCE`） |
| `fde_confirmed` | **只能经 approval 产生** | `approved_at`（+ `confirm_reason`） | 模型直接写 ⇒ 写入器拒绝（`MEMORY_SOURCE_POLLUTED`，防污染） |

- **两道防线**：`writeDecision` 纯函数层校验（`client_stated` 无 `provenance` 抛、`fde_confirmed` 无 `approved_at` 抛）+ `fde_memory_write_decision` 工具层拦截（`source=fde_confirmed` ⇒ throw + 审计 `source-polluted`）。
- **防污染语义**：`fde_confirmed` 是"客户已确认"的强断言，必须经 `approval.request` 弹窗（用户点 allow）才能产生；模型不能在 prompt 里自我标榜"这是确认过的"。审计里 `source-polluted` 留痕每次试图伪造。

**R2 逐条确认**（B2，新增 `fde_memory_confirm` 工具）：

- 覆盖 R2 五类「认知摩擦项」：数据接入范围 / 规则阈值 / 上线部署 / 对外承诺 / 跳过 deny 相邻项。
- **参数**：`phase` / `question`（待确认项描述）/ `decision`（决定文本）/ `rationale`（理由）/ `reason`（**一句话理由必填**，缺失 ⇒ `MEMORY_BAD_REASON`）。
- **三态**（经 `approval.request`，与 phase 的 D4 ask / D5-pre 同构）：
  - `allowed-once` ⇒ 写 `source=fde_confirmed`（带 `approved_at` + `confirm_reason`），审计 `memory-confirm outcome=confirmed`；
  - `rejected` ⇒ throw `MEMORY_CONFIRM_REJECTED`，审计 `outcome=rejected`；
  - `unavailable` / `cancelled` ⇒ throw `MEMORY_CONFIRM_UNAVAILABLE`（**fail-closed**），审计 `outcome=unavailable`。
- 🔴 **与 D4/D5-pre 的 ask 不同，confirm 是 fail-closed**：`fde_confirmed` 是强断言，通道不可用时**不能降级成 `plugin_inferred`**（那等于把"客户已确认"偷换成"插件推断"）——宁可拒绝产生记录，也不产出假确认。
- **不允许异步补录**：confirm 只在「approval 弹窗当场」这一条路径产生 `fde_confirmed`；模型事后"我确认了"没有入口（唯一能写 `approved_at` 的只有 confirm 工具，且它要求 approval 当场返回 `allowed-once`）。
- **共享助手 `lib/approval.js`**：`askApproval(ctx, exec, reason)` 复制自 phase 的 `lib/approval.js`（跨包不 import，照抄 + 离线对拍等价）；`ctx.get('approval')` 缺失或 `exec.agent` 缺失 ⇒ 返回 `'unavailable'`（fail-closed，与 confirm 语义一致）。

### 1.9 E3 schema 迁移失败 ⇒ 降只读（spec 第七节）

**旧行为（缺陷）**：`SCHEMA_VERSION` 迁移失败时 `apply()` 直接 `throw` ⇒ fiber failed ⇒ **全部工具都不注册** ⇒ **连读都没了**。这正是 spec 第七节要消灭的形态 —— 原文：

> 「schema 版本 …… 加 **迁移失败 = 写入 fail-closed，读取降级为只读模式（数据不扣人质）**」

即"迁移失败"该扣的是**写**，不该扣**读**。把数据扣成人质是 v2 的病，不是 v3 的解法。

**现行为**：迁移失败 ⇒ `apply()` 不抛错、**全部工具照常注册**、**只封三个写工具**。

⚠️ **E2 起"三个写工具"这个数字要小心读**：本插件现在共 **7 个工具**（4 个记忆工具 + 3 个沙箱工具，见 §1.10）。
只读守卫封的是**记忆数据的三个写工具**；沙箱工具**有意不加守卫**（理由见 §1.10 与诚实条目 34）。

| 动作 | 迁移失败（只读模式）时 | 判据来源 |
|---|---|---|
| `fde_memory_context`（读） | ✅ 照常返回 | 数据不扣人质 |
| `fde_memory_write_decision` | ❌ `MEMORY_SCHEMA_READ_ONLY` | 写入 fail-closed |
| `fde_memory_confirm` | ❌ 同上 | R2 不可逆层不得在只读期被写穿 |
| `fde_memory_review` | ❌ 同上 | 同上 |
| 审计链写入（`memory/audit/events.jsonl`） | ✅ **照常** | 见下 |

**实现点**（三处，都在源码里）：
- `lib/index.js`：`sv.status === 'failed'` ⇒ 置 `readOnly` 标志（**不再 throw**），记一条 `schema-readonly` 审计 + `log.warn`，并把 `readOnly` 传给工具注册；`log.info` 汇总行也带只读标记。
- `lib/tools.js`：`installMemoryTools(ctx, cfg, audit, readOnly)` 第四参数；`assertWritable(what)` helper 是**每个写工具的 execute 第一行**（放在开头而不是包一层，是为了让读者扫一眼就看见"这个工具受只读约束"）。
- 读工具**不加**守卫 —— 漏放一处就等于把数据扣成人质。

**为什么审计在只读期照常写**（刻意的取舍，两个理由）：
1. 审计是 **append-only 的运行痕迹**，不是被 schema 版本管辖的**用户数据**；"schema 迁移失败"约束的是记忆数据的格式，不是"发生了什么"的记录。
2. 停写审计会让**只读期间发生的事完全无痕迹** —— 那比"审计里混了两种格式"更坏。降只读这件事本身若不留痕，"系统什么时候开始只读的"就成了静默点。

**残余风险（如实写）**：只读期内写入的 `schema-readonly` 等审计记录，与迁移前旧格式记录共处同一条链 —— 链本身（`prevHash`/`hash`）不受影响，但"这段时期的记录由哪个 schema 版本产生"只能靠记录自身的 `type` 与 `from`/`current` 字段推断，**链上没有版本分段标记**。

**作用域（重要，别误读）**：只读判定在 **`apply()` 期算一次**。运行中改 `SCHEMA_VERSION` 文件**不会热生效** —— 要么重启 DSH，要么等下次 apply。这与本插件既有的"改 cfg 必须重启"（§2.1 第 4 条）是同一类性质。

**四层验证**（每层的边界都不同，不许混着说）：

| 层 | 证据 | 覆盖 |
|---|---|---|
| 离线 | `_fde_memory_e3_test.mjs` **19 断言 / 0 失败**（`_fde_memory_e3_out.txt`） | 单元 + apply 行为 + 三写工具拒/读照常 + 边界 |
| 变异 | `_fde_memory_e3_mut.mjs` **RED 12 / GREEN 0 / INVALID 0**（`_fde_memory_e3_mut_out.txt`） | 证明上面 19 条**具名断言**真能抓住缺陷（不是恒真） |
| 真 SDK（隔离） | `_fde_memory_e3_live.mjs` **6 断言 / 0 失败** | 真 `defineTool` 构造成功 + 真 `HarnessError` 的 `instanceof` 与 `code` |
| 真数据（只读） | 同上场景 3 | 真 `fde-state/memory/` 树上读得出、写全拒、**前后快照逐字节未变** |

⚠️ **还差一层**：工具在 **DSH 进程内**注册（`pluginInventory/list` 的 `fiberPhase`）—— 需要重启 DSH，已在差距清单里标注。

⚠️ **真环境当前不是只读模式**：`fde-state/SCHEMA_VERSION` = `1` = `CURRENT` ⇒ `status="ok"`。只读分支是**韧性路径**，当前未被真实触发；它的正确性由上面四层覆盖，**不靠真环境撞上**。

### 1.10 E2 探索沙箱（spec v3 §7）—— 新增 3 个工具 + `lib/experiments.js`

**spec §7 四条要求与本插件的落点**（四条各自"怎么落"与"怎么证"必须一一对上，不许合并）：

| spec §7 | 落点 | 证据 |
|---|---|---|
| ① 沙箱内容**不进分层注入** | 沙箱不在 `memory/` 下，`fde_memory_context` 的六层读的都是 `memory/` 下的目录 | E2 用"逐字不变"；E3 用 `[L5] notes` 双向（放入 `memory/notes/` ⇒ 显示；放入沙箱 ⇒ 不显示）+ 正面对照 |
| ② 草稿**不参与 D1/D3** | **结构性**：dsl 全用 `join(ontologyRoot, ONTOLOGY_FILES.X)` 按**固定文件名**读（`lib/*.js` 里**零 `readdir`** ⇒ 不枚举目录），而沙箱在 `protectedExtraRoots[0]` 下、与 `ontologyRoot` 无交集 | E4（输入路径全由 `ontologyRoot` 直接拼出、与任何沙箱无交集）+ E5（文件名都是**单段**名 ⇒ `join` 出的永远是 `ontologyRoot` 的直接子文件） |
| ③ 验收后走**正式通道**合入 | **不提供"提升/promote"工具**（有意），合入只能走 gate 的 `fde_ontology_write`（L0/L1/L2 分级在那边） | `tools.js` 里三个工具的 description 都写明这条；无提升工具可断言 |
| ④ 沙箱内容**无审计要求** | 三个工具**都不调** `audit.record` | D9 用**真审计链**核 `events.jsonl` 字节数前后不变；变异 M7 反证 |

**为什么"没有 promote 工具"是要求 ③ 的正确落点**：spec 说的是"通过正式变更通道合入"，
而正式通道 = gate 的 `fde_ontology_write`（带 source 溯源、confidence 门槛、越界判定、L0/L1/L2 分级）。
给沙箱单开一条"提升"入口 = **在门禁旁边开一条旁路**，正是 spec 要防的。
⇒ 沙箱的产物要进 ontology，**和模型凭空想出来的一条草稿走的是同一条路**，没有优待。

**`lib/experiments.js`** —— 沙箱边界的唯一实现处（工具层只是薄壳）：

| 导出 | 作用 |
|---|---|
| `EXPERIMENTS_SUBDIR = 'experiments'` | ★ 与 gate 部署配置的 `sandboxSubdirs: ['experiments']` 是**同一件事的两处字面量**（跨插件不 import）⇒ `_fde_e2_test.mjs` F1 直接读部署配置对拍 |
| `MAX_CONTENT_BYTES = 256 KiB` | 超限**拒**（不截断 —— 截断会让模型拿到"看起来完整"的半份草稿） |
| `MAX_DEPTH = 4` / `MAX_ENTRIES = 200` | 目录深度与条目数上限（防一次 list 撑爆输出） |
| `experimentsRootOf(projectRoot)` | `<projectRoot>/experiments` |
| `resolveExperimentPath(root, name)` | 名字 → 绝对路径，**两条结构性防线**见下 |
| `writeExperiment` / `readExperiment` / `listExperiments` | 三个工具的实现 |

**两条防线**（分段校验挡不住符号链接，所以是两条不是一条）：

```js
function splitSafeSegments(name)        // 非空 / 非绝对路径 / 按 / 与 \ 切段 / 每段非空、非 . 非 .. / 匹配 SEGMENT_RE
function assertNoSymlinkInside(root, abs) // 从沙箱根之下**逐级** lstatSync(cur).isSymbolicLink() ⇒ 抛；不存在即返回
```

- 分段校验挡的是 `../../memory/state.yaml` 这类**字面**穿越；
- 逐级 `lstat` 挡的是"沙箱里有个软链接指向 `memory/`"这类**结构**穿越 —— 字符串上看它完全合法（就是沙箱内的一个名字）。
- ⚠️ 代价：**沙箱里的合法软链接也被拒**（诚实条目 36）。

**三个工具**（`fde_experiment_write` / `fde_experiment_read` / `fde_experiment_list`）与其它 memory 工具
**刻意相反**的三处，写进代码注释与 description：

| 面 | 记忆工具 | 沙箱工具 |
|---|---|---|
| 审计 | 落 `memory/audit/events.jsonl` | **不落**（spec §7 ④） |
| 只读模式 | 三个写工具加 `assertWritable` | **不加**（不是记忆数据，见诚实条目 34 的例外） |
| source / confidence | 受防污染判定 | **不受**（沙箱无合入门禁，判定属于合入那一步） |

**四层证据**：

| 层 | 证据 | 覆盖 |
|---|---|---|
| 离线 | `_fde_e2_test.mjs` **41 断言 / 通过 41 / 失败 0 / EXIT=0**（`_e2_out.txt`） | A 派生面 / B 加载期 fail-closed / C guard 真判定 / D 沙箱边界 / E 隔离 / F 跨包对拍 / G 打印 |
| 变异 | `_fde_e2_mut.mjs` **红 10 / 绿 0 / 无效 0**（`_e2_mut_out.txt`） | 每条变异被**具名断言**抓住、exit=1、源码 sha256 逐字还原 |
| 部署 | `_deploy_diff.mjs` **ALL_MATCH**（gate 18 / memory 24 个文件，仅源有 0 / 仅副本有 0 / 内容不一致 0） | 源↔活副本一致 |
| 活体 | ⏳ **未做** —— 需重启 DSH：期望 `request/header` 工具面**逐名 diff** 恰为 `新增 ["fde_experiment_write","fde_experiment_read","fde_experiment_list"]`，且模型真能写进 `<projectRoot>/experiments/` | 见差距清单 |

⚠️ **离线套件不 import `lib/config.js`**：它 import `@deepseek-ai/schemastery`，离线工作区无该桩 ⇒
import 会让整个模块加载失败、报告零产出。`_fde_e2_test.mjs` 因此**手写 cfg**，
代价由 F3（grep 确认 `normalizeConfig` 真调了两个沙箱校验）+ F4（断言手写 cfg 覆盖
`guard.js`/`paths.js` 读到的每个 `cfg.*`）补。⇒ **补丁过，不是绕过**，但终究不是直接跑真 `config.js`，如实记着。

### 1.11 审计外置 L2 + L3 + 离线降级（spec 第八节）已实现

spec §8 四层里，**L1**（本地采集）见 §1.7；本节是 **L2 outbox 文件队列** + **L3 只写端点投递** + **降级模式**。
**L4 交叉校验**落在 phase 插件（它才是跑 deny 校验的地方），见 `dsh-fde-phase/README.md` §5.2。

**为什么没实现 spec 字面上的 `SessionTelemetryBackend`** —— 见 §1.7 的订正段（一句话：那个 seam 位已被 otel 占着、
且它跑在 DISABLED 上 ⇒ waterfall 永不派发）。**这是有意偏离，不是漏做。**

| 件 | 文件 | 干什么 |
|---|---|---|
| L2 队列 | `lib/outbox.js` | `<projectRoot>/memory/outbox/{seq}.json`；原子写（`.tmp` + rename）；按 **seq 数值**升序重放；投递成功才删；坏条目**不删**、跳过继续 |
| 跨包契约 | `lib/outbox.js` 的 `state.json` | 降级状态；**写者是本插件、读者还有 phase 的 L4** ⇒ 键名/取值域是跨插件契约，phase 侧有镜像，靠 `_fde_d1_test.mjs` F 组逐字对拍 |
| L3 投递 | `lib/telemetry-sink.js` | **只发 POST**（从不 GET、从不解析响应体，只看状态码）；按 seq 升序重放、**一条失败就停**（保序）；`AbortController` 超时 |
| 降级状态机 | `lib/telemetry-sink.js` | 失败 ⇒ 置 `outageSince`（**只在为空时置位**，中断从第一次失败算起）；中断 ≥ 阈值 ⇒ 写 `telemetry-degraded`；恢复 ⇒ 写 `telemetry-recovered` 带 `pendingReview: N` |
| L1→L2 接线 | `lib/session-audit.js` | 链写入成功后才 `sink.enqueue({seq, hash, entry})` ⇒ 队列文件名与链上那行**同一个 seq** ⇒ 幂等键天然成立 |

**为什么降级阈值存在 `state.json` 里而不是各插件各配一份**：阈值只有一个真源，且 **"24h 那一刻没有任何写入动作"** ——
缓存成布尔值必然过期（读者会在阈值刚过时仍看到旧值）⇒ 写进文件、由 phase **现算**（`evaluateRemote`）。

**三档判据**（`evaluateRemote`，memory 与 phase 两边逐字同解）：

| 状态 | 判据 | 括号「远端存在 OR 降级」 |
|---|---|---|
| `present` | 无未恢复中断，且**曾经**投递成功 | 成立 |
| `degraded` | 有中断，中断时长 **≥** 阈值（`>=` 边界） | 成立，但带 `degraded: true` |
| `missing` | 其余（**含"从未成功投递过"**） | **不成立** ⇒ deny 校验失败 |

🔴 「从未投递过」判 `missing` 是 **fail-closed**：没证据 ≠ 存在。**不许**判成 `present` 图省事。

**未配端点**（`telemetryEndpoint: ''`）**不是故障**：写一条 `telemetry-disabled` 留痕、**不写 `state.json`** ⇒
phase 的 L4 因 `telemetryStatePath` 为空而**根本不适用**（"没配"与"读不到"是两回事，必须能分辨）。
配了端点但**坏掉**（URL 非法 / 协议非 http(s)）⇒ **插件加载失败**（fail-closed；配了个连不上的端点却静默退回本地，
会让部署方以为"审计已经外置了" —— 那是把没做的事说成做了）。

**恢复后的"待复核"提示**：`telemetry-recovered` 记录带 `pendingReview: N`（N = 降级期间**成功投递**的条数）。
⚠️ **N 的语义是"降级窗口内投递出去的条数"，不是"降级期间通过了多少次 deny"** ——
后者只有 phase 的 guard 知道，若两个插件都写同一份 `state.json` 就破了"单写者"纪律（字段没有唯一维护者 = 迟早变成没人更新的谎）。
⇒ 降级期的**通过**记在 **phase 自己的审计链**上（`type:'phase-advance'` 带 `degraded: true`），要计数就从链上数。

## 2. 安装 runbook

### 2.1 部署
1. 把 `dsh-fde-memory` 包放进 `<DSH_HOME>/profiles/web/node_modules/`（与 gate/dsl/phase 同级）
2. 在 `<DSH_HOME>/profiles/web/cordis.patch.yml` 加配置段（key: `fdeMemory`）：
   ```yaml
   fdeMemory:
     projectRoot: 'E:/DSH-desktop/DeepSeek Harness/data/dsh-home/fde-state'
     mode: 'enforce'
     schemaVersion: 1
     # ── 审计外置 L2/L3（§1.11）—— **不给就是"不启用"，不是错误** ──
     # telemetryEndpoint: 'https://audit.example/v1/events'   # 留空/不给 = 只留 L1 本地链
     # telemetryToken: '<服务账号的写凭据>'                    # 留空则不发 Authorization 头
     # telemetryDegradeAfterMs: 86400000                      # 降级阈值，默认 24h
     # telemetryTimeoutMs: 5000                               # 单次投递超时
     # telemetryRetryMs: 60000                                # 重试/心跳周期
   ```
3. 在 `plugins` 列表加 `dsh-fde-memory`（与 gate/dsl/phase 同级）
4. **重启 DSH 才生效**（0076 §3.5：改 cfg 不热重载，已在 0074 §4 实验 1 实测证明）

⚠️ 三个时长（`telemetryDegradeAfterMs` / `telemetryTimeoutMs` / `telemetryRetryMs`）必须是**正的有限数**：
`telemetryDegradeAfterMs = 0` 会让"降级"**在任何时刻立刻成立** ⇒ L4 的「远端存在 OR 降级」退化成恒真 ⇒
**门禁静默失效（而它看起来还在工作）**。⇒ config 层直接抛（fail-closed），不在运行时兜。

### 2.2 验证
- `pluginInventory/list` ⇒ `fiberPhase: "active"` / `failed: 0`
- `<projectRoot>/SCHEMA_VERSION` 文件存在，内容 `1`
- `<projectRoot>/memory/` 下有 `ontology/decisions/checklist/notes/audit/` 五个空目录
- `memory/state.yaml` 一个字节都不许变（phase 财产）
- **配了端点才有**：`<projectRoot>/memory/outbox/` 目录 + `state.json`（未配端点 ⇒ **这两个都不该出现**）

### 2.3 离线回归
```bash
# A1 套件（config/schema-version/index，68 断言 —— E3 把原「apply 迁移失败 ⇒ throw」
#         两条旧断言换成三条新契约断言，67 → 68）
node _fde_memory_test.mjs

# A2 套件（confidence/decisions/照抄件跨包等价 + §2 三条补丁，47 断言）
node _fde_memory_decisions_test.mjs

# A3 套件（assertPhaseId 双向 + readDecision 双向断言 + listDecisions {items,bad}
#         + confidence psr 校验 + maturity 单向规则 + change_log 顺序 + checklist/stakeholders 基础
#         + §3.2 readRecentChanges {items,bad} + §3.4 maturity 非法 status fail-closed，115 断言）
node _fde_memory_a3_test.mjs

# A4 套件（notes 6 API + §4.2 四组双向过期 + §6.5 confidence 不可写 + §6.6 expires_at 不可写
#         + §6.7 slug 路径穿越 + readNote fail-closed + listNotes bad + reviewNote 原子写
#         + §2 三条修（todayLocal 本机时区 / isExpired 双向 / assertNoteFile 双向），61 断言）
node _fde_memory_a4_test.mjs

# A5 套件（六层各一条命中 + [L5] 封顶 10 + [L6] 封顶 20 + confidence 不可写
#         + 过期注记双向 + 复核后不进 [L6] + readCurrentPhase，33 断言）
node _fde_memory_a5_test.mjs

# import 覆盖套件（lib/*.js 除 index.js 自身与例外名单外都必须在 index.js import 图上
#         + 坏样本自证：去掉豁免必须红，11 断言）
node _fde_memory_import_cover_test.mjs

# 审计 L1 套件（0077：脱敏真阳性 + 监听器不阻塞 + assistant/chunk 过滤 + 链完整性，23 断言）
node _fde_memory_session_audit_test.mjs

# B1/B2 套件（source 防污染 5+3 断言 + confirm 工具三态 5 断言 + 退出码敏感，13 断言）
node _fde_memory_source_test.mjs

# E3 套件（迁移失败降只读，19 断言）：apply 不抛错 / 全部工具仍注册 / 审计落 schema-readonly
#         / 三个写工具拒 + 读工具照常 / 非只读与三参调用兼容 / 退出码敏感
#         ⚠️ E2 起「全部工具」从 tools.js 的导出常量算，不写死数字（原为 4 个硬编码名字）
node _fde_memory_e3_test.mjs

# E3 变异注入（12 条语义变异必须**全部**被具名断言抓住；GREEN 或 INVALID 都判非 0）
node _fde_memory_e3_mut.mjs

# E3 真 SDK 活验（真 defineTool 构造 + 真 HarnessError instanceof + 真 memory/ 树只读零污染，6 断言）
node _fde_memory_e3_live.mjs

# E2 套件（探索沙箱 spec §7，41 断言）：A 派生面 / B 加载期 fail-closed / C guard 真判定
#         / D 沙箱边界（含 .. 段、符号链接、大小上限）/ E 不进注入（逐字不变 + [L5] 双向）
#         / F 跨包字面量对拍（部署配置的 sandboxSubdirs / protectedExtraRoots[0]）/ G 打印双向
#         ⚠️ 它**不 import gate 的 config.js**（schemastery 无桩）⇒ 手写 cfg，代价由 F3/F4 补
node _fde_e2_test.mjs

# E2 变异注入（10 条语义变异必须**全部**被具名断言抓住；GREEN 或 INVALID 都判非 0）
#         目标是**工作区源码**（套件 import 的就是它）⇒ 收尾按 sha256 逐字核对还原
node _fde_e2_mut.mjs

# D1 套件（审计外置 L2/L3 + 离线降级 + phase 侧 L4 判据，**跨包**，107 断言）
#         A L2 队列（含"按数值升序而非字典序"的反例）/ B state.json 契约（缺席四档分开报）
#         / C evaluateRemote 三档 + 两处边界 / D L3 投递（只写端点、坏条目不删、一条失败就停、
#         降级与恢复留痕、重启重放）/ E phase L4 判据（含"不适用时不拦"的反例）
#         / F 跨包字面量 + `evaluateRemote` 逐例同解 / G 回执呈现面 / H config 校验
node _fde_d1_test.mjs

# D1 变异注入（26 条语义变异必须**全部**被具名断言抓住；GREEN 或 INVALID 都判非 0）
#         ⚠️ 与前几个变异套件**不同**：本套件改的是**沙箱副本**（`_mut/d1/`），真源码一次都不碰
node _fde_d1_mut.mjs

# 🔴 D1 **活体验证**（第六层：前五层证明"给定输入算得对"，这一层证明"在真 DSH 里接线接上了"）
#     分步执行，每步把证据**追加**到 `_fde_d1_live_out.txt`（不覆盖上一轮）：
node _fde_d1_live.mjs dry     # 不碰 DSH：配置补丁在 **YAML 解析层面**校验落在对的插件 config 里（15/15）
node _fde_d1_live.mjs probe   # 只读勘察：跑着的 DSH 里有没有这次的代码、outbox/state.json 该不该在
node _fde_d1_live.mjs live    # ✅ **交付态活验**（只读，不改配置不重启）：代码装上了吗 / 未配端点分支对吗 /
                              #    L4 的「本地链完整」真算一遍 / 四个 fde 插件还 active 吗。17/17
node _fde_d1_live.mjs prep    # ⚠️ **会重启 DSH**：备份配置 → 打补丁 → 起桩(3099) → 重启
node _fde_d1_live.mjs v1      # 心跳投递 ⇒ state.json present（顺带验 Bearer 头、URL、POST 方法）
node _fde_d1_live.mjs ev      # 造一条会话事件（`session/create`）—— **不碰任何已有会话**
node _fde_d1_live.mjs v2      # 入队 → 投递 → 删净；链上 seq 与投递的 seq/hash 对得上
node _fde_d1_live.mjs out     # 桩切 fail + 造事件（**阈值 4s，故意不达阈值**）
node _fde_d1_live.mjs v3      # 未达阈值 ⇒ L4 判 **missing**（不许提前降级）
node _fde_d1_live.mjs down    # 等到超阈值
node _fde_d1_live.mjs v4      # 超阈值 ⇒ L4 判 **degraded** + 链上有 telemetry-degraded
node _fde_d1_live.mjs rec     # 桩切 ok
node _fde_d1_live.mjs v5      # 补传：队列投净 + telemetry-recovered（带 pendingReview）
node _fde_d1_live.mjs restore # ⚠️ **会重启 DSH**：还原配置 → 杀桩 → 重启（**收尾必跑**）
#     桩本体：`_fde_d1_stub.mjs`（只写端点仿真，端口 3099，日志 `_d1_live_stub.jsonl`）
#     ⚠️ `prep` / `restore` 会 kill 运行中的 DSH 并改 `cordis.patch.yml` ⇒ 这两步需要**用户授权**
#     ⚠️ `prep`–`v5`–`restore` 这**一整条端到端**在 PoC 内**没有跑过**（需两次重启）；`live` 是交付态那一层。
#
# 诊断：`_fde_d1_chain_diag.mjs` / `_fde_d1_chain_diag2.mjs`（**只读**）
#     它们是 `live-C1` 报出 3 处假断链时写的二诊工具，`diag2` 是**判定"按 seq 重放 ⇒ 断链 0"**的那一次。
#     **刻意保留**：§12.6 第 5、6 条的结论都由它们产生，删掉就没有可复算的证据（见 `deletion-needs-reference-check`：
#     删除前先查引用 —— 这两份**被本节引用**，故一律不删）。不改任何文件，可随时重跑。

# 串行跑九个套件（任一非 0 ⇒ 非 0）
node dsh-fde-memory/precheck.mjs

# 验 exit code 敏感（FDE_INVERT=1 时套件必红，确认真的会非 0）
$env:FDE_INVERT='1'; node _fde_memory_a5_test.mjs; echo $LASTEXITCODE
```
退出码 0 = 全绿；非 0 = 有失败。

**A2 套件覆盖**（0079 §6 验证表 15 条 + 0082 §2.2 listDecisions bad 新断言）：
- §6.1-§6.2 规则表（6 基础档 + 4 叠加组合 + 补写档钉死）
- §6.3 confidence 不可写
- §6.4-§6.5 序号独占 + 文件名切分（phase=0.1 => 0.1-1.yaml）
- §6.6 连续写无重号、无空文件
- §6.7 失败清理（通过 `FDE_INJECT_WRITE_FAIL=1` 钩子注入）
- §6.8 fail-closed 读
- §6.9 source 枚举校验
- §6.10 跨包等价（linkHash / parseYamlSubset 行为对拍，含 3 条错误分支）
- §6.11 SRC_SHA 哨兵（源件变 ⇒ 提示不判红）
- §6.12 exit code 敏感（FDE_INVERT=1 必红）
- §6.14 不动既有状态（A2 全程临时目录，不接触真实部署）
- §6.13 / §6.15 由 `_deploy_diff.mjs` 和真活验负责
- **0082 §2.2 新断言**：`listDecisions bad 数量=0`（坏文件不存在的正向情况）

**A3 套件覆盖**（0082 §3.3 + §5 验证表）：
- §2.3 `assertPhaseId`：15 个合法 phase id 全过 + 10 个非法逐个抛（含路径穿越反例 `'../x'` / `'/abs'` / `'a/b'` / `'0.1/../..'` / `''` / `null` / `undefined` / `123` / `'abc'` / `'0.1.2'`）
- §2.2 `readDecision`：phase 为 number ⇒ 抛；内容 phase 与文件名不符 ⇒ 抛；seq 不符 ⇒ 抛；seq 非整数 ⇒ 抛
- §2.2 `listDecisions`：3 好文件 + 2 坏文件混合 ⇒ items=2 / bad=2（坏的不消失）
- §2.1 `confidence`：`psr='3'` / `psr=1.5` ⇒ 抛；`psr=null` / `psr=undefined` ⇒ 走默认 0 不抛；回归反例（`psr='3' + last_reviewed=null`）现在抛
- §3.2 `maturity`：draft→verified→locked 前进 OK；locked→draft 无 reason ⇒ 抛；有 reason ⇒ OK；history 留痕；同 rank no-op
- §3.3 `change_log`：追加 7 条 ⇒ `readRecentChanges(5)` 返回最后 5 条**倒序**（最新在前，[p-6, p-5, p-4, p-3, p-2]）；边界 limit=0/100；非法 kind/target/limit ⇒ 抛
- §3.2 `checklist` 基础：read/write + 整文件重写（同一 phase 写两次覆盖）+ item 字段校验 + 不存在 ⇒ null
- §3.0 `stakeholders` + `summarize`：insert + update（按 id upsert）+ summarize 4 字段（不含 contact/notes）
- §2.3 `assertPhaseId` 在 4 个入口（`writeDecision`/`readDecision`/`nextSeq`/`listDecisions`）均被调用 —— 路径穿越反例 `'../../escaped'` 被 assertPhaseId 挡住，无文件外漏
- §3.2 三写入器自动追加 change_log（checklist/stakeholder/maturity 写完各追加一条，kind 正确）
- INVERT 模式：FDE_INVERT=1 ⇒ 必红

## 3. 诚实缺口清单（0076 §7 + 0079 §7 + 0082 §6）

1. **spec 的 `$DSH_HOME/projects/{project}/` 路径不成立** —— 本实现落在 `config.projectRoot`（§3.1）
2. **`compliance.yaml` 在 `ontologyRoot` 而非 `memory/`** —— 与 spec 目录树不符（§3.2，**既有偏差，本单不修**，D5 已按此实现并活验通过）
3. **`decisions`/`checklist`/`stakeholders` 字段结构 spec 未定义** —— A2 已给出 decisions schema，A3 给出 checklist/stakeholders/maturity schema
4. **§5.x 3 处选择**（0076 §5.x，A3 已落地核证人建议的两条）：
   - 5.2a `stakeholders` 4 字段摘要 = `name` / `role` / `org` / `influence`（**A3 已落地**）
   - 5.2b `change_log` 数据源 = 新增 `memory/change_log.jsonl`（**spec 目录树外加文件**，A3 已建）
   - 5.3 注入面 = 只读工具 `fde_memory_context`（**不碰** `agent-instructions`，A5 落地）
5. **置信度规则的叠加顺序 spec 未写清** —— A2 已落地（写进 `lib/confidence.js` 代码注释 + 真值表钉死）
6. **D4 不受本单影响** —— 它仍卡在"外置归档远端比对"（PoC 外）；B 单（0077）只解锁它的 ①③ 两项
7. **A2 补写档（0079 §4 A2-2 注脚）**：§5.5 规则表第 1 步里 `source=fde_confirmed, !data_verified` 这一档 spec 未列，**A2 补为 `medium`**
8. **照抄件真实依赖（0079 §3 实核）**：0076 §3.3 漏写 `errors.js` 是 `yamlsubset.js` 的跨文件依赖
9. **A2 测试钩子**：`lib/decisions.js` 加了 `FDE_INJECT_WRITE_FAIL=1` 写盘失败注入钩子（**在生产代码路径上**：任何能设环境变量的进程都能让 decision 写入永久失败）。当前威胁模型内接受（PoC 单机 + 钩子为开发态工具），但必须在 README 写明
10. **0082 §6.1**：`change_log.jsonl` 是 **spec 目录树之外的新增文件**（§3.0 5.2b）—— 与 spec `memory/{ontology,decisions,checklist,notes,audit}/` 五目录并列出现，注入规则（"最近 5 条 change_log"）依赖它存在
11. **0082 §6.2**：`maturity` 的 `nodeId` **不校验**是否存在于 `objects.yaml` —— 那要读 ontologyRoot，是 dsl 的地盘，跨包不 import。**maturity 可以挂着不存在于 ontology 的 nodeId**（A5 工具面若要严谨，应在工具侧加 enum）
12. **0082 §6.3**：`stakeholders` 的 4 字段摘要是**本单拍定**，spec 未定（§3.0 5.2a）—— 注入面要回答"该找谁"，故选 name/role/org/influence
13. **0082 §6.4**：进程**崩溃**在 `rename` 之前会留下空 `<phase>-<seq>.yaml`（`wx` 已占位、`catch` 没机会跑）⇒ `nextSeq` 会跳过该号（**空洞**，不是重号）—— 崩溃路径未验，PoC 内接受
14. **0082 §6.5**：见 §9（A2 测试钩子，已在 A2 缺口里披露；A3 不重复但保留索引）
15. **0082 §6.6**：`listDecisions` 的 `bad` 列表是**新签名**（原为静默跳过）—— 若有外部调用方按老签名用会拿到对象而不是数组（当前无外部调用方）
16. **0084 §3.5**：`change-log` 的 `appendFileSync` **无 fsync**（decisions/checklist/stakeholders/maturity 都有）⇒ 崩溃时最后几条可能丢
17. **0084 §3.5**：`setMaturity` 里 `appendChange` 在写盘**之后**且无 try/catch ⇒ 若 change_log 写失败，maturity 已落盘但函数抛错（两处写入无事务）
18. **0084 §7.4**：notes 的 `expires_at` 由**本机时钟**算；`date` 缺省用**本机时区**（`todayLocal`，非 UTC —— 0086 §2.1 修复，原 `toISOString().slice(0,10)` 是 UTC，北京 00:00–08:00 写 note 日期会早一天）；时钟回拨/时区不影响天数比较（都用 ISO 字符串比较），但**跨时区**的"今天"以本机时区为准
19. **0084 §7.5**：**加载成功 ≠ 运行时正确**（§2）：`active` 只证明 15 个文件在进程内可解析；行为正确性靠离线断言（A1 68 + A2 47 + A3 115 + A4 61 + A5 33 + 审计 L1 23 + E3 19）
20. **0084 §7.6 → 0086 已关闭（部分）**：notes 过期降级已接进 `fde_memory_context` 的 `[L5]`/`[L6]` 层；**但只经这一个入口生效** —— 模型若不走该工具就看不到分层记忆，PoC 内**不保证**记忆一定进入上下文（见缺口 23）
21. **0084 §3.1**：`readRecentChanges` 是"全量读入 + 倒序取最后 N 条"，文件很大时内存仍 O(文件大小)，PoC 内接受
22. **0086 §2.1**：`todayLocal` 的"本机时区"断言在 **UTC 机器上恒绿**（`new Date(2026,8,28,0,30)` 的 `toISOString()` 版在 UTC 机器也返回 `2026-09-28`）；本机为 UTC+8，当前有效。断言旁已注明该前提
23. **0086 §2.2 / §7.4**：`isExpired` 的 `now` 缺省用**本机时钟**（§2.2 修完已 fail-closed —— 非法输入抛，不再 fail-open）；但**时钟回拨**仍会影响"过期/未过期"判定
24. **0086 §4.4（两条未做）**：① 跨 Phase 自动降档（`phases_since_review` 自动累加）**本单不做** —— 它需要"Phase 推进时回写 memory"，跨插件，留给 0077/下一批；② `session-start` 提醒**不做**（需要 `session/start` 挂点，本单不碰）
25. **0086 §3.2**：`config-schema.js` 是 import 覆盖断言里**唯一的显式例外** —— 它走动态 `import('./config-schema.js')`（import `@deepseek-ai/schemastery`，离线测试环境没有）
26. **0086 §7.6**：notes 跨进程并发写未验（PoC 单进程）
27. 🔴 **0077 §7.1 —— 已订正（2026-09-29，D1）**。原写「L2（外置远端）PoC **未实现** ⇒ L3 交叉校验做不了 ⇒ **②远端存在**在 PoC 内**永远为假**」。**该判断的两条依据都已不成立**：
    - ①「L2 才实现 `SessionTelemetryBackend`」——实测那个 seam 位已被 otel 占着、且跑在 `DISABLED` 上（§1.7 订正段）⇒ 走 seam 这条路是死的。**改走 L1 之上的自建队列**（§1.11），L2/L3 已实现。
    - ②「②远端存在永远为假」——现在它**可真可假**，且**降级模式下"存在"这一条被显式豁免**（spec §8 的降级语义）。
    - **仍然成立的残余**：**③签字三要素**需要 sign_off 事件 schema，**仍未定义**；另见本清单 41（降级降低保证强度这件事本身）。原句「L2 接口位留空（不建空壳占位类）」这条纪律**保持不变** —— `telemetry-sink.js` 不是占位（有 107 条离线断言 + 26 条变异 + 活验）。
28. 🔴 **0077 §7.2 —— 已订正（2026-09-29，D1）**。原写「投递是 **at-most-once / best-effort** —— 崩溃时队列中的内容丢失。持久化 outbox 明确推迟」。**持久化 outbox 已建**（`memory/outbox/{seq}.json`，§1.11）⇒ **崩溃不再丢队列内容**，重启后重放。
    - **仍然成立的两条**：① **`lib/audit.js` 的 L1 内存 `#outbox` 依旧进程退出即丢**（文件落盘失败时那条记录只活在内存里）——这与 L2 的文件队列是**两个不同的东西**，别混（`outbox.js` 头注释有对照表）；② **`appendFile` 无 fsync** ⇒ 已 rename 的队列文件在断电时仍可能丢，且"投递成功才删"这个窗口内崩溃会**重复投递一次**（幂等键 = 链上 seq，由服务端吸收）。
29. **0077 §7.3**：脱敏规则是**本单自定**（seam 不内置），漏检风险由规则表覆盖度决定。当前规则表见 §9.2。**未覆盖**：40+ 位连续 base64、命令输出/文件内容整段 `[REDACTED:content]`（这两条会误伤大量正常文本，本单不收 —— 写成规则表，不写成"应该没问题"）
30. **0077 §7.4**：`ctx.sessionTelemetry` 这个位**本单不占**（§3）；将来 L2 落地时**必须先卸掉其他后端**（重复注册抛错）
31. **0077 §7.5**：监听面只覆盖**本进程存活期间**的会话（`session/event` 是 live 面）；**历史会话不回填**
32. **E3 §1**：**真实迁移链仍是空的**（`CHAIN = {}`、`CURRENT = 1`）⇒ 生产环境**走不到** `migrate()` 的"有路径"分支。**这不是缺陷**：没有 v2 数据格式，就没有"从 v1 到 v2 的迁移"可言 —— 凭空写一条 `CHAIN['1'] = ['2']` 是**假迁移**（会声称"已迁移"而实际一个字节都没转），比空链更坏。可测的判定逻辑（无路径 ⇒ `failed` ⇒ 降只读）**已由离线断言钉住**（磁盘=2 / 代码=1 即触发），空链只影响"将来加 v2 时要补的那一环"。
33. **E3 §2**：只读判定在 `apply()` 期**算一次**。运行中改 `SCHEMA_VERSION` 文件**不热生效**（要重启 DSH）—— 与"改 cfg 必须重启"同类（§2.1 第 4 条）。
34. **E3 §3（最重要的残余缺口）**：只读守卫的覆盖面 = **当前这三个写工具**（`write_decision`/`confirm`/`review`）。插件内其他写路径（如 `installSessionAudit` 的审计落盘）**刻意不封**。⇒ "只读模式"的准确说法是**"记忆数据只读"**，不是"本插件零写入"。**任何新增写工具必须自己加 `assertWritable`，否则会静默绕开只读模式** —— 当前靠变异 M2/M3/M4 **逐工具**钉住，那是**逐例**覆盖、不是结构性保证（没有"新写工具忘了加守卫就报红"的机制）。
    - 🔴 **E2（2026-09-29）给这条加一个明确的例外：`fde_experiment_write` 有意**不加** `assertWritable`。** 理由：只读模式的语义是"**记忆数据**（schema 版本管辖的用户数据）封写"（见 §4 的 E3 修正），而**沙箱草稿不是记忆数据** —— 它是 spec §7 里明确"无审计要求、不进分层注入、不参与 D1/D3"的试验区，与 `SCHEMA_VERSION` 没有管辖关系。**把它一起封掉才是缺陷**：迁移失败时沙箱跟着不可用，等于让"降只读"这个韧性动作顺手砍掉试验区。
    - ⚠️ 所以读上面那句"任何新增写工具必须自己加守卫"时，要连**例外**一起读：**受 schema 版本管辖的**新增写工具必须加；沙箱类（写在 `memory/` 之外、不属于记忆数据）**不加**。这个分界**没有机制保证**，靠人判 —— 与这条缺口本来的性质一致，不假装它变好了。
35. **E3 §4**：审计记录**没有 schema 版本分段标记** ⇒ 只读期记录与之前的记录混在同一条链上，只能靠每条记录自身的 `type` / `from` / `current` 推断"这段是谁写的"（§1.9 残余风险）。链完整性（`prevHash`/`hash`）不受影响。
36. **E2 §1**：**沙箱禁符号链接**（`experiments.js` 的 `assertNoSymlinkInside` 逐级 `lstatSync` 判 `isSymbolicLink`），
    方向是**保守的**（宁拒不放），但代价是**合法用法也被拒**：沙箱目录里若有人手工做了个指向沙箱内另一个子目录的 junction/symlink，
    那个名字就**读写都用不了**。理由：分段校验（拒 `..` / 绝对路径 / 空段）挡不住"沙箱内一个软链接指向 `memory/`"这条路径，
    而逐级 `lstat` 能挡 ⇒ 在"少一个合法用法"与"多一条逃逸路径"之间选前者。**PoC 内没有真实用户会用软链接组织草稿**，但这是**行为约束**，要写进交付说明。
37. **E2 §2**：**链上没有沙箱记录是设计，不是审计坏了**（spec §7 第 4 条"沙箱内容无审计要求"）。
    沙箱的写/读/列**都不落 `memory/audit/events.jsonl`** —— 已由 `_fde_e2_test.mjs` 的 D9 用**真审计链核字节数前后不变**钉住，变异 M7（给沙箱写入加一条 `audit.record`）会红。
    ⚠️ 危害方向与一般缺口相反：**它是"少记了"，而读者最容易反过来读** —— 排查时若按"链上没有 ⇒ 写入没发生"推理，会得出**沙箱根本没被用过**的结论（错，沙箱本来就不记）。这条必须写在交付说明里，否则会变成一次误判。
38. **E2 §3**：沙箱**不参与 D1/D3 校验**是**结构性**的（spec §7 第 2 条），不是"我们没写代码去读它"：
    dsl 的 `ONTOLOGY_FILES` 用 `join(ontologyRoot, <固定文件名>)` **逐个文件读**（不枚举目录），
    而沙箱位于 `protectedExtraRoots[0]` 之下、与 `ontologyRoot` **无交集** ⇒ 结构上到不了。证明见 `_fde_e2_test.mjs` E4/E5。
39. **E2 §4**：沙箱**不进分层注入**（spec §7 第 1 条）用"逐字不变"来证：`_fde_e2_test.mjs` E2 断言
    在沙箱里放内容前后，`fde_memory_context` 的输出**逐字不变**；E3 用 `[L5] notes` 这个**真的会显示文件名的观测点**做**双向**断言
    （同一份 note 放进 `memory/notes/` ⇒ 立刻显示；放进沙箱 ⇒ 不显示）。⚠️ 反向对照不可省 ——
    否则"沙箱里的不显示"可能只是因为**那条注入路本来就是死的**（这是恒真判据的经典形态，实测踩过一次）。
40. **E2 §5**：`_fde_e2_test.mjs` **不 import `lib/config.js`**（它 import `@deepseek-ai/schemastery`，离线工作区无该桩
    ⇒ 整个模块加载失败、报告零产出），改为**手写 cfg**。代价由 F3（grep 确认 `normalizeConfig` 真调了两个沙箱校验）+ F4
    （断言手写 cfg 覆盖 `guard.js`/`paths.js` 读到的每个 `cfg.*`）补 —— **补丁过，不是绕过**，
    但终究不是直接跑真 `config.js`，如实记（§11.5；gate README 同款）。

41. **D1 §1（诚实边界，spec §8 原文）**：**降级模式降低审计保证强度**，不是"和正常一样安全"。spec 原文要求把这条写进交付 —— 所以：① 本 README 这一条；② `lib/telemetry-sink.js` 头注释；③ phase 的**回执正文**（`degraded: true` 时打印那段中文说明，见 `_fde_d1_test.mjs` G1/G1b）。**三处都有**，不是"文档里写了"。降级期间的通过**记在 phase 的审计链上**（`degraded: true`），可事后按窗口筛出来复核。
42. **D1 §2**：**没有跑通对真实远端端点的投递**。spec §8 的 L3 端点需要真服务账号与写凭据，PoC 内不存在 ⇒ 离线套件用**注入的 `fetchImpl`**（`deps.fetchImpl`）覆盖成功/失败/超时/坏响应四条路径，活验用一个**本地桩端点**。⚠️ 由此产生一条真实缺口：**真实端的鉴权/重试/幂等语义（例如 409 重复、429 限流）从未被验证过** —— 本实现「只看状态码、非 2xx 一律算失败」，遇到 429 会当失败并开始降级计时。这是**已知的有意简化**，不是 bug。
43. **D1 §3**：`telemetry-sink.js` 的定时器是 `setInterval(...).unref()` ⇒ **它不会阻止进程退出**（正确），但也意味着**进程被 SIGKILL 时最后一次 drain 不会跑**（`dispose()` 里的收尾只在正常拆卸路径上）。⇒ 队列里最多留一批未投递条目，由**下次 apply 重放**兜住。
44. **D1 §4**：`state.json` 的**单写者假设是"同一时刻只有一个 memory 插件实例在写同一个 `projectRoot`"**。多进程/多实例（例如两个 DSH 进程指同一个 `fde-state`）会**互相覆盖** `outageSince`/`degradedDelivered`，而**两边都不会报错**。PoC 单进程内成立；这条**没有机制保证**，靠部署纪律。
45. **D1 §5：第六层（活体验证）—— 交付态已活验、端到端未验**（2026-09-29）。
    **第一层（离线）**：`_fde_d1_test.mjs` 107/107、`_fde_d1_mut.mjs` 红 26/绿 0/无效 0、
    `_deploy_diff.mjs` 双方 ALL_MATCH、`_run_all_tests.sh` 41 套件 ALL-TESTS-GREEN。
    **交付态活验：已做，`node _fde_d1_live.mjs live` 17/17 全绿**（用户手动重启 DSH 后跑的，**纯只读**）。
    它证明的是"新代码在真进程里装上了、且在**未配端点**这一交付态下行为正确"：
    - `live-A1/A2/A3`：真进程写出了 `telemetry-disabled`（`seq=433`，在链尾窗口内），
      且链上 `telemetry-*` 记录**只有这一种** —— 即 `installTelemetrySink` 真的被 apply 调用了
      （接线断了的话这一条不会有）；
    - `live-B1/B2`：该记录读起来是"**配置选择**不是故障"（`reason` 含"未配置 telemetryEndpoint"、`note` 含"配置选择"）；
    - `live-C1…C7`：**L4 的前半句「本地链完整」在活体上真算过一遍** —— 434 条按 `seq` 重放，
      断链 0、哈希不符 0、无重号、无缺号，链尾 head == 文件末行 hash；`C7` 是**负向自证**
      （篡改一条必不符 ⇒ 证明 `C2` 不是恒真式）；
    - `live-D1/D2`：未配端点 ⇒ `outbox/` 与 `state.json` **都不存在**（双向判据）；
    - `live-E1…E3`：`pluginInventory/list` ⇒ 四个 fde 插件全部 `fiberPhase: active`、无 failed
      （D1 改动没弄坏插件加载）。
    仪器自身的两个 bug 也在这轮被抓出并修掉，都是"**长得像实现没做到**"的形状，见 §12.6 第 5、6 条。
    **仍未验的是"端到端接线"**：投递、降级三档、恢复补传（`prep` → `v1`…`v5` → `restore`）。
    这一段要求**改 `cordis.patch.yml` 并重启 DSH 两次**，超出"只读活验"的范围，PoC 内**未做**。
    ⇒ ⚠️ 交付文案**只可**写"D1 的 L1 采集、L4 本地链一侧已在交付态活验；L2/L3 的对远端投递
    仅有离线证据（注入 `fetchImpl`）+ 本地桩设计，**未在真实进程里跑过**"，
    **不可**写"D1 已端到端活验"。

## 4. SCHEMA_VERSION 决策与理由

- **缺失 ⇒ 视为 v1 并写入**：因为本插件是新引入的，磁盘上不可能有更老的版本
- ⚠️ 另一种合理做法是 fail-closed（缺失即拒绝启动）；本单选"视为 v1 并写入"是为了让首次安装不需要手工预置 SCHEMA_VERSION 文件
- 这条决策**写进 README**（即本节），是因为 0076 §5 A1.3 明确要求"要写进 README 的决策与理由"
- **存在且 != 当前版本且无迁移路径 ⇒ fail-closed**：不许"猜测兼容"（0076 §1 完成判据 3）
- 🔴 **E3（2026-09-29）修正这条的**作用域**：fail-closed 指的是**写** fail-closed，**不是"整个插件不加载"**。
  - 旧实现（A1 起）：`status === 'failed'` ⇒ `apply()` `throw` ⇒ fiber failed ⇒ 包括**读**在内全没了。
  - 现实现：保留读、只封三个写工具，并在审计/日志里明说降级（§1.9）。spec 第七节原文见 §1.9 引文。
  - **判据（可复算）**：迁移失败时 `fde_memory_context` 仍返回内容，三个写工具抛 `MEMORY_SCHEMA_READ_ONLY`；`apply()` 不抛错且**全部工具**注册。见 `_fde_memory_e3_test.mjs` §2/§3。

## 5. A2 设计决策与理由（0079 §2-§4）

### 5.1 批次调整：confidence 提前到 A2
- `0076 §5` 原把 `lib/confidence.js`（规则表）放 A5
- **0079 §2 把它提前到 A2**：① `decisions` 落盘要写 `confidence` 字段，若 A2 不写、A5 才补，则 A2 落盘的文件缺字段，A5 回头要么迁移已落盘文件、要么写兼容分支 —— 而 `SCHEMA_VERSION` 本单只有 v1，没有迁移链可走；② 它是纯函数零 IO，最容易被逐条断言钉死；③ 提前后 A5 只剩"分层注入 + 升级路径"，体量更稳

### 5.2 照抄件依赖（0079 §3 实核）
- 0076 §3.3 说 `yamlsubset.js` 照抄整 file —— **不完整**
- 实核：`yamlsubset.js:17` `import { DslError } from './errors.js'`，三处 `throw new DslError('YamlParseError', …)`
- 照抄件实际是 3 个文件：`errors.js` + `yamlsubset.js` + `audit.js`，少 `errors.js` 会让 `yamlsubset.js` 一 import 就 `Cannot find module './errors.js'` ⇒ 插件 fiber failed（失败点在 import 期，报错离"我少抄了一个文件"很远）
- **两条纪律**：
  1. `DslError` 类名不改（虽带 `Dsl` 前缀、住在本插件里）—— 改名会让"逐字照抄"对拍判据失效，将来两边漂移无从发现
  2. `lib/audit.js` 本批交付但本批不接线（decisions 写入**不进**哈希链）。使用者是 `0077` B1。**唯一刻意差异**：本插件**导出 `linkHash`**（phase 那边未导出）—— 不导出无法在回归里直接对拍；这是**增加导出**，不改行为

### 5.3 序号分配：独占创建 + 重试（非锁/非内存计数器）
- `nextSeq`：扫目录取最大 + 1（不用内存计数器，重启会重号）
- 抢号：`openSync(final, 'wx')` 原子排他创建；EEXIST ⇒ seq+1 重试（上限 50 次）
- 写盘：`tmp + fsyncSync + closeSync + renameSync(tmp, final)` —— **比 `dsh-fde-phase/lib/state.js` 多一步 fsync**（数据先落盘再改名）
- 失败清理：catch 块 `unlinkSync(final)`，**不许留空文件**（空文件会污染 nextSeq）
- **跨进程高并发未验**（0079 §7.4 诚实缺口）—— PoC 内够用（单进程 + 目录级独占）

### 5.4 字符串 YAML 安全：数字字面量加引号
- `serializeYaml`/`formatValue`/`formatInline` 对"看似数字的字符串"（如 `"0.1"`、`"3"`）强制加引号
- 原因：`parseYamlSubset` 把不带引号的 `0.1` 解析为数字 0.1，破坏 `phase` 字符串语义
- 判断条件：`!isNaN(Number(v)) && isFinite(Number(v))`（含 `0.1` / `3` / `-1` / `1e3` 等）
- **A3 §3.1 提取**：三个函数已搬迁至 `lib/yaml-write.js` 并导出，`decisions.js` 改为 import —— 避免三个 A3 写入器各抄一份导致漂移

## 6. A3 设计决策与理由（0082 §3）

### 6.1 §3.0 拍定（spec 未明确，本单出单人拍定）
- **5.2a stakeholders 4 字段摘要** = `name` / `role` / `org` / `influence`：注入面要回答的是"**该找谁**"：是谁 / 干什么 / 哪家 / 说话有多重（`high|medium|low`）。联系方式类字段不进摘要（隐私 + 体积），只在按需检索时给
- **5.2b change_log 数据源** = 新增 `memory/change_log.jsonl`（append-only）：① spec 的注入规则明确引用"最近 5 条 change_log"，没有它这条规则无法实现；② **不能**用 `maturity.yaml` 的变更历史聚合代替 —— 覆盖面不同（maturity 只记节点成熟度变更，change_log 要记**所有记忆写入**）；③ 它是 **spec 目录树之外的新增文件**，README §3 必须单列

### 6.2 §3.1 提取：先做一次 yaml-write.js（否则出现两份 serializeYaml）
- `serializeYaml`/`formatValue`/`formatInline` 原私有在 `decisions.js:213-268`
- A3 的三个写入器都要用 ⇒ 新建 `lib/yaml-write.js` 逐字搬迁并导出，`decisions.js` 改为 import + 删本地
- **搬迁是逐字搬迁**（连注释一起），不许顺手改行为 —— 改完 `decisions.js` 的行号会整体上移

### 6.3 §3.2 三个库 + 共有约定
- **三个写入器共有约定**：① 走 `assertPhaseId`（凡带 phase 的）；② 写完 `appendChange` 追加一条 change_log；③ 原子写（tmp+fsync+rename）
- **maturity 的 nodeId 是自由字符串**（本插件**不校验**它存在于 `objects.yaml` —— 那要读 ontologyRoot，是 dsl 的地盘，跨包不 import）。**README 必须披露这条**：maturity 可以挂着不存在于 ontology 的 nodeId（§3 缺口 11）

### 6.4 §2 三条补丁（A2 已交付但未真活验，本单随 A3 同批落）
- **§2.1 fail-open 修复**：`phases_since_review` 非整数（字符串 '3' / 浮点 1.5）原静默当 0 ⇒ 时效衰减整条失效。改 `null/undefined` 视为"未提供"，其余非整数一律抛（与 yamlsubset 的"宁可报错，不可猜"纪律同款）
- **§2.2 双向断言**：readDecision 加 `phase 必须字符串 / phase==文件名 / seq==文件名` 三条断言（防 type drift）；listDecisions 改签名 `{items, bad}`（坏文件进 bad 而非静默消失）
- **§2.3 路径穿越防御**：四个入口共用 `assertPhaseId`（PHASE_ID_RE），导出供 A3 复用


## 7. A4 设计决策与理由（0084 §2-§4）

### 7.1 §2 index.js import 化（让活验判据第一次有验证力）
- **问题**：A1 交付的 `lib/index.js` 只 import `config.js` + `schema-version.js`，A2/A3 交付的 12 个库**全部不在加载图上** ⇒ "重启后 4 插件全 active" 在三种情况下都为真（重启前/后/12 文件全坏）⇒ 该判据对 A2/A3 **零验证力**（恒真式）
- **修法**：顶部静态 import 全部 12 个库（一行一个）。**不**改成动态 `import()` —— 动态 import 的失败可被 try/catch 吞掉，失去 fail-closed
- **收益**：静态 import 是加载期求值 ⇒ 任一库有语法/解析/依赖错误 ⇒ `fiber failed`。"active" **第一次**有了实际含义
- **⚠️ 加载成功 ≠ 运行时正确**：active 只证明 12 个文件可解析；行为正确性靠离线断言（67+47+108+A4）
- **0086 §3-§4 + 0077 扩展**：再 static import `notes.js` + `tools.js`（0086）＋ `session-audit.js`（0077）⇒ 现共 **15 个相对库**

### 7.2 §4.0 三处拍定（spec 未定，本单出单人拍定）
- **a) expires_at 一律由写入器按 TTL 算**，不接受调用方传值（传了忽略并覆盖）—— spec 说 informal_commitment 强制 30 天，"强制"只有在调用方无法覆盖时才是强制
- **b) confidence 由 deriveConfidence(facts) 推**（复用 A2 纯函数），调用方传了忽略并覆盖 —— spec 第六节：禁止模型写 confidence，与 decisions 同款禁令 ⇒ 两处实现必须一致
- **c) TTL 来源 = config 的 notesTtlDays（默认 90）/ informalCommitmentTtlDays（默认 30）** —— A1 的 DEFAULTS 里已有这两个值，直接用。非正式承诺的 30 天**不可**被 config 调高（强制项优先，实现用 `Math.min(cfg, 30)`）

### 7.3 §4.1 slug 白名单（路径穿越防御）
- 只允许 `[a-z0-9-]`，挡 `../`、`/`、`:`、空格、大写
- 同 §2.3 `assertPhaseId` 精神 —— A3 那条路径穿越缺陷的同类面，不要等下次被探针打出来

### 7.4 §3 四条小修
- **§3.1 措辞修正**（方案 A）：原注释"按行倒读、不全量解析"名不副实。实际是"全量读入 + 倒序取最后 N 条（只 parse N 条）"。只改注释与 README 措辞，不真做尾部读
- **§3.2 readRecentChanges 改签名 `{items, bad}`**：坏行进 bad 而非静默消失（与 listDecisions 同形）。change_log 是 A5 注入面数据源 ⇒ 静默跳过 = 注入面静默缺内容
- **§3.3 maturity 同 rank 注释修正**：删掉"仍追加一条 history 留痕"半句。实现是 no-op + 不写盘（审计上视为幂等 no-op）
- **§3.4 maturity readMaturity 加 fail-closed**：读到 `rec.status` 若是手改过的非法值（如 3）⇒ 抛。防 `RANK[非法] === undefined` 导致 `newRank < undefined` 恒为 false、单向规则被绕过

## 8. A5 设计决策与理由（0086 §2-§4）

### 8.1 §4.0 命名（下划线族）
- memory 四个工具走 **`fde_*` 下划线族**（与 gate/phase 的写入类工具同族）：`fde_memory_context` / `fde_memory_write_decision` / `fde_memory_review` / `fde_memory_confirm`。现行 dsl 有 `fde-run-validation`（连字符族），两族并存是既有事实；`grep fde_memory` 零冲突
  - E2 的三个沙箱工具另起 **`fde_experiment_*`** 前缀（不叫 `fde_memory_experiment_*`）：它们是**沙箱**的入口、不是记忆数据的入口，前缀把这条边界写进名字里（与 §1.10 表格里"三处刻意相反"呼应）。`grep fde_experiment` 同样零冲突

### 8.2 §4.1.1 层名前缀用 ASCII（不用 ①②③）
- 层名定成 `LAYER` 常量（`[L1]`~`[L6]` + 中文说明），**不散在模板里**
- **理由**：① 套件要稳定 grep 层名，全角数字在不同代码页下会变形（本项目 `_*_out.txt` 就是为躲这个）；② 中文说明留给模型读，不受影响；③ 每段末尾带计数（如 `[L5] notes（N 条，其中过期 E 条）`），让最小 grep 面自我暴露

### 8.3 §4.1.2 [L5] 与 [L6] 的分工（不冗余）
- `[L5]` 是**内容视角**（notes 正文，按 date 倒序封顶 10）；`[L6]` 是**待办视角**（过期未复核队列，按 `expires_at` 升序封顶 20，只给文件名+date+过期天数）
- `[L5]` **必须封顶**：初稿无上限 ⇒ note 一多注入面就爆；封顶 + 段尾计数，截断要看得出来

### 8.4 §4.2 HarnessError 拿法（拍定 1，2026-09-28 修订）
- `import { HarnessError } from '@deepseek-ai/dsh-llm'`
- **事实（修订）**：`HarnessError` 真身是 `@deepseek-ai/dsh-llm` 的类，**dsh-tools 并不 re-export**（实测 `dshTools.HarnessError === undefined`）。旧写法 `const HarnessError = dshTools.HarnessError ?? Error` 在真 SDK 下静默降级丢 `code`。工作区离线桩补 `node_modules/@deepseek-ai/dsh-llm/` 同形状类，具名 import 离线不崩。不新建类、不用 `DslError` 顶替（语义不同）

### 8.5 confidence / expires_at 不可写（三处一致）
- `fde_memory_write_decision` 的 `confidence`、`fde_memory_review` 的 `reviewed_at`、notes 的 `expires_at` —— 一律由写入器算，调用方传了忽略并覆盖（与 `decisions.js` / `notes.js` 同款禁令，三处实现必须一致，不许漂移）

### 8.6 §3 import 覆盖断言（可判红，非恒绿）
- 判据：`lib/*.js` 除 `index.js` 自身与显式例外名单外，每个文件都必须出现在 index.js 的 import 上（`from './<file>'`）
- **坏样本自证**：把 `EXEMPT` 里临时去掉 `config-schema.js` ⇒ 断言必须红；恢复 ⇒ 绿。这是让"新增 lib 却忘了加 import"能红的关键，否则是恒绿断言

## 9. 0077 审计外置 L1 设计决策与理由

### 9.1 §3 L1 不走 telemetry seam
- L1 用 `ctx.on('session/event')`，**不实现 `SessionTelemetryBackend`**（L2 才实现）
- **理由**：① seam 语义是「对外上报」（`sharing` 披露的是"会话是否被共享给外部"），L1 是本地落盘，不该假装成外发；② `ctx.sessionTelemetry` 重复注册抛错，L1 占了它 L2 就挂不上；③ `ctx.on('session/event')` 是 cordis 基础面，零额外依赖

### 9.2 §4 B3 脱敏规则表
- 键名命中 `/(token|secret|password|passwd|credential|authorization|cookie|api[_-]?key|jwt|bearer|signature)/i` ⇒ 整值 `[REDACTED]`（宁多不漏）
- 值命中 `Bearer\s+[A-Za-z0-9._~+/=-]+` / `sk-[A-Za-z0-9]{16,}` / JWT 三段式 ⇒ 打 `[REDACTED:bearer]` / `[REDACTED:sk]` / `[REDACTED:jwt]` 标记
- **递归深度上限 30**：超深嵌套返回 `[REDACTED:depth]`（防深度炸弹）
- **不原地改**：返回新对象，源数据不受污染
- 真阳性用例：合成含 `Bearer sk-…` 的事件 ⇒ 落盘文件搜不到明文（脱敏"能观测到"≠"会被判红"，必须有真阳性断言）

### 9.3 §5.a / §5.b 拍定
- **5.b 每条一行 + 异步串行 writer**（`setImmediate` 触发 `drain()`，`queue.shift()` 保序落盘）
- **5.a 被动 flush**：监听 `session/flush` → `await audit.flush()`（把 outbox 落盘），**不主动调 `ctx.sessions.flush(session)`** —— 那个 flush 的语义是会话存储 durability checkpoint，不是我们 outbox 的落盘；本单也不在同步监听器里 await（会阻塞 agent loop）

### 9.4 链完整性判据（§2.3③）
- 用**自己的** `prevHash`+`hash` 链判完整，**绝不用** session 事件 `seq` 连续 —— 事件 seq 缺口是常态，用它判会造出永远为红的假告警
- 重放脚本 `_replay_memory_audit.mjs`：逐行校验 seq 单调无重号 + `hash == linkHash(prevHash, 去掉 prevHash/hash 的 record)` + `prevHash == 上一条 hash`（首条 `prevHash == GENESIS`）

### 9.5 复用 lib/audit.js（不新建第二份）
- `session-audit.js` 直接 import `lib/audit.js` 的 `AuditChain`（同包内），不照抄第二份链实现
- **理由**：0076 §3.3 禁止的是**跨包** import（插件独立安装），**同包内** import 无此约束；照抄只会造出两份漂移的链

### 9.6 不建 telemetry-sink.js 空壳占位
- 施工单 §3 原写「留 lib/telemetry-sink.js 占位」，本单**改为留空**（README 缺口 27/30 记录）
- **理由**：占位类不注册、不 import 真基类（离线环境无 `@deepseek-ai/dsh-session-telemetry`），是纯死代码；`emit` 抛错的行为永远测不到（不注册），加它只扩大 fail-closed 面却不增加可验证行为
- 🔴 **订正（2026-09-29，D1）：`lib/telemetry-sink.js` 现在有了 —— 但它不是本条说的那个东西。**
  本条反对的是「**空壳占位类**」（不注册、不可测、纯死代码），那条理由**完全没变**。
  D1 建的 `telemetry-sink.js` 是**有行为的投递器 + 降级状态机**（107 条离线断言 + 26 条变异 + 本地桩端点活验），
  且**仍然不 import** `@deepseek-ai/dsh-session-telemetry`、**仍然不碰** `ctx.sessionTelemetry` 那个位
  （理由见 §1.7 订正段与 §1.11：那个位被 otel 占着，且它跑在 DISABLED 上 ⇒ seam 这条路是死的）。
  ⇒ **同名不同物**：读本条时不要以为"当初说不要、后来又加了" —— 反对的是空壳，加的是有行为的实现。

## 10. E3 设计决策与理由（2026-09-29）

### 10.1 守卫放在每个写工具的**第一行**，不包一层装饰器
- 备选：写一个 `withWritable(execute)` 高阶包装，注册时统一套上。
- **选第一行**，理由：读者打开任一写工具，**第一眼**就看到"它受只读约束"；换成包装器后，这个事实藏在注册点的 map 里，读单个工具看不见。
- 代价（如实记）：**新增写工具不会自动继承守卫** —— 必须手写。这是缺口 34，也是变异 M2/M3/M4 存在的理由（逐工具钉住"这行还在"）。

### 10.2 审计不停写（取舍，两个理由见 §1.9）
- 备选：只读模式下连审计一起停，最大化"不写任何东西"。
- **选不停**：审计是运行痕迹不是用户数据；停写会让只读期完全无痕。
- **残余风险**明写进缺口 35：链上没有版本分段标记。

### 10.3 审计里 `current` 写**插件支持的版本**，不写 `sv.version`
- 第一版实现写的是 `sv.version` —— 而 `failed` 分支的 `sv.version` **就是磁盘上的版本**（= `sv.from`）⇒ 记录会变成 `from:2, current:2`，读者看到的是"从 2 迁到 2 却失败"这种**自相矛盾**的记录。
- 改成 `SCHEMA_CURRENT` 才读得出真相：磁盘是 2、本插件只支持 1、中间无迁移路径。
- 这是**变异 M9** 钉住的那一条（把 `SCHEMA_CURRENT` 改回 `sv.from` ⇒ 具名断言当场红）。

### 10.4 测试夹具的两个形状要求（吃过亏，写下来）
- **登记序 = 输出序**：异步用例各自往自己的**槽位**写结果，收尾统一渲染。第一版用 `lines.push` 直接追，结果 `sleep(80)` 的用例落到输出后半段、`[场景 3]` 的标题跑到用例前面 —— 读的人会以为那条用例属于上一节。**能靠输出形状解决的，别靠读者的注意力。**
- **`out.txt` 必须非空且有 `RESULT:` 行**：本项目有过一次 `_fde_d5_test.mjs` 是 **0 字节**却留下 `PASS 9 / FAIL 0` 产物的事故（`node` 跑空程序必然零断言 + exit 0）。判定"跑过"要三件套：脚本字节数（`ls -la`）+ 当场重跑 + 退出码。变异脚本里判 `crashed = out.txt 里没有 RESULT 行` 就是这条纪律的落地。

### 10.5 "零污染"要用快照**自证**，不能靠声称
- 场景 3 在**真 `memory/` 树**上跑：读 + 被拒的写。为了证明"一字未改"不是口头承诺，脚本对真目录树做**前后递归快照**（相对路径 → `size:mtimeMs`）并逐项对比，输出里打印文件数与结论。
- 同理场景 1 用**纯读**的 `readSchemaVersion`（不是 `ensureSchemaVersion`）—— 后者在文件缺失时会**写盘**，不该让"只读观察"这条路径带写能力。这是"生产路径上不持有写能力"的具体做法。

## 11. E2 设计决策与理由（2026-09-29，spec §7）

### 11.1 沙箱位置：**不是**"再配一个 extra root"，而是在保护根**之内**开豁免
- 沙箱必须在**模型可读写**的地方（否则不叫沙箱）。而 `<fde-state>` 整个是 `protectedExtraRoots[0]`，
  且守卫**读也拦**（见 gate README 的 P1-7）⇒ 在它下面加一个 extra root 配出来的沙箱是**不可用的**。
- **否决的备选**：把保护根收窄成 `[<fde-state>/memory]`，让 `<fde-state>/experiments` 自然落到保护之外。
  **为什么否决**：`SCHEMA_VERSION` 在 `<fde-state>/` **根下**（不在 `memory/` 里，见 `schema-version.js`），
  收窄后它**真的**失去保护 —— 模型能直接改 `SCHEMA_VERSION` 绕开 E3 的整套迁移判定。
  那是把"沙箱可用"换成"**保护面变小且变得 fail-open**"，方向错。
- **选定**：保护根一个不动，另加 `sandboxSubdirs` 做**显式、单向、可打印**的豁免。
  收窄三条（只挂 extra / 单段名 / 默认空）写在 gate README 的「探索沙箱豁免」节 —— 跨包，两边都要写。

### 11.2 命名 `fde_experiment_*`，**不叫** `fde_memory_experiment_*`
- 名字是**唯一的、一直在场的**文档。`fde_memory_` 前缀会让人按 §1.9 的只读模式去核它、
  按 §3 缺口 34 去核它的 `assertWritable` —— 而这两条**都不该**适用于它。
- 另起前缀让"这不是记忆数据的入口"**在名字层面就成立**，而不是靠读者找到 §1.10 才明白。

### 11.3 为什么**不提供** promote / 提升工具（要求 ③ 的正确落点）
- spec §7 说的是"通过**正式变更通道**（L0/L1/L2）合入"，而正式通道 = gate 的 `fde_ontology_write`
  （带 source 溯源 / confidence 门槛 / 越界判定 / 分级）。
- 给沙箱单开一条"提升"入口 = 在门禁**旁边**开一条旁路，正是整套门禁要防的东西；
  而且那条旁路还得自己重新实现一遍 source/confidence/分级 —— 两次实现必有一次先腐坏。
- ⇒ 沙箱产物合入时**和模型凭空想出的草稿走同一条路**，没有优待。三个工具的 description 都写明这条。

### 11.4 隔离用"**逐字不变**"证，不用"我没写读它的代码"证
- 后者是**关于代码的断言**，而且论证方向是反的：它证明的是"我以为的读路径不包含沙箱"，
  不是"沙箱进不了上下文"。只要有一条我没意识到的读路径（例如将来某层改成枚举目录），
  前者仍绿、后者已破。
- ⇒ 判据改成**可观测的输出**：`fde_memory_context` 的输出在沙箱塞入内容前后**逐字不变**（E2）。
- ⚠️ **但"不变"单独一条也是恒真的**（若那条注入路本来就是死的，两边都是空 ⇒ 永远绿）。
  ⇒ 必须配**正面对照**：同一份 note 放进 `memory/notes/` 会**立刻**在 `[L5]` 里显示（E3）。
  这是本项目记过的恒真判据形态（§10.4 的 `_fde_d5_test.mjs` 0 字节事故、以及一次 `[E3]` 原写法的失败），
  所以对照**不是可选补充**，是这条判据成立的前提。

### 11.5 离线套件不 import `config.js` —— 代价与补丁（跨包同款，两边都记）
- `config.js` import `@deepseek-ai/schemastery`，离线工作区只有 `dsh-tools` / `dsh-llm` 两个桩 ⇒
  import 它会让**整个模块加载失败、报告零产出**（第一次跑就撞上：`ERR_MODULE_NOT_FOUND`）。
- **处置**：`_fde_e2_test.mjs` 手写 `makeGateCfg()`，并补两条断言把这个代价**封住**：
  **F3** grep `config.js` 确认 `normalizeConfig` 真的调了两个沙箱校验（M9 可证伪）；
  **F4** 断言手写 cfg 覆盖 `guard.js` / `paths.js` 读到的**每一个** `cfg.*` 字段。
- ⇒ 这是"**补丁过的**"而不是"绕过去的"；但它终究不是直接跑真 `config.js`，所以写进诚实清单（§3 条目 40）。

### 11.6 一条刻意的测试修法（"旧断言指控正确实现"的实例，记下来）
- E2 加了 3 个工具后，**两个既存套件**（`_fde_memory_test.mjs` / `_fde_memory_e3_test.mjs`）的
  「迁移失败时**四个工具**全部注册」把**正确实现**判成了红的（实测 PASS 65 / FAIL 2）。
- 最省事的"修法"是把沙箱工具摘掉 ⇒ 灯变绿、缺陷回来。**没这么做**：
  改成从 `tools.js` 的**导出常量**派生期望清单 —— 加工具自动跟上，缺注册仍判红。
- 同批还修了 `_fde_memory_import_cover_test.mjs`：新文件 `experiments.js` 由 `tools.js` import
  （`index.js` 不直接用它的导出）⇒ 旧判据"必须在 **index.js** 的 import 上"判它缺失。
  改成沿 `from './x'` **递归**收集可达集 —— 并**保留坏样本**（`config-schema.js` 去掉豁免仍必须红，
  它走动态 `import()`，递归只跟静态两式）⇒ **是手段升级，不是放宽**。

### 11.7 一处**间歇红**被当成缺陷处理（而不是当噪声忽略）
- `_fde_memory_e3_test.mjs` 的 `schema-readonly` 断言单跑出现过一次 `types=[]`，紧接着连跑 6 次全不复现。
- 根因：`audit.record` 是 **fire-and-forget**，测试用固定 `sleep(80)` 等它 —— 机器一慢就读不到。
- ⇒ 改成 `waitForAudit(dir, pred, 3000)` **轮询**（出现即返回，超时也返回、由断言判红，函数自己不抛）。
- **为什么值得单独记**：间歇红比稳定红更危险 —— 它会被当成噪声重跑掉，而它下一次出现的场合是
  **CI 或客户现场**。判据是"有没有可能因为**等我等得不够**而红"，是的话就得轮询。

## 12. D1 设计决策与理由（2026-09-29，spec §8）

### 12.1 为什么 L2/L3 没走 spec 字面上的 `SessionTelemetryBackend`
spec §8 的 L3 写的是「**自定义 TelemetryBackend** → HTTP(S) 只写端点」。实测对不上的有两处（细节见 §1.7 订正段）：
`ctx.sessionTelemetry` **只有一位**且已被 otel 占着（重复注册**抛错**）；而那个 otel 后端跑的是默认
`mode: DISABLED`，DISABLED **不构造协调器** ⇒ `session-telemetry/record` waterfall **永不派发**。
⇒ 就算不撞第一点、改成挂个 waterfall 监听器，**这条路在本部署下也是死的**。

按 spec §9.0 自己写的「**开发第 0 步：验证这些 API …… 对不上先改方案再写代码**」，改为建在**已有的 L1 采集**之上。
**收益**：这条路真会跑，而不是挂一个永不触发的后端。**代价**（必须写进交付，不能只说收益）：
拿不到 seam 的 `sharing` 披露与「每 (turn,step) 只发首块」投影 —— 投递的是**本插件自己捕获的**记录。

### 12.2 阈值只有一个真源，且**写进文件**而不是缓存成布尔
「进入降级」由**时长**决定，而 **24h 那一刻没有任何写入动作** ⇒ 任何"在切换时翻一个标志位"的写法都必然过期
（读者会在阈值刚过时仍看到旧值，直到下一次投递失败）。⇒ 把 `degradeAfterMs` 存进 `state.json`（写者是 memory），
phase 侧**每次现算**。两侧的 `evaluateRemote` 必须同解 ⇒ 由 `_fde_d1_test.mjs` 的 F 组**逐例对拍**（20 组输入），
变异 M23（只改 phase 一侧的 `>=`）会红。

### 12.3 「没配」与「读不到」必须分开（否则复现 spec 要修的那个死锁）
- `telemetryStatePath` **为空** ⇒ L4 **不适用**（`applicable: false`）。把它判成"不满足"会让
  **所有没接远端审计的部署在 Phase 4 永久卡死** —— 那正是 spec §8 要修的形态（v2 的 D4「远端不可达 = 永远不过」）。
- 路径**给了**但读不出来（坏 JSON / schema 不认 / 空文件）⇒ **fail-closed 判 `missing`**。
  "读不到"绝不能当成"没问题"：那会把盲区说成事实。
- 两条各自有反例钉住：E1/E1b（不适用不拦）与 E2/E2b（读不到则拦）。

### 12.4 `degradedPasses` 字段**被删掉**了（一个"没有唯一维护者"的字段）
最初想在 `state.json` 里记「降级期间通过了多少次 deny」（spec：「降级使用次数和时长本身就是验证指标的一部分」）。
**去掉了**，理由：那个数**只有 phase 的 guard 知道**，而 `state.json` 的写者是 **memory** ⇒
两方都写同一份 JSON 就破了本项目"单写者"纪律，而**字段没有唯一维护者 = 迟早变成一个没人更新的谎**。
⇒ 改记在 **phase 自己的审计链**上（`type:'phase-advance'` 带 `degraded: true`），要计数就从链上数
（与 spec §14 其余指标同一口径：**链是证据，报表是派生**）。
⚠️ 因此 `telemetry-recovered` 记录里的 `pendingReview: N` 的 N 是「降级窗口内**投递成功**的条数」，
**不是**「降级期间通过了多少次 deny」—— 两者不是一回事，别按后者读（§1.11 末尾也写了）。

### 12.5 变异套件改用**沙箱副本**（与既有 6 个变异套件的唯一不同）
既有做法 = 备份真源码 → 就地改 → 跑 → `finally` 还原 → 核 sha。每一步都对，但有一个**不对称的风险**：
进程被强杀（Ctrl-C / OOM / 断电）会**把生产源码留在变异态**，而它唯一的保障是"下次有人来核 sha"。
⇒ `_fde_d1_mut.mjs` 改在 `_mut/d1/` 的副本上注入，真源码**一次都不碰**；
收尾核 7 个文件的 sha256 是用来**证明**这一点（不是补救），且最后 **reseed 一次让沙箱 ≡ 源**
（否则沙箱留在最后一条变异的状态里，将来有人 grep 到它，会以为自己看到的是源码）。

### 12.6 七个"仪器自己会撒谎"的形状（前两个在离线套件，后五个在活验仪器；每一个都当场栽了一次）
1. **裸取下标 ⇒ 崩溃 ⇒ 整份报告消失**。`_fde_d1_test.mjs` 里 `rec[0].pendingReview` 在记录缺席时会**抛**，
   于是变异 M16（D9 不留痕）一开始被判成"崩溃"而**不是**"断言红" —— 崩溃与"没通过"看起来一模一样。
   ⇒ 测试里所有嵌套读取改走 `at(obj, ...path)` 安全读，并**先断言"那条记录存在"**再读它的字段。
2. **锚点缩进是抄来的，不是估的**。变异 M24 的 `from` 我写成 4 空格（真源码是 2 空格）⇒ 锚点 0 次命中，
   变异套件正确判成"无效变异"。**这不是坏消息**：无效变异被单独记一档（不算红也不算绿）恰恰是它该有的行为。
3. 🔴 **`readJson(p)` 读的是文件，我却把「一行文本」当路径传了进去**（`_fde_d1_live.mjs` 第一版）。
   于是每一行都 `ENOENT` ⇒ `chainEvents()` 报「432 行，**坏行 432**」，而 `telemetry-*` 计数是 0。
   **危害方向**：所有"链上有 X"的断言都会红，而它长得**完全像"实现没做到"** ——
   若没跑 `probe` 就直接开 `prep` 验，我会拿着一张全红的报告去改**正确**的实现。
   （同族纪律：期望写错会伪装成实现有缺陷。）⇒ 修法分两步：① 拆成 `parseJsonText(s)` / `readJson(p)` 两个函数；
   ② **加一条仪器自检** `probe-0「链逐行可解析（坏行 0）」` —— 读法一错就当场红，不靠下次小心。
4. ⚠️ **在同一份注释里写行号，会被"写行号"这个动作本身弄失效**（`telemetry-sink.js` 头注）。
   我给注释补行号引用后，同一段又编辑了两次 ⇒ 每编辑一次，后面所有行号偏移一次。
   第一次写 `:298/:227/:216-225`，实测已是 `:301/:230/:219-230`，**三个数全错**。
   ⇒ 口径改成：**指符号名（可 grep）＋ 行号并标明"写入时在 `:N`"**，且**在最后一次编辑之后再统一校准一次**。
   （行号只会相对某一版有效 —— 跨文档引用更要把"哪一份、哪一版"写出来。）
5. 🔴 **按「文件行序」重放哈希链，会在一处**真**错位上报出 3 处**假**断链**（`_fde_d1_live.mjs` 的 `live` 命令第一版）。
   实测 `memory/audit/events.jsonl` 第 224 行的 `seq=223` 排在第 223 行 `seq=224` **之后** ——
   两个写者并发分配到相邻 seq（同一毫秒的 `memory-confirm` 与 `session-event`），落盘次序被 OS 打乱。
   按行序重放报「断链 3、哈希不符 3」；**按 `seq` 升序重放：断链 0、哈希不符 0**，且 seq 无重号无缺号。
   **危害方向与第 3 条相反、但更阴**：它指向的是**正确**的实现，而且只有 3 处红（不是全红），
   看起来像"某几次写入有 bug" —— 很容易被当成真缺陷去查、甚至去改坏一处正确的并发写。
   （同族纪律：**期望写错会伪装成实现有缺陷**。也见 [[audit-window-vs-full-scan]]。）
   ⇒ 修法三条一起：① 重放口径改为**按 `seq` 排序**，并在注释里写明"**不是**按行序"；
   ② 补两条**独立**判据把"排序"这个动作本身兜住 —— `seq` 无重号、无缺号（否则重放会**静默跳过**一条而不报断链）；
   ③ 补一条**负向自证** `live-C7`：内存里篡改一条，重算必须不符（证明 `C2` 不是恒真式）。
   另有一条真性质值得记：**`#restoreFromTail` 取的是"文件最后一行"的 hash**，所以"末行 hash == 链尾 head"
   是重启后能续上链的必要条件 —— 已作为 `live-C5` 单独断言。
   （本链恰好是**错位处不在尾部**，所以没造成后果；若是最大 seq 那一条先落盘后又被后写者覆盖……见 `dsh-audit-chain-fork-trap`。）
6. ⚠️ **"行序 ≠ seq 序"这条事实，第一版诊断脚本自己也差点读错**：`_fde_d1_chain_diag.mjs` 按行序打印
   "坏行的前一行 / 后一行"，于是把 `seq=223` 打印在 `seq=224` 后面，看起来像**两条记录内容都一样、互相矛盾**。
   ⇒ 诊断脚本**也必须锚 `seq`**，不能锚行号；行号只作"这一条在文件里排第几"的参考坐标。
7. 🔴 **措辞写对了、判据写窄了：「只有这一种」被实现成「恰好一条」**（`_fde_d1_live.mjs` 的 `live-A2`）。
   我的注释写的是"**只有配置为「未配端点」才会写它**"，判据却写成
   `tele.map(r => r.type)` **深等于** `['telemetry-disabled']` —— 于是：
   该记录**每 apply 一次就写一条**，用户重启第二次后链上变成 2 条 ⇒ **判据当场假红**。
   ⇒ **危害方向**：这是一个**会随正常使用而变红**的判据 —— 它指控的不是代码，是"你重启了"。
   若不追根因，下一个来跑的人会以为 D1 的"配置判据"坏了。
   **固定动作**：写"只有 X／只有这一种／一定是 X"时，**当场分清判的是「种类」还是「条数」** ——
   判种类用 `[...new Set(...)]` 比对，判条数才用数组全等；并把这句话写进判据名里。
   （**同批还修了一处**：`live-A3` 原本用 `find()` 取**第一条**判断"在链尾窗口内"，
   重启两次后第一条已不在尾部 ⇒ 同样会假红；改成 `reduce` 按 **`seq` 取最新一条**。
   又一次踩到"行序 ≠ seq 序"。）
   ⚠️ 这轮的教训是:**这个形状只能靠"再来一次真实的操作"暴露**，靠重读代码读不出来 ——
   判据文本本身完全合理，是它与"环境会变化"的组合才出问题（同族：[[observable-must-not-self-vary]]）。
