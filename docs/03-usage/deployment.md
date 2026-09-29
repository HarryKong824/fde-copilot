# 部署运维手册 · FDE Copilot

> **本文写给**：负责安装、维护、排障的技术人员。
>
> **⚠️ 本文的命令与路径均来自本项目实际验证过的操作**，不是通用模板。

---

## 一、环境要求

| 项 | 要求 | 本项目验证环境 |
|---|---|---|
| 操作系统 | Windows | Windows 11（10.0.22631） |
| Node.js | **跑插件**：与 DSH 宿主一致<br>**跑回归 / precheck**：**≥ 22.15** | 已装（`node` 在 PATH 中）<br>⚠️ Node 20 **不行**：`zlib.zstdDecompressSync` 该版本没有这个导出（实测 20.20.2 无 / 22.15.0 有） |
| DeepSeek Harness | **桌面应用形态**（`DeepSeek Harness.exe`） | 已安装 |
| 磁盘 | 插件 + 审计链所需空间 | 审计链会持续增长，**需预留** |
| 网络 | **无需外网**（零外部服务依赖） | — |

> ⚠️ **DSH 不是命令行服务**，而是 Electron 桌面应用。因此「启动/停止」= 打开/关闭应用，**没有 systemd / service 概念**。

---

## 二、部署前必做：三项预检

在动手之前，先跑这三个——它们能在**不碰生产数据**的前提下发现大多数问题。

```bash
# ① 插件自检
#    ⚠️ 实测只有 3 个插件带 precheck.mjs：dsh-fde-dsl / dsh-fde-phase / dsh-fde-memory
#       dsh-fde-ontology-gate **没有**这一份（旧版本文档写「每个插件都有」，已更正）
#    ⚠️ 必须在**已安装副本**目录里跑，在工作区源目录跑会解析到桩（退出码 2 = 结论无效）
cd <已安装副本目录>
node precheck.mjs

# ② YAML 锚点/条目顺序 smoke check（退出码敏感）
node _probe_yaml_anchor.mjs

# ③ 离线回归全套件
bash _run_all_tests.sh
#   期望最后两行（本机**没有**部署 DSH 时）：
#   共 41 个套件；已跑 37；跳过 4（白名单内，需本机部署的 DSH）；失败 0；疑似空程序 0
#   ALL-TESTS-GREEN
#   本机**有**部署时是「已跑 41；跳过 0」。
#   退出码：0 = 通过；1 = 有失败。
```

> ⚠️ `_run_all_tests.sh` 会**预警小于 400 字节的脚本**。一条真实教训：`_fde_d5_test.mjs` 曾是 **0 字节**，而跑一个空程序 `node` 必然 **零断言 + EXIT=0** ⇒ 产物文件里写着「PASS 9 / FAIL 0」却**从未真跑过**。

---

## 三、部署步骤

### 3.1 放置插件

```
<DSH_HOME>\profiles\web\node_modules\
  ├── dsh-fde-dsl\
  ├── dsh-fde-memory\
  ├── dsh-fde-ontology-gate\
  └── dsh-fde-phase\
```

其中 `<DSH_HOME>` 本机为：
```
E:\DSH-desktop\DeepSeek Harness\data\dsh-home
```

每个插件目录至少包含：`package.json`、`lib/`。**不需要** `node_modules`（插件零运行时依赖）。

### 3.2 配置

编辑 `<DSH_HOME>\profiles\web\cordis.patch.yml`。**这是配置的唯一权威**——插件内的 `config.js` 只是兜底与校验。

### 3.3 源 ↔ 部署副本对拍（**关键一步**）

```bash
node _deploy_diff.mjs
#   期望：ALL_MATCH
```

> ⚠️ **对拍的域包含 `README.md`，不只是 `lib/*.js`**。本项目的教训：只改了源 README 忘了同步副本，`_deploy_diff.mjs` 报 `HAS-DIFF`，而 14 个文件里**只有这一处**不一致 —— 极易被误读成「代码没同步」。
>
> ⚠️ **README 不参与运行时**，补一次 `cp` 即可，**不必重启**。

### 3.4 重启 DSH

**必需**。改了 `lib/*.js` 只有重启进程才生效。

---

## 四、启动与停止

| 操作 | 方法 |
|---|---|
| **启动** | 运行 `DeepSeek Harness.exe`（桌面应用） |
| **停止** | 关闭应用窗口 / 结束 `DeepSeek Harness.exe` 进程 |
| **重启** | 关闭后重新运行 |

**验证是否起来了**（本机 Typert RPC 端口 **3080**）：

```bash
netstat -ano | grep "127.0.0.1:3080" | grep LISTENING
```

**验证插件是否装载**：开一个会话，让 AI 列出 fde 工具（应为 19 个）。

> ⚠️ **不要用「探端口」的当前状态去回答「某时刻它在不在」的问题**。本项目踩过这个坑：用 `tasklist` + 探端口的**现在时**观测，否定了别人关于「DSH 起来后」的**过去时**陈述，而磁盘上的 `phase.jsonl` 时间戳与 agent 字段当场证伪。**关于环境的断言必须带时间点。**

---

## 五、配置项全表

### 5.1 `dsh-fde-ontology-gate`

| 配置项 | 本机值 | 说明 |
|---|---|---|
| `mode` | `enforce` | `shadow`（只记不拦） / `enforce`（真拦） |
| `denyRunCode` | `true` | 是否禁止运行代码类工具 |
| `auditPath` | `…\fde-audit\gate.jsonl` | gate 链 |
| `phaseAuditPath` | `…\fde-audit\phase.jsonl` | phase 链（gate 会写它） |
| `allowedWriteSources` | `['user', 'model']` | 允许的写入来源 |
| `minConfidence` | `70` | 置信度阈值 |
| `protectedExtraRoots` | `[…\fde-state]` | 额外受保护根（YAML 锚点 `&fde_state_root`） |
| `sandboxSubdirs` | `['experiments']` | 探索沙箱子目录（豁免分层注入） |

### 5.2 `dsh-fde-dsl`

| 配置项 | 本机值 | 说明 |
|---|---|---|
| `ontologyRoot` | `E:\ontologyRoot` | 受控本体区 |
| `mode` | `shadow` | ⚠️ 见下方说明 |
| `minRules` | `3` | 最少规则数 |
| `minCasesPerRule` | `5` | 每条规则最少反例数 |
| `maxCombos` | `200` | 多叶子规则的笛卡尔积上限 |

> ⚠️ **dsl 的 mode 是 `shadow`**：它**不直接拦**（拦由 phase/guard 执行），只负责**算结论并广播**。

### 5.3 `dsh-fde-phase`

| 配置项 | 本机值 | 说明 |
|---|---|---|
| `projectRoot` | `*fde_state_root`（锚点） | 项目状态与记忆的根 |
| `ontologyRoot` | `E:\ontologyRoot` | 受控本体区 |
| `mode` | `enforce` | — |
| `auditPath` | `…\fde-audit\phase.jsonl` | phase 链 |
| `gateAuditPath` | `…\fde-audit\gate.jsonl` | gate 链（交叉校验用） |
| `lockTtlMs` | `30000` | 锁超时（毫秒） |
| `protectedPhases` | `['4', '6', '10']` | 这些阶段启用工具面过滤 |
| `denyTools` | `['pwsh']` | 受保护阶段要隐藏的工具 |
| `industry` | `未声明` | 行业标识 |

> ⚠️ **`denyTools` 是「隐藏名单」，不是「唯一会变的工具」**。本项目实测：新工具注册会让 header 里的**工具总数不降反升**（36→37，而 `pwsh` 确实被摘掉了）。**验收时必须逐名 diff，不能看总数。**

### 5.4 `dsh-fde-memory`

| 配置项 | 本机值 | 说明 |
|---|---|---|
| `projectRoot` | `*fde_state_root`（锚点） | 与 phase 同一个锚点 |
| `mode` | `enforce` | — |

> ⚠️ **YAML 锚点在多处被复用**（`*fde_state_root`）。改锚点定义会同时影响多个插件——**这是设计，不是巧合**，但改的时候要意识到影响面。

---

## 六、日志与审计查看

### 6.1 三份审计链（**类型字段不统一，务必注意**）

| 链 | 路径 | 类型字段 |
|---|---|---|
| gate | `<DSH_HOME>\fde-audit\gate.jsonl` | `type` / `tool`+`decision` / `event` |
| phase | `<DSH_HOME>\fde-audit\phase.jsonl` | `type` / `tool`+`decision` |
| memory | `<DSH_HOME>\fde-state\memory\audit\events.jsonl` | **`kind`**（+ `eventType`） |

### 6.2 常用排查命令

```bash
# 最后 5 条 phase 记录（可读化）
tail -5 "<DSH_HOME>/fde-audit/phase.jsonl"

# 所有被拒绝的操作
grep '"decision":"deny"' "<DSH_HOME>/fde-audit/phase.jsonl"

# 查锁竞争
grep 'lock-contended' "<DSH_HOME>/fde-audit/phase.jsonl"

# 查逃生门
grep 'break-glass' "<DSH_HOME>/fde-audit/phase.jsonl"

# 全量统计各类型记录数（不要用 tail 的观感代替全量）
node -e "const fs=require('fs');const r=fs.readFileSync(process.argv[1],'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));const t={};for(const x of r){const k=x.type??x.kind??'(无类型字段)';t[k]=(t[k]??0)+1}console.log(r.length+' 条:',t)" "<DSH_HOME>/fde-audit/phase.jsonl"
```

> ⚠️ **「链里有没有 X」是全量属性，尾部窗口对它零信息量。** 本项目实测过：凭 `tail -6` 断言「链里没有 allow 记录」，而**链的前部有 2 条**。必须全量 parse。

### 6.3 链完整性校验

```bash
node _replay_phase_audit.mjs
#   期望：断链 0 处 / CHAIN-INTACT
```

> 🔴 **重放必须按 `seq` 排序，绝不能按文件行序**。
>
> 同一毫秒的两个并发写者会分到**相邻 `seq`**，而落盘次序可能被 OS 打乱——实测出现过第 224 行 `seq=223` 排在第 223 行 `seq=224` **之后**。
>
> | 重放方式 | 结果 |
> |---|---|
> | 按**文件行序** | ❌ 报 **3 处假断链** |
> | 按 **`seq` 升序** | ✅ **断链 0、哈希不符 0** |
>
> ⚠️ 按 `seq` 重放还必须**同时**断言 `seq` **无重号、无缺号**，否则重放会静默跳过一条而不报错。

**哈希公式**（重算时用）：
```js
// 必须用 rest 解构保留键顺序
const { prevHash, hash, ...record } = row
linkHash(prevHash, record) === hash   // sha256(prevHash + '\n' + JSON.stringify(record))
```

---

## 七、数据备份与恢复

### 7.1 备份范围（**三处缺一不可**）

| # | 路径 | 内容 | 频率 |
|---|---|---|---|
| 1 | `E:\ontologyRoot\` | 受控本体（5 个 YAML） | 每次修改后 |
| 2 | `<DSH_HOME>\fde-state\` | 项目状态、记忆、决策 | 每天 |
| 3 | `<DSH_HOME>\fde-audit\` | 审计链 | **只追加，越早越好** |

### 7.2 备份命令

```bash
# 用时间戳命名，避免覆盖
STAMP=$(date +%Y%m%d-%H%M%S)
cp -r "E:/ontologyRoot" "./backup-$STAMP/ontologyRoot"
cp -r "<DSH_HOME>/fde-state" "./backup-$STAMP/fde-state"
cp -r "<DSH_HOME>/fde-audit" "./backup-$STAMP/fde-audit"
```

> ⚠️ **审计链备份后不要再改动它**。它是事后追溯的唯一依据。

### 7.3 恢复

| 场景 | 做法 | 注意 |
|---|---|---|
| 本体被改坏 | 从备份复制回 `E:\ontologyRoot\` | 恢复后**旧校验结论会自动失效**（内容哈希变了，这是设计） |
| 状态文件损坏 | 从备份恢复 `fde-state\memory\state.yaml` | **保留 `revision` 与 `updated_at` 原值**——那是工具写的计数器，手改等于伪造 |
| 审计链损坏 | **不要自己修** | 先停写入、备份现场，再排查 |

> ⚠️ **恢复本体后，不要试图「让旧结论继续有效」**。结论绑定内容哈希是**安全属性**，绕过它等于把门禁作废。

---

## 八、常见故障处置

| 症状 | 排查顺序 |
|---|---|
| 插件完全没反应 | ① DSH 起来了吗（§4）② 插件目录在 `profiles/web/node_modules/` 吗 ③ 重启过吗 |
| 工具数不对 | ⚠️ **逐名 diff，别数总数**——见 §5.3 |
| 推进总被拒 | 读拒绝理由；常见是「无 D1 结论」（先跑 `fde-run-guardrails-check`） |
| 「锁未过期」 | 确认持有 PID 是否还活着。**不要盲删锁文件** |
| 审计链报断链 | **停止写入 → 备份 → 上报**。先确认是「真断链」还是「按行序重放的假断链」（§6.3） |
| `_deploy_diff.mjs` 报 HAS-DIFF | 看**具体哪个文件**——很可能只是 README 没同步（§3.3） |

---

## 九、升级与回滚（插件代码）

```bash
# 升级前：存快照（本项目的惯例是 _snapshots/<日期>-before/）
cp -r dsh-fde-phase "./_snapshots/$(date +%Y-%m-%d)-before/dsh-fde-phase"

# 改代码 → 跑回归 → 对拍 → 部署 → 重启
bash _run_all_tests.sh && node _deploy_diff.mjs
```

> ⚠️ **改代码后必须重跑全套件**。本项目的历史快照有 **35 个**（`_snapshots/`），命名格式就是 `<日期>-before` —— 这是**改动可追溯**的做法。

---

## 十、运维者的三条铁律

1. **重启才生效**——`lib/*.js` 的改动，不重启等于没改。
2. **全量优先于观感**——「链里有没有 X」「工具有没有少」这类问题，必须全量 diff / parse，**不能用 `tail` 或总数代替**。
3. **不可逆的动作先确认**——删锁文件、改状态文件、修审计链，三思而后行；**成本不对称时选可逆的那一边**。
