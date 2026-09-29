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
| Node.js | 与 DSH 宿主一致 |
| DeepSeek Harness | **桌面应用**形态（`DeepSeek Harness.exe`）**已安装** |

> ⚠️ DSH **不是命令行服务**，是 Electron 桌面应用 ⇒ 「启动/停止」= 打开/关闭应用，**没有 systemd 概念**。

### 跑一遍回归（**不需要 DSH**）

```bash
bash _run_all_tests.sh
#   期望最后一行：ALL-TESTS-GREEN
#   共 41 个套件；EXIT!=0 的 0 个；疑似空程序 0 个
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
├── LICENSE                      ← MIT + 四项如实声明
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md                  ← 报漏洞的私密渠道 + 已知安全边界
├── CODE_OF_CONDUCT.md
├── .gitignore                   ← ⚠️ node_modules 有反常规处理，改前先读
├── .gitattributes               ← ⚠️ 强制 LF；删了会让 .sh 在 Windows 上坏掉
├── .github/
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

> ✅ **本结构已被验证**：从本仓库**克隆到干净目录**，`bash _run_all_tests.sh` → **41 套全绿**。
> 这证明 `.gitignore` 里的 node_modules 例外有效、LF 归一化不破坏夹具。

> ⚠️ **脚本为什么不放进子目录**：它们用 `./dsh-fde-phase/lib/state.js` 这类**相对导入**，
> 移动会**直接破坏**已验证的 41 套回归。这是**不可移动的硬约束**，不是没整理。

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
> 📌 `LICENSE` 中另附**四项如实声明**（AI 生成 / 领域敏感内容 / 第三方宿主 / 不构成专业意见）——
> 它们**不修改 MIT 条款**，只是披露事实。

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
