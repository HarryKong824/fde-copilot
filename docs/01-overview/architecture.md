# 技术架构说明 · FDE Copilot

> **本文写给**：需要接手维护、排查故障、或评估这套架构能否复用的工程人员。
>
> **本文的写法**：所有结构、字段、接口均**从源码与磁盘实测得出**，不引用设计文档的设想。凡与 spec 有出入处，明确标注。

---

## 一、整体架构

### 1.1 一句话概括

**这不是一个独立应用，而是挂在宿主平台（DSH）上的四个插件**——它们不拥有自己的进程、不监听端口、不提供服务；它们**寄生在宿主的 AI 助手回合里**，通过宿主的「工具调用 → 守卫判定」链路起效。

### 1.2 架构图

```
┌──────────────────────────────────────────────────────────────────────┐
│  DeepSeek Harness（DSH）宿主进程                                       │
│                                                                       │
│   ┌────────────┐                                                      │
│   │  AI 模型    │ ── 发出工具调用（如 fde_ontology_write）              │
│   └─────┬──────┘                                                      │
│         │                                                             │
│         ▼                                                             │
│   ┌────────────────────────────────────────────┐                     │
│   │ ① tools/pre-execute（waterfall，全部跑完）   │ ← 只记录，不否决     │
│   └────────────────┬───────────────────────────┘                     │
│                    ▼                                                  │
│   ┌────────────────────────────────────────────┐                     │
│   │ ② tools.guard（同步 · 单调 · 只能否决）      │ ← ★ 门禁的真正挂点   │
│   │    返回 string ⇒ 拒绝；返回 undefined ⇒ 放行 │                     │
│   └────────────────┬───────────────────────────┘                     │
│                    ▼                                                  │
│   ┌────────────────────────────────────────────┐                     │
│   │ ③ dispatch → 插件的 execute()               │ ← 真正干活 + 写盘    │
│   └────────────────────────────────────────────┘                     │
│                                                                       │
│   ┌──────────────────┬──────────────────┬──────────────────┐          │
│   │ dsh-fde-          │ dsh-fde-dsl      │ dsh-fde-phase    │          │
│   │ ontology-gate     │ 规则可信度        │ 业务阶段机        │          │
│   │ 谁能在什么条件下改 │ (D1/D3)          │ (D1/D2/D3/D5)    │          │
│   └──────────────────┴──────────────────┴──────────────────┘          │
│   ┌──────────────────────────────────────────────────────┐            │
│   │ dsh-fde-memory（记忆系统：决策/检查单/干系人/沙箱/审计）│            │
│   └──────────────────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────────────────┘
         │                          │                          │
         ▼                          ▼                          ▼
   ┌───────────┐          ┌──────────────┐          ┌──────────────────┐
   │ 受控本体区 │          │ 项目状态与记忆│          │ 审计链（只追加）  │
   │ E:\ontology│          │ <projectRoot>│          │ fde-audit/        │
   │ Root\      │          │ /memory/     │          │  gate.jsonl       │
   │  objects   │          │  state.yaml  │          │  phase.jsonl      │
   │  logic     │          │  decisions/  │          │ fde-state/memory/ │
   │  actions   │          │  checklist/  │          │  audit/events.jsonl│
   │  guards    │          │  .state.lock │          │                  │
   │  compliance│          │              │          │                  │
   └───────────┘          └──────────────┘          └──────────────────┘
```

### 1.3 为什么门禁挂在 `guard` 上（而不是别处）

这是整个架构的**承重墙**，值得单独说明：

| 候选挂点 | 能不能拦住 | 结论 |
|---|---|---|
| 提示词里提醒模型 | ❌ | 模型可以不听 |
| `tools/pre-execute`（waterfall） | ❌ | 返回值被丢弃，只能记录 |
| 插件自己的 `execute()` 里判 | ⚠️ | 能拦，但**每个工具都要重复写**，漏一个就是漏洞 |
| **`tools.guard`** | ✅ | **同步、单调、只能否决**——返回 `string` 即拒绝，之后无人能翻盘 |

`guard` 的三个性质决定了它的用法：
- **同步**：签名无 `Promise`。传 async 函数会被当成「返回了非 undefined」⇒ 拒绝理由变成 `Error: [object Promise]`。
- **单调**：只有 `string | undefined`，**没有 allow 结果**。任何 denier 之后无人能翻盘。
- **层级**：插件自己的 `ctx` ⇒ 全局生效；`agent.ctx` ⇒ 仅该 agent。

> ⚠️ **代价（如实说明）**：`guard` 是同步的，**不能做 IO**。所以「校验结论」不能靠 guard 现算——必须先由工具算出、广播、存进**内存镜像**，guard 只做**同步的哈希重算比对**。这是 §4.4 那套「结论锚定」机制的由来。

---

## 二、插件边界（谁管什么）

| 插件 | 目录 | 注册名 | 管什么 | 工具数 |
|---|---|---|---|---|
| 本体门禁 | `dsh-fde-ontology-gate` | `fde-ontology-gate` ⚠️ | **谁**能在什么条件下改本体 | 5 |
| 受限 DSL | `dsh-fde-dsl` | `dsh-fde-dsl` | 改出来的**规则**能不能信 | 2 |
| 业务阶段机 | `dsh-fde-phase` | `dsh-fde-phase` | 现在在**哪个阶段**、能不能推进 | 6 |
| 记忆系统 | `dsh-fde-memory` | `dsh-fde-memory` | 决策/检查单/干系人/沙箱/审计 | 7 |

> ⚠️ **已知不一致**：`dsh-fde-ontology-gate` 的包名带 `dsh-` 前缀，但**注册名没有**（`fde-ontology-gate`）。排查问题时按**注册名**查。

**边界原则**：一个插件**不直接读写**另一个插件的状态文件。跨插件通信只走**事件**（§5.2）。

---

## 三、技术栈选型

### 3.1 关于「前后端」——本项目没有前后端

| 常规项 | 本项目情况 |
|---|---|
| 前端框架 | ❌ **不存在**。没有 Web UI、没有页面、没有客户端资源 |
| 后端服务 | ❌ **不存在**。没有 HTTP 服务、不监听端口、不处理请求 |
| 交互界面 | DSH 宿主自带的 AI 对话界面（本项目**不开发**界面） |
| 用户如何操作 | 用自然语言让 AI 助手调用工具，**或**由 AI 自动触发 |

> **为什么没有**：这套东西的定位是**护栏**，不是应用。护栏应该长在被保护的动作旁边（宿主进程内），而不是另一个进程里——否则又要多一套鉴权、多一个故障点、多一次网络往返，而且**拦不住**（模型可以直接调宿主的原生工具）。

### 3.2 选型表

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | **Node.js**（ESM） | 与宿主同构，插件跑在宿主进程内，零跨进程开销 |
| 语言 | **纯 JavaScript**（无 TS 编译步骤） | PoC 期减少构建链；类型用 JSDoc 表达 |
| 模块系统 | ESM（`type: "module"`） | 与宿主 SDK 一致 |
| 配置校验 | `@deepseek-ai/schemastery`（peer） | 宿主生态内标准，**仅供配置面板提示**；真权威永远是 `lib/config.js` |
| YAML 解析 | **自研** `yamlsubset.js` | 见 §7.1 |
| 状态存储 | YAML 文件 + 原子 rename | 见 §4.1 |
| 审计存储 | JSONL（每行一条 JSON） | 只需追加，不需要查询 |
| 哈希 | Node 内置 `node:crypto`（SHA-256） | 无第三方依赖 |

---

## 四、数据持久化设计

> **本节等价于常规项目的「数据库表结构说明」**——本项目没有数据库，用**文件**持久化。理由与代价见 §7.2。

### 4.1 业务状态：`<projectRoot>/memory/state.yaml`

```yaml
schema_version: 1            # 数据格式版本（链式迁移用）
current_phase: "10"          # 当前业务阶段（15 个 Phase 之一）
phase_status: in_progress    # in_progress | done
ontology_version: 1          # 本体版本号
revision: 60                 # 每次成功写入 +1（乐观并发控制）
updated_at: "2026-09-28T12:38:19.569Z"
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema_version` | number | 数据格式版本。**迁移失败 ⇒ 整个记忆系统降只读**（写入拒绝、读取照常） |
| `current_phase` | string | 阶段 id，取值 `0.1`–`0.4`、`1`–`11` |
| `phase_status` | string | `in_progress` / `done` |
| `revision` | number | **乐观并发**用：调用方持有旧 revision 时写入会被拒 |
| `updated_at` | string | ISO 8601 |

**写盘流程**（`lib/state.js`）：
```
acquireLock（原子排他创建 .state.lock，含 PID 存活检测）
  → 写 state.yaml.tmp
  → rename() 覆盖（同卷 rename 是原子的）
  → releaseLock（放在 finally，异常路径也解锁）
```

### 4.2 受控本体区：`E:\ontologyRoot\`（5 个文件）

#### ① `objects.yaml` —— 对象与属性

```yaml
objects:
  - name: treatment
    attributes:
      - name: dose_mg
        type: number
        step: 1          # 数值：派生边界候选值用
        min: 0
        max: 200
        maturity: verified   # verified | draft | locked
      - name: site
        type: string
        enum: ["face", "body", "neck", "hands"]   # 字符串：派生成员/非成员候选值
        maturity: verified
      - name: note
        type: string
        # 故意不写 maturity ⇒ 默认 draft（fail-closed）
```

| 字段 | 作用 |
|---|---|
| `type` | `number` / `string` / `boolean` |
| `step` / `min` / `max` | **不是装饰**——直接决定 D3 派生出多少条边界反例 |
| `enum` | 决定字符串属性的成员与非成员候选值 |
| `maturity` | **决定 `deny` 规则能不能引用它**。缺省即 `draft`，被 `deny` 规则引用时 D3 判失败（`DraftReference`） |

#### ② `logic.yaml` —— 规则表

```yaml
rules:
  - id: R001
    effect: deny            # deny | warn | allow
    reason: 剂量超过单次上限   # 必填
    condition: {">": [{"var": "treatment.dose_mg"}, 100]}
```

| 字段 | 说明 |
|---|---|
| `effect` | `deny` / `warn` / `allow` |
| `condition` | **受限 DSL 表达式**，必须写成**行内合法 JSON** |
| 多叶子条件 | 会额外跑**候选值笛卡尔积**，否则「一次只动一个叶子」凑不出触发输入 ⇒ 假失败 `RuleNeverFires` |

**DSL 运算符白名单**：`== != > >= < <= and or ! in var`

#### ③ `actions.yaml` —— 动作清单

```yaml
actions:
  - id: suggest_treatment_plan
    writes: true                       # 是否写操作（决定 D1 的严格程度）
    guardrails:
      - ref: guard.dose_upper_bound    # 必须解析到 guards.yaml 里的 ref
        effect: deny
```

#### ④ `guards.yaml` —— 护栏注册表

```yaml
guards:
  - ref: guard.dose_upper_bound
    description: 单次剂量不得超过 100mg
    impl: {'>': [{'var': 'treatment.dose_mg'}, 100]}   # 可编译的 DSL 表达式
    tests:
      - {id: g1-trigger, input: {'treatment.dose_mg': 150}, expect: true}
      - {id: g1-pass,    input: {'treatment.dose_mg': 50},  expect: false}
```

> ⚠️ **PoC 降级**：spec 要求 `impl` 解析到**已注册的可执行函数**；本项目是 **DSL 表达式**。理由：动态 `import()` 任意路径等于开出**代码执行面**。**这条降级不得被说成「已按 spec 实现」。**

> ⚠️ **解析器约束**：本项目自研的 `yamlsubset` 对行内集合**直接调 `JSON.parse`** ⇒ `{}` / `[]` 内部**必须写合法 JSON（双引号）**，单引号会解析失败。

#### ⑤ `compliance.yaml` —— 合规记录

```yaml
schema_version: 1
output_boundary:      { statement: ... }         # 输出边界声明
review_chain:         { reviewer, reviewed_at, conclusion, original_snapshot_ref }
data_policy:          { masking_rule, authorization_basis, retention_period, minimal_scope }
change_assessment:    { classified, level, assessed_at }
```

> **写入纪律**：`data_policy` 由工具**原子写入**（tmp + rename），且**只覆盖 `data_policy` 这一个键**，不碰其余键。

### 4.3 记忆区：`<projectRoot>/memory/`

| 路径 | 内容 |
|---|---|
| `decisions/*.yaml` | 决策记录（含 `source` 防污染字段、置信度推导结果） |
| `checklist/` | 检查单 |
| `stakeholders/` | 干系人 |
| `notes/` | 笔记（带溯源过期） |
| `ontology/` | 记忆侧的本体快照 |
| `.state.lock` | 单写者锁（`{pid, at}`） |
| `audit/events.jsonl` | 审计链（见 §4.4） |

### 4.4 审计链（三份，**记录 schema 各不相同**）

> ⚠️ **这是排查故障时最容易踩的坑**：三份链的「类型字段」**不统一**。

| 链 | 路径 | 规模（实测） | 类型字段 |
|---|---|---|---|
| **gate 链** | `fde-audit/gate.jsonl` | 25 条 | `type`（部分记录）／ `tool` + `decision`（守卫记录）／ `event`（链轮转） |
| **phase 链** | `fde-audit/phase.jsonl` | 119 条 | `type`（部分记录）／ `tool` + `decision`（守卫记录） |
| **memory 链** | `fde-state/memory/audit/events.jsonl` | 486 条 | **`kind`**（+ `eventType`、`sessionSeq`、`data`） |

**实测出现过的记录类型**：

| 链 | 类型分布（全量统计） |
|---|---|
| phase | `restrict`×82 · `phase-advance`×16 · 守卫记录×6 · `check-result`×4 · `phase-advance-d5pre-ask`×4 · `check-skipped`×3 · `phase-advance-d4-ask`×2 · `rollback-denied`×1 · `change-close-denied`×1 |
| gate | 守卫记录×19 · `mode-switch-unattested`×6 |
| memory | 会话事件×481（`kind`+`eventType`） · `memory-confirm`×2 · `telemetry-disabled`×2 · `source-polluted`×1 |

**链式哈希公式**：

```js
linkHash(prevHash, record) = sha256(prevHash + '\n' + JSON.stringify(record))
// 落盘为 JSON.stringify({ ...record, prevHash, hash })
```

> ⚠️ **重算时必须用 rest 解构**：`const { prevHash, hash, ...record } = row`
> 它保留 `record` 其余键的**原顺序**，而 `JSON.stringify(record)` 依赖键顺序。手工拼装字段会得到不同的哈希。

**🔴 重放必须按 `seq` 排序，不能按文件行序**：

同一毫秒的两个并发写者（如 `memory-confirm` 与 `session-event`）会分到**相邻 `seq`**，而落盘次序可能被 OS 打乱。实测出现过**第 224 行 `seq=223` 排在第 223 行 `seq=224` 之后**。

- 按**文件行序**重放 ⇒ 报 **3 处假断链**
- 按 **`seq` 升序**重放 ⇒ **断链 0、哈希不符 0**

> ⚠️ 排序带来新的失效面：按 `seq` 重放必须**同时**断言 `seq` **无重号、无缺号**，否则重放会静默跳过一条而不报断链。

**链轮转**：gate 链支持轮转，轮转时写一条 `event: "chain-rotated"` 记录，含 `archivedTo` / `archivedSha256` / `archivedLines` / `archivedBytes` / `seams`（分段缝）。归档文件形如 `gate.jsonl.2026-09-26T10-18-10-793Z`，配套 `.manifest.md`。

---

## 五、核心接口设计

### 5.1 工具接口（19 个）

所有工具遵守**同一套约定**：

| 约定 | 内容 |
|---|---|
| 参数声明 | 宿主自有 DSL：`{ field: { type, required: true, description, enum? } }`，`required` 写在**属性内部**且只能是字面量 `true` |
| 输出声明 | 每个 `type:'object'` 节点**必须显式写 `additionalProperties`**（`true`/`false`），否则构造时抛 `JsonSchemaError` |
| 可用 schema 关键字 | 白名单：`type / oneOf / properties / required / additionalProperties / items / enum / const` + 注解 `description / title / default / examples`。**没有** `pattern` / `minimum` / `format` |
| 拒绝方式 | **一律 `throw new HarnessError(message, code)`**。**不要**返回 `{error}` 对象——那会被当成成功值去校验 schema |
| 返回值 | `execute(args, exec)` 必须返回 `Promise`，且返回值必须符合 `output.schema`，否则运行时抛 `ToolOutputError` |

**工具清单**：

| 插件 | 工具名 | 类型 |
|---|---|---|
| gate | `fde_ontology_write` | 写 |
| gate | `fde_ontology_read` | 读 |
| gate | `fde_metrics` | 读 |
| gate | `fde_shadow_status` | 读 |
| gate | `fde_shadow_switch` | 写（模式切换） |
| dsl | `fde-run-validation` | 读（跑 D3） |
| dsl | `fde-run-guardrails-check` | 读（跑 D1） |
| phase | `fde_phase_advance` | 写（推阶段） |
| phase | `fde-run-audit-check` | 读（跑 D2） |
| phase | `fde-run-compliance-check` | 读（跑 D5） |
| phase | `fde_rollback` | 写（回滚） |
| phase | `fde_change_close` | 写（变更闭环） |
| phase | `fde-break-glass` | 写（逃生门） |
| memory | `fde_memory_context` | 读 |
| memory | `fde_memory_write_decision` | 写 |
| memory | `fde_memory_review` | 读 |
| memory | `fde_memory_confirm` | 写 |
| memory | `fde_experiment_write` | 写 |
| memory | `fde_experiment_read` | 读 |
| memory | `fde_experiment_list` | 读 |

> ⚠️ **保留工具名**：`RESERVED_TOOL_NAMES = ['run_code']`——这个名单里的名字**不许**被 `restrict` 点名（点名会抛错）。

### 5.2 跨插件事件契约

插件之间**不直接互调**，只通过宿主的 `ctx.emit` / `ctx.on` 通信。

**事件名**：`fde/check-result`

```js
{
  check:  'D1' | 'D2' | 'D3' | 'D4' | 'D5',
  passed: boolean,
  anchor: { file: string, sha256: string },   // ★ 内容锚定
  detail: string,
  at:     string                               // ISO 8601
}
```

**流向**：`dsh-fde-dsl` 算出结论 → `emit` → `dsh-fde-phase` 收下 → 写自己的审计链 + 更新**内存镜像**

> ⚠️ **广播方必须 `try/catch` 包住 `emit`**：宿主的 `emit` 监听器同步抛错会**直接冒泡给调用方**，异步 reject 会变成 unhandled rejection。**广播失败不能让校验本身失败**。
>
> ⚠️ **命名禁忌**：不要用 `internal/` 前缀——那会绕过所有基于 `internal/dispatch` 的 invariant 检查。
>
> ⚠️ `ctx.on` 返回 `() => boolean`（**不是** `() => void`），注销器形态与 `ctx.effect` 不同。

### 5.3 结论锚定机制（本架构最巧妙的一处）

**问题**：`guard` 是同步的、不能做 IO；而「校验结论」必须**绑定到被校验文件的内容**，否则会出现「文件改了、旧结论还能用」的漏洞。

**解法**（三步闭环）：

```
① dsl 只算不存：跑 D1/D3 → 算出 anchor = {file, sha256(文件内容)}
                → ctx.emit('fde/check-result', {check, passed, anchor, ...})
                → dsl 不写任何状态文件、不持审计链

② phase 负责记：ctx.on('fde/check-result') → 写进 phase 自己的哈希链审计
                → 更新内存镜像

③ phase 负责判：guard 只读内存镜像，并【同步】重算当前文件的 sha256
                → 与镜像里的 anchor 比对
                → 不一致 或 镜像为空 ⇒ deny（fail-closed）
```

**重启后**：phase 在 `apply()` 期用**同步 fs 读**审计文件尾部重建镜像 ⇒ 重启不丢结论；但**改了被校验的文件，结论必然失效**——这正是要的性质。

**为什么 guard 里敢做同步 IO**：只读一个 <1KB 的 YAML 算哈希。这是「结论绑定当前内容」的唯一可行办法，代价明确、可接受。

---

## 六、部署架构

### 6.1 部署形态（当前：单机、同进程）

```
E:\DSH-desktop\DeepSeek Harness\
├── data\
│   ├── node_modules\@deepseek-ai\        ← 真 SDK（宿主提供）
│   └── dsh-home\                          ← DSH_HOME
│       ├── settings.yaml                   ← 全局设置
│       ├── profiles\web\
│       │   ├── cordis.patch.yml           ← ★ 插件配置（权威）
│       │   └── node_modules\              ← ★ 插件部署位置
│       │       ├── dsh-fde-dsl\
│       │       ├── dsh-fde-memory\
│       │       ├── dsh-fde-ontology-gate\
│       │       └── dsh-fde-phase\
│       ├── fde-audit\                     ← 审计链（gate / phase）
│       ├── fde-state\                     ← 项目状态与记忆
│       └── sessions\                      ← 会话持久化（宿主拥有）
└── ...

E:\ontologyRoot\                           ← ★ 受控本体区（客户资产）
```

### 6.2 部署要点

| 要点 | 说明 |
|---|---|
| 插件位置 | `profiles/web/node_modules/<包名>/` |
| 配置权威 | `profiles/web/cordis.patch.yml`——**不是**插件内的 `config.js`（它只是兜底与校验） |
| 生效方式 | **改 `lib/*.js` 必须重启 DSH 进程**；切换 `mode`（shadow/enforce）**不需要**重启 |
| 路径不猜测 | 所有路径由**配置显式给出**（`projectRoot` / `ontologyRoot` / `auditPath`）——插件**不做任何路径猜测** |
| 配置无环境变量回退 | `normalizeConfig(raw = {})` **没有** `process.env` 分支 ⇒ 配置的唯一来源是 DSH 配置文件 |

### 6.3 配置项（phase 插件示例）

```yaml
projectRoot: ...        # 必填。项目状态与记忆的根
ontologyRoot: ...       # 必填。受控本体区
auditPath: ...          # 审计链路径（默认 ''）
mode: shadow            # shadow | enforce
lockTtlMs: 30000        # 锁超时（毫秒）
```

**fail-closed 校验**：`projectRoot` 缺失即抛错，**不给默认值**。

---

## 七、第三方依赖服务清单

### 7.1 运行时第三方依赖：**零个**

| 依赖 | 类型 | 版本 | 用途 |
|---|---|---|---|
| `@deepseek-ai/dsh-tools` | **peer** | `0.1.2-rc.1` | 工具注册（`defineTool`）与守卫（`ctx.tools.guard` / `restrict`） |
| `@deepseek-ai/schemastery` | **peer** | `3.18.2` | 配置项 schema（**仅供配置面板提示**，真权威是 `lib/config.js`） |
| Node.js 内置模块 | — | — | `node:crypto`（SHA-256）、`node:fs`、`node:path` 等 |

**为什么刻意零运行时依赖**：

插件跑在**客户现场**的宿主进程里。每多一个第三方包就多一份供应链风险、多一次版本冲突的可能、多一个「上游改了行为」的隐形变更点。代价是功能受限——比如自研的 `yamlsubset.js` **只支持用到的 YAML 子集**（行内集合要求合法 JSON、不支持锚点等高级特性）；收益是**行为完全可预测**。

### 7.2 外部服务：**零个**

| 常规项 | 本项目 |
|---|---|
| 数据库 | ❌ 无（用文件，见 §4） |
| 缓存 / 消息队列 | ❌ 无 |
| 对象存储 | ❌ 无 |
| 域名 / 证书 | ❌ 无 |
| 远端审计端点 | ⚠️ **可选**。L3 TelemetryBackend 支持外置，当前部署**未配置端点**（实测链上只有 `telemetry-disabled` 记录）——这是**配置选择，不是故障** |

> **成本含义**：本项目**没有服务器、没有域名、没有云服务账单**。唯一的硬性成本是开发期的 AI 工具使用费，见 `docs/04-retrospective/cost-resources.md`。

---

## 八、安全设计（本架构的核心资产）

| 机制 | 实现 | 防住什么 |
|---|---|---|
| **fail-closed** | 判定不了「安全」时一律判「不放行」 | 故障时不会静默放行 |
| **守卫单调否决** | `guard` 只有 `string \| undefined`，无 allow | 任何插件都无法「翻盘」别人的拒绝 |
| **哈希链审计** | `sha256(prevHash + record)` | 事后篡改会被发现 |
| **内容锚定** | 结论绑定被校验文件的 sha256 | 「文件改了但用旧结论」的漏洞 |
| **单写者锁** | 原子排他创建 + PID 存活检测 + 超时强夺 | 并发写坏状态文件 |
| **原子写** | tmp + `rename()` | 写一半崩溃留下半个文件 |
| **乐观并发** | `revision` 校验 | 基于过期快照的覆盖写 |
| **保留工具名** | `RESERVED_TOOL_NAMES = ['run_code']` | 关键工具被 `restrict` 隐藏 |
| **broadcast 隔离** | `emit` 用 `try/catch` 包住 | 广播失败拖垮校验本身 |
| **审计写失败不改结论** | 审计 `catch(() => {})` | 把 fail-closed 变成 fail-open |

---

## 九、已知技术债与注意事项

| # | 项 | 影响 | 建议 |
|---|---|---|---|
| 1 | 三份审计链的**类型字段不统一**（`type` / `tool`+`decision` / `kind`+`eventType`） | 排查时要记得查多个字段名，容易漏 | 后续可加一层归一化读取器 |
| 2 | gate 插件的**包名与注册名不一致**（`dsh-fde-ontology-gate` vs `fde-ontology-gate`） | 按包名查插件会查不到 | 后续统一 |
| 3 | `guard` 内做同步文件 IO | 每次推阶段读一次 <1KB YAML | 已评估可接受；若本体文件变大需重新评估 |
| 4 | 配置**无环境变量回退** | 端到端验证必须改配置文件并重启 | 见《功能清单对照表》§4.4 |
| 5 | 自研 `yamlsubset` 只支持子集 | 行内集合必须写合法 JSON（双引号） | 写本体文件的硬约束，已文档化 |
