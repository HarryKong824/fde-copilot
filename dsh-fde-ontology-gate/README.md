# dsh-fde-ontology-gate

FDE Copilot ontology 门禁插件 —— **PoC 骨架**。

平台：DeepSeek Harness（DSH），SDK 版本钉 `0.1.2-rc.1`（已是 CVE-2026-82533 修复版）。
底层：Cordis 插件框架。

---

## 0. ⚠️ 使用前提：新建会话第一步切 `standard` preset

DSH 默认 preset 是 `ptc`，且本插件的 `denyRunCode: true` —— 该组合下**模型一个工具都调不到**（不是只调不到本插件的工具）。
所以建会话后第一件事：把 preset 切到 **`standard`**（UI 选下拉；脚本 / 服务端传 `agentPreset: 'standard'`）。
判据：让模型**自报工具清单**，须含 `fde_phase_advance`、`fde-run-guardrails-check`（gate 侧还应看到 `fde_ontology_read` / `fde_ontology_write`）。
**报不出来 = preset 没切对**，先解决这个再谈门禁 —— 否则很容易误判成"gate 没挂上"。

> 权威全文见 [操作卡 C-0](../DSH插件-enforce操作卡.md)；另一份等价说明见 [dsh-fde-phase/README §0](../dsh-fde-phase/README.md)。

---

## 架构

按《FDE-Copilot-可行性分析》6.7 的收口决议：

| 层 | 机制 | 文件 | 职责 |
|---|---|---|---|
| 主防线 | `ctx.tools.guard()` | `lib/guard.js` | 钉在专用工具入口，同步、语义级 + source 溯源 + 置信度；单调否决、不可翻盘 |
| 兜底 | 同一个 guard 的路径匹配 | `lib/guard.js` | 拦"绕过专用工具直奔受保护区域"的通用 fs / shell 调用 —— **读与写都拦**（不按动作分叉，见下） |
| 留痕 | `tools/pre-execute`（async） | `lib/pre-execute.js` | 哈希链审计；shadow 模式把 would-deny 记成 `shadow-deny` 后放行 |
| 通道 | 原生 `node:fs` 直写 | `lib/tools.js` | 专用工具是唯一被授权绕过原生 fs 围栏的合法通道 |
| 准入 | 影子统计 + `enforce` 门 | `lib/shadow-stats.js`、`lib/shadow-tools.js` | spec §12/§14：谁、在什么条件下可以把门禁从 observe 拧到 enforce（见「影子模式与 enforce 准入」节） |

**为什么判定和留痕分成两个模块**：`ctx.tools.guard()` 的签名是
`(exec) => string | undefined`，**同步**返回，写不了文件。审计（哈希链、outbox、
HTTP 只写端点）天然异步，所以只能挂 `tools/pre-execute`。这条约束决定了模块划分，
不要试图把两者合并。

`evaluate()`（`lib/guard.js`）是两者共用的**纯同步**规则函数 —— guard 用它真拦，
pre-execute 用它记录。共用同一份规则，避免 shadow 说会拦、enforce 却不拦的规则漂移。

---

## 安装

### 1. 装进 profile

profile 目录是**桌面版**那个（不是 CLI 的 `~/.dsh`）：

```
E:\DSH-desktop\DeepSeek Harness\data\dsh-home\profiles\web
```

pnpm 不在 PATH 上（`dsh plugin` 会报 `'pnpm' 不是内部或外部命令`）。
内置 pnpm 在 `resources\pnpm\bin\pnpm.cjs`，需要手动指：

```bash
node "E:/DSH-desktop/DeepSeek Harness/resources/pnpm/bin/pnpm.cjs" \
  add "file:C:/Users/DELL/WorkBuddy/2026-09-22-18-30-18/dsh-fde-ontology-gate"
```

工作目录须为上面那个 profile 目录。

### 2. 挂进 `cordis.patch.yml`

文件：`E:\DSH-desktop\DeepSeek Harness\data\dsh-home\profiles\web\cordis.patch.yml`

⚠️ 是 **`cordis.patch.yml`**，不是根 `cordis.yml`（后者是空数组，改了不生效）。

patch 是顶层 YAML 数组；`- insert:` 加新行，`- id: <row>` 覆盖已有行。
**patch 会替换目标行的整个 `config`，不是合并**。

```yaml
- id: tools
  config:
    # 钉死 native：覆盖 web profile 那行 `mode: !!js process.env.DSH_TOOLS_MODE`
    # 的环境变量 seam（该行注释自称 TEMPORARY）。见下方「禁 PTC」。
    mode: native

- insert:
    - id: fde-ontology-gate
      name: 'dsh-fde-ontology-gate'
      config:
        # 插件会在首次 fde_ontology_write 时 mkdir -p 自动创建该目录，无需手动建。
        # 必须位于 DSH 会话工作区（实测 E:\DSH-workspace）之外（区外）；E:\ontologyRoot 在 E: 盘根，
        # 与 DSH 工作区互不包含，故在区外。换位置只改这一行。
        ontologyRoot: 'E:\ontologyRoot'
        # shadow = 只审计不拦（首跑校准用）；enforce = 真拦。
        # ⚠️ 改这一行只会热重载【配置】（apply() 重跑），**不会重新导入模块代码**——
        #    改 lib/*.js 后必须【重启 DSH 进程】，翻 mode 不够（见 HANDOFF §2）。
        # 2026-09-23 用户拍板后已正式切入 enforce（切换/回滚均只需改这一行、免重启，
        # 完整清单见《开发手册》§4.5；回滚 = 改回 shadow）。切换前备份 cordis.patch.yml.bak-pre-enforce。
        mode: enforce
        denyRunCode: true
        # 审计落盘路径——⚠️ 必须在会话工作区之外（HANDOFF §7.3）：放工作区内 agent 有 write 权限能改能删。
        auditPath: 'E:\DSH-desktop\DeepSeek Harness\data\dsh-home\fde-audit\gate.jsonl'
        allowedWriteSources: ['user', 'model']
        minConfidence: 70
        # workspaceRoot 不填则默认 process.cwd()，路径兜底按它解析相对路径（fail-closed）。
```

### 3. 重启桌面版

`patchReload: live` 会热加载 patch，但改了 `insert` 新包通常仍需重启进程。

---

## 禁 PTC（`run_code`）

`run_code` 是保留名：**`ctx.tools.restrict` 点名它会直接报错**，无法用 restrict 裁掉。
所以要分层处理，单靠任何一层都不够。

**现状核查（2026-09-23）**：`DSH_TOOLS_MODE` 在进程环境、用户级、系统级环境变量，
以及桌面版 `app.asar` 中**均未出现** → 当前进程级 PTC 是关闭的。

| 层 | 做法 | 强度 | 状态 |
|---|---|---|---|
| 1 | profile patch 把 `- id: tools` 钉成 `mode: native` | 挡进程级 env seam，**挡不住 preset 覆盖** | 见上方配置 |
| 2 | 插件 `denyRunCode: true`，guard 按 `RUN_CODE_NAME` 拒 | 挡 per-scope 的 `ptc` preset | ✅ **已活验（2026-09-23）** |
| 3 | 自有 preset roots（`includeShippedRoot: false`）或删 preset 目录 | 挡 UI 里的 preset 选择 | **已不需要**（第 2 层成立） |

**第 1 层实测拦不住 preset（2026-09-23）**：`ptc` agent preset 通过
`dsh-agent-presets/presets/ptc/agent.cordis.yml` 的 `id: tool-presentation`（`mode: ptc`）
做 **per-scope 覆盖**，优先于进程级 `mode`。用 `pluginInventory/list` 实测确认：
`@deepseek-ai/dsh-agent-tool-presentation` **只出现在 `ptc` 这一个 preset 中**，
且 4 个 preset 全是 `trust: system`、UI 里可选 —— **第 1 层只挡 env seam，挡不住 UI 切 preset**。

⚠️ **而且 `ptc` 实测是 `isDefault: true`（`agentPresets/list`）—— 新会话默认就走 PTC。**
这把第 2 层从"兜底"抬成了**唯一防线**。

**第 2 层：代码级确认 + 活验实测**（`@deepseek-ai/dsh-tools@0.1.2-rc.1` 源码）：

- `ToolRuntime.execute(exec)` → `prepareExecution` → waterfall `tools/pre-execute`
  → `guardReason(exec)` —— 这是**唯一**入口，无绕过分支（`lib/index.js:3016`）。
- `run_code` 是注册工具（`:1087` `name: RUN_CODE_NAME`），走同一调度器。
- run_code 程序**内部**发起的工具调用同样过闸：`:1272` `await scheduler.prepare(input)`。
- guard 只在 pre-execute 决策为 `allow` 时才被咨询（`:3128`），语义为单调否决。

✅ **已活验（2026-09-23）**：ptc preset 下模型调 `run_code` 跑 `console.log(1+1)`
（**纯计算、不碰文件系统**），`tool/result` 为 `isError: true`，回门禁原文
「PTC 通道（run_code）已按门禁策略禁用：它不受 restrict 约束，且其内部代码无法被路径守卫审计」。
**第 2 层成立，无需退第 3 层。**

⚠️ **判据说明**：早先版本以"文件未创建"为证据，**那条无效** —— 当时目标是 `E:\ontology\test.txt`，
而 `E:\ontology` 这个目录**根本不存在**，ENOENT 同样能解释。**只有不碰文件系统的调用才是干净判据。**

> ✅ **随之暴露的缺陷 ① 已修（见下「诚实清单」#7）**：这次拦截**确实发生了**，但审计链里记的是
> `decision: "shadow-deny"` —— 该标签的语义是「记下后**放行**」。**日志与实际相反。**
> 根因：`denyRunCode` 的判定在 `evaluate()` 中位于 `applySemanticRules` 提前返回**之前**（与 mode 无关），
> 而 `pre-execute.js` 只按 `cfg.mode` 打标签。
> **修法**：`evaluate()` 对 mode 无关规则返回 `modeIndependent: true`，
> 标签与决策分支统一为 `enforcing || modeIndependent ? 'deny' : 'shadow-deny'`。
> ✅ 修复**已同步到 DSH 安装副本**（文件级 SHA-256 逐项 MATCH）。
> ✅ **已活验通过**（2026-09-23，重启 DSH 进程后）：同一发纯计算 `run_code`，审计行 `decision` 已是
> **`deny`**（修复前 `shadow-deny`），且 `tool/result` 回执里的编号变成「审计 **#2**」——
> `seq` 不再复用、定位唯一。详见 HANDOFF §4.3「复验结果」。
>
> 📌 **由此确立的硬约束**：**改 `lib/*.js` 必须重启 DSH 进程** —— **翻 `mode` 无效**：
> 它只重跑 `apply()` 带新配置，不重新导入模块（ESM 按 URL 缓存），
> 会得到"配置新、代码旧"的半吊子状态，2026-09-23 实测如此。

**第 3 层的代价**（不推荐直接上）：
- `includeShippedRoot: false` 会连 `standard` / `minimal` / `cordis` 一起丢掉 —— 包括
  `cordis` preset（preset 自助编写依赖它）。得自己复制这三个，且升级后不会跟着更新。
- 直接删 `presets/ptc/` 目录有效，但它在 `data/node_modules/` 下，**升级会还原**；
  且 DSH 自带的 `editing-cordis-compositions` skill 明确写着
  "Never edit, delete, or overwrite a preset that ships with the deployment"。

---

## PoC 验证清单

按优先级。第 1 条是地基，不过就别往下走。

> **2026-09-23：清单 #1–#6 已全部活验跑完**（用 Typert HTTP RPC 从外部驱动会话，
> 有 `tool/result` 的 `isError` + 审计链双证据）。#1–#5 完整矩阵见 HANDOFF.md §5.5，
> #6（符号链接/junction 回归）见 §5.6。

1. ✅ **`denyRunCode` 拦得住 `run_code`**：ptc preset 下跑**纯计算** `console.log(1+1)`
   （不碰文件系统），`tool/result` 为 `isError: true`，回门禁原文。
   ⚠️ **判据必须是"不碰文件系统"的调用** —— 用"文件未创建"判定无效（目录不存在时 ENOENT 同样成立）。
2. ✅ **guard 能拒 `fde_ontology_write` 的非合规 payload**（5 个子用例全过）：

   | 子用例 | 结果 |
   |---|---|
   | `source: 'import'` | 拒（来源不在白名单） |
   | `source: 'tool'`（**表内但非白名单**） | 拒（审计 #9） |
   | `source: ''`（空值） | 拒「缺少 source，无法做来源溯源」（审计 #7） |
   | **完全省略 `source`** | 拒「缺少 source，无法做来源溯源」（审计 #10） |
   | `source:'model'` + `confidence: 10` | 拒「置信度 10 低于门槛 70」 |
   | `source:'model'` + `confidence: 70`（边界） | ✅ 放行 —— 边界**闭**（判据是 `< minConfidence`） |
   | `source:'model'` + `confidence: 69` | 拒（审计 #13） |

   🔴 **原"缺 `source` 不可达"的结论已被实测推翻（2026-09-23 复测）**：原判据说 `source` 是
   `required: true`、框架会在 guard 之前拒。**实测框架并没拦** —— 省略 `source`、空值 `""`、
   表外值 `"web"` 三种调用**全部到达 guard** 并被其专设分支拒绝（审计 #7/#8/#10）。
   ⚠️ **`parameters` 里的 `required` / `enum` 是给模型看的类型提示，不是 guard 之前的强制闸**；
   判"用例可不可达"**必须实测**。
3. ✅ **路径兜底拦得住区外直写**：enforce 下 `write` / `pwsh` 写 `E:\ontologyRoot` 内文件均被拒。
   实测还发现 **`read` 读 ontology 内文件同样被拒** —— 比原设计的"只管直写"更严，
   合法读入口只有 `fde_ontology_read`。**交付说明里要写清这条。**
4. ✅ **专用工具的合法写能成功**：合规 payload 写入成功。**对照很有说服力**：
   同一个 `E:\ontologyRoot`（会话工作区之外），通用 `write` 被原生沙箱拒
   （`[sandbox: file access denied under workspace-write mode]`），而 `fde_ontology_write` 写进去了
   —— 这才实证了"专用工具走原生 `node:fs` 直写、确实绕过 `FS_SANDBOX_DENIED`"。
5. ✅ **shadow 模式只记不拦**：shadow 下重放 2、3，调用放行、审计里出现 `shadow-deny`。

6. ✅ **符号链接/junction 回归——已跑（2026-09-23，非漏洞、常规项）**：
   先离线 5/5、再在活 DSH 上双用例实测（`mode: enforce`）：

   | 用例 | 调用 | 结果 |
   |---|---|---|
   | 区外 junction → ontology | `write` → `E:\DSH-workspace\poc6-in\poc6-a.md`（`poc6-in` 是 junction 指向 `E:\ontologyRoot`） | ✅ **拒**：「命中受保护的 ontology 目录」（审计 #6），文件确未创建 |
   | ontology junction → 区外 | `write` → `E:\ontologyRoot\poc6-out\poc6-b.md`（`poc6-out` 指向 `E:\DSH-workspace`） | ✅ **放行**：`isError=False`，文件实际落在 `E:\DSH-workspace\poc6-b.md` —— **未误拒** |

   两条硬结论：① `E:\DSH-workspace\poc6-in\x` 被归一为 `E:\ontologyRoot\x` 并判 DENY ——
   **"在工作区造 junction 指向 ontology 再直写"这条逃逸被堵死**；
   ② `isInside` 是 **canonicalize-then-contain 双侧归一**，`ontology\poc6-out\x` 归一成区外后
   **不误拒**。**原报的"符号链接逃逸漏洞"不存在**（见 HANDOFF.md §4.1、§5.6）。

   > ⚠️ **分支归因更正（2026-09-23 实测，Node v24.15.0 / `mklink /J`）**：初稿曾写
   > "junction 的 `isSymbolicLink()` 返回 `false`、解析全靠 `realpathSync.native`"——**那是臆断**。
   > 实测 `lstatSync().isSymbolicLink()` = **`true`**、`readlinkSync()` = 目标路径，
   > 即 junction **走的是 `paths.js` 里的 `isSymlink` + `readlinkSync` 分支**（不是 `realpath` 分支）。
   > 两条分支殊途同归（所以离线用例照样全过、**结论不受影响**），但**原先给的理由是错的**，已更正。

---

## 变更分级（L0/L1/L2，spec v3 §4）

`fde_ontology_write` 写入时按**语义载荷**自动判定级别（v3 口径：看碰没碰到临床/合规红线，
**不是** v2 的"只看新增还是修改"）。判定是纯函数 `lib/classify.js` 的 `classifyChange`，
级别写进审计 `allow` 记录的 `level` 字段。

| 级别 | 判定规则（满足任一即命中，取最高档） |
|---|---|
| **L0 补充** | 仅新增对象/属性/规则，新增规则的 `effect` 非 `deny`，且不涉及受监管字段 |
| **L1 修正** | 改既有语义（修改/删除）；或新增 `effect:deny` 规则但不触临床语义 |
| **L2 受监管** | 触临床判定（禁忌症/适应症/剂量上限等）；或改适用范围/输出形式；或受监管行业（`medical-*`，config `industry`）改动 `logic.yaml` 的 `deny` 规则 |

**受监管字段识别是启发式**（关键词表见 `classify.js` 顶部三张表），**不是精确语义分析** ——
可接受漏报，不冒充精确。例：字段起名 `limit_mg` 不命中 `dose` 关键词 ⇒ 漏报；已诚实标注。

**手动升降级**：`fde_ontology_write` 可选 `level` 参数，**只能升级、不能降级**。
低于自动级别 ⇒ 拒绝（`LEVEL_DOWNGRADE_DENIED`）+ 审计 `decision:'deny'`，文件不落盘。

**解析失败 / 非受管文件 ⇒ fail-closed 判 L2**：`classifyChange` 解析不了新旧内容、
或 path 不是 `objects/logic/actions/guards.yaml` 之一，一律按最坏档 L2。

**PoC 降级声明**：本单只**记级别**，不驱动 C2 的各级流程（重生成用例 / 回 Phase 3 / D5 评估）。
审计 `allow` 记录额外带 `level` / `autoLevel` / `added` / `modified` / `deleted` / `classifyReasons`。

---

## ⚠️ 未验证项与已知缺口（诚实清单）

**2026-09-23：PoC #1–#6 已全部活验通过**（详见上方 PoC 清单与 HANDOFF.md §5.5 / §5.6）。
已验证：① 全部 7 个文件语法通过；② `lib/paths.js` 路径判定功能测试（非符号链接 7 例全过）；
③ **离线对照已安装 SDK 0.1.2-rc.1 的 `.d.ts`，逐条核实全部 API 契约**（见 VERIFICATION.md）——
这也把"加载即崩"的头号风险（RUN_CODE_NAME 未导出）排除了；
④ 插件实测 `fiberPhase: "active"`；⑤ **运行时 deny / 放行 / 影子行为全部实测**。

✅ **活验暴露的两个代码缺陷（下表 #7/#8）已于 2026-09-23 源码修复并通过回归测试。**
✅ **两者已同步到安装副本（SHA-256 逐项 MATCH），并已于 2026-09-23 重启 DSH 后活验通过**：
① 同一发纯计算 `run_code`，审计行 `decision` 从 `shadow-deny` 变为 **`deny`**；
② 新行 `seq` 续接末行（`1 → 2`）、`prevHash` 精确相接，重载不再断链。
另做了**反向对照**（standard 会话里 shadow 下发语义违规），确认语义规则仍记 `shadow-deny` 且放行
—— 修复没有把标签一律打成 `deny`。详见 HANDOFF §4.3「复验结果」。

> 📌 **硬约束（已实测坐实）**：**改 `lib/*.js` 必须重启 DSH 进程** —— **翻 `mode` 无效**
> （它只重跑 `apply()` 带新配置，ESM 按 URL 缓存不重新导入模块）。

✅ **第三个代码修复（2026-09-23，切换 enforce 后复检发现，见上表 #3b）**：shell 引号串里的
**字面量路径**曾静默漏报（读成功、不拦、不落审计）。已改 `shellPathTokens()`（两条兜法）+
顺带修 `fde_ontology_read` 的 `EISDIR` 原始报错，离线回归 **18/18**、已同步安装副本 **11/11 MATCH**，
**并已重启 DSH 活验通过**（审计 #30/#31/#33 三种形态被拒；对照与假阳性复检零误伤）。
⚠️ **交付说明的措辞边界**：可写"**引号串内的字面量路径已纳入判定（同机制已验证）**"，
**不可写**"shell 通道对读已全覆盖" —— 变量拼接 / base64 仍抓不到，且真实读取动词那一形态未上线。

> ⚠️ **符号链接用例更正（2026-09-23，已实证推翻"逃逸漏洞"）**：初版声称"`canonicalizeSync` 在 realpath 失败时把
> "区外符号链接→ontology"误判区外而放行，构成真实逃逸"——**此结论不成立**。用真实 junction 复跑（非沙箱坏链接）：
> 初版与"修复版"对 7 个用例输出**完全一致、各 0 错误**，不存在可利用逃逸。
> ⚠️ 这组探针数据跑的**就是 junction 路径**（实测 junction 的 `lstat` 是符号链接、`readlink` 给目标），
> 走的是 `isSymlink` + `readlinkSync` 分支 —— 与 §5.6 实测相互印证。
> 原判定之所以"测得"逃逸，是测试沙箱的 `symlinkSync` 静默造出坏链接
> （`realpath`/`lstat`/`readlink` 全返 `ENOENT`），而坏链接的路径本就写不进去（OS 返 `ENOENT`），不构成逃逸。
> 详见 HANDOFF.md §4.1。`paths.js` 的 `isSymlink`/`readlinkSync` 分支与初版功能等价，可保留也可回退；
> **PoC #6 已降级为常规回归项，不再是必须优先复测的漏洞**。

以下是**未验证**或**已知拦不住**的：

| # | 项 | 影响 |
|---|---|---|
| 1 | guard 是否被 `run_code` 的执行咨询到 | ✅ **已活验（2026-09-23 PoC #1）：guard 被 run_code 执行咨询并拒，第 2 层成立**，无需第 3 层（见上「禁 PTC」节） |
| 2 | `sessionCwdOf()` 的字段路径（**已对照 0.1.2-rc.1 类型核实并修正**） | `Agent` 类型无 `cwd` / `workspace` 字段、`Session` 未暴露 `cwd`，故实际回退 `process.cwd()`；已改正字段路径、去掉两条死字段。fail-closed 多基准缓解 |
| 3 | `run_code` 内部程序用 `node:fs` 直写 | guard 看不到的是 run_code 程序里**直接调 `node:fs`**（绕过工具系统）；程序内**通过工具系统**发的调用 guard **看得到**。直写部分无法用本插件方案堵上，要么整体禁 run_code，要么依赖代码运行时自身沙箱 |
| 3b | ✅ **shell 引号串里的路径曾抓不到（读侧静默漏报，2026-09-23 发现 → 已修 + 已活验）** | `cmd /c "type E:\ontologyRoot\poc-t5.md"` 这类命令**曾既不被拦、也不落审计，且读成功**（实测回显 `t5 legal`，审计新增 0 行）。根因是代码 bug 不是启发式限制：`shellPathTokens()` 把**整个引号串**当一个 token，再当相对路径 `resolve` 掉。⚠️ **第二层兜底对此无效** —— 原生沙箱**读永远放行**（见下方「能力边界」节），所以这一类**guard / 沙箱 / 审计三层全空**。<br>**2026-09-23 已修 + 已活验**：`shellPathTokens()` 加两条兜法（按空白再拆 + 按绝对路径锚点取后缀），离线回归 **18/18**、安装副本 **11/11 MATCH**；重启 DSH 后三种命令形态线上被拒（审计 **#30 / #31 / #33**）、同行对照不误伤、零假阳性。顺带把 `fde_ontology_read` 的 `EISDIR` 原始报错换成一句人话。<br>⚠️ **一处诚实边界**："真实读取动词 `type`"那个形态**没能上线**（模型会换工具/明文拒绝），覆盖结论由**修复前后同串 A/B** 支撑 —— 写法应是"**同机制已验证**"，**不是**"该命令已在线拦过"。<br>**残留漏报面不变**：`%VAR%` / `$env:` 变量拼接、base64、运行时拼装的路径依旧抓不到；只能声称"覆盖了字面量路径"。详见 HANDOFF §7 #6、§7-附注 |
| 4 | shell 命令的路径 token 提取是有损启发式 | 变量拼接、base64 解码后写入等抓不到。写侧设计上接受漏报（原生沙箱兜第二层）；⚠️ **读侧没有第二层** —— 原生沙箱**读永远放行**（见下方「能力边界」节），所以读侧的漏报是**裸漏**，抓到多少算多少。不要把"原生沙箱兜底"当成读侧的安全论证 |
| 5 | `ctx.effect` / `ctx.logger`（**已对照 0.1.2-rc.1 类型核实**） | cordis `Context.effect(callback, label?)` 签名匹配、`ctx.logger` 用可选链安全；**不再属未验证项** |
| 6 | ⚠️ **`str_replace_editor` 参数名已核实，但该映射是休眠代码** | 读 `@deepseek-ai/dsh-tool-str-replace-editor/lib/index.js` 确认路径参数就是 **`path`**（`args.path`）、**要求绝对路径**（`isAbsolute` 否则抛错），`guard.js` 早已映射进 `PATH_TOOLS` —— **参数名部分没问题**。<br>⚠️ **2026-09-23 更正**：本条曾写"该工具在活 DSH 中确实注册（`pluginInventory/list` 命中），该覆盖真在起作用" —— **后一句是错的**。它虽出现在 inventory 里，但状态是 `fiberPhase: null, enabled: false`；**开会话让模型自报，答"不存在 `str_replace_editor`"**（存在 `pwsh`、`read`）。即该映射**当前不生效**，属休眠代码。<br>同批实测还推翻了一条更重要的假设：**inventory 的 `enabled` 字段不是会话内可用性的判据** —— `dsh-tool-pwsh` 同样是 `enabled: false`，却在会话里**完全可用**。同字段同值，两种相反真实态 |
| 7 | ✅ **审计标签与实际决策相反**（2026-09-23 活验发现，**已修**） | `run_code` 在 `shadow` 下**真被拦**，却记成 `shadow-deny`（该标签语义＝放行）→ **合规审计低报实际拦截量**，且无法区分「本会拦但放行」与「真拦住了」。根因：`denyRunCode` 判定在 `evaluate()` 里位于 `applySemanticRules` 提前返回**之前**（与 mode 无关），而 `pre-execute.js` 只按 `cfg.mode` 打标签。**已修**：`evaluate()` 返回 `modeIndependent`，标签与决策分支统一为 `enforcing \|\| modeIndependent`。✅ **已同步 + 已活验（2026-09-23）**：shadow 下同发纯计算 `run_code`，审计行 `decision` 已是 `deny`，回执编号变为「审计 #2」（HANDOFF §4.3） |
| 8 | ✅ **哈希链在插件重载处断开**（2026-09-23 活验发现，**已修**） | 重载后链从 `prevHash=全零` 重启、`seq` 回到 1，日志文件里成**多条互不相连的链** → **尾部截断不可检测**，「审计 #1」有歧义。**已修**：`AuditChain` 构造时同步回读 `auditPath` 尾部 64KiB，从最后一条可解析 `{hash, seq}` 的行恢复链头与 seq（含补残尾换行），重载即续接。✅ **已同步 + 已活验（2026-09-23）**：重启 DSH 后首写即续接（`seq 1→2`、`prevHash` 精确相接，旧行为会重置为 1 + 全零）；`seq` 一路连到 5 无断点（HANDOFF §4.3） |
| 9 | ✅ **`AuditChain` 三处硬化**（2026-09-26，**已修**，移植自 `dsh-fde-phase` 补丁 3 与 P2-3） | 本插件与 `dsh-fde-phase` 的 `lib/audit.js` **同源**，但那边的三处硬化这边一直没有，现已一并移植（详见下方「审计链三处硬化」）。<br>**① `#degraded` 排队闸**：交错失败（写 `A` 成功、写 `B` 失败、写 `C` 成功）曾导致磁盘上 `A → C`，`C.prevHash` 悬空 ⇒ 假断链；`flush()` 后还变成 `A, C, B`（**顺序反了，仍然断**）。现改为：上一条没落盘 ⇒ 后续一律排队，不抢先写。<br>**② `record()` 剥除调用方注入的 `seq`**：`{ seq: ++n, ...entry }` 的展开顺序让 `entry.seq`（哪怕是 `undefined`）覆盖自动编号 ⇒ 落盘记录**缺 seq** ⇒ 重启恢复跳过末行 ⇒ 真分叉。现改为 `const { seq, ...rest } = entry`。<br>**③ 恢复时链头与 seq 起点分两遍取**：链头只认 hash（**不强制 seq**），seq 取窗口内最大值。原实现单遍且要求 `Number.isInteger(seq) && seq > 0` ⇒ 末行缺 seq 时被跳过，链头落到上一条 ⇒ **两条记录同父**（真分叉）。<br>✅ **三项都只在失败路径 / 老格式输入上有差异** ⇒ 只需离线回归，**不需要重启活验**；三项各自独立可回退。回归见 `tests/_audit_gate_test.mjs`（**14/0**，改前正向 7 条全红） |

| 10 | 🟡 **「旧套件绿」不等于「没缺陷」（2026-09-26，写死在这里防止误读）** | `tests/_audit_chain_test.mjs` 测的**正是本插件这份 `audit.js`**，但它的 4 个场景**从头到尾没有一次写失败** ⇒ 在「交错失败 ⇒ 假断链」「恢复跳过末行 ⇒ 真分叉」这类场景上**必然绿**。<br>⇒ **它绿不能作为"这些方面没问题"的证据**，只能说明"它没覆盖"。这三条真正的凭证是 `tests/_audit_gate_test.mjs` 那 14 条（改前正向 7 条全红）。<br>同理：任何"某个套件全绿"的结论，都要先问**那个套件有没有真的触发失败路径**，否则就是假阴性。 |
| 11 | 🟡 **C1 分级是启发式；C2 各级流程未接（2026-09-28）** | 关键词表漏报存在（字段名不命中即漏，见「变更分级」节）；本单只**记级别**、不驱动 L0/L1/L2 各自流程（重生成用例 / 回 Phase 3 / D5 评估），流程留 C2 |
| 12 | 🔴 **影子期样本**极小**且分两段链**（2026-09-29 实测）** | 真链当前段 `shadow-deny` **0 条**（`deny 11 / allow 4 / write-probe 1`）；同目录**归档段** `gate.jsonl.2026-09-26T10-18-10-793Z` 有 `shadow-deny` **10 条**、跨度仅 **3.28 小时**（2026-09-23）。⇒ 按 §12 的「连续 7 天 + 准确率 > 80%」**当前不达标**，且**归档段不自动合并**（只作为 `warnings` 报出）。**不要**据此写"影子期没跑过" —— 跑过，在归档侧 |
| 13 | 🔴 **enforce 的"批准"只在工具路径上硬**（2026-09-29）** | `fde_shadow_switch` 通过后才写 `mode-switch approved:true`；但**模式本身是部署层配置**（`cordis.patch.yml` 的 `mode`），插件只读 ⇒ 手改配置**结构上管不着**（与"手改 yaml 绕过 deny"同属进程内软约束边界）。本插件的兜底**只是"曝光"**：apply 期若发现 `mode: enforce` 而链上没有最新批准，记一条 `mode-switch-unattested` + 告警，**不拒绝加载、不降级**（硬降级方向是**放松**门禁，比"生效但被记一笔"更坏） |
| 14 | 🟡 **"连续 7 天"只按跨度落地**（2026-09-29）** | 判据是**最早→最晚的跨度 ≥ 7×24h**；中间是否有空档**不参与裁决**（`maxGapDays` 只作为 `warnings` 报出）。理由：spec 没有给"最多允许空 N 天"的权威口径，**这个 N 我不编**。⇒ 交付文案不可写"已验证连续 7 天无中断" |
| 15 | ⚠️ **`fde_shadow_status` 只读也入链** | 与 `fde_ontology_read` 同形态。口径：**只要有一类访问不落链，"完整访问史"就不成立**。⇒ 影子统计的每次查询都会给链**追加**一行 `decision:'allow'`；统计只挑 `shadow-deny`/`shadow-judged`，不受影响 |
| 16 | ✅ **R2 逐条确认的弹窗面只由离线套件覆盖**（2026-09-29）** | 活验的合成达标链是"全部已确认"⇒ 走的是闸门 2 的 0 条分支，**没弹过窗**。弹窗语义（`allowed-once`⇒agree / `rejected`⇒disagree / **`unavailable`/`cancelled`⇒中止**）由离线 `tests/_fde_e4_tools_test.mjs` 46 断言 + 变异 M16 钉住。<br>⚠️ 注意方向与 D4 ask **相反**：那里 `unavailable` 放行，这里`unavailable` **中止**（拿不到 FDE 的明确结论就不许把门拧到 enforce） |
| 17 | 🔴 **放行表的恢复只覆盖链尾 64 KiB**（2026-09-29，E1） | 与 `D1Mirror` / `AuditChain` 同一个 `TAIL_BYTES` 窗口。**窗口外的 `break-glass` 记录读不到 ⇒ 那条放行在重启后静默失效**。方向是**保守的**（少放行 = 更难绕过），但"重启后行为与重启前不同"必须让客户知道。窗口内的 `break-glass-resolved` 一定读得到（它比 open 晚），所以不会出现"已补正却被当成还开着" |
| 18 | 🟡 **`GATE-CLASSIFY` / `GATE-PATH` 不带内容锚点**（2026-09-29，E1） | 带锚的一类（`D1`/`D3`/`D5`）在内容变化时**放行自动失效**；而 `GATE-*` 判的是**载荷语义**（分类等级 / 命中哪个保护区），**没有文件可锚** ⇒ 只按 `deny-id` 比对。内容变了、放行仍有效，这一点必须写进交付说明，不能声称"放行一律与内容绑定" |
| 19 | 🔴 **`GATE-*` 记录一旦开出，本仓库内没有"补正"路径**（2026-09-29，E1） | 自动补正只在 phase 侧（`audit-listener.js` 的 `resolvedCandidates`），其判据是 `checks.includes(r.denyId)`，而 `checks` 只可能来自 `DENY_CHECKS`∩`IMPLEMENTED` = `D1/D2/D3/D5` ⇒ **`GATE-*` 永远不在候选里**。`fde-break-glass` 也只开不补。⇒ `GATE-*` 放行的**唯一**收口方式 = 人工（改 `memory/break-glass.json` / 追加链记录）。这是设计取舍（`GATE-*` 在 gate 插件里，phase 复算不了），不是遗漏，但它必须可见 |
| 20 | 🔴 **广播失败 ⇒ gate 不知道这次补正，且无自动恢复路径**（2026-09-29，E1） | phase 的自动补正会 `ctx.emit('fde/break-glass', {resolved:true})` 并在失败时吞掉（`try/catch`，理由：监听器同步抛错会冒泡、绝不能把补正流程搞失败）。而 gate **只从自己的链恢复**，那条写的是 **phase** 的链 ⇒ 症状是"phase 说已补正、gate 还在放行"，且**只在重启后才看得出来**。补救 = 再砸一次玻璃（产生新 id，旧记录留作证据）或人工核对两条链。触发条件很窄（`emit` 监听器同步抛错），但不假装它不存在 |

| 21 | 🔴 **路径兜底只看**键名**，表外的键一律扫不到（2026-09-29 核，**既有缺口**，早于 E2） | `guard.js` 的 `collectCandidates` 按 `KNOWN_PATH_KEYS[exec.name] ?? GENERIC_PATH_KEYS` 取**键名表**，再只读这几个键的值。`GENERIC_PATH_KEYS` 是 `path / file_path / filePath / filepath / file / target / target_path / targetPath / directory / dir` **十个** —— **不含 `name`**，也不含任何"自定义键"。<br>⇒ 一个**未在 `KNOWN_PATH_KEYS` 里**的工具，若把路径放在表外的键上（`name` / `src` / `dest` …），其路径**不被扫描 ⇒ 不拦、也不落审计**（留痕那一条同样依赖 `collectCandidates`，见 P1-3）。<br>**⚠️ 边界（别高估它）**：真实 DSH 的 `read` / `write` / `edit` / `read_image` / `str_replace_editor` 都在 `KNOWN_PATH_KEYS` 里**被精确覆盖**；带 `command` 字段的 shell 类调用另有专项兜法（`shellPathTokens`）。⇒ 这条要**装上第三方插件**、且其路径参数名恰好落在表外才可触发。<br>**为什么现在写下来**：E2 新增的 `fde_experiment_write` 参数名**正是 `name`** —— 这证明"`name` 当路径键名"不是臆想出来的假设，是真实工具里就在用的形态（它本身落在沙箱豁免区内，不存在"该拦而漏拦"）。本条性质是**偏松**（漏拦），没有 fail-closed 那种天然的保守性 |
| 22 | 🔴 **历史 deny 记录**没有 `denyId` ⇒ ① 只能弱配对**（2026-09-29，E5） | `denyId` 是 E5 期才补进 `pre-execute.js` 的 deny 记录里的（**只增字段**，历史行仍是旧形态）。⇒ 读侧必须把"缺 `denyId`"当**独立一档**：这类 deny 只能按**工具名**弱配对"后续是否被绕过/修复"，同工具的不同 deny 会互相串。实现里按 `hasId` 分强/弱两档，弱配对**单列计数**并把 `confidence` 降档 —— **不许静默当成强配对**。另：`fde_ontology_write` 的 allow 记录早期也没有 `level` 字段，见 #26 |
| 23 | 🔴 **两项指标在实现期各踩过一个"假证据"坑（2026-09-29，E5，已修）** | **① ③ 的分母选错**：先写成"只给有变更的 Phase 建行"⇒ 零变更时塌成 `insufficient-data`。实测症状最刺眼：**链上有 16 条 `phase-advance` 却报"无数据"**。修法 = 先按 Phase 段播种、分母取**段数**。**② ⑤ 用了恒真判据**：`ratioVerdict(sum14, 1, …)` 的分母恒为 1 ⇒ **永远不可能红**（`X == Y` 型恒真式），还会在无配对段时假报"0 天 + ok"。修法 = 新增 `absoluteVerdict(value, hasData, …)`，`hasData` 为假即报缺席。⇒ 两条都写进 `tests/_fde_e5_test.mjs` 的**具名断言**（D2 / F3）并用变异钉住（M9 / M2） |
| 24 | 🟡 **`degraded` 是合并档：`cancelled` 与 `unavailable` 拆不开**（2026-09-29，E5） | ④ 的跳过率把 `degraded` 计为跳过，但源记录里 `cancelled`（FDE 撤回）与 `unavailable`（没有 answerer）**已经合并**成一个值（`dsh-fde-phase/lib/tools.js:268` 的 `d4Approval = d4 === 'allowed-once' ? 'confirmed' : 'degraded'`，D5-pre 同形在 `:315`；`:274`/`:341` 的 `outcome:` 已是合并后的值）。⇒ 本指标**无法**分列这两者（设计时曾打算分列，实测数据源不支持）。这是**数据源的粒度**决定的，不是统计口径的选择；要拆必须先改 phase 侧的写侧 |
| 25 | 🟡 **`phaseAuditPath` 缺省是"能起但三项无数据"**（2026-09-29，E5） | 与 `dsh-fde-phase` 的 `gateAuditPath`（缺 ⇒ **抛错、插件加载失败**）**刻意不对称**：它只是只读指标的数据源、不参与任何拦截判定，缺它只让 ③④⑤ 报 `insufficient-data`（**不是 0%**）。✔ 理由：为一个**报表项**让整个门禁插件起不来，方向是拿合规能力换报表能力。⚠️ 代价写在这里：**部署时忘了配它，症状是"三项静默无数据"**，只有启动日志那一行（已加）能一眼分辨"真没数据"与"路径配错了" |
| 26 | 🟡 **③ 的 `noLevel` 是下界，真值是上界**（2026-09-29，E5） | 老版本写的 `fde_ontology_write` allow 记录**没有 `level` 字段**（真链 seq 4/5）。实现里**全收**、单列 `noLevel` 桶、**不计入** L0+L1（判不出级别就不猜），并在 `note` 里写明"`value` 是**下界**，真值上界为 X 次/Phase"，`confidence` 降为 `proxy`。⚠️ 交付文案不可写"Phase 4 变更已精确计数" |
| 27 | 🟡 **⑤ 的口径在 spec 内部就不一致**（2026-09-29，E5） | 指标**定义**写的是"日历天数"，**推翻条件**写的是"工作日"（> 15）。本实现取**日历天**，理由是它与数据源（审计链的 `ts` 差值）可直接计算、不需节假日表；方向**偏红**（日历天 ≥ 工作日 ⇒ 更容易触发"流程过重"）。⚠️ 这不是实现口径选择，是**spec 自身的矛盾**，故在 `note` 里逐字写出，**不假装已按 spec 统一**。同批：③ 的"变更"只数 L0+L1（L2 是否计入 spec 未明说）、① 的"修复"只认两个写通道 —— 都是我们**声明过的 proxy**，不是 spec 的原文 |
| 28 | 🟡 **测试套件的崩溃兜底会丢后续断言**（2026-09-29，E5） | `tests/_fde_e5_test.mjs` 装了 `uncaughtException` 兜底，目的是**保住整份报告**（崩溃一次会让所有断言结果消失，本项目实测过）。⚠️ 代价：崩溃点**之后**的断言不会继续跑，报告里它们**缺席**而不是"红"。⇒ 读报告时要看**断言条数**是否等于 **63**（2026-09-29 加 F5b 后，原为 62），少于 63 就是中途崩过，不能只看"失败 0" |
| 29 | 🔴 **⑤ 的链尾是"按链推断"，不是"当前 Phase"**（2026-09-29，第五层活验发现） | 权威是 `<projectRoot>/memory/state.yaml` 的 `current_phase`，而它**会被手工 seed/restore**（活验常用手段，不留链记录，且按既有纪律保留 `revision`/`updated_at` ⇒ 时间戳也看不出动过）。实测本机：链尾 **Phase 3** 而 `state.yaml` **Phase 10**（seq 88/93/96/99 的 `2→3` 每次成功、被紧随的 `restrict-lifted phase:"3"` 证明，随后又被 re-seed 回 10）。⇒ 字段名从 `inProgress` 改为 **`chainTail`**：旧名在**断言**"现在正处在这个阶段"，而 `computePhaseDwell` 只读链、读不到 `state.yaml`。F5b 用**双向**断言钉住（必须不含旧名 + note 必须含"权威是 state.yaml"），M21/M22 各打一个方向。⚠️ **推论**：凡是只读链推断"当前状态"的判据都受同一限制，要报"现在"必须去读 `state.yaml` |

> 全部 API 契约的离线类型核实结果见 **[VERIFICATION.md](./VERIFICATION.md)** —— 插件加载不会因 API 签名失真而崩溃。

### 审计链三处硬化（2026-09-26）与 `dsh-fde-phase` 的差异

两个插件的 `lib/audit.js` **同源但已不再是同一份代码**。截至本次移植，差异收敛到下表 ——
**这张表就是下次改其中一份时的对照依据**，别再让两边 silently drift。

| 能力 | `dsh-fde-phase` | `dsh-fde-ontology-gate` | 说明 |
|---|---|---|---|
| `GENESIS` / `TAIL_BYTES` 导出 | 导出 | 模块内常量 | 有意保留：gate 无人消费这两个常量 |
| `#readTailLines()` 单一读取路径 | 有 | 无（逻辑内联在 `#restoreFromTail`） | 有意保留：gate 只有一处读尾部，抽出来没有第二个调用方 |
| `tailTruncated` / `latestRestrictByAgent()` 索引 | 有 | **无** | 有意不移植：那是 restrict 的功能（第四批），gate 没有按 agent 查决策的需求 |
| `#degraded` 排队闸 | 有（补丁 3） | ✅ **本次移植** | 缺陷修复：失败路径才会有差异 |
| `record()` 剥离调用方 `seq` | 有（P2-3） | ✅ **本次移植** | 输入防御 |
| 恢复分两遍取（head 只认 hash / seq 取 max） | 有（P1-1 + P2-3） | ✅ **本次移植** | 防御更多来源的缺 seq |

⚠️ **一个容易读错的地方**：链头取到手以后，**本插件不校验 `prevHash`**。
`#restoreFromTail()` 的职责只是"决定从哪里接着写"，链完整性由外部校验器（逐条比 `prevHash`）
判定。不要把"它读了文件"误读成"它验过链"。

审计的 fail 方向是**故意**的：落盘失败不抛，进内存 outbox 待重放
（fail-open on audit），因为审计故障不该让 agent 全线停摆。合规场景若要
fail-closed，把 `pre-execute.js` 里 `audit.record` 的返回值纳入判定即可。

⚠️ **但"不抛"不等于"可以抢先写"**（2026-09-26）：某条落盘失败后，后续记录**一律排队**，
直到 `flush()` 成功为止 —— 否则磁盘上出现 `A → C` 而 `C.prevHash` 指向只存在于内存的 `H_B`
⇒ 悬空 prevHash，外部校验器会报"链断了/被篡改"，而链其实没被改过（下文 #9）。
副作用是刻意保留的：**写盘持续失败期间，审计链停在最后成功点** ——
宁可"审计停止前进"，不可"前进了但是假的"。

⚠️ **代价要写死在这里**：持续写失败期间 `#outbox` **无上界地在内存里增长**（每条记录一行）。
这是 fail-open on audit 的既定取舍，**不是**本次引入的新性质（排队之前失败记录也一样进 outbox），
但排队闸让它更容易被注意到：磁盘上的链会明显落后于 `count`。判据：
`count - pending` 是真正"可信记录"的条数，磁盘行数 ≤ 它。

---

## 能力边界（交付时须写进说明）

> 门禁 = 防漂移 + 留痕 + 可纠正；**不是** 防恶意 + 密不透风。

DSH 的信任模型是：第三方插件运行在**核心 Node 进程内**，沙箱与审批是 consent UX
而非 OS 边界。本插件是**进程内软约束** —— 防的是模型无意的失误与漂移，
不是有意的恶意绕过。对医美合规场景应承诺：绕过**可见、可审计、可统计、可纠正**。

原生 fs-sandbox 的定位同样要讲清：官方自述 *"containment, not a security boundary"*，
且读与网络访问永远不受限。它的 `workspace-write` 对本插件只是"区外=只读"的偶然纵深，
**不可作为主防线**（`danger-full-access` 模式下围栏整体关闭）。

### 路径判定是"归一后包含"，不是字符串前缀匹配（交付说明必写）

`isInside()` 的做法是 **canonicalize-then-contain**：先把路径（含所有 junction / 符号链接祖先）
解析成真实路径，再判它是否落在 ontology 根目录内。

- **不是** `path.startsWith(root)` 这种字符串前缀匹配 —— 字符串匹配会把
  `ontology\out-junction\x`（真实落在区外）**误判成区内**，也会把
  `E:\DSH-workspace\poc6-in\x`（junction 指向 ontology）**误判成区外而放行**。
- 归一化是**双侧**的：既把"区外链接 → ontology"归一进来判 DENY（堵死逃逸），
  也把"ontology 内链接 → 区外"归一出去判放行（**不误拒**）。
- 2026-09-23 PoC #6 两个方向都有实测支撑（见 HANDOFF §5.6）。

⚠️ 已知残留：`gate.jsonl` 现有 **3 条链**（前两条是缺陷 ② 修复前的历史残留，修复只保证此后新增连续、
不回填历史）。**当前决定暂不归档** —— 归档会把「`seq 1→6` 连续」这段修复证据一起搬走，
而它在活文件里可当场展示。要单链到底时归档旧文件后重启即可，**不影响可用性**。

### 审计目录已进保护根（2026-09-26）—— 副作用与固有边界（必读）

`guard.js` 第 ③ 段的受保护集由**单根** `{ontologyRoot}` 扩为 `{ontologyRoot, dirname(auditPath)}`
（2026-09-26 实测缺口：审计链落在 ontologyRoot 之外 ⇒ 模型只要被批准一次 `danger-full-access`
就能改写它 ⇒ 留痕即失效，而门禁自己没有任何判定）。

**副作用（运维会以为工具坏了）**：此后**任何**调用的参数或 shell 命令串里出现审计目录的
路径字面量都会被拒 —— 包括运维自己用来核对链的 `cat gate.jsonl` / `cp` / `wc` / `Get-Content`。
**这是门禁生效，不是故障。** 要读链：在 DSH 之外的终端/编辑器里读，或临时把 `mode` 切 `shadow`
（路径兜底受 `applySemanticRules` 门控，shadow 下不拦）。

**⚠️ 判空不是可有可无的防御**：`auditPath` 留空（`''`，PoC 默认"只驻内存不落盘"）时
`dirname('') === '.'` ⇒ 若把 `.` 当保护根，进程 cwd 内**一切写都被拒**。本实现显式跳过空串
（回归用例见 `tests/_gate_audit_guard_test.mjs` 的「auditPath 为空串」那条）。

**固有边界（别把它读成"从此万无一失"）**：`collectCandidates()` 是从参数/命令串里**提路径 token**
的启发式（两条兜法见 `guard.js` 的 `shellPathTokens`）。像
`node -e "fs.writeFileSync('E:\\…\\gate.jsonl', …)"` 这类把路径藏在代码字符串里的写法
**提不出来** ⇒ 本次只是把既有兜底的**范围**扩大，**没有**改变它的性质。
真正的硬边界要靠 `ctx.tools.restrict` 摘掉 shell / code 类工具（本插件不做这件事）。

### 受保护集已配置化：`protectedExtraRoots`（2026-09-26 / 0023 P0-4a）

受保护集现在是 `[ontologyRoot, dirname(auditPath), ...protectedExtraRoots]`，
**唯一定义处**是 `lib/paths.js` 的 `protectedRootsOf(cfg)` ——
`guard.js` 的判定与 `index.js` 的启动打印**共用这一个函数**，
⇒ "日志里打出来的保护根"和"真正判的保护根"字面上不可能不一致。

**为什么要有第三类**：`state.yaml`（`<projectRoot>/memory/state.yaml`）与 `.state.lock`
既不在 `ontologyRoot`、也不在审计目录里 ⇒ 此前**完全不在守卫内**，而它是三者里
唯一"改了没有任何东西会发现"的一条 —— 改 `state.yaml` 之后 `fde_phase_advance`
的 deny **一次都不会跑到**，门禁被整个跳过（A① 被改至少还有 D2 事后能查）。

**⚠️ 配置即生效面**：`protectedExtraRoots` 只是**字段**，不给活体配置填值 ⇒ A②③ 依然敞着。
配错（非数组 / 含空串 / 非字符串）⇒ **插件加载失败**（fail-closed），不是静默丢弃。

**🔴 shadow 模式下这一段也不拦**（P1-4，别漏读）：受保护集整段受 `applySemanticRules` 门控，
与 `ontologyRoot` 同口径。切 shadow 时模型可直写审计链 / state.yaml 而门禁**一声不吭**。
启动日志因此在 shadow 下会额外打 `（⚠️ shadow 模式下**不拦**）`。

**⚠️ 受保护区域内「读」也被拒**（P1-7，是生效行为，不是故障）：第 ③ 段按**路径**判定，
不区分读 / 写 ⇒ 模型在 DSH 里 `read` `fde-state/memory/state.yaml` 同样被拒。
要核对阶段：**退出 DSH** 用外部编辑器读，或临时切 `shadow`。
「阶段由操作者掌握、agent 不自查」是有意设计，见 phase README §4.9。

**⚠️ 拒绝文案的读写口径必须与判定一致**（P0-9 / 0025）：三个区域的 `note` 曾一律写「**直写**」，
而守卫**读也拦** ⇒ 模型用 `read` 撞上时会读到"我只是读，为什么在讲写"，并可能据此推断
"读应该被允许"再去试一次。活体实证：`gate.jsonl seq 9/10/11` 三个动作**全是 `read`**，
旧文案却在讲「直写绕过…」/「不接受任何直写」。

现文案（`PROTECTED_KINDS`，三类**各说各的**）：

| 区域 | 有专用通道？ | 口径 |
|---|---|---|
| ontology | ✅ 有（读 / 写各一） | 读与写**都得走** `fde_ontology_read` / `fde_ontology_write`，直连文件绕过入口的语义判定 |
| 审计链目录 | ❌ 无 | 不接受任何直接读与写 —— 写入伪造留痕，**读取同样被拒**（守卫对读写不作区分） |
| 额外受保护目录 | ❌ 无 | 不接受任何直接读与写，也没有专用工具通道（**不提** `fde_ontology_*`，否定句式也会诱导模型去试） |

回归用例见 `tests/_gate_audit_guard_test.mjs` E 组：三条 `read` 打三类路径，
断言理由**不含「直写」**且**明确覆盖「读」**。

### 探索沙箱豁免：`sandboxSubdirs`（2026-09-29 / E2，spec v3 §7）

spec §7 要求一个**探索沙箱**：模型在里面自由试 ontology 草稿，且
① 沙箱内容**不进分层注入**、② 沙箱草稿**不参与 D1/D3 校验**、③ 验证成功后经
**正式变更通道**（L0/L1/L2，即 `fde_ontology_write`）合入、④ 沙箱内容**无审计要求**。

**为什么需要"豁免"这个东西**：沙箱必须在**模型可读写**的位置，否则不叫沙箱。
但 `protectedExtraRoots: [<fde-state>]` 把整个状态根封死了（见上一节：**读也被拒**）
⇒ 沙箱不能只是"再配一个 extra root"，那样配出来是**不可用的**。
⇒ 引入 `sandboxSubdirs`：在**已有保护根之内**、按**路径**豁免的子目录名。

**🔴 三处刻意收窄**（每一条都对应一个本该发生的坏结果）：

| 收窄 | 做法 | 不这样做会怎样 |
|---|---|---|
| ① 只挂 extra 类根 | 派生只在 `protectedExtraRoots` 上做（`paths.js` 的 `sandboxPathsOf`），**不碰** `ontologyRoot` / 审计目录 | 给受控区或**合规证据**开一个可写洞 —— 前者等于门禁作废，后者等于让被审计方能改证据 |
| ② 只接受**单段**名字 | `assertSandboxSubdirs` 拒 `/` `\` `:` 与 `.` `..`，且要求宿主根非空 | `sandboxSubdirs: ['../../x']` 会 join 出保护根之外的任意位置 |
| ③ 默认**空数组** | 不配 = 不开沙箱 | 「默认放在某个位置」等于**默认开着一个洞** |

第三条的语义要写清楚：**空 = 没有洞**，不是"洞在默认位置"。

**⚠️ 配错即插件加载失败**（不是静默丢弃）：`assertSandboxSubdirs`（形态）
与 `assertSandboxNotInOtherRoots`（沙箱压在别的保护根内 —— 例如与审计目录重叠）
都在 `normalizeConfig()` 里调，任一不过就抛 ⇒ `fiberPhase: failed`。
理由同 `protectedExtraRoots`：**一个配错的沙箱 = 保护根上开了洞，而运行期毫无症状**。

**启动打印**：`formatProtectedRootsLine()` 在原有保护根之后追加沙箱段
（`｜ 沙箱（N）：<path>（豁免自 <root>）`）。不开沙箱时不打印这一段。
判据是双向的：开了必须看得见（否则洞开着而启动期看不见），没开必须不出现
（否则读日志的人以为有洞）。

**★ 跨插件字面量对拍**：`'experiments'` 在**两处**出现 —— 本插件的部署配置
`cordis.patch.yml` 与 `dsh-fde-memory/lib/experiments.js` 的 `EXPERIMENTS_SUBDIR`
（跨插件不 import，只能照抄）。`tests/_fde_e2_test.mjs` 有一条断言**直接读部署配置与源码常量对拍**，
改一处不改另一处会当场红。同理还有一条对拍 `protectedExtraRoots[0]`。

**⚠️ 沙箱只豁免 guard 的**路径兜底**那一段**。「谁能在什么条件下改 ontology」的语义判定
（`fde_ontology_write` 的 source/confidence/越界检查）**一字未动** ——
沙箱是"允许直连文件系统写草稿"，不是"绕过 ontology 门禁"。

**⚠️ 诚实的代价（写下来，别当成没有）**：`tests/_fde_e2_test.mjs` **不 import `lib/config.js`** ——
`config.js` import `@deepseek-ai/schemastery`，而离线工作区没有该桩（只有 `dsh-tools` /
`dsh-llm`），import 它会让**整个模块加载失败、报告零产出**。代价用两条断言补：
**F3** grep `config.js` 确认 `normalizeConfig` 真的调了两个沙箱校验（静态断言，
可被 `tests/_fde_e2_mut.mjs` 的 M9 变异证伪）；**F4** 断言手写 cfg 覆盖 `guard.js` / `paths.js`
读到的**每一个** `cfg.*` 字段（防"手写 cfg 少一个字段 ⇒ 测试测的是另一个形状"）。
⇒ **这条代价是"补丁过的"，不是"绕过去的"；但它终究不是直接跑真 config.js**，如实记在这里。

### 越界写的留痕**看链**，不看工具返回（P1-3）

`fde_ontology_write` 越界被拒时，模型拿到的错误是**原错误原文，不带审计编号**
（`throw e` 是刻意保留的：判定语义与文案一字不改）。留痕确实写了 —— 链上多一条
`decision: 'write-probe'`。⇒ **"返回里没编号" ≠ "没留痕"**，要确认得读链。

同一会话里"被 `pre-execute` 拒"带编号（`（gate 审计 #N）`）、"被工具自己拒"不带，
粒度不一致是**已知的**，不改：改文案就是拿一个已验证的不变量去换一个便利。

**⚠️ 编号带链名**：gate 与 phase **各有一条链、各自从 1 起排**，只写「（审计 #7）」
会被并读成同一条链的推进（2026-09-26 实测：模型正是这么误判的）。已改为
`（gate 审计 #N）` / `（phase 审计 #N）`。

---

## 影子模式与 enforce 准入（spec §12 / §14）

### 两个阈值不是矛盾，是**两个数、两种用途**

| | 出处 | 阈值 | 语义 |
|---|---|---|---|
| **准入线** | §12 | 连续 7 天、准确率**严格大于 80%** | 达到才**允许**切 enforce |
| **推翻线** | §14 | 准确率**小于 70%** | 门禁**不成熟**，该重审规则质量（不是"再攒数据"） |

70–80 之间是**灰区**：不推翻，但也不够切。⚠️ `pre-execute.js` 原注释写的是「准确率 ≥70% 再切 enforce」——
那是把 §14 的**推翻线**当成 §12 的**准入线**用（**口径串台**）。已于 2026-09-29 改正，两个常量
`ADMIT_PCT = 80` / `OVERTURN_PCT = 70` 在 `lib/shadow-stats.js` 文件头，**刻意不做成配置项**
（做成配置项就等于允许把 spec 里的数调走）。

### 两个工具

| 工具 | 读写 | 做什么 |
|---|---|---|
| `fde_shadow_status` | **只读** | 报 `verdict` / 样本数 / 已确认数 / 准确率 / 跨度，以及**离可切还差什么**（`blockers` 参与裁决、`warnings` 只须知）。只读也入链（见诚实清单 #15） |
| `fde_shadow_switch` | **写** | `to:'observe'` **无条件放行**；`to:'enforce'` 走三道闸门 |

### `to:'enforce'` 的三道闸门（**顺序不可换**）

```
闸门 0  链读不到            ⇒ SHADOW_STATS_UNAVAILABLE（明说"读不到"≠"没有样本"）
闸门 1  与用户回答无关的硬事实，先判 —— 避免白弹窗
          total === 0       ⇒ SHADOW_NO_SAMPLES
          spanMs < 7 天     ⇒ SHADOW_WINDOW_TOO_SHORT
          anomalies > 0     ⇒ SHADOW_CHAIN_ANOMALIES
闸门 2  R2 逐条确认（spec §12「逐条确认所有历史"本应 deny"的项」）
          一次一条、不可批量跳过；超单次上限 ⇒ SHADOW_CONFIRM_BATCH_LIMIT
          拿不到明确结论 ⇒ SHADOW_CONFIRM_ABORTED（停在 observe）
闸门 3  **重读磁盘**再裁决 ⇒ SHADOW_NOT_READY
```

**为什么闸门 1 必须在闸门 2 之前**：真环境影子期数据不足，反过来的话 FDE 会先答完
所有历史项、再被告知"跨度不够" —— 白打扰，而且会让人以为"多答几次就能切"。活验断言
**弹窗次数 = 0**（`tools/_fde_e4_live.mjs`）。

**为什么闸门 3 非要重读磁盘**：`audit.record()` 是 **fail-open** 的（写盘失败进内存 outbox、
不抛错）⇒ 只信内存里的计数，会在"确认根本没落盘"的情况下批准切换。

**审批语义与 D4 ask 方向相反**：这里 `unavailable` / `cancelled` **一律中止**（fail-closed）。
D4 是"放行前问一声"，拿不到回答时放行是安全的；这里是"要一个明确的 FDE 结论才允许把门禁
从 observe 拧到 enforce"，拿不到结论就必须停在 observe。**同一个 helper，两种相反语义，由调用方定。**

### 逃生方向不设门

`to:'observe'` **无条件批准**（连 `approval` 返回 `unavailable` 也放行）。给"往回走"设门 =
把门禁变成**单向棘轮**，而门禁失效时人必须能撤。判据另有一条：`enforceAttestation` 取
**最后一条**模式切换 ⇒ **批准后切回 observe，旧批准失效**（为什么：链 append-only，
"存在过一条批准"是错的读法 —— 那是变异 M13 实测出来的）。

### ⚠️ 模式改不了：工具只**裁决 + 留痕**

`mode` 是 `apply()` 期读的**部署层配置**。`fde_shadow_switch` 返回 `needsRestart: true` 是
**如实**的：批准之后仍需把 `cordis.patch.yml` 的 `mode` 改为 `enforce` 并**重启 DSH**。

### 验证分工（哪一层钉住了哪一条）

| 层 | 内容 | 结果 |
|---|---|---|
| 离线纯函数 | `tests/_fde_e4_test.mjs`（缺席分档 / 窗口 / 阈值边界 / 标注归并 / 不变量） | **40/40** |
| 离线工具 | `tests/_fde_e4_tools_test.mjs`（注册面 / 闸门顺序 / R2 逐条 / 逃生 / 凭据 / 真链坏行） | **46/46** |
| 变异注入 | `tools/_fde_e4_mut.mjs`（20 条，逐条要求**具名断言**抓住） | **RED 20 / GREEN 0 / INVALID 0** |
| 真 SDK + 真数据 | `tools/_fde_e4_live.mjs`（含 defineTool **负向对照**） | **12/12** |
| ✅ **第五层：进程内注册 + 调用** | 重启 DSH 后：① `pluginInventory/list` ⇒ 插件 `fiberPhase=active`；② 新会话 `request/header` 的**工具名清单**；③ 模型**实际调用** | **已验（2026-09-29）** |

🔴 **第五层的判据是 `request/header` 事件里的工具名清单，不是 `pluginInventory/list`。**
后者只列**插件**（字段 `moduleName` / `fiberPhase` / `enabled`），**看不到工具** —— 插件 `active` 而工具缺失是完全可能的形态。header 只在**清单发生变化时**追加，所以**陈旧 header 不能反推"现在没注册"**（那是「缺席第三层」：那条 header 可能写于工具部署之前）。

实测（2026-09-29 重启后）：

| # | 动作 | 结果 |
|---|---|---|
| ① | `pluginInventory/list` | 四个 FDE 插件 `fiberPhase=active`、`enabled=true` |
| ② | 新会话 `request/header`（seq=10，共 40 工具）**逐名 diff** | **新增恰为** `["fde_change_close","fde_shadow_status","fde_shadow_switch"]`、移除 `[]`、**非 fde 工具面逐字未变** |
| ③ | 让模型调 `fde_shadow_status`（只读 + 如实 reason） | `tool/call:89` → `tool/result:90 isError=false`；真链 `seq=19 decision=allow`，`callId` 与 transcript 逐字一致 |

⚠️ ② 的 diff 是**唯一**能区分"新注册"与"本来就有的"的手段 —— 只看总数不行：新工具注册会让总数**不降反升**，且 header 只在清单变化时追加。

---

## 指标采集（spec §14）：`fde_metrics`

spec §14 给了六项验证指标，**每一项都配一条推翻条件**。这套东西的用途不是"看板漂亮"，
是**决定要不要把门禁调松**：指标越线 ⇒ 推翻当初的设计假设（门禁位置设错 / 规则质量不合格 /
流程过重 …），而不是"再多攒点数据"。

### 六项指标与推翻线（**逐字取自 spec，改这里等于改判据**）

| # | id | 指标 | 推翻条件（spec 原文） | 推翻的含义 |
|---|---|---|---|---|
| ① | `deny-fix-rate` | deny 修复率 | 长期 **< 30%** | 门禁位置设错 → 应下调为 `ask` |
| ② | `break-glass-categories` | break-glass 分类统计 | `deny_defect` 占比 **> 20%** | 门禁 bug 太多 |
| ③ | `change-rate` | 变更触发率 | Phase 4 单阶段 **> 5 次** | Ontology 首版质量不合格 |
| ④ | `ask-skip-rate` | ask 跳过率 | **> 30%** | 摩擦点设计错了 |
| ⑤ | `phase-dwell` | Phase 停留时长 | Phase 1–4 合计 **> 15 天** | 流程过重 |
| ⑥ | `shadow-accuracy` | 影子模式准确率 | **< 70%** | 不应该切 enforce |

阈值常量在 `lib/metrics.js` 的 `OVERTURN`，**刻意不做成配置项**（做成配置项 = 允许把 spec 里的数调走，
与 `ADMIT_PCT` / `OVERTURN_PCT` 同一条纪律）。

### 🔴 红线：分母为 0 报 `insufficient-data`，**绝不报 0%**

六条推翻条件**全部是阈值比较**，而 `0 < 30%` 当场为真。⇒ 一条**从未被观测过**的指标若报 0%，
会直接给出"门禁位置设错"的推翻结论，读者会照此去改一个**没坏**的部署。
**"没有样本"与"比值为 0"是两个不同的状态** —— 这是本模块唯一不可妥协的地方，它在三层各钉了一遍：

| 层 | 形态 | 离线断言 |
|---|---|---|
| 数据层 | `metric()` 的 `value: null` + `verdict: 'insufficient-data'` | A1b（六项全无输入） |
| 呈现层 | `fde_metrics` 输出 `value: '—（无样本，不报 0%）'` | H5（`message` 里不出现人话形式的 `0.0%`） |
| 判决层 | 总 `verdict` 分 `ok` / `overturn` / **`no-data`** 三档，`no-data` ≠ `ok` | A3（空输入 ⇒ `no-data`） |

绝对量型（⑤ 停留时长）走的是 `absoluteVerdict(value, hasData, …)`：**`hasData` 为假时报缺席**。
它此前写成 `ratioVerdict(sum14, 1, …)` —— 分母恒为 1 ⇒ **恒真判据**，永远不可能红，
还会在无配对段时假报"0 天 + ok"（实测抓到，见 §诚实清单 #23）。

### 数据源：**两条链，各读各的**

| 指标 | gate 链 `auditPath` | phase 链 `phaseAuditPath` |
|---|---|---|
| ① deny 修复率 | ✅（deny 记录 + 后续合法通道 allow） | — |
| ② break-glass 分类 | — | ✅（`break-glass` 记录） |
| ③ 变更触发率 | ✅（`fde_ontology_write` 的 L0/L1/L2） | ✅（时间段 ⇒ 归到某个 Phase） |
| ④ ask 跳过率 | — | ✅（`*-ask` 记录） |
| ⑤ Phase 停留时长 | — | ✅（相邻 `phase-advance` 配对） |
| ⑥ 影子准确率 | ✅（转调 `shadow-stats.js`，**不重算**） | — |

`phaseAuditPath` 是 E5 新增的配置项，与 `dsh-fde-phase` 的 `gateAuditPath` **镜像对称**：
谁要读对方的数据，谁就得被显式告知路径，**插件一律不猜路径**。
🔴 但两边**刻意不对称**：phase 侧缺 `gateAuditPath` ⇒ `normalizeConfig()` **抛错、插件加载失败**（fail-closed）；
gate 侧缺 `phaseAuditPath` ⇒ **留空也能起**。理由：它是**只读指标**的数据源、不参与任何拦截判定，
缺它只会让 ③④⑤ 三项如实报 `insufficient-data`（**不是 0%**），不会让任何一次 deny 失效。
启动日志会打印生效值 —— 配错路径的症状是"三项静默无数据"，只有把生效值打出来才能一眼分辨
"真没数据"与"路径配错了"（同 `formatProtectedRootsLine()` 的理由）。

### 🔴 链尾 ≠ 当前 Phase：`chainTail` 为什么**不叫** `inProgress`

⑤ 的 `buckets.chainTail` 是"链上最后一条 `phase-advance` 的 `to`"，**不是**"现在处在哪个 Phase"。

权威是 `<projectRoot>/memory/state.yaml` 的 `current_phase`，而**它会被手工 seed/restore** ——
那是本项目活验的常用手段（要验 D2/D3/D4 就得先把 `current_phase` 摆到目标阶段），**不留任何链记录**
（且按既有纪律保留 `revision` / `updated_at`，以免伪造工具写的计数器 ⇒ 连时间戳都看不出动过）。

实测（本机 `phase.jsonl`）：seq 88 / 93 / 96 / 99 四条 `2→3`，每条都被紧随的
`restrict-lifted phase:"3"` 证明**推进真的成功了**，可下一条 `restrict-applied` 又报 `phase:"10"`
⇒ 每次推进到 3 之后都被 re-seed 回 10。结果：链尾 **Phase 3**，`state.yaml` **Phase 10**，
而**链本身看不出**这次改动。

- 字段名刻意不叫 `inProgress`：那个名字在**断言**"现在正处在这个阶段"，而 `computePhaseDwell`
  只读链、读不到 `state.yaml`。F5b 用**双向**断言钉住（必须不含旧名 + note 必须含"权威是 state.yaml"），
  M21 / M22 各打一个方向。
- note 里照写这个偏差，字段与说明**同体传播**（读 JSON 的人一定拿到 `note`）。
- ⚠️ **推论**：凡只读链推断"当前状态"的判据都受同一条限制 —— 要报"现在"就必须去读 `state.yaml`。

### `fde_metrics` 工具

| 项 | 形态 |
|---|---|
| 入参 | `reason`（必填，写入审计） |
| 只读 | 不改任何业务状态；只读两条链 |
| **只读也入链** | 与 `fde_ontology_read` / `fde_shadow_status` 同形态——只要有一类访问不落链，"完整访问史"就不成立。审计记 `verdict` + 命中的推翻项，⚠️ **不写六个比值**（链是合规证据，不是报表缓存；抄进去就会随样本增长与真值漂移） |
| 输出 | `verdict` / `overturns[]` / `insufficient[]` / `metrics[]`（六项，统一形状）/ `warnings[]` / `message` |
| schema 类型 | `value` / `numerator` / `denominator` 都是 **`string`** —— schema DSL 里没有 `null`，而无数据必须能与 `0` 分辨（H3 断言钉死） |

### 三项数据的口径取舍（**都是 proxy，方向一律选偏红**）

| 指标 | 取舍 | 为什么偏红，为什么可接受 |
|---|---|---|
| ① 修复 | 只有 `fde_ontology_write` / `fde_phase_advance` 的 `allow` 算修复 | 分子窄 ⇒ 修复率**偏低** ⇒ 更容易触发"下降为 ask"。方向安全：spec 的推翻动作是**调松**门禁，不是放松合规 |
| ① 配对 | 同一条 deny **既被绕过又有后续写** ⇒ **优先算绕过** | 与上同向。⚠️ 历史记录可能没有 `denyId` ⇒ 只能按 `tool` 弱配对，`confidence` 降档并单列（#22） |
| ③ 分母 | = **Phase 段数**，不是"有变更的 Phase 数" | 后者会让"零变更"塌成"无数据"（修前实测：链上 16 条 advance 却报无数据，见 #23） |
| ④ 分母 | = **全部 ask 记录**（含 `write-failed` 这类失败档） | 剔掉失败档 ⇒ 分母变小、跳过率虚高。失败不是"认真回答过"，但也不能假装没发生 |

### 验证分工

| 层 | 内容 | 结果 |
|---|---|---|
| 离线纯函数 + 工具 + 跨包对拍 | `tests/_fde_e5_test.mjs`（红线 / 六项 / 边界 / 工具层 / 与 phase 的字面量对拍） | **62/62，EXIT=0** |
| 变异注入 | `tests/_fde_e5_mut.mjs`（20 条，逐条要求**具名断言**抓住） | **红 20 / 绿 0 / 无效 0** |
| 源↔副本 | `tests/_deploy_diff.mjs` | **20 文件 ALL_MATCH** |
| 全量回归 | `tests/_run_all_tests.sh` | **41 套件 ALL-TESTS-GREEN** |
| ⏳ **第五层：活体** | 重启 DSH 后 `request/header` **逐名 diff** 应新增 `fde_metrics`；再让模型实调一次 | **待验** |

⚠️ 变异验证不是走过场：首轮实跑是 **红 17 / 绿 2 / 无效 1**，三条问题各有各的教训 ——
无效那条是把 `to` 串里的闭合 `})` 写漏（`SyntaxError` ⇒ **崩溃不是证据**）；
两条"绿"是**等价变异**（改的初值随后被覆盖 / 守卫仍然拦住）⇒ **等价变异不是"没抓住"，是本轮作废重做**。

---

## break-glass 逃生门（spec §11）：**本插件只消费放行表**

break-glass 的**生产者是 `dsh-fde-phase`**（工具 `fde-break-glass` + 自动补正循环）。
gate 侧在这个机制里只有一个角色：**在判定那一刻问一句"这一条被放行了吗"**。

### 三个物件与两条链

| 物件 | 位置 | 谁写 |
|---|---|---|
| 放行表（给人看的事实源） | `<projectRoot>/memory/break-glass.json` | **只有 phase**。gate 不读它 |
| phase 链上的生命周期记录 | `phase.jsonl` 的 `break-glass` / `break-glass-resolved` | phase |
| **gate 链上的同一对记录** | `gate.jsonl` 的 `break-glass` / `break-glass-resolved` | **gate 自己**（收到广播时写） |

🔴 **为什么 gate 要把放行镜像进自己的链，而不是去读 phase 的链或那张 JSON**：
两条链是**分开的**（`cordis.patch.yml`），而 guard 是**同步**的、跨插件只有 `ctx.emit`。
若 gate 只监听事件、不落自己的链，**重启后放行全丢** —— phase 不会为已存在的记录重新广播
⇒ 行为会依赖"两个插件谁先起来"。各写各的链 ⇒ **重启顺序无关**。

### gate 侧三步

1. **apply 期**：`bg.restoreSync(cfg.auditPath)` 同步扫**自己链**的尾部（64 KiB，见诚实清单 #17）
   重建放行表；启动日志会打出 `break-glass=已恢复 N 条放行 / 无放行`，**一眼可辨**。
2. **运行时**：`ctx.on('fde/break-glass', …)` —— 收到 open 就 `bg.update(payload)` 并把同一对
   字段写进自己的链；收到 `resolved:true` 就标补正 + 写 `break-glass-resolved`。
   监听器**整段 try/catch**：同步抛错会冒泡给广播方，那会把一次成功的砸玻璃变成工具调用失败。
3. **判定时**：`guard.js::evaluate()` 先跑纯规则（`evaluateRules`），**得当 `deny` 之后**
   才问 `bg.isBypassed(denyId)`。放行 ⇒ 返回 `{deny: undefined, bypassed}`；否则原样返回。

### 哪些 deny-id 可绕：钉在**消费侧**，不依赖"表里恰好没有"

`BYPASSABLE_DENY_IDS`（`lib/deny-ids.js`）= `D1 / D2 / D3 / D5 / GATE-CLASSIFY / GATE-PATH`。
短路发生在 **`lib/bg-mirror.js::isBypassed()` 的第一行**：

```js
if (!BYPASSABLE_DENY_IDS.includes(denyId)) return false
```

⚠️ **这一行是补上去的，不是一开始就有**。原先 `isBypassed` 只查表内容、**从不检查 id 是否可绕**，
而 `fde-break-glass` 的 `enum` 只是**工具面**的一道闸 —— 两者之间隔着 `break-glass.json`
这个**可被手改的文件**和一次 JSON 解析。实测把 `GATE-PTC` 硬塞进表（跳过 enum）就能绕过它。
现在"哪些 id 可绕"这个事实**只有一份**、且位于两个插件都拿到的共享模块里。
（教训写在这里：注释里写下的机制，要么当场在代码里指出它在哪一行，要么别写 ——
本插件的 `guard.js` 曾经写过一句"双保险"，而那个保险当时并不存在。）

`GATE-PTC` **永不被放行**：它不是"门禁判错了"，而是一个**部署级通道开关**（`cfg.denyRunCode`）；
要开这个通道应当改配置，而不是砸玻璃 —— 否则等于把"关掉 PTC 策略"伪装成一次紧急绕过。

### guard 的单调性没有被破坏

放行发生在**规则求值之后、返回 `deny` 之前**。一旦真返回了 `deny`，仍然没有任何下游监听器
能翻盘。这是有意的：逃生门只能开在**门禁自己的判定里**，不能变成一个"谁都能挂上去翻案"的后门。

### 留痕

每次**真的因为放行而没被拦**的调用，`tools/pre-execute` 会写一条 `type:'break-glass-bypass'`
（带 `denyId` / `tool` / `paths` / `callId`）。`callAllowed` 如实写：shadow 模式下这条路本来
就不拦 ⇒ 那次"放行"并没有改变结果，但它仍要记 —— 它证明**存在一条开着的高危放行**，正是 E5 指标要看的东西。
（`break-glass` 的**开**与**补正**不在这里写：那是 phase 的事，两边都写会让同一件事被记两次、指标重复计数。）

---

## 变更记录

### 2026-09-29：指标采集（E5，spec v3 §14）

| 文件 | 动作 |
|---|---|
| `lib/metrics.js` | **新增**（约 900 行）：六个纯函数 + 薄 IO + 报告格式化。指标 ⑥ **转调** `shadow-stats.js`，不重算 |
| `lib/metrics-tools.js` | **新增**：`fde_metrics` 工具（只读 + 入链，输出 schema 里数值一律 `string`） |
| `lib/config.js` | `phaseAuditPath`（默认 `''`，**不 fail-closed**，理由见 §指标采集） |
| `lib/index.js` | 挂载指标工具 + 启动日志打印生效的 `phaseAuditPath` |
| `lib/pre-execute.js` | **修真缺陷**：deny 记录补 `denyId`，并返回 `evaluate()` 的 `denyId`。① 的强配对依赖它（历史行仍是旧形态，见诚实清单 #22） |
| `cordis.patch.yml` | gate 配置块补 `phaseAuditPath`，与 phase 的 `auditPath` **指同一文件**（跨插件不 import，两处字面量） |

§14 六项指标此前**零实现**（仅 ⑥ 的影子准确率由 E4 的 `shadow-stats.js` 提供，见下）。
本批首次落地全部六项 + 六条推翻条件。红线：**分母 0 报 `insufficient-data`，绝不报 0%**
（`0 < 30%` 当场为真 ⇒ 一条从未被观测的指标会直接触发推翻结论）。

证据（离线四层）：`tests/_fde_e5_test.mjs` **62/62 EXIT=0** ｜ `tests/_fde_e5_mut.mjs` **红 20 / 绿 0 / 无效 0**
（首轮 17/2/1，含一条崩溃型无效变异 + 两条等价变异，均已重做）｜ `tests/_deploy_diff.mjs` **20 文件 ALL_MATCH**
｜ `tests/_run_all_tests.sh` **41 套件 ALL-TESTS-GREEN**。⏳ 第五层（活体逐名 diff + 实调）**待重启后验**。

**2026-09-29 第五层活验（重启后）** —— 三项全过 + 一项修：
- ① `tools/_alive.mjs`：四个 FDE 插件 `fiberPhase:"active"`、`enabled:true`、153 条目、非 active 0 个。
- ② `tools/_e5_header_diff.mjs` **PASS**：重启前 40 工具 → 重启后 45；🔻消失 **0**；🔺新增恰为
  `fde-break-glass` / `fde_experiment_{write,read,list}` / `fde_metrics`；算术 40+5-0=45 ✓。
- ③ 模型实调 `fde_metrics` → `ok`，真链**零污染**（22 → 23 行，新增恰 1 行 allow）。
- 🔴 **④ 第五层抓出一个真缺陷并已修**：`phase-dwell` 报 `insufficient-data` 是**对的**
  （离线复算 11 处"推进不连续"逐条吻合：`11≠6` / `7≠4` / `5≠6` …，确无一对落在 Phase 1–4），
  但 `buckets.inProgress` 把**链上推断**说成了**当前事实**（链尾 Phase 3，而 `state.yaml` 是 Phase 10）。
  修法 = 改名 `chainTail` + note 写明权威是 `state.yaml`（见诚实清单 #29）。该修复**离线**验证：
  `tests/_fde_e5_test.mjs` **63/63 EXIT=0**（新增 F5b）｜ `tests/_fde_e5_mut.mjs` **红 22 / 绿 0 / 无效 0**（新增 M21/M22）。
  ⚠️ **`chainTail` 这个新名字本身尚未在活体上跑过** —— 重启时装的是改名前的副本，活体返回的仍是 `inProgress`
  （值与逻辑完全相同，只差字段名）。

### 2026-09-29：探索沙箱豁免（E2，spec v3 §7）

**改动面**（四个文件 + 一份部署配置）：
`lib/paths.js` 新增 `assertSandboxSubdirs` / `sandboxPathsOf` / `assertSandboxNotInOtherRoots`，
`formatProtectedRootsLine` 追加沙箱段；`lib/config.js` 新增 schema 字段
`sandboxSubdirs: z.array(z.string()).default([])`，`normalizeConfig` 里按
`assertProtectedExtraRoots` → ontologyRoot 校验 → `assertSandboxSubdirs` → `assertSandboxNotInOtherRoots`
的顺序调（**顺序有理由**：`ontologyRoot` 为空时 `protectedRootsOf` 会跳过它 ⇒
保护根集合残缺 ⇒ 后面那条"沙箱压在别的保护根上"的判定会漏判）；
`lib/guard.js` 的路径兜底加一层 `!sandboxes.some(...)` 过滤；
`cordis.patch.yml` 的 gate 条目填 `sandboxSubdirs: ['experiments']`。

**语义判定的面一字未动**：`fde_ontology_write` 的 source / confidence / 越界检查、
三个 deny 站点、break-glass 放行表全部照旧 —— 沙箱只豁免 guard 的**路径兜底**那一段。
`pre-execute.js` **没有改**（`import { evaluate } from './guard.js'` ⇒ 自动继承）。

**证据**：`tests/_fde_e2_test.mjs` **41 断言 / 通过 41 / 失败 0 / EXIT=0**；
`tests/_fde_e2_mut.mjs` **红 10 / 绿 0 / 无效 0**，每条变异 exit=1、收尾 sha256 逐字还原（PASS）。
变异目标是**工作区源码**（测试 import 的就是它），覆盖：派生源换 `ontologyRoot`、
删 guard 沙箱过滤、放开单段校验、短路"压在别的保护根"检查、不拒 `..` 段、
不查符号链接、沙箱写入落审计、打印不显示沙箱、删 `normalizeConfig` 里的校验调用、
去掉大小上限。

**⚠️ 离线套件的一个代价（补丁过，不是绕过）**：`tests/_fde_e2_test.mjs` **不 import `lib/config.js`**
（它 import `@deepseek-ai/schemastery`，离线工作区无该桩 ⇒ 整个模块加载失败、报告零产出）。
代价由 F3（grep 确认 `normalizeConfig` 真调了两个校验，M9 可证伪）+ F4（断言手写 cfg
覆盖 `guard.js`/`paths.js` 读到的每个 `cfg.*`）补 —— 详见「探索沙箱豁免」节末。

**新增诚实条目**：上表 #21（`GENERIC_PATH_KEYS` 不含 `name`，既有缺口）。

### 2026-09-29：break-glass 逃生门（E1，spec v3 §11）

**gate 侧只消费**：新增 `lib/deny-ids.js` 与 `lib/bg-mirror.js`（**逐字照抄** `dsh-fde-phase`
的同名文件 —— 跨包不能 import，一致性由 `tests/_fde_e1_crosspkg_test.mjs` 用 sha256 逐字对拍）；
`lib/audit.js` 导出 `TAIL_BYTES`（让两边同源，不再有第三份魔数拷贝）；`lib/guard.js` 拆出
`evaluateRules`（纯规则）与 `evaluate`（规则 + 放行表），三个 deny 站点补上 `denyId`；
`lib/pre-execute.js` 加 `break-glass-bypass` 留痕；`lib/index.js` 装配 `restoreSync` +
`fde/break-glass` 监听 + 启动日志。

🔴 **实现期间抓出的真缺陷**：`isBypassed` 原先只查表内容，硬塞 `GATE-PTC` 即可绕过（见上节）。
已修（消费侧短路），并新增直接断言覆盖 `GATE-PTC` / `RULE-JUMP` / `RULE-LAST` / `RULE-OBSERVATION` / `D9` / 空串。

四层验证：离线 `tests/_fde_e1_test.mjs` 62/62、跨包对拍 `tests/_fde_e1_crosspkg_test.mjs` 7/7、
变异 `tools/_fde_e1_mut.mjs` **20 条全被抓**（RED 20 / GREEN 0 / INVALID 0）、
接线 `tests/_fde_e1_wiring_test.mjs` 19/19（**import 部署副本**，覆盖"重启后从自己链恢复出放行"
这条端到端主张，并由 `tools/_fde_e1_wiring_mut.mjs` 的 6 条变异逐条证明会红）。
诚实缺口见上方表 **#17–#20**。

### 2026-09-29：影子模式与 enforce 准入门（E4，spec v3 §12/§14）

新增 `lib/shadow-stats.js`（纯函数：链解析分档、统计、裁决、凭据判定）、`lib/shadow-tools.js`
（两个工具）、`lib/approval.js`（**照抄** `dsh-fde-phase/lib/approval.js` —— 跨包不 import，
三份副本语义必须一致）；`lib/config.js` 加 `maxConfirmPerCall`（默认 50，**拍脑袋值**，
只为避免真实链上几百条时一次弹几百个窗）；`lib/index.js` 加 apply 期 unattested 曝光
+ 注册两个工具；`lib/pre-execute.js` 修正 §12/§14 **口径串台**的注释。

四层验证：离线 40/40 + 46/46、变异 **20 条全被抓**（RED 20 / GREEN 0 / INVALID 0）、
真 SDK 活验 12/12（含"缺 `additionalProperties` ⇒ 真 SDK 必须抛"的**负向对照**，
证明"构造成功"不是"校验不存在"）。诚实缺口见上方表 #12–#16。

⚠️ **活验覆盖到哪**：真数据上验的是**拒绝**路径（真链 `shadow-deny` 0 条 ⇒
`SHADOW_NO_SAMPLES`，且**弹窗 0 次**、真链 SHA-256 前后未变）；**批准**路径验在合成的
达标链上（7 条跨 8 天、准确率 85.7%）。**"真环境批准一次"没做，也不该做** ——
那会把真实门禁拧到 enforce。

### 2026-09-28：变更分级（C1，spec v3 §4）

新增 `lib/classify.js`（`classifyChange` / `resolveManualLevel` / `isRegulatedIndustry`）与
`lib/ontology-parse.js`（照抄 dsl 的 YAML 子集解析器 + 轻量结构提取，fail-closed）；`config.js` 加
`industry` 字段；`tools.js` 的 `fde_ontology_write` 读旧内容做 diff、自动判级、手动只能升级不能降级
（降级拒绝 `LEVEL_DOWNGRADE_DENIED`）、审计带 `level/added/modified/deleted`。
离线回归 `tests/_fde_classify_test.mjs` **16/16** + `tests/_fde_classify_exec_test.mjs` **3/3**，两套件 `FDE_INVERT=1` 均 exit 1。
活验（2026-09-28 重启后）：4 个 fde 插件 `fiberPhase:active`、`failed 0`；`fde_ontology_write` 的
`parameters` 已带 `level`（enum L0/L1/L2）。端到端验「降级拒绝」：真实调用传 `level:L0` 写 deny 规则
→ 自动判 L2（本部署 `logic.yaml` 有残留规则，删除触临床，语义正确）→ 拒绝
（`tool/result.isError=true` +「拒绝降级」+ 自动级别）→ 文件未落盘 → 审计 `decision:deny` 带
`level:L0`/`autoLevel:L2`，哈希链完整衔接。
⚠️ 诚实边界：「干净新增 deny → L1」与「升级放行落盘」**未活体复现**（前者被残留规则干扰、后者仅离线
集成测试覆盖），由离线 16/16 + 3/3 钉住这两支。

### 2026-09-27：拒绝文案的**读写口径**对齐判定（0025 P0-9）

**缺陷**：三类区域的 `note` 一律写「**直写**」，而第 ③ 段**按路径判定、读也拦**
⇒ 模型 `read` 撞上时读到的是"我只是读，为什么在讲写"。活体实证（0025 §1）：
`gate.jsonl seq 9/10/11` 三个动作**全是 `read`**，旧文案分别在讲
「不接受任何直写，也没有专用工具通道」/「审计链目录不接受任何直写」/「**直写**绕过了入口的语义判定」。

**这不是文档笔误，是会让模型建立错误认知的控制反馈**：拒绝理由与动作不符，
模型有理由推断"读应该是允许的"，从而再试一次 —— 而"再试一次"在本设计中**仍被拒**，
于是它学到的是"这条理由不可信"。

**修法**（与 P0-8 同一处，`PROTECTED_KINDS` 表）：三类各说各的，口径统一覆盖读与写 ——

- `ontology`：有专用通道 ⇒ 「读与写**都得走** `fde_ontology_read` / `fde_ontology_write`」；
- `audit` / `extra`：无任何通道 ⇒ 「不接受任何直接读与写」，且 `audit` 明说"**读取同样被拒**（守卫对读写不作区分）"；
- `extra` 依旧**不提** `fde_ontology_*`（否定句式也会诱导模型去试）。

**回归**：`tests/_gate_audit_guard_test.mjs` E 组新增 14 条（改前 **58 通过 / 7 失败** ⇒ 改后 **65 / 0**），
其中三条用 `read` 形状的 exec（`KNOWN_PATH_KEYS.read = ['file_path']`）断言理由
**不含「直写」**且**含「读」**；另有一条前提断言（"read 确实被拒"）——
它先红了一次，暴露的正是我第一版夹具把参数键写成 `path` 导致的**空过**风险。

### 2026-09-27：拒绝文案按**命中的受保护区域**生成（0024 P0-8）

**缺陷**：第 ③ 段的拒绝文案是**写死**的一句话 —— 无论命中哪个根，都把
「ontology 只能通过 `fde_ontology_read` / `fde_ontology_write` 访问；审计链目录不接受任何直写」
**两句全说一遍**。活体实测（0024 §5.1）：写 `fde-state` 被拒时，理由通篇在讲审计链目录，
而这个目录既不是 ontology 也不是审计链目录 ⇒ 模型拿到后建立错误的心理模型。
**安全控制的拒绝理由不准，等于告诉操作者"别信这条理由"。**

1. **`lib/paths.js`**：`protectedRootsOf(cfg)` 的返回由**裸字符串**改为
   **`{root, kind, label, note}` 条目**，label / note 取自同处新增的 `PROTECTED_KINDS` 表
   ⇒ root / label / note **同出自一个函数**，"打印的叫法 ≠ 拒绝的叫法"这个分叉在结构上不可能发生。
   新增 `formatProtectedRootsLine(cfg)`：启动打印整行由它产出。
2. **`lib/guard.js`**：文案改为 `目标路径命中受保护区域（<label>）：<path>。<note>`，
   `<label> / <note>` 取**命中那一条**（重叠时按 ontology → 审计 → 扩展 的优先序）。
3. **`lib/index.js`**：启动打印改调 `formatProtectedRootsLine()` —— 这正是 0024 §6 那条
   "打印对不对没人验过"的处置：**提成可离线断言的函数**，而不是一句 `join(' | ')`。
4. ⚠️ `extra` 的 note **刻意不提** `fde_ontology_*` 的名字（哪怕是否定句式）—— 写出来会让模型去试。
5. 回归：`tests/_gate_audit_guard_test.mjs` 新增 D 组 16 条（**改前 38 通过 / 13 失败**，改后 **51/0**）。
   其中两条是**反向**断言：命中 ontology 时理由**不得**出现"审计链目录"、命中审计目录时
   **不得**出现 `fde_ontology_read`（改前两条都红 ⇒ 证明确有"串台"）。

### 2026-09-27：`tools/_probe_yaml_anchor.mjs` 提升为**部署前 smoke check**（0024 P1-6）

退出码敏感（`0` 通过 / `1` 失败），**部署前跑一次**：

```bash
node tools/_probe_yaml_anchor.mjs
```

检查四项：① 用 DSH 自家的 `js-yaml` + `JSON_SCHEMA.extend(!!js)` 解析得通；② gate 条目在
phase 条目**之前**（锚必须在别名之前，否则 boot 抛 `unidentified alias`）；③ 锚点真同源
（`protectedExtraRoots[0] === projectRoot`）；④ 落点存在（`<projectRoot>/memory/state.yaml`
是真文件 ⇒ 专防"锚点挂错一层"那种**静默错位**）。
**自带可证伪**：末尾对三个合成样本断言预期结果（正确样本通过 / 反序样本失败 / 错位样本失败）；
检查器若对坏样本也说 OK，**脚本自己判红**。

⇒ 把 `cordis.patch.yml` 的顺序约束从"boot 期的响亮失败"提前成"部署期的响亮失败"。

### 2026-09-26：受保护集配置化 + 启动打印 + 编号带链名（0023 P0-4a / P0-6 / P1-3~P1-5）

1. **`lib/paths.js`**（新增两个导出）：`protectedRootsOf(cfg)` = 受保护集的**唯一定义处**
   （`ontologyRoot` + `dirname(auditPath)` + `...protectedExtraRoots`，空串跳过、按 canonicalize
   后的键去重）；`assertProtectedExtraRoots()` = 加载期 fail-closed 校验。
2. **`lib/guard.js`**：第 ③ 段改为调用 `protectedRootsOf(cfg)`（不再各写一份 ⇒ 判定与打印不可能漂移）。
3. **`lib/config.js`**：新增 `protectedExtraRoots: z.array(z.string()).default([])`，
   `normalizeConfig()` 里调 `assertProtectedExtraRoots()`（配错 ⇒ 加载失败）。
4. **`lib/index.js`**（P0-6）：启动期打印**生效的**受保护根列表（shadow 下附带"不拦"警示）
   ⇒ 配置漂移**可见**而非静默。
5. **`lib/pre-execute.js`**：`（审计 #N）` → `（gate 审计 #N）`；phase 侧同步改为 `（phase 审计 #N）`。
6. 回归：`tests/_gate_audit_guard_test.mjs` 新增 C 组 13 条（**改前 27 通过 / 7 失败**，改后 **34/0**）；
   全矩阵仍 **16 套件 × 2 轮全过**。
7. ⚠️ 未完成面：`protectedExtraRoots` **需要活体配置填值才生效**（见"配置即生效面"）。

### 2026-09-26：审计目录进保护根 + 写侧越界留痕（0022 施工单 P0-1 / P0-2）

1. **`lib/guard.js` 第 ③ 段**：受保护集 `ontologyRoot` → `[ontologyRoot, dirname(auditPath)]`
   （`auditPath` 为空串时跳过 —— 防 `dirname('') === '.'` 变成死门禁）；拒绝文案改为"受保护目录"
   并点明"审计链目录不接受任何直写"。**shadow 下仍不拦**（与 ontologyRoot 那段同口径）。
2. **`lib/tools.js`**：新增导出 `WRITE_PROBE = 'write-probe'`，`fde_ontology_write` 按读侧
   （`:109-128`）的 `probe` 范式补写侧留痕 —— `resolveWithinOntology()` 抛错时**先落痕再抛原错**，
   判定语义与错误文案**一字不改**。此前越界写**零留痕**（`audit.record` 排在写文件之后，
   抛错就中断），而"留痕即失效"是本项目自己的口径。
3. 回归：`tests/_gate_audit_guard_test.mjs`（新增，21 条；改前 14 通过/**7 失败**，改后 21/0）。
4. 顺带修一个**既有**缺口：`tests/_gate_mode_test.mjs` 此前**不响应** `FDE_INVERT`（INVERT 轮它 exit=0）
   ⇒ 它绿了不可证伪。已补钩子。全矩阵现为 **16/16 两轮全过**。

### 2026-09-26：重算审计链时，`record` 里**不含** `prevHash` / `hash`（易错点，已有人踩）

`linkHash` 的输入是"去掉 `hash` **和** `prevHash` 之后的记录体"（`audit.js:34` 注释：两者在写入时才计算）。
写反的代价是**全链 0/N 不符**，症状酷似"链被篡改"：

```js
const { hash, prevHash, ...record } = e          // ✅ 正确
sha256(prevHash + '\n' + JSON.stringify(record))

const { hash, ...rest } = e                       // ❌ 错误（把 prevHash 也算进去）
sha256(rest.prevHash + '\n' + JSON.stringify(rest))
```

两种解构只差一个字段。给任何"重算审计链"的脚本/文档都写上这一条。

### 2026-09-26：`lib/audit.js` 三处硬化（对齐 `dsh-fde-phase`）

**只动 `lib/audit.js` 这一个文件** —— 未碰 `guard.js`、未碰任何 decision 语义、未碰判定路径。

| # | 改动 | 修的是什么 |
|---|---|---|
| ① | `#degraded` 排队闸（`record()` / `flush()`） | 交错落盘失败 ⇒ 磁盘 `A → C`，`C.prevHash` 悬空（假断链）；`flush()` 后还变成 `A, C, B` 顺序颠倒 |
| ② | `record()` 剥除调用方注入的 `seq` | `{ seq: ++n, ...entry }` 的展开顺序让 `entry.seq` 覆盖自动编号 ⇒ 记录缺 seq ⇒ 重启跳过末行 ⇒ 真分叉 |
| ③ | 恢复分两遍取（head 只认 hash；seq 取窗口 max） | 原单遍要求 `seq` 为整数 ⇒ 末行缺 seq 时跳过它 ⇒ 两条记录**同父**（真分叉） |

① 是 `dsh-fde-phase` 2026-09-26 补丁 3 的移植；②③ 是 P2-3 / P1-1 的补移植 ——
**两个插件的 `audit.js` 同源但已经分叉**，这是把它们重新对齐的一步（有意保留的差异见「诚实清单」#9 后的对照表）。

**为什么没做活验**：三项都只在**失败路径**或**老格式输入**上有差异，正常路径零行为差异
（`tests/_audit_chain_test.mjs` 的四条场景改动前后全绿即为证）。按第四批起的纪律，正常路径无差异 ⇒ 不开窗口。

**证据**：新增 `tests/_audit_gate_test.mjs`，**改前正向 7 条全红（7 通/7 红）→ 改后 14/0**；
`FDE_INVERT=1` exit 1；反向 5 条（§4）改前就绿 = 防改过头的护栏。
12 套全套矩阵部署前后均 `normal=0 / invert=1`。

### 2026-09-24：读探测落审计（新增决策类别 `read-probe`）

**此前**：`fde_ontology_read` 在**读不到**的时候（路径越界 / 文件不存在 / 指向目录）直接抛错、
审计链**一行不记** —— 模型可以逐个猜文件名、靠报错与否判断存在性，全程无痕。
硬证据：审计文件 mtime 停在 `15:22:21.262`，那三次探测发生在 `15:22:22.604/615/622`，文件零字节变化。
只要有一类访问不落链，"完整访问史"这个说法就不成立（本项目口径：留痕即失效）。

**现在**：这三条路径各落一条 `decision: read-probe`，`code` 分别为
`OutOfOntology` / `ENOENT` / `EISDIR`。**记而不拦** —— 抛错的错误类型、文案，
以及 allow/deny 的结论**一字未改**，改的只是可见性。

为什么不写成 `deny`：它**没拦任何东西**（当初本来就直接抛错返回了）。
写成 deny 会把"模型自己失败的探测"记成"门禁的拦截"，污染 enforcer 语义 —— 它是**访问史**，不是判定。

**证据**：新增回归 `tests/_gate_readprobe_test.mjs`（15/15 全绿），既验留痕，也验"判定语义没被改动"
（错误类型 / 文案 / allow 计数都不变），并验哈希链仍连续、`read-probe` 不冒充 deny。

✅ **已上线并活验通过（2026-09-24 18:25 重启后，PID 17172）**：一句自然请求触发模型探 6 个文件名 →
6 条 `read-probe`（#38/39/40/42/43/44，`code=ENOENT`）一一对应；期间 `glob E:\ontologyRoot` 是 **#41 真 deny**，
与 `read-probe` 分得开。改动前这些探测**审计无痕**，现全部在案。详见 dsl README §10.2。

### 2026-09-24：`fde_ontology_read` 的 description 补上可用文件名（消掉盲探）

**现象（活验实测）**：失败项指向的文件能一次命中（模型直接读 `objects.yaml`，reason 明写"校验报错指向 objects.yaml"），
但**没被指向的文件仍然靠猜** —— 一次会话里错猜 7 个名字（`rules.yaml` / `rules.yml` / `ontology.yaml` /
`rules.json` / `README.md` / `ontology/objects.yaml` …）+ 1 次 `glob` 被拒，
最后**靠 grep 我们自己的插件源码**（`dsh-fde-dsl/lib/validate.js` 里的 `const FILE = {...}`）才拿到 `logic.yaml`，
**隔了 1173 个 seq**。

**改法（一行）**：description 补上
`可用文件名：objects.yaml（对象与属性声明）、logic.yaml（规则表）、maturity.yaml（成熟度覆盖，可选，可能不存在）。`

**为什么这不违反"不泄漏"**：这三个名字是 dsl README §2 已公开的约定，红线是"不回显**内容**"，名字不在红线内。
🔑 更根本的一条：**写在插件实现里的字符串不是秘密** —— gate 拦得住 `glob E:\ontologyRoot`，
拦不住模型 grep 插件目录（也不该拦）。隐藏只会逼模型绕更远的路，不如直接给。
这也与 dsl README §10.1"文件名可以给"同源。

⚠️ **仍需一次重启**（`lib/tools.js`）。已同步安装副本（11/11 MATCH）、离线回归全绿。
