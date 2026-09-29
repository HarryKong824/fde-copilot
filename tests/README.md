# `tests/` —— 离线回归

这个文件夹里是**全部 41 套离线回归**，以及它们依赖的 11 个非套件脚本和夹具。

---

## 怎么跑

```bash
bash tests/_run_all_tests.sh          # 从仓库根
bash /任意/路径/tests/_run_all_tests.sh   # 从任何地方都行
```

**脚本自己会 `cd` 到本目录**，再展开 `_*_test.mjs` —— 从哪儿调用结果都一样。

> ⚠️ 踩过的坑（写在这里防止再犯）：早先版本靠 **CWD** 展开 glob，
> 换个目录跑就一个套件都找不到。**实测那次不是「假绿」** ——
> bash 不展开未匹配的 glob，会留下字面量 `_*_test.mjs`，`node` 跑它 `EXIT=1` ⇒ 计入失败 ⇒ `HAS-FAILURE`。
> 是**一条令人困惑的红**，不是假绿。但报错信息完全看不出真因，所以现在加了两道：
> ① 脚本自定位；② **零套件显式判红**（`nullglob` + 空数组即报 `HAS-FAILURE`）。

### 怎么看结果

看**最后三行**：

```
共 41 个套件；已跑 …；跳过 …（白名单内，需本机部署的 DSH）；失败 …；疑似空程序 …
ALL-TESTS-GREEN          ← 或 HAS-FAILURE
```

退出码：`0` = 通过 / `1` = 有失败。**判定行与退出码同源**，不会一个说绿、一个给红。

---

## 哪 4 套在这台机器上跑不了

有 **4 套不是纯离线套件** —— 它们要读**你本机已部署**的插件副本 / 部署配置。
没有那份部署时它们自行 `exit 77`，脚本把它计入「跳过」：

| 套件 | 为什么需要部署 |
|---|---|
| `_fde_e1_wiring_test.mjs` | 要读已安装副本的接线 |
| `_fde_e2_test.mjs` | 要读已安装副本 |
| `_fde_e5_test.mjs` | 要读已安装副本 |
| `_fde_phase_wiring_test.mjs` | 要读部署配置 |

> **三条防止「跳过变成假绿出口」的约束**（写在 `_run_all_tests.sh` 里，别改松）：
> ① 只有白名单里的套件才允许 `77`，**别处的 77 一律算失败**；
> ② 白名单**按名字钉死**（不是"最多允许 4 个"）——换个套件来跳过，名字对不上就红；
> ③ 汇总行**必须报出跳过条数**，且 `已跑 + 跳过 + 失败 == 总数` 不自洽就算失败。

设 `FDE_DSH_HOME=<你的 dsh-home>` 就能让它们真跑（本机已部署时是 **41/41、跳过 0**）。

---

## 除 41 套套件外，这里还有 7 个脚本（**不是**套件）

它们**不叫 `_*_test.mjs`**，所以 `_run_all_tests.sh` 不单独跑它们。放在这里的原因是**套件要用**：

| 脚本 | 依赖形态 | 谁在用 |
|---|---|---|
| `_a2_inject_fail.mjs` | **被 spawn** | `_fde_memory_decisions_test.mjs:217` —— 做「写盘失败」注入 |
| `_assert_restrict_live.mjs` | **被 import** | `_assert_restrict_live_test.mjs:32` |
| `_tool_surface_check.mjs` | **被 import** | `_tool_surface_test.mjs:21` —— 工具面判红仪器 |
| `_fde_d1_mut.mjs` | **反过来调用套件** | 它 `spawn` `_fde_d1_test.mjs`（变异测试：故意改坏源码，看套件会不会报警） |
| `_fde_e2_mut.mjs` | 同上 | 调 `_fde_e2_test.mjs` |
| `_fde_e5_mut.mjs` | 同上 | 调 `_fde_e5_test.mjs` |
| `_deploy_diff.mjs` | **验证入口**（无套件依赖它） | `npm run deploy:diff` 的实体；也做「源 ↔ 部署副本」对拍 |

> ⚠️ **别凭 `grep 文件名` 判依赖**：这里曾经有 4 个脚本（`_assert_lock_msg`、`_cc_transcript_dump`、
> `_dsh_lifecycle`、`_cc_tool_list`）**只被注释提到名字**、没有任何 `import`/`spawn` ——
> 按名字搜会以为它们是依赖，实际是孤立文件，已挪去 `tools/`。
> **判据是「有没有被 import / spawn」，不是「有没有被提到」。**

> **`_deploy_diff.mjs` 本可挪去 `tools/`**（没有套件依赖它），但它留在这是因为
> `package.json` 的 `npm run deploy:diff` 与多份文档都指向 `tests/_deploy_diff.mjs`，且它属于本项目的验收判据。

---

## 其他约定

- **`_fixtures/`** —— 回归夹具，被 `_restrict_index_test.mjs` 等引用，别删。
- **产物文件**（`_*_out.txt`）**与套件同级**：有 4 套按设计**不往控制台打印**
  （Windows 代码页会把中文打成乱码），结果只落 `<同名>_out.txt`。
  这类套件的判据是「`EXIT=0` + **产物非空**」，本脚本不构成"跑过"的证据。
  ⚠️ 反面教材：`_fde_d5_test.mjs` 曾是个 **0 字节文件**，产物却写着 `PASS 9 / FAIL 0`。
- **产物已被 `.gitignore`**（`_*_out.txt`），不进仓库；历史产物归档在仓库根的 `evidence/`。
- 加新套件：直接放这里、以 `_test.mjs` 结尾即可，脚本自动收编，**不用登记**。
  但「跳过」要进白名单 —— 白名单是**按名字**写的，见上。

---

## 移动脚本时要改什么（下次别踩）

2026-09-29 把这些脚本从仓库根搬进来时，**失败过两轮**（37 套 → 11 套 → 0）：

1. **相对导入**：`'./dsh-fde-phase/lib/x.js'` → `'../dsh-fde-phase/lib/x.js'`（44 个文件 / 127 处）。
2. **运行时路径**：少数脚本按「我所在目录 = 仓库根」拼路径（`ROOT`/`HERE` 常量）。
   这类要**逐文件**判断 `ROOT` 指的是"仓库根"还是"同目录"——`_fde_d1_mut.mjs` 就**两种语义混用**，
   必须拆成 `HERE`（同目录）与 `REPO`（仓库根）两个常量，不能一刀切加 `'..'`。
3. **例外**：`_fde_memory_import_cover_test.mjs` 里的 `'./config-schema.js'` **不能改** ——
   它是被断言的**字符串内容**（检查插件源码文本里有没有这句话），不是导入路径。
