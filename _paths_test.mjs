import { isInside, canonicalizeSync } from './dsh-fde-ontology-gate/lib/paths.js'
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  lstatSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = mkdtempSync(join(tmpdir(), 'fde-paths-'))
const root = join(base, 'ontology')
const evil = join(base, 'ontology-evil')
mkdirSync(root, { recursive: true })
mkdirSync(evil, { recursive: true })

let pass = 0, fail = 0
function check(name, got, want) {
  const ok = got === want
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
  ok ? pass++ : fail++
}

check('prefix trap: ontology-evil NOT inside ontology', isInside(evil, root), false)
check('positive subdir inside', isInside(join(root, 'a', 'b.json'), root), true)
check('root itself inside', isInside(root, root), true)
check('sibling dir NOT inside', isInside(join(base, 'other', 'x'), root), false)
check('new file under ontology inside', isInside(join(root, 'new.txt'), root), true)

const outside = join(base, 'work')
mkdirSync(outside, { recursive: true })
const escaped = join(outside, '..', 'ontology', 'evil.txt')
check('.. escape into ontology DETECTED', isInside(escaped, root), true)

const c = canonicalizeSync(join(root, 'brand', 'new.txt'))
check('canonicalize new file under root', isInside(c, root), true)

// symlink escape —— **必须先验证链接真的建成了**，否则 SKIP，不许拿退化夹具判 FAIL。
//
// 2026-09-24 实测：本机 `symlinkSync(target, link, 'dir')` **不抛错但静默退化成普通目录**
//   （lstat.isSymbolicLink=false、readlinkSync=EINVAL、经链接**看不到**目标里的 leak.txt）。
//   拿这种夹具跑 isInside(link/leak.txt, root) 得到 true —— 而 true 对"普通目录下的文件"
//   恰恰是**正确答案**，与 symlink 逃逸毫无关系。于是它是一条**假失败**：
//   常年飘红的测试会训练人忽略回归信号，危害等同于假绿（手册 §3 #6 的镜像情形）。
//
// 判据因此改成能力自检：经链接可见目标文件 **且** lstat 认它是符号链接，才算夹具成立。
// 能建链接的环境（开发者模式 / 管理员 / CI Linux）会真跑；本机器上诚实跳过。
const outsideDir = join(base, 'outside-secret')
mkdirSync(outsideDir, { recursive: true })
writeFileSync(join(outsideDir, 'leak.txt'), 'SECRET')
const secretLink = join(root, 'secret-link')
let symState = 'SKIP'
try {
  symlinkSync(outsideDir, secretLink, 'dir')
  let isLink = false
  try {
    isLink = lstatSync(secretLink).isSymbolicLink()
  } catch {
    isLink = false
  }
  const reachable = existsSync(join(secretLink, 'leak.txt'))
  if (isLink && reachable) {
    check('symlink pointing OUT is NOT inside ontology', isInside(join(secretLink, 'leak.txt'), root), false)
    symState = 'RAN'
  } else {
    symState = `SKIP(链接未真正建成: isSymbolicLink=${isLink} 经链接可见目标文件=${reachable}` +
      ` → 本机缺 SeCreateSymbolicLinkPrivilege / 未开开发者模式，此用例在此机器无信息量)`
  }
} catch (e) {
  symState = 'SKIP(' + e.code + ')'
}
// 故意反一次以验证退出码会变红（手册 §8 纪律：所有回归一视同仁，无"只管新增"豁免）。
// 本钩子属第二批补上（此前本套件不响应 FDE_INVERT）。
if (process.env.FDE_INVERT === '1') {
  check('[INVERT] 故意失败以验证退出码敏感', true, false)
}
console.log('symlink test:', symState)
console.log(`\nRESULT pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
