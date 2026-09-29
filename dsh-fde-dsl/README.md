# dsh-fde-dsl — Ontology 受限 DSL + D3 验证器

> 对应 **FDE Copilot v3 第十三节的 Stage 3 + Stage 4**。
> 依据：`fde-copilot-design-spec-v3.html`（第三节 / 第四节 / 第七节 / 第九节 / 第十三节）。
>
> **验证状态**（2026-09-24 收口）：离线回归 **63/63**（§8）；活体两条判据 + 反向验证成立（§7.4）；
> 变更窗口两项（§10.1 报告带文件名 / §10.2 读探测落审计）**均已活验通过**；
> §10.1 的**文案去重**（4.2 + 4.2b）**已于 18:25 重启后活验通过**（回执见 §10.1）。
> ⚠️ 唯一待重启项（属 **gate** 插件，非本插件）：`fde_ontology_read` 的 description 补文件名（§10.4）。
> ⚠️ 凡标"未支持""未覆盖"的地方，是实测确认的边界，不是保守措辞。
> 🔴 **但"离线绿"不等于"能在 DSH 里加载"**：离线回归覆盖不到的面在 **§8 末尾**逐条列全了 —— 那里出过一次阻断性缺陷（工具层输出 schema），59/59 全绿照样照不出来。上线前请务必读那一段并跑 §7.3 的预检。

---

## 0. ⚠️ 使用前提：新建会话第一步切 `standard` preset

DSH 默认 preset 是 `ptc`，且 gate 侧 `denyRunCode: true` —— 该组合下**模型一个工具都调不到**（不是只调不到本插件的工具）。
所以建会话后第一件事：把 preset 切到 **`standard`**（UI 选下拉；脚本 / 服务端传 `agentPreset: 'standard'`）。
判据：让模型**自报工具清单**，须含 `fde-run-guardrails-check` 与 `fde_phase_advance`；
**报不出来 = preset 没切对**，先解决这个再谈校验 —— 否则很容易误判成"本插件没挂载"。

> 权威全文见 [操作卡 C-0](../DSH插件-enforce操作卡.md)；另一份等价说明见 [dsh-fde-phase/README §0](../dsh-fde-phase/README.md)。

---

它是 [`dsh-fde-ontology-gate`](../dsh-fde-ontology-gate) 的**下游**：

| 插件 | 管什么 |
|---|---|
| `dsh-fde-ontology-gate` | **谁能在什么条件下改 ontology**（通道、来源、置信度、路径） |
| **`dsh-fde-dsl`（本插件）** | **改出来的规则本身能不能信**（DSL 合法性、能否触发、能否被反驳） |

两者不共享进程状态，只共享同一个 `ontologyRoot`。

---

## 1. 它到底校验什么（先看这段，别被名字误导）

D3 的六项硬判据，**任一项失败即整体不通过**：

| # | 判据 | 失败码 | 为什么这条重要 |
|---|---|---|---|
| ① | 规则条数 ≥ `minRules`（默认 3） | `TooFewRules` | v3 原文：少于 3 条不通过 |
| ② | 条件能编译（算子在白名单、类型不自相矛盾） | `UnknownOperator` / `BadArity` / `TypeMismatch` … | 认不出就报错，绝不猜测语义 |
| ③ | **`effect: deny` 的规则不得引用 `maturity: draft` / `status: pending` 的属性** | `DraftReference` | v3 铁律：草稿属性没经数据验证，用它做临床判定＝空中楼阁换了个名字 |
| ④ | 每条规则派生的反例数 ≥ `minCasesPerRule`（默认 5） | `TooFewCases` | 来源：v3 Stage 4 完成判据「3 条规则 ≥15 条反例」→ 每条 ≥5 |
| ⑤ | 至少有一条用例让规则**触发**，也至少有一条让它**不触发** | `RuleNeverFires` / `RuleAlwaysFires` | 死规则和永真规则都是伪装成规则的缺陷 |
| ⑥ | 引擎求值结果与**边界算术期望**一致 | `OracleMismatch` | 两条独立实现路径对拍，对不上说明一边有 bug |

### 🔴 能力边界（必须对客户原样讲清）

本插件**不**做这两件事，也做不到：

1. **不判定规则的临床正确性。** v3 对 D3 的免责边界原话：D3 只验证"代码实现与规则定义一致"，不验证"规则临床上正确"。医学正确性由人负责。
2. **不校验"某份下游实现与规则一致"。** 那要求被测实现先存在。本阶段实现的是**规则本身的可执行性 + 可反驳性 + 用例集完整性**，不是"与产品代码的一致性"。
3. `RuleNeverFires` / `RuleAlwaysFires` 只对**复合条件**有意义。候选值刻意包含阈值两侧（`t-step` / `t+step`），所以单叶子比较在结构上不可能"永不触发"——这条判据会在自相矛盾的 `and`、互补的 `or` 上发挥作用（回归里两条用例专门盯着）。

---

## 2. 文件约定

插件从 `ontologyRoot` 下读三个固定文件名：

| 文件 | 必需 | 内容 |
|---|---|---|
| `objects.yaml` | ✅ | 对象与属性声明（类型、值域、成熟度） |
| `logic.yaml` | ✅ | 规则表（id / effect / reason / condition） |
| `maturity.yaml` | 可选 | 节点级成熟度**覆盖**（不存在则用 objects.yaml 里的值） |

缺 `objects.yaml` 或 `logic.yaml` → 工具直接报错：**没东西可验的时候宁可不跑，也不静默放行**。

形态见 [`examples/objects.yaml`](./examples/objects.yaml) 与 [`examples/logic.yaml`](./examples/logic.yaml)。要点：

- 属性值默认 `maturity: draft`（**从严**）——没显式声明成熟度的属性一旦被 deny 规则引用，D3 直接判失败，逼作者把话说清楚。
- `step` / `min` / `max` / `enum` 不只是文档：**它们决定派生出多少反例**。一条只有 `type: number` 别的都不写的属性，只能派生 3 条反例 → 会撞 `TooFewCases`。补 `min` / `max` 就够 5 条。

---

## 3. DSL：受限 JSON Logic 子集

白名单之外的算子**一律报错**（`UnknownOperator`）：

| 类别 | 算子 |
|---|---|
| 比较 | `==` `!=` `>` `>=` `<` `<=` |
| 逻辑 | `and` `or` `!` |
| 成员 | `in` |
| 取值 | `var` |

**明确禁止**（会抛错，不静默接受）：

- 白名单外任何算子（含 `map` / `filter` / `if` / `reduce` 等可编程算子）
- 一个对象多个算子键（语义依赖遍历顺序）
- 比较两侧类型不一致（`x > "abc"`）
- `var` 指向输入里不存在的变量
- 条件求值结果不是布尔
- 数字/字符串当条件（布尔字面量允许，这是 JSON Logic 常规写法）

刻意不支持的东西见 [`lib/yamlsubset.js`](./lib/yamlsubset.js) 顶部注释：多行字符串块（`|` / `>`）、
锚点与别名、多文档标记、行尾注释。**YAML 子集认不出来就报错并带行号**，不会猜缩进语义。

---

## 4. 反例是怎么派生的

全部从**属性声明**机械推出，不接受任何外部输入（同一份 `objects.yaml` 永远派生同一批用例，指纹稳定）：

- **数值**：`t-step` / `t` / `t+step`，再加声明值域两端 `min` / `min-step` / `max` / `max+step`
- **枚举**：全部成员 + 一个哨兵非成员 `__fde_out_of_enum__`
- **布尔**：`true` / `false`
- **`in`**：全部成员 + 哨兵非成员

每条用例带一个 `expectedLeaf`：**它是用边界算术直接算出来的，完全不经过 DSL 求值器**，于是运行时可以两边对拍（判据 ⑥）。

### "用例不可删"怎么落地

工具 `fde-run-validation` **只接受一个 `reason` 参数**，没有任何 `skip` / `only` / `exclude` 之类的口子 —— 用例集完全由机器派生，**模型在调用层面无法去掉任何一条**。

不是靠约定，是靠"根本没有这个参数"。回归里有一条用例专门断言参数清单恰好是 `['reason']`。

### 组合用例（多叶子规则）

一次只动一个叶子的话，`and` 起来的规则可能**永远凑不出触发输入**（非焦点叶子停在声明默认值上把路堵死）→ 会产出**假失败** `RuleNeverFires`。

所以叶子数 ≥2 时会再跑一遍候选值笛卡尔积，上限 `maxCombos`（默认 200）。**超过上限就明确报 `CombinatorialSkip` 提示**——不假装验过。

---

## 5. 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `fde-run-validation` | `reason`（可选，写回执用） | 跑 D3 校验，返回报告 |

🔴 **输出只有报告，绝不回显 ontology 文件内容。**

这条是硬约束，理由：本插件为了取数用原生 `node:fs` 直读 ontology（gate 插件已经把通用 `read` 接管了，且 ontology 在工作区之外）。如果再把文件内容吐给模型，就等于给模型开了一条绕过 `fde_ontology_read` 的读通道——把门禁自己的口子撕开。回归里有专门用例盯着（往文件里塞哨兵字符串，断言它不出现在任何输出里）。

> ⚠️ **例外澄清（2026-09-24 §10.1 落地后）**：报告里**会出现 `objects.yaml` / `logic.yaml` 这类文件名**
> （每条失败项末尾的 `⟨改：xxx.yaml⟩`）。文件名是 §2 文件约定里**已经公开**的固定三名之一，
> 不是"内容"；红线一直是"不回显文件**内容**"，文件名从来不在红线内。
> 哨兵用例断言的也始终是"内容不出现"，这条约束没有被削弱 —— 回归里另加了用例盯住两者的区别。

---

## 6. 配置

`cordis.patch.yml` 里挂在 plugins 下：

```yaml
- id: tools
  mode: native
# …
- id: dsh-fde-dsl
  config:
    ontologyRoot: 'E:\ontologyRoot'   # 与 fde-ontology-gate 同根
    mode: shadow                       # shadow=只报告；enforce=失败则工具报错
    minRules: 3
    minCasesPerRule: 5
    maxCombos: 200
```

`mode` 的语义与 gate 插件一致：**`shadow` 下失败只报告、工具照常返回；`enforce` 下失败抛错（`tool/result.isError = true`）**。初次上线建议先 `shadow`。

---

## 7. 安装到 DSH（活体验证 runbook）

> 四条纪律：前三条来自《DSH 插件开发手册》§2（**这条链路上一半的坑是这三条**），
> 第 3 条是 2026-09-24 一次阻断性缺陷换来的，**别跳过它**。

1. **同步必须 `pnpm remove` + `pnpm add`**（`add` / `install --force` 都会回 `Already up to date` 不动）

```powershell
cd "E:\DSH-desktop\DeepSeek Harness\data\dsh-home\profiles\web"
pnpm remove dsh-fde-dsl
pnpm add file:"./dsh-fde-dsl"
```

2. **改 `lib/*.js` 必须重启 DSH 进程**，翻 `mode` 无效（这条是踩出来的）

3. **上线前预检：在"已安装副本"目录里用真 SDK 跑一遍注册**（离线 59/59 照不出的缺陷靠它抓）

离线回归里的 `@deepseek-ai/dsh-tools` 是**工作区根的本地桩**（`defineTool = (def) => def`，恒等函数、零 schema 校验）。
所以**"离线 import 成功"推不出"工具能在 DSH 里注册成功"** —— 真 SDK 会逐层校验输出 schema，
校验不过就**同步抛错**，而抛错发生在插件 `apply()` 内 → **插件加载即失败** → 工具根本注册不上，
重启只会拿到一个 `fiberPhase: failed` 的条目，白停一次服务。

为此本插件自带 `precheck.mjs`：

```powershell
cd "E:\DSH-desktop\DeepSeek Harness\data\dsh-home\profiles\web\node_modules\dsh-fde-dsl"
& "C:\Users\DELL\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" precheck.mjs
# PRECHECK OK → 可以重启
# exit 2 = 跑在桩环境（位置不对，结论无效）　exit 3 = 注册/取数失败，别带着它重启
```

⚠️ **必须 cd 到已安装副本目录**：只有那条 node_modules 链解析得到真 SDK，工作区解析到的是桩
（脚本会自己探测：喂一个已知违规的 schema，真 SDK 会抛、桩不抛）。

**实测（2026-09-24）**：这条预检抓到过一次阻断缺陷 —— 输出 schema 的嵌套 `summary` 层没写 `additionalProperties`，
真 SDK 抛 `unsupported JSON schema: schema.properties.summary.additionalProperties must be explicitly true or false`（已修，见 `lib/tools.js` 注释）。
**反向对照**：把修复撤掉再跑，预检稳定 `exit 3` 并复现同一条文案 —— 它不是摆设。

4. **验证加载用 `pluginInventory/list`，不要翻日志**（stdout 被桌面启动器收走）

```bash
# ① 用启动 token 换 cookie（token 每次启动都变，从启动输出里拿）
JAR=/tmp/dsh-cookie.txt
curl.exe -s -c "$JAR" "http://127.0.0.1:3080/?token=<本次启动的 LAUNCH_TOKEN>" -o /dev/null

# ② 按 Netscape 列取 cookie：domain / flag / path / secure / expires / name / value → 取第 6、7 列
#    ⚠️ cookie 名不是 dsh-auth-web：是 dsh-auth-<authority 摘要>
#       = COOKIE_PREFIX + base64url(sha256("<host>:<port>")) —— dsh-client-connection 的 cookieName()，纯函数
#       → 对同一 authority **恒定**，与启动次数无关。本机 127.0.0.1:3080 恒为
#         dsh-auth-VPhEEcLKeqRDBoBalzN2Nm7CnfxKhLE00pKIDWxt1sw
#         （实算自验：printf '127.0.0.1:3080' | sha256sum → 二进制 → base64url，逐字吻合）
#    ⚠️ 每次启动变的是 **launch token**；换出来的**签名 cookie 跨重启复用**（与手册 §2.3 一致）
#    ⚠️ 别 tail -1 手拼：jar 里有 #HttpOnly_ 前缀行，且值是带签名的
COOKIE=$(awk '$6 ~ /^dsh-auth-/ { print $6"="$7; exit }' "$JAR")

# ③ 调 RPC —— type 必须写 "client-request"
#    写成 "rpc" 会被网关拒：gateway/bad-request: invalid client-request message ... expected "client-request"
curl.exe -s -X POST "http://127.0.0.1:3080/api/pluginInventory/list" \
  -H "Content-Type: application/json" -H "Cookie: $COOKIE" \
  -d '{"type":"client-request","rpcId":"1","method":"pluginInventory/list","payload":{"args":{}}}'
# 期望：dsh-fde-dsl → fiberPhase "active"、failed = 0
```

> 补充实测：**不带有效 cookie 时，两种 `type` 都只回 `unauthorized`** —— 鉴权在结构校验之前。
> 所以"换个 type 返回不一样"必须在带 cookie 的前提下看，否则会误判成"结构无影响"。

**上线前把样例 ontology 放进 ontologyRoot**（我没动 `E:\ontologyRoot`，那是你的受控区，且它现在被 gate 以 `enforce` 守着）：

```powershell
copy examples\objects.yaml E:\ontologyRoot\objects.yaml
copy examples\logic.yaml   E:\ontologyRoot\logic.yaml
```

然后**让模型跑一次校验**，直接说「跑一次 D3 校验」或让它调 `fde-run-validation`：

判据（两条都要满足）：

- ① 回执里 `passed: true`
- ② `summary.cases >= 15`（3 条规则，每条 ≥5 条反例）

只有 ① 没有 ② = 规则缝了但反例不够，等同于没验。

**反向验证（务必跑一次）**：把 `examples/logic.yaml` 里某条 `deny` 规则改去引用 `treatment.note`（它是 `maturity: draft`），再跑一次 → 必须报 `DraftReference`。这证明判据 ③ 在活体环境里真的在起作用，而不是只在离线测试里成立。

### 7.1 活体实测记录（2026-09-24，已跑通）

环境：DSH 0.1.2-rc.1 / profile `web` / 重启于 15:20:41。数据来自活体 RPC 原始载荷（seq 号可追溯）。

| 项 | 结果 |
|---|---|
| 加载 | `pluginInventory/list` → `dsh-fde-dsl` fiberPhase **`active`**、enabled true、**failed 0** ✅ |
| 触发（新会话 / standard preset / cwd `E:/DSH-workspace`，自然语气） | seq=56 `tool/call fde-run-validation` args = `{"reason":"…"}` ← **只有 reason** |
| 判据 ① | `passed: true` ✅ |
| 判据 ② | `summary.cases = 29 ≥ 15` ✅ |
| 与离线预检一致性 | cases=29、指纹 `7ebb39d521c150ba`，**逐字一致** |
| 反向验证（R001 改引用 `treatment.note`，draft） | 不通过：规则 3 / 反例 22 / 失败 3（`DraftReference`+`NoCandidate`+`TooFewCases`@R001）、指纹 `7bfa81a5cecc10aa` ✅ |
| 硬约束"用例不可删" | 注册后参数表 = `{type:'object', properties:{reason}}`，无 skip / only / exclude 口子 ✅ |
| 硬约束"输出不回显 ontology" | 模型侧自述未见到规则名 / 边界值 / 逐条用例结果 ✅ |
| shadow / enforce 三分支（离线补验，线上仍 `shadow`） | 不通过+shadow→不抛错（返回报告）；不通过+enforce→`isError=true`；通过+enforce→不抛错 ✅ |

`mode` 现留在 `shadow`（热生效、免重启）。切 enforce 的建议：先让 shadow 下连续几次 `passed: true` 稳定再切。

---

## 8. 跑回归

```powershell
& "C:\Users\DELL\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" `
  "tests/_fde_dsl_test.mjs"
# 结果落在 _dsl_test_out.txt（自己写文件，规避控制台代码页乱码）
```

**实测：63 通过 / 0 失败（2026-09-24）**，覆盖 config / YAML 子集 / schema / DSL 引擎 / 派生 / D3 编排 / 工具层七个面，其中一条直接拿 `examples/` 里的样例文件跑（用户会上线用的就是这两个文件，不能只测夹具）。

### 🔴 离线回归覆盖不到的面（出过事，逐条列全）

| 面 | 为什么全绿照不出 | 兜底 |
|---|---|---|
| **断言写成"存在性"（≥1 次）时对重复不敏感** | 2026-09-24 第二例：`derive.js` 的 `UnknownAttribute` 在 `message` 里写了 `objects.yaml`，而 `file` 字段又会渲染一次 `⟨改：objects.yaml⟩` —— 同一行两次。原断言只查"正文**出现**文件名"，重复照样通过 | 断言方向反过来：**`message` 里出现零次**（文件名只能由 `file` 字段承担），并要求样本非空、必须覆盖 `UnknownAttribute`；反向对照实测会红（见 §10.1） |
| **工具层输出 schema 是否被真 SDK 接受** | 离线用的是工作区根**本地桩** `defineTool = (def) => def`（恒等函数、零校验）。**"离线能 import"推不出"能在 DSH 里注册成功"** —— 2026-09-24 就栽在这里：嵌套 `summary` 层缺 `additionalProperties`，真 SDK 同步抛错 → 插件加载失败、工具注册不上 | §7 纪律 3 的 `precheck.mjs`（在真 SDK 下跑注册；反向对照实测能复现并拦下该缺陷） |
| `config-schema.js`（依赖 schemastery） | 不在覆盖内 | 它只承担 DSH 面板提示；真正的校验权威是 `config.js` 的 `normalizeConfig()` |
| 活体 RPC 链路（鉴权 / 报文结构 / 工具真被模型调到） | 纯离线测不到 | §7.1 的活体实测 |

一句话：**离线全绿是必要条件，不是充分条件。** 上线判定以 §7 的预检 + §7.1 的活体两条判据为准。

另外提醒：离线回归**能**真实 import 工具层（桩帮的忙），所以"import 成功"这个信号在这里是**假阳性温床** ——
看到它别放心，要看的是 precheck 有没有在真 SDK 下跑过。

---

## 9. 不在本插件范围内（后续 Stage）

| Stage | 模块 | 依赖 |
|---|---|---|
| 2 | 记忆系统 v3（state.yaml 状态机 + 写入器 source 防污染 + 置信度规则化推导 + 单写者锁 + SCHEMA 迁移） | 独立，未做 |
| 5 / 7 | Phase 流转 + D1/D2/D5 deny + fail-closed 行业判定 | 需 Stage 2 |
| 6 | 审计外置三层 + outbox 重放 + 脱敏 + 离线降级 | 需 Stage 5 |
| 8 / 9 / 10 | Zone A 清单 / R2 认知摩擦 / L0-L1 变更通道 | 需 Stage 2、5 |
| 12 | break-glass + 端到端跑真实项目 | 全部 |

⚠️ 另外注意（**Stage 5.5 已改变这一点**）：以前这条写的是"本插件只提供校验工具、没接入任何 deny"。
现在 `fde-run-validation` 跑完会**广播结论**给 `dsh-fde-phase`（`ctx.emit('fde/check-result', {check:'D3', …})`），
由 phase 的 guard 在 `fde_phase_advance` 入口真拦 Phase 4 的推进。

**但本插件自身依然不拦任何东西** —— 它只"算结论 + 广播"。决定权仍在 phase 那边，这句话的实质没变。

### 9.0.1 Stage 5.5：D3 结论是怎么传出去的

```
fde-run-validation
  ├─ 读 objects.yaml + logic.yaml（这两个就是 D3 的规则来源）
  ├─ 跑 validateOntology(...)
  ├─ anchor = { alg: 'sha256(objects+\u0000+logic)@v1', files:[objects.yaml, logic.yaml], sha256: 复合哈希 }
  └─ ctx.emit('fde/check-result', { check:'D3', passed, anchor, detail, at, callId })   ← try/catch 包住
```

为什么锚 `objects` / `logic` 而不是照搬 D1 的 `actions` / `guards`：
D3 验的是"规则↔实现一致"，**规则就写在 objects / logic 里**。若锚 actions/guards，
改了 objects 而不动 actions 时 D3 会说自己"新鲜" —— 门禁形同虚设。

🔴 **两侧 alg 表必须一致**：`ANCHOR_ALGS` 在本文件的 **dsl** 与 phase 的 `lib/mirror.js` 各有一份
（两个包各自独立安装，跨包 import 会让"一个包没装"直接拖垮另一个）。
`tests/_fde_d2d3_test.mjs` 有一条用例逐项比对两张表 —— 改一边忘另一边会立刻变红。

> ⚠️ 广播失败只 `logger.warn`，**不得**让校验本身失败（继承 `fde-run-guardrails-check` 的既有模式）。

---

## 10. 变更窗口 2026-09-24 —— ✅ **两条都已改完，待一次重启 + 一次活验**

两条都来自 2026-09-24 活体验证的观察，性质都判为"要做"。**按"同进程、都要重启"打包成一次窗口**：
各自改完 → 跑全量离线回归（含 `tests/_shelltok_test.mjs` 18 例）→ dsl 侧在**已安装副本目录**跑 `precheck.mjs`
→ **一次重启 + 一次活验**。

前置基线已存 `_baseline/baseline-2026-09-24.txt`（6 个脚本结果 + 源码 SHA-256），改完直接对拍。

### 10.1 D3 报告带文件名（本插件）

**现象**：不通过时模型知道"哪条规则错了"，不知道"去哪个文件改"。活体里它的动作序列是
glob ontology → 被 gate 拒（#37 deny）→ 猜 5 个文件名（`rules.yaml` / `ontology.yaml` / `index.yaml` / `rules/R001.yaml` / `attributes.yaml`）→ 全 ENOENT → 放弃并反问用户。
这是**稳定复现**的：每次多轮会话都要重猜一遍或重问一遍。

**判断：加，但只加文件名，不加内容，先不加行号。**
- 泄露为零：文件名就是 §2 已经公开的三个固定名之一（`logic.yaml` / `objects.yaml` / `maturity.yaml`），本来就不是秘密。
- 红线是"不回显**内容**"，文件名不在红线内；而"告诉模型去哪儿改"是它能自己完成修复的前提。
- 落地形态：每条 failure / warning 上加一个 `file` 字段（值为 `objects.yaml` / `logic.yaml`），行号等有了稳定 parser 位置信息再说。

**代价**：改 `lib/validate.js` + `lib/tools.js` → **重启才生效**。

**✅ 已改完 + 活验通过（2026-09-24）**。离线回归 **59 → 62/62**（新增 3 条用例：盯 file 字段取值、
回执正文含文件名、以及"仍然不回显内容"这条红线没被削弱）；`precheck.mjs` 在已安装副本目录 `PRECHECK OK`；
**cases=29 / 指纹 `7ebb39d521c150ba` 与改动前逐字一致** —— 用例集一个字节没动，加的只是"指路"元数据。

**活验（PID 24544 重启后）+ 行为级前后对照** —— 同一句 prompt「帮我跑一次 D3 校验……」，修前 vs 修后：

| | 修前 | 修后 |
|---|---|---|
| 模型动作 | 盲猜 5 个文件名 → 全 ENOENT → glob 被拒 → 放弃并反问「我猜不到文件布局」 | 一次直接读 `objects.yaml`（isError=false），接着读 `logic.yaml` |
| 依据 | 无 | 失败项末尾的 `⟨改：objects.yaml⟩` |

失败回执原始形态：`[R001] DraftReference / NoCandidate / TooFewCases ……　⟨改：objects.yaml⟩`；
`cases=22 / 指纹 7bfa81a5cecc10aa` 与改动前逐字一致。
🔑 **这条判据的价值在行为对照，不在文案**：模型把 `⟨改：⟩` 当成了"去哪改"的指路，两个文件都按映射走通了。

映射规则（按**修它要去哪改**）：

| 判据 | 指到 |
|---|---|
| `DraftReference` / `TooFewCases` / `UnknownAttribute` / `NoCandidate` / `NonDerivable` | `objects.yaml`（补 maturity / min / max / enum 即可） |
| 编译错误 / `RuleNeverFires` / `RuleAlwaysFires` / `EvalError` / `OracleMismatch` | `logic.yaml`（是条件写法的问题） |

回执形态：`  · [R001] DraftReference：规则 R001（effect: deny）引用了未成熟属性 treatment.note（maturity=draft）……　⟨改：objects.yaml⟩`

> **收敛（2026-09-24，第二次小改）**：`DraftReference` 的 message 原本在末尾还写了一句
> 「（属性成熟度在 objects.yaml 里改；规则本体在 logic.yaml）」，与结尾的 `⟨改：objects.yaml⟩`
> **是同一信息的两处表达**。已删掉正文那句，只留 `⟨改：⟩` —— reason 不是"啰嗦"，是
> **日后改映射漏改一处就会自相矛盾**。职责分离已写进 `validate.js` 的 `FILE` 注释：
> `file` = 机器字段（渲染器用，唯一事实源），`message` = 只讲为什么错。
>
> **✅ 已重启 + 活验通过（2026-09-24 18:25，PID 17172，session-30e3fe78）**。活体回执原文
> （一次调用同时命中两条判据，规则 5 / 反例 31 / 失败 4，指纹 `bc99f6d06533cf50`）：
>
> ```
> · [R900] DraftReference：规则 R900（effect: deny）引用了未成熟属性 treatment.note（maturity=draft）。
>   v3 铁律：……请先转成 verified。　⟨改：objects.yaml⟩        ← 无"属性成熟度在 objects.yaml 里改"那句
> · [R901] UnknownAttribute：规则 R901 引用了未在本体属性表里声明的属性：treatment.ghost　⟨改：objects.yaml⟩
> ```
>
> 两条判据各就各位：`objects.yaml` 在每行都**只出现 1 次**（仅在 `⟨改：⟩` 里）。

**🔴 同型漏网一处（2026-09-24 补）**：`derive.js` 的 `UnknownAttribute` 是**同一个毛病** ——
`message` 写「未在 objects.yaml 声明的属性」，而它又在 `ATTRIBUTE_LEVEL_CODES` 里会被挂上
`file: objects.yaml`，渲染后同一行出现两次 `objects.yaml`。已同样去掉 message 里的文件名
（改为"未在本体属性表里声明"）。

**为什么 62/62 照不出来**：原断言写的是"回执正文**出现**文件名"（≥1 次），对**重复**完全不敏感。
现已把方向反过来 —— 断言改为 **`message` 里出现零次**（文件名只能由 `file` 字段承担），
并要求样本非空、且必须覆盖 `UnknownAttribute`。
**反向对照已做**：把 `derive.js` 退回旧文案 → 精确报
`UnknownAttribute 的 message 里出现了文件名 objects.yaml` → FAILED；还原 → 63/63。

> ⚠️ 别一刀切：`schema.js` / `tools.js` 里那些含 `.yaml` 的文案**不是违例** ——
> 它们是**解析期抛错**的错误定位（`loadOntology` 的解析错误直接从 `execute` 抛出，
> 不进 `failures`、不经 `renderReport`），不会被追加 `⟨改：⟩`，不存在重复。

### 10.2 读通道的"读探测"不落审计（属 **gate** 插件，不是本插件）

**✅ 实现状态（2026-09-24）**：已改完（gate `lib/tools.js`），新增回归 `tests/_gate_readprobe_test.mjs` **15/15 全绿**。
三类读探测各落一条 `decision: read-probe`（`OutOfOntology` / `ENOENT` / `EISDIR`），**记而不拦** ——
抛错的错误类型、文案、allow/deny 结论**一字未改**，回归里专门有断言守住这条。
回归同时验证了哈希链仍连续（seq 递增 1、prevHash 衔接），且 read-probe **不冒充 deny**
（单列一类，否则会把"模型自己失败的探测"记成"门禁的拦截"，污染 enforcer 语义）。
**✅ 活验通过（2026-09-24，PID 24544 重启后）**：一句自然请求「ontology 里好像有个 rules.yaml，帮我读一下」，
模型探了 6 个文件名 → 审计 **6 条 `read-probe` 一一对应**（#38/#39/#40/#42/#43/#44，`code=ENOENT`），
期间那次 `glob E:\ontologyRoot` 是 **#41 deny** —— 与 `read-probe` 分得开，没被混为一类。

| 活验判据 | 结果 |
|---|---|
| 记而不拦：错误文案/类型/isError 一字未改 | ✅ 仍是 `Error: ENOENT: no such file or directory, stat 'E:\ontologyRoot\rules.yaml'`、isError=true |
| 不冒充 deny：字段形状干净 | ✅ `decision: "read-probe"` + `target`+`code`，无 `confidence`、无 `source`，与 deny 行的 `paths` 形态区分 |
| 原发现被钉住 | ✅ 改动前这 6 次探测**审计无痕**，现在全部在案；且这次探了 6 个（上次 5 个）→ 非偶发 |

**现象**：`fde_ontology_read` 读不存在的文件 → 返回 `ENOENT` 文案，但**审计链一行都不记**。
硬证据：审计文件 mtime 停在 `15:22:21.262`，三次探测发生在 `15:22:22.604/615/622`（晚 1.3 秒），文件零字节变化。
衍生两条：① 模型可**静默枚举**文件名（靠 ENOENT 与否判断存在性），而 gate 明确拒过 glob `E:/ontologyRoot`（#37 deny，理由正是"ontology 只能经 fde_ontology_read / write 访问"）—— 堵目录枚举的意图被这条探测路径绕过了；② 文案回显 `E:\ontologyRoot` 绝对路径。

**判断**：
- **性质必须补**：只要有一部分访问无痕，审计链就不能被称为"完整访问史"，这与本项目"留痕即失效"的口径冲突。
- **严重度低**：那两个文件本来就允许模型经该通道合法读取，枚举**名字**的增量有限 —— 所以不紧急、不单独立项。
- **路径回显不单独处理**：gate 自己的 deny 文案里本来就带 `E:/ontologyRoot`，路径本身不是新增泄漏。
- 落地要防日志膨胀（模型猜文件名会刷屏）：建议记为独立类别 `read-probe`，**记而不拦**。
- **这个窗口里只有上面这一件事，别给它打包别的洞。** 特别澄清一条容易记混的：
  `cmd /c "type E:\ontologyRoot\poc-t5.md"`（引号字符串被当成一个 token）**已于 2026-09-23 修好**，不是待办 ——
  证据：`tests/_shelltok_test.mjs` 的 case #26 就是这条命令串、`want: 'deny'`，回归 18/18 且该 case 通过 deny；
  修复前后 A/B 也已对拍（旧代码 5 种形态全 allow、新代码全 deny）。
  它缺的**只是活体拦截演示**（模型当时改用了 `fde_ontology_read`，线上证据取不到），
  措辞边界见手册 §4.2 / §7 #2 —— **这是"缺证据"，不是"有洞"**，两者在这项目里差一个量级的工作量。
- gate 侧真正的遗留只有手册 §7 #2 里"**运行时才成形**的路径"（`%VAR%` / `$env:` / base64 / 字符串拼接）那一类，早已明确接受、且不在这次范围内。

### 10.3 窗口执行清单 —— ✅ 已全部完成（2026-09-24，PID 17172）

| # | 动作 | 结果 |
|---|---|---|
| 1 | 重启 DSH（18:25:32，PID 17172） | ✅ 3080 在听 |
| 2 | `pluginInventory/list` | ✅ 两个插件 `enabled: true` / `fiberPhase: active`，全量 242 条目 `failed = 0` |
| 3 | 活验 10.1 | ✅ 见 §10.1 活体回执（`⟨改：objects.yaml⟩`，且 4.2/4.2b 去重都成立） |
| 4 | 活验 10.2 | ✅ 见 §10.2（6 条 `read-probe` 一一对应） |
| 5 | 文档收口 | ✅ 本轮完成 |

现场还原：`logic.yaml` 已还原（`f6d5431d…08c5`，与 `examples/logic.yaml` 逐字节一致）、
`objects.yaml` 未动（`3a8b107c…8d1c`，mtime 仍 15:00:19）、审计 68 行 max seq 55。

### 10.4 🔴 新发现：读通道不列文件名 → 模型靠 grep 插件源码走侧信道（属 **gate**）

**✅ 已改完（2026-09-24，gate `lib/tools.js`），待重启生效。**

**现象**：10.1 只修好了一半 —— **被失败项指向的文件**能一次命中（模型直接读 `objects.yaml`），
但**没被指向的文件仍然靠猜**。实测一次会话的完整代价：

```
#446 read rules.yaml → ENOENT      #594 read README.md → ENOENT
#518 glob E:\ontologyRoot → 被拒    #671 read rules.yml → ENOENT
#673 read ontology.yaml → ENOENT   #886 read rules.json → ENOENT
#888 read ontology/objects.yaml → ENOENT   （共 7 次错猜 + 1 次被拒）
#1083 grep "TooFewCases|DraftReference" …\data → ok 14 处
#1293 grep（收窄到 node_modules/dsh-fde-dsl）→ ok 58 处
#1372 read logic.yaml → ok        ← 隔了 1173 个 seq 才拿到
```

它是靠 grep **我们自己的插件源码**拿到名字的（`dsh-fde-dsl/lib/validate.js` 里明写 `const FILE = {...}`）。

**改法**：`fde_ontology_read` 的 description 补上
`可用文件名：objects.yaml / logic.yaml / maturity.yaml（可选）`（并在 `path` 参数描述里给例子）。

**判断依据**：① 这三个名字是 §2 已公开的约定，不是秘密；② 红线是"不回显**内容**"，名字不在红线内；
③ 🔑 **写在插件实现里的字符串不是秘密** —— gate 拦得住 `glob E:\ontologyRoot`，拦不住模型 grep 插件目录
（也不该拦）。**隐藏只会逼模型绕更远的路**，而且绕出来的那条路（grep 源码）比直接告诉它更不值得鼓励。

⚠️ 待一次重启（`lib/tools.js`）。已同步安装副本（11/11 MATCH），离线回归全绿。

**回滚**：改动面只有 3 个文件、约 40 行且彼此独立 —— 按上面的段落说明反向删掉即可。
⚠️ 诚实说明：**没有留存改动前的字节级备份**（工作区无 git，`_baseline/` 里只有哈希与脚本结果）。
如果你要"一键回到改动前"，先告诉我，我可以把三个文件的旧版本重建出来存档。

### 10.4 不做的（已判定）

- **gate 读探测的"绝对路径回显"**：见上，不单独处理。
- **把 D3 接进 deny**：属于 Stage 5，需先有 Stage 2 记忆系统，不在本插件范围（见 §9）。
