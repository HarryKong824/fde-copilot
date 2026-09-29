# 变更记录 · FDE Copilot

> 格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
>
> ⚠️ **本项目的版本实践与常规不同**，读之前请先看下面这段。

---

## ⚠️ 关于本项目的版本号

| 事实 | 说明 |
|---|---|
| 四个插件版本号 | **全部停在 `0.0.1`**，开发期间**从未升过** |
| 开发周期 | **7 天**（2026-09-23 — 09-29），期间 **35 次改动** |
| **开发期间没有用 git** | 无 commit 历史、无 tag（**2026-09-29 交付时已补上**，见下方「交付后补做」）<br>**交付仓库已是 git 仓库，并已打 `v0.0.1` 标签 + Release** |
| 实际用的版本手段 | `_snapshots/<日期>-before/` **手工快照**（35 项） |

**⇒ 本文的版本分组是「按开发阶段」划分的**，标识（如 `Stage 5`）**来自 `_inbox/` 的交接文档**，
**不是磁盘上的 tag**。详见 [版本管理记录](docs/02-development/releases.md)。

> 📌 **建议的下一步**：给四个插件从 `0.0.1` 起正式编号，每次改动 bump patch。

---

## [未发布]

### 计划中（详见 [后续迭代规划](docs/04-retrospective/roadmap.md)）

**P0**
- ~~把项目纳入 git~~ ✅ **已完成**（2026-09-29，见下方「交付后补做」）
- ~~建立成本台账~~ ✅ **已完成**（2026-09-29，实测 Token 数据见[成本与资源统计](docs/04-retrospective/cost-resources.md)）
- 清理「已解除但没人改」的记录（stale red）
- 补齐 4 项未验完的功能验证

**P1**
- D1 的 `impl` 升级为受控的**真可执行函数**（当前是 DSL 表达式）
- D4 完整实现（需外置远端通道）
- 审计外置 L2
- C2 各级流程
- restrict 第二批（两个时序问题需先探明）

**P2**
- 统一三份审计链的 schema
- 消除「一物两名 / 一名两物」
- 修 `_replay_phase_audit.mjs` 的崩溃零输出
- 恒真判据全仓排查 + 检查器自检

---

## [交付后补做] — 2026-09-29

> 交付之后的复核发现的问题及修复。**每一项都写明了「怎么发现的」**——
> 本项目的规矩是：结论要指着一个能被别人独立复算的事实。

### 修复（🔴 会影响使用者的）

| # | 问题 | 怎么发现的 | 修复 |
|---|---|---|---|
| 1 | **GitHub 把许可证识别成 "Other" 而非 MIT** | `gh api` 读回 `spdx_id: NOASSERTION` | `LICENSE` 只留规范 MIT 正文；四项披露移到新增的 `DISCLOSURE.md` |
| 2 | **报漏洞的两条渠道都是死的**（私密报告未开启；备用渠道指向不存在的"仓库联系方式"） | `private-vulnerability-reporting.enabled === false` | 已开启该功能；备用渠道改为「开一个不含细节的公开 Issue」 |
| 3 | **9 套回归写死作者本机绝对路径**，别人克隆下来必挂 | 在隔离目录下跑，9 套 `EXIT=1` | 改为从脚本自身位置推导；**变异验证**：改名插件目录 ⇒ 套件报 `ERR_MODULE_NOT_FOUND`，证明它读的确实是自己那份 |
| 4 | **成本文档 10 处 `【待补充】`** —— 用户明确要求的 Token 费用没有内容 | grep 全仓 | 从会话记录实测汇总，见[成本与资源统计](docs/04-retrospective/cost-resources.md)；附带可复算工具 `_token_usage_report.mjs` |
| 5 | **41 套回归不是跨平台的**（Ubuntu 上挂 9 套） | 新加的 CI 第一次跑就红了 —— **幸好没先写成"应该会绿"** | CI 固定在 `windows-latest`（项目真正验证过的平台）；**没有**改成"Linux 失败也算通过"（那是假绿）。平台边界已写进 README |
| 6 | **41 套回归在 Node 20 上跑不了**（挂 2 套：`zlib` **没有** `zstdDecompressSync`） | 上一条改成 `windows-latest` 后**仍然红**，追下去才是这个 | `engines` 由 `>=20` 改为 **`>=22.15`**（实测：20.20.2 无该导出 / 22.15.0 有）；CI 改跑 `22.15.0` 与 `24` 两档 |
| 7 | **4 套被算进「41 套离线回归」，其实根本不是离线的**（要读本机**已部署**的 DSH：`E:/DSH-desktop/...`） | 同上：CI 上这 4 套全挂，而开发机 E: 盘在 ⇒ 一直没暴露 | 改为「没有那份部署就**明确跳过并报条数**」（`exit 77`）；汇总行固定报出「跳过 N」；**CI 额外断言「跳过数 == 4」**，让"跳过"不能变成吞红灯的出口 |
| 8 | **`npm test` 永远报成功** —— `_run_all_tests.sh` 只 `echo` 不 `exit`，退出码恒为 0 | 读脚本时发现：**判定行**与**退出码**不同源 | 判定与退出码改为同源（`0` 通过 / `1` 有失败）。这正是本项目一直在抓的"仪器自己撒谎"那一类 |
| 9 | `_fde_memory_decisions_test.mjs` 的**子脚本** `_a2_inject_fail.mjs` 写死作者本机路径 | CI 上该套件 §6.7 判红 | 改为从脚本自身位置推导（与前面那 9 套同一种修法） |
| 10 | **文档承诺的 `node _deploy_diff.mjs` 根本不能用** —— 脚本只支持双参数形态，不传参数就打印「用法」并 `exit 2` | 写出这条命令后**照着跑了一次**，当场看到 `用法: …` | 改为无参数即对拍**全部 4 个插件**（原双参数用法保留）。**8 处文档 + `npm run deploy:diff` 一次性变成真的**，而不是去改那 8 处 |
| 11 | `_paths_test.mjs` 的**跳过不进 RESULT 行** —— 本机 `pass=7`、CI `pass=8`，而「少跑 1 条」只印在上一行 | 比对本机与 CI 日志时发现两个数不一致，读源码才知有一支条件断言 | 把 `skip=N` 写进 `RESULT` 行本身；**"必须读上一行才能发现"等价于"在最小 grep 面下不存在"** |

### 新增

- **`DISCLOSURE.md`** —— 四项如实披露（从 `LICENSE` 拆出，理由是**机器可识别性**，不是条款变更）
- **`package.json`** —— 提供 `npm test` 入口（原先没有，别人不知道该怎么跑测试）
- **`.github/workflows/test.yml`** —— CI，每次推送自动跑那 41 套
- **`_token_usage_report.mjs`** —— Token 用量统计工具（可移植版，无本机路径）
- 仓库 topics（`ai-safety` / `guardrails` / `audit-trail` / `fail-closed` / `hash-chain` 等）
- **`v0.0.1` 标签 + [Release](https://github.com/HarryKong824/fde-copilot/releases/tag/v0.0.1)** —— 交付时补打了版本点，使「现场装的是哪一版」从此**有坐标可指**（此前只能靠 `_snapshots/` 的人工快照，见 [版本管理记录](docs/02-development/releases.md)）

### 文档更正

- `README.md` —— 新增「哪些脚本你能跑，哪些跑不了」小节（如实区分 41 套回归与 43 个活验仪器）
- `README.md` —— 环境要求补上「**跑回归需 Node ≥ 22.15**」（并注明插件 `lib/` 无此要求）；
  平台边界表补齐 `windows-latest` 那一行与**三条根因方向**（zstd / 部署依赖 / 子脚本路径）
- `README.md` —— 「41 套全绿」改为按**本机有无部署**两种口径分别写（有 ⇒ 41 跑；无 ⇒ 37 跑 + 4 跳过）
- `docs/README.md`、`data-licensing.md` —— 同步许可证拆分后的引用
- `CHANGELOG.md` —— 「开发期间没有用 git」的表述更正（交付时已纳入 git）

### ⚠️ 已知未修（**不是漏了，是修不了**）

- **40 个活验脚本仍含作者本机路径**（`C:/Users/DELL/...`）与 launch-token 文件位置。
  它们的行为**必须连着运行中的 DSH 才能验证**，而**无法验证的改动不允许进主干** ⇒ 保留并写进 README 告知。
- **9 套回归无法在 Linux 上跑**（路径语义 / shell 分词语义差异，见上表 #5）。
  它们是**功能测试**、不是可移植性测试；改成跨平台属于**重写判据**，不是修 bug ⇒ 列为下一步，不在本轮动。
- **有 4 套回归必须连着「本机已部署的 DSH」才能真跑**（见上表 #7）。
  在没有那份部署的机器上它们**明确跳过**、不判红 —— 这是**如实标注**，不是"已覆盖"。
  ⇒ 准确口径是：**CI 上真正跑的是 37 套，另有 4 套跳过**。该口径写在 README 与 CI 的判定步里。

---

## [0.0.1] — 2026-09-23 — 2026-09-29

> **PoC 阶段。** 19 项功能中 15 项活验完整、4 项部分完成、**0 项未实现**。

### 新增

#### M0 · 立项（09-23）
- 可行性分析

#### M1 · Stage 5：Phase 状态机（09-24）
- **新增插件 `dsh-fde-phase`** —— FDE 业务阶段概念 + 自建状态机
- `fde_phase_advance` 工具（推阶段的**唯一**入口）+ `guard` 钉在入口
- 15 个 Phase 的权威表 + `DENY_CHECKS` 门禁映射
- `state.yaml` 状态机 + **单写者锁**（强夺条件：`超时 && 持有进程已死`）
- D1 结论的**内存镜像**（事件驱动 + 重启后从审计尾部恢复）

#### M2 · Stage 5 第一批~第三批（09-25 — 09-27）
- **`ctx.tools.restrict` 工具面过滤**（受保护阶段隐藏 `pwsh` 等）
- restrict 审计链补齐 `replaced` / `restored` / `untracked` 三态
- trigger 沿调用链传递 + 吞错分级

#### M3 · Stage 5.5：D2/D3 接线（09-26）
- **D2** 审计链完整性校验（**含内容级 hash 重算**）
- **D3** 规则可信度校验（可反驳性、`DraftReference`）

#### M4 · Stage 5.6：D5 合规门禁（09-28）
- `check-d5.js` —— Phase 6 的合规边界检查
- D4 从 `deny` 降为 **`approval.ask`**

#### M5 · 记忆系统 v2（09-28）
- **新增插件 `dsh-fde-memory`**（第 4 个插件）
- decisions / checklist / stakeholders / notes / maturity
- **审计外置 L1**（`memory/audit/events.jsonl`）+ **凭据脱敏**
  - 键名匹配 `/(token|secret|password|credential|api[_-]?key|jwt|bearer|signature)/i`
  - 值样式匹配（bearer / sk- / JWT 三路）+ 深度上限

#### M6 · C 系列与 E1（09-28）
- **C1** 变更分级（L0/L1/L2，写入时自动判定）
- **C3** 回滚预授权（审批时同步记录 preauth）
- **E1** break-glass 逃生门（独立留痕 + **7 天补正期**）

#### M7 · 交付归档（09-29）
- **17 份交付文档**（5 大类）
- 仓库结构标准化（README / LICENSE / CHANGELOG / CONTRIBUTING / .gitignore）

---

### 修复

> **口径**：以下 **47 条**是 `_inbox/` 123 份交接文档中**被明确记录下来的**缺陷与错误。
> **完整版见** → [问题与 Bug 台账](docs/02-development/issue-log.md)

#### 🔴 A 级 · 真缺陷（12 条，摘录）

| 出处 | 缺陷 |
|---|---|
| `0006` | `replaced` 会抹掉 `appliedSeq` |
| `0010` | `audit.js` 的 `writable` 三元写反（`0o444 : 0o644`） |
| `0012` | gate 链 2 处 GENESIS 接缝 ⇒ **D2 活体永不过** |
| `0014` | **D2 判据② 只验 hash 格式、从不重算** ⇒ 内容可改仍判「完整」 |
| `0018` | preset `ptc` 遮蔽 `mode:native` ⇒ **fail-closed 变 fail-dead**（模型零工具） |
| `0022` | 三条路径（`phase.jsonl`/`state.yaml`/`.state.lock`）**全无守卫** |
| `0055` | `_replay_phase_audit.mjs` 遇坏 JSON **崩溃 + 零输出** ⇒ **报警能力为零** |
| `0066-A` | `industry:'未声明'` 不关闭 D5 ⇒ **Phase 6 推进必被拦死** |
| `0066-B` | `_fde_d5_test.mjs` 是 **0 字节空文件** ⇒ 测试从未跑过，产物却写「PASS 9 / FAIL 0」 |
| `0086` | `notes.js` 的 date 缺省用 **UTC 而非本机时区** |

#### 🟠 B 级 · 判据 / 方法错（18 条，摘录）

| 出处 | 错在哪 |
|---|---|
| 多次 | 重放报「3 处断链」——**按文件行序**重放 ⇒ 应按 `seq` 排序 |
| 多次 | 「工具总数变多了」——总数**本来就不是判据** |
| `0015` | 元错误：**「断言域 ≠ 验证域」** |
| `0026` | **自己的仪器对坏样本说 OK** |
| `0027` | **自己的 shell 命令骗了自己** |
| `0030` | `with` 方向把视窗 **fail-closed 丢了**（假绿） |
| `0050` | 🔴 **「逐名 diff」判据被实测证伪** ⇒ 改用「链事件 + 时间紧邻配对」 |
| `0052` | 归因是我补的 + 仪器命令下错（第 28 次） |

#### 🟡 C 级 · 记账 / 表述（17 条，摘录）

| 出处 | 问题 |
|---|---|
| `0023` | 认 `cfg.auditPath` 写错（**第 7 次同族失手**） |
| `0059` | README 挂着**已解除但没人改的红**（stale red） |
| `0062` | **README 源↔副本漂移** |

---

### 变更

> **口径**：以下 **16 条**。**完整版见** → [需求变更记录台账](docs/02-development/change-requests.md)

| # | 变更 |
|---|---|
| CR-01 | 🔴 **多 AI 协作 → 单 AI 独立**（09-28，用户拍板） |
| CR-02 | D4 从 `deny` 降为 `ask` |
| CR-03 | D4 本轮不做（需外置远端） |
| CR-04 | D1 的 `impl` 用 **DSL 表达式**而非真函数（⚠️ **PoC 降级**） |
| CR-05 | restrict 工具面过滤推迟到第二批 |
| CR-06 | 记忆系统 v2 **新建第 4 插件** |
| CR-07 | E1 break-glass 放 `dsh-fde-phase`，不新建插件 |
| CR-08 | 审计外置**只做 L1，L2 留接口** |
| CR-09 | confidence 提前到 A2 批 |
| CR-10 | C2 留后 |
| CR-11 | `from` 字段改指「最后一条 applied」，不链式 |
| CR-12 | 归档策略选方案 A |
| CR-13 | P0-4 选方案 X（YAML 锚点消重） |
| CR-14 | seed 做法变更（不需推进/重启/写 reason） |
| CR-15 | 🔴 判据变更：逐名 diff 降为辅助 |
| CR-16 | spec 假设的 `approval.ask` 签名是错的 |

---

### 已知问题（**未修，已记录**）

| 项 | 说明 |
|---|---|
| 三份审计链 schema 不统一 | gate 用 `type`/`tool`+`decision`/`event`；memory 用 **`kind`** |
| 一物两名 | 目录 `dsh-fde-ontology-gate` vs 注册名 `fde-ontology-gate` |
| 一名两物 | 「**D1**」既指 spec §3 护栏绑定，又指 §8 审计外置四层 |
| 4 项未验完 | 见 [功能对照表 §4](docs/01-overview/feature-matrix.md) |
| 无版本控制 | 见 [版本管理记录](docs/02-development/releases.md) |
| 无成本台账 | 见 [成本与资源统计](docs/04-retrospective/cost-resources.md) |

---

## 链接

- [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)
- [语义化版本](https://semver.org/lang/zh-CN/)
