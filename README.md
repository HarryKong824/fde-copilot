# FDE Copilot

> **给 AI 助手装上工程护栏的插件套件** —— 让 AI 在改业务规则、推进项目阶段时，**没通过校验就动不了**，
> 且所有动作都被记在一本**改不掉的账**上。

[![State](https://img.shields.io/badge/state-PoC%200.0.1-orange)](#项目状态)
[![Tests](https://img.shields.io/badge/regression-41%20suites%20green-brightgreen)](docs/03-usage/deployment.md)
[![Deps](https://img.shields.io/badge/runtime%20deps-zero-blue)](#零运行时依赖)
[![AI](https://img.shields.io/badge/code-100%25%20AI--generated-purple)](#-ai-生成声明)

---

## 这是什么

一套跑在 **DeepSeek Harness（DSH）** 上的插件，由四个互相协作的模块组成：

| 插件 | 管什么 |
|---|---|
| **`dsh-fde-ontology-gate`** | **谁**能在什么条件下改本体（业务规则） |
| **`dsh-fde-dsl`** | 改出来的**规则**能不能信（D3）+ **护栏**绑没绑好（D1） |
| **`dsh-fde-phase`** | 现在处在**哪个业务阶段**、能不能推进 |
| **`dsh-fde-memory`** | 决策、清单、干系人、笔记，以及**审计采集** |

**共注册 19 个工具**，全部通过 `ctx.tools.guard` 挂在宿主的工具调用链上。

---

## 为什么需要它

**「在提示词里提醒 AI 注意安全」是没用的——AI 可以不听。**

| 方式 | 能拦住吗 |
|---|---|
| 提示词提醒 AI | ❌ AI 可以不听 |
| **守卫（`ctx.tools.guard`）** | ✅ **同步、单调、只能否决**——返回拒绝后**无人能翻盘** |

这套系统提供的是**机制**，不是**建议**：

- **fail-closed**：判定不了「安全」时，一律判「不放行」；
- **哈希链审计**：改任何一条记录都会导致后续**全部哈希不符**；
- **结论绑定内容哈希**：改了文件 ⇒ 旧结论**自动失效**，杜绝「拿改动之前的结论蒙混过关」。

---

## 快速开始

### 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows（本项目在 Windows 11 上开发与验证） |
| Node.js | **插件运行**：与 DSH 宿主一致（四个插件的 `lib/` **不用** `node:zlib`，没有额外版本要求）<br>**跑回归**：**Node ≥ 22.15**（`package.json` 的 `engines`；实测依据见下节） |
| DeepSeek Harness | **桌面应用**形态（`DeepSeek Harness.exe`）**已安装** |

> ⚠️ DSH **不是命令行服务**，是 Electron 桌面应用 ⇒ 「启动/停止」= 打开/关闭应用，**没有 systemd 概念**。

### 跑一遍回归（**不需要 DSH**）

```bash
bash _run_all_tests.sh
#   期望最后两行（本机**没有**部署 DSH 时）：
#   共 41 个套件；已跑 37；跳过 4（白名单内，需本机部署的 DSH）；失败 0；疑似空程序 0
#   ALL-TESTS-GREEN
#   ⚠️ 「跳过 4」= 这 4 套要读你**本机已部署**的插件副本，没有那份部署就跑不了 —— 见下节。
#      本机**有**那份部署时是「已跑 41；跳过 0」。
#   退出码：0 = 通过；1 = 有失败（判定行与退出码同源，不会一个说绿一个说红）
```

### 部署插件

```bash
# 1. 复制 4 个插件目录到 DSH 的插件位置
cp -r dsh-fde-*  <DSH_HOME>/profiles/web/node_modules/

# 2. 编辑配置（这是配置的唯一权威）
#    <DSH_HOME>/profiles/web/cordis.patch.yml

# 3. 对拍源 ↔ 副本
node _deploy_diff.mjs      # 期望：ALL_MATCH

# 4. ⚠️ 重启 DSH —— 改了 lib/*.js 不重启等于没改
```

**完整步骤见** → [`docs/03-usage/deployment.md`](docs/03-usage/deployment.md)

---

## 零运行时依赖

```json
"dependencies": {}
```

四个插件的 `dependencies` **全部为空**。

| 意味着 | |
|---|---|
| ✅ 不向宿主引入任何依赖面 | ✅ 不联网、不上云、**数据 100% 留本机** |
| ✅ 不打包任何第三方代码 | ✅ 无第三方许可证义务 |

**peer 依赖**（由宿主 DSH 提供，本项目不打包）：

```
@deepseek-ai/dsh-tools    0.1.2-rc.1
@deepseek-ai/schemastery  3.18.2
```

> 连 YAML 解析都是**自研的受限子集**（`yamlsubset.js`）——代价是**行内集合必须写合法 JSON（双引号）**。

---

## 仓库结构

```
.
├── README.md                    ← 本文件
├── LICENSE                      ← 规范 MIT 正文（GitHub 可自动识别）
├── DISCLOSURE.md                ← 四项如实披露（AI 生成 / 领域敏感 / 第三方宿主 / 非专业意见）
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md                  ← 报漏洞的私密渠道 + 已知安全边界
├── CODE_OF_CONDUCT.md
├── package.json                 ← `npm test` 入口（= bash _run_all_tests.sh）
├── .gitignore                   ← ⚠️ node_modules 有反常规处理，改前先读
├── .gitattributes               ← ⚠️ 强制 LF；删了会让 .sh 在 Windows 上坏掉
├── .github/
│   ├── workflows/test.yml       ← CI：每次推送自动跑那 41 套
│   ├── ISSUE_TEMPLATE/bug_report.md
│   ├── ISSUE_TEMPLATE/feature_request.md
│   └── PULL_REQUEST_TEMPLATE.md
│
├── docs/                        ← 📚 17 份交付文档（从这里开始读）
│   ├── README.md                  导航中枢
│   ├── 01-overview/               项目说明书 · 功能对照表 · 技术架构
│   ├── 02-development/            开发日志 · 变更台账 · Bug台账 · 版本记录
│   ├── 03-usage/                  用户手册 · 部署运维 · FAQ
│   ├── 04-retrospective/          总结报告 · 成本统计 · 迭代规划
│   └── 05-ai-development/         AI工具清单 · Prompt库 · 代码风险 · 数据版权
│
├── dsh-fde-ontology-gate/       ← 插件 1（16 文件 / 4,797 行）
├── dsh-fde-dsl/                 ← 插件 2（12 文件 / 2,211 行）
├── dsh-fde-phase/               ← 插件 3（22 文件 / 5,528 行）
├── dsh-fde-memory/              ← 插件 4（21 文件 / 4,195 行）
│
├── _*_test.mjs                  ← 41 套离线回归
├── _*_live*.mjs                 ← 活体验证脚本（需 DSH 在跑）
├── _run_all_tests.sh            ← 全量回归入口
├── _fixtures/                   ← 回归夹具
└── node_modules/@deepseek-ai/   ← ⚠️ 测试桩，【必须保留】，见 .gitignore
```

> ✅ **本结构已被验证**：从本仓库**克隆到干净目录**（290 个文件），`bash _run_all_tests.sh` → **ALL-TESTS-GREEN**。
> 这证明 `.gitignore` 里的 node_modules 例外有效、LF 归一化不破坏夹具。
> （本机**有**部署时 41/41；干净机器上是 37 跑 + 4 跳过，见下节。）

> ⚠️ **脚本为什么不放进子目录**：它们用 `./dsh-fde-phase/lib/state.js` 这类**相对导入**，
> 移动会**直接破坏**已验证的 41 套回归。这是**不可移动的硬约束**，不是没整理。

### ⚠️ 哪些脚本你能跑，哪些跑不了

**请先读这段，否则会在不该失败的地方失败。**

| 类别 | 能否直接跑 | 说明 |
|---|---|---|
| `_*_test.mjs`（**41 套**） | ✅ **能** —— 限 **Windows** + **Node ≥ 22.15** | 路径从**脚本自身位置**推导，不含作者本机绝对路径。<br>2026-09-29 实测：换目录也能跑，且改坏插件会让对应套件**变红**（变异验证过）。 |
| ↳ 其中 **4 套** | ⚠️ **要本机已部署 DSH**，否则**明确跳过** | `_fde_e1_wiring_test.mjs`、`_fde_e2_test.mjs`、`_fde_e5_test.mjs`、`_fde_phase_wiring_test.mjs`。<br>它们要读你本机已部署的插件副本 / 部署配置 ⇒ **不是纯离线套件**。<br>没有那份部署时它们 `exit 77`（跳过），汇总行会报出「跳过 4」。<br>设 `FDE_DSH_HOME=<你的 dsh-home>` 即可让它们真跑。 |
| `_deploy_diff.mjs` | ✅ **能**（限 Windows，且**需本机有部署**） | **不传参数 = 对拍全部 4 个插件**（就是下面部署步骤里那条命令）。<br>本机没有那份部署时它会明确报 `SKIP` 并 `exit 77`，**不会**报 `ALL_MATCH`；设 `FDE_DSH_HOME=<你的 dsh-home>` 即可真跑。<br>也支持原用法 `node _deploy_diff.mjs <源目录> <副本目录>` 只对拍一对。<br>退出码：`0` 全一致 / `1` 有差异 / `77` 无部署可测（**不是**一致）。 |
| `_token_usage_report.mjs` | ✅ **能**（跨平台） | 纯统计工具，路径由命令行参数给。 |
| `_*_live*.mjs`、`_cc_*.mjs`、`_dsh_*.mjs` 等（**40 个**） | ❌ **不能开箱即跑** | 它们是**活验仪器**：① 需要 **DSH 正在运行**；② 里面写死了作者本机路径（`C:/Users/DELL/...`）与 launch-token 文件位置。<br>（口径：`grep -rl "Users/DELL"` 命中的**根目录脚本**共 40 个；另有 6 份文档在正文里提到该路径。） |

> 🔴 **两条边界 —— 都是 CI 实测出来的，不是猜的**
>
> **① 平台：这 41 套回归是 Windows 专用的。**
>
> | 平台（同一次提交） | 结果 |
> |---|---|
> | Windows 11（开发机） | ✅ 41 套全绿 |
> | `windows-latest`（GitHub 托管） | ✅ 全绿（修好下面②之后） |
> | `ubuntu-latest` | ❌ **41 套挂 9 套** |
>
> 从失败断言能看出两处根因方向：`_gate_mode_test.mjs` 的断言原文是
> 「**enforce 下路径命中应拒**」⇒ **路径语义**不同；`_shelltok_test.mjs` ⇒ **shell 分词语义**不同；
> 其余若干在导入期直接崩溃。
>
> **② Node 版本：不能低于 22.15。**
>
> | Node | 结果 |
> |---|---|
> | 20.20.2 | ❌ 挂 2 套：`zlib` **没有** `zstdDecompressSync` 这个导出 |
> | 22.15.0 | ✅ 有该导出（实测 `typeof === 'function'`） |
> | 24.15.0 | ✅ 全绿 |
>
> 用到 zstd 的是**读 DSH 会话记录**的那几个脚本（`_tool_surface_check.mjs` 等）——
> **插件 `lib/` 本身不用 zstd**，所以「跑插件」没有这个版本要求。
> 下界已写进 `package.json` 的 `engines`。
>
> ⇒ 所以 [CI](.github/workflows/test.yml) **固定在 `windows-latest`，Node 取 `22.15.0` 与 `24` 各跑一遍**。
> **没有**把它改成"Linux 上失败也算通过"、也**没有**把 Node 钉在 20 再放宽判据 —— 那都是假绿。
> CI 的判定步还额外核一件事：**跳过数必须正好是 4**（白名单一变就红），
> 这样「跳过」不会变成一个能吞掉红灯的出口。

> 🔴 **关于那 40 个活验脚本 —— 一个必须说清的事实**：
> 它们含作者本机路径这一点**已知未修**。原因不是没发现，而是**修不了**：
> 它们的行为**必须连着运行中的 DSH 才能验证**，而合并前无法验证的改动**不允许进主干**
> —— 这正是本项目自己的纪律（"判据必须可复算"）。
> ⇒ **要复用它们，请先按你的环境改路径，并自己验一遍。**

---

## 文档导航

**第一次接触这个项目？** 按这个顺序读：

| 顺序 | 文档 | 读它能知道 |
|---|---|---|
| 1 | [项目说明书](docs/01-overview/project-brief.md) | 这是什么、为谁做、核心价值 |
| 2 | [功能清单与对照表](docs/01-overview/feature-matrix.md) | **19 项功能的真实完成度**（含 4 项缺口） |
| 3 | [技术架构说明](docs/01-overview/architecture.md) | 架构、数据、19 个工具接口、技术债 |
| 4 | [用户操作手册](docs/03-usage/user-manual.md) | **不需要懂编程**——跟 AI 说一句话就行 |
| 5 | [常见问题 FAQ](docs/03-usage/faq.md) | 20+ 个**真实踩过的坑** |

**要接手维护？** 另加：

| 文档 | 为什么必读 |
|---|---|
| [部署运维手册](docs/03-usage/deployment.md) | 环境、部署、配置全表、排障 |
| [问题与 Bug 台账](docs/02-development/issue-log.md) | **47 条**已记录缺陷 + **6 条固定动作** |
| [AI 代码风险说明](docs/05-ai-development/ai-code-risks.md) | 🔴 **风险没有被消除，只是被压制** |
| [版本管理记录](docs/02-development/releases.md) | ⚠️ 本项目**没有用 git**，看它实际用了什么 |

---

## 🔴 AI 生成声明

**本仓库的源码、测试与文档全部由 AI 工具生成**，人类负责需求、决策与验收。

| 角色 | 承担者 |
|---|---|
| 需求 / 决策 / 验收 | **HarryKong824**（人类） |
| 主要实现 | **Claude Code** |
| 早期并行实现 | WorkBuddy（**2026-09-28 退出**） |
| 阶段性接力 | Trae |

**这带来一个无法消除的风险：AI 既是实现者，也是验证者。**

> 一个 AI 如果对某个机制有错误理解，它会**同时**把这个错误写进实现**和**测试里——
> 两边一致 ⇒ **测试全绿** ⇒ 错误被牢牢锁住。
>
> **⇒ 本项目的代码质量不能只用「41 套回归全绿」来论证。那 41 套也是 AI 写的。**

**压制手段**（不是消除）：判据必须落到**磁盘事实**（哈希 / `seq` / 退出码 / 字节数），
核证方**独立重算**，不看实现方的说明。

**完整说明** → [`docs/05-ai-development/ai-code-risks.md`](docs/05-ai-development/ai-code-risks.md)

---

## 项目状态

| 维度 | 状态 |
|---|---|
| 版本 | **0.0.1**（PoC 阶段） |
| 开发周期 | 2026-09-23 — 2026-09-29（**7 天**） |
| 功能完成度 | 19 项中 **15 项活验完整**、4 项**部分完成**、**0 项未实现** |
| 回归 | **41 套全绿** |
| 运行时依赖 | **零** |
| 界面 | ❌ 没有界面——它是一套装在 AI 助手上的护栏 |
| 多租户 | ❌ **不支持**——设计场景是**单机单用户** |

**四个尚未验完的功能**（**不是没做，是没在真环境验完**）→ [功能对照表 §4](docs/01-overview/feature-matrix.md)

---

## 三条最重要的使用纪律

> **1. 被拒绝是设计行为，不是故障。**
> fail-closed 意味着它**宁可拦住正确的操作，也不放过错误的操作**。
> 被拦时先读拒绝理由——里面通常已经写了「怎么补」。
>
> **2. 理由要写真的。**
> 这套系统存在的意义就是「说的话都能被追溯」。
> **不要为了「测试一下」而推进阶段或编造理由**——业务状态会被真实推进，且链上永久留一条测试记录。
>
> **3. 看到异常先怀疑自己的判据。**
> 本项目至少 3 次发生「先怀疑实现有缺陷，查下去发现是判据/观测方法错了」。
> 如果当时直接动手「修」，**会把一个本来正确的实现改坏**。

---

## 许可证

**MIT** —— 见 [`LICENSE`](LICENSE)。

> ✅ **已确认的两个前提**（由版权持有人 HarryKong824 于 2026-09-29 确认）：
>
> 1. `E:\ontologyRoot\` 里的医疗领域示例为**通用示例**，不来自真实客户业务、不含真实患者信息；
> 2. 本项目**以 MIT 公开**。
>
> 📌 另见 [`DISCLOSURE.md`](DISCLOSURE.md) —— **四项如实披露**（AI 生成 / 领域敏感内容 / 第三方宿主 / 不构成专业意见）。
> 它**不修改 MIT 条款**，只是披露事实。
>
> ⚠️ **为什么披露要单独放**：原先这四项是附在 `LICENSE` 正文后面的，实测导致 **GitHub 的许可证识别器匹配不上**，
> 仓库页面显示为 "Other" 而非 MIT。现在 `LICENSE` 只保留规范 MIT 正文，**许可证能被正确识别**，事实也照旧告知。

**如需改用其它许可证**（Apache-2.0 / AGPL-3.0 / 专有），整体替换 `LICENSE` 即可。

> 相关的深度分析 → [`docs/05-ai-development/data-licensing.md`](docs/05-ai-development/data-licensing.md)

---

## 贡献

见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

**最重要的一条**：本项目的方法论核心是 **「判据必须可复算」**——
提交前请确认你的每条结论都指着一个**可以被别人独立复算的磁盘事实**。

---

## 致谢

- **DeepSeek Harness** —— 宿主平台
- 本项目 7 天里的 **123 份交接文档**、**41 套回归**、**47 条被记录下来的缺陷** ——
  它们不是项目的污点，**它们正是这套系统想证明的东西**。
