set -u
# 全量回归。**EXIT 直接取（不走管道）**；判定行只从**本套件自己的 stdout** 取，
# 不去猜产物文件名（第一版猜文件名 ⇒ 读到了别的脚本的产物，制造了两处假警报）。
#
# ⚠️ 有一类套件**按设计不打印**（`_fde_dsl_test.mjs` 等：Windows 代码页会把中文打成乱码，
#    结果只落 `<...>_out.txt`）⇒ 它们的 `EXIT=0` 后面是**空**判定行，**不是**"没输出=没跑"。
#    这类要另读它自己的产物文件；本脚本对它不构成"跑过"的证据，只有 EXIT=0 + 非空脚本。
#    （反面教材：`_fde_d5_test.mjs` 曾 0 字节 ⇒ 空程序必然零断言 + EXIT=0。）
#
# ══════════════════════════════════════════════════════════════════════
# ⚠️ 2026-09-29 新增「SKIP」这一档 —— **先读这段再用**
#
# 事实：有 4 套**不是离线套件**。它们要 import / 读你本机**已部署**的 DSH 副本
#       （作者机器上是 `E:/DSH-desktop/...`）。在没有那份部署的机器上（例如 CI）
#       它们**跑不了** ⇒ 它们自行 `exit 77`，本脚本把它计入 SKIP 并**在同一行报出条数**。
#
# 🔴 三条防止「跳过变成假绿出口」的约束：
#    ① 只有 SKIP_OK 白名单里的套件才允许 77 —— **别处的 77 一律算失败**；
#    ② 白名单**按名字钉死**，不是"最多允许 4 个" —— 换个套件来跳过，名字对不上就红；
#    ③ 汇总行**必须报出跳过条数**，且 `已跑 + 跳过 + 失败 == 总数` 不自洽就算失败。
#
# 想看全 41 套：把 `FDE_DSH_HOME` 指向你本机的 dsh-home（见 README「哪些脚本你能跑」）。
# ══════════════════════════════════════════════════════════════════════
SKIP_OK=" _fde_e1_wiring_test.mjs _fde_e2_test.mjs _fde_e5_test.mjs _fde_phase_wiring_test.mjs "

fail=0; vac=0; n=0; skip=0; ran=0
for t in _*_test.mjs; do
  n=$((n+1))
  size=$(stat -c %s "$t")
  [ "$size" -lt 400 ] && { vac=$((vac+1)); printf '%-46s ⚠️ 脚本仅 %sB（疑似空程序 ⇒ EXIT=0 无意义）\n' "$t" "$size"; }
  out=$(node "$t" 2>&1); code=$?
  verdict=$(printf '%s\n' "$out" | grep -E '^(RESULT:|状态：|结果：)' | tail -1)
  [ -z "$verdict" ] && verdict=$(printf '%s\n' "$out" | tail -1 | cut -c1-60)
  if [ "$code" -eq 77 ]; then
    case "$SKIP_OK" in
      *" $t "*)
        skip=$((skip+1))
        verdict='SKIP（需本机已部署的 DSH）'
        ;;
      *)
        fail=$((fail+1))
        verdict="⚠️ EXIT=77 但**不在** SKIP 白名单内 ⇒ 计为失败：$verdict"
        ;;
    esac
  elif [ "$code" -ne 0 ]; then
    fail=$((fail+1))
  else
    ran=$((ran+1))
  fi
  printf '%-46s EXIT=%s  %s\n' "$t" "$code" "$verdict"
done
echo "----"
# 自检：三个计数必须加起来等于总数（本脚本自己也是仪器，也要有坏样本能判红的地方）
if [ $((ran + skip + fail)) -ne "$n" ]; then
  echo "⚠️ 计数不自洽：已跑 $ran + 跳过 $skip + 失败 $fail = $((ran+skip+fail)) ≠ 总数 $n"
  fail=$((fail+1))
fi
echo "共 $n 个套件；已跑 $ran；跳过 $skip（白名单内，需本机部署的 DSH）；失败 $fail；疑似空程序 $vac"
if [ "$fail" -eq 0 ] && [ "$vac" -eq 0 ]; then
  echo "ALL-TESTS-GREEN"
  exit 0
fi
echo "HAS-FAILURE"
# ⚠️ 退出码必须跟着判定走。本脚本原先**只 echo 不 exit** ⇒ 退出码恒为 0，
#    于是 `npm test` / `bash _run_all_tests.sh && ...` 会把红灯报成通过
#    （这正是本项目一直在抓的"仪器自己撒谎"那一类：判定行是对的，退出码是假的）。
exit 1
