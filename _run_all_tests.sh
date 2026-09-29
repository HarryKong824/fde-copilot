set -u
# 全量回归。**EXIT 直接取（不走管道）**；判定行只从**本套件自己的 stdout** 取，
# 不去猜产物文件名（第一版猜文件名 ⇒ 读到了别的脚本的产物，制造了两处假警报）。
#
# ⚠️ 有一类套件**按设计不打印**（`_fde_dsl_test.mjs` 等：Windows 代码页会把中文打成乱码，
#    结果只落 `<...>_out.txt`）⇒ 它们的 `EXIT=0` 后面是**空**判定行，**不是**"没输出=没跑"。
#    这类要另读它自己的产物文件；本脚本对它不构成"跑过"的证据，只有 EXIT=0 + 非空脚本。
#    （反面教材：`_fde_d5_test.mjs` 曾 0 字节 ⇒ 空程序必然零断言 + EXIT=0。）
fail=0; vac=0; n=0
for t in _*_test.mjs; do
  n=$((n+1))
  size=$(stat -c %s "$t")
  [ "$size" -lt 400 ] && { vac=$((vac+1)); printf '%-46s ⚠️ 脚本仅 %sB（疑似空程序 ⇒ EXIT=0 无意义）\n' "$t" "$size"; }
  out=$(node "$t" 2>&1); code=$?
  verdict=$(printf '%s\n' "$out" | grep -E '^(RESULT:|状态：|结果：)' | tail -1)
  [ -z "$verdict" ] && verdict=$(printf '%s\n' "$out" | tail -1 | cut -c1-60)
  [ "$code" -ne 0 ] && fail=$((fail+1))
  printf '%-46s EXIT=%s  %s\n' "$t" "$code" "$verdict"
done
echo "----"
echo "共 $n 个套件；EXIT!=0 的 $fail 个；疑似空程序 $vac 个"
[ "$fail" -eq 0 ] && [ "$vac" -eq 0 ] && echo "ALL-TESTS-GREEN" || echo "HAS-FAILURE"
