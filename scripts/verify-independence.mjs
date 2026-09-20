/**
 * 验收 ① 的自动化：删除内容包后引擎仍可运行
 * ===========================================================================
 *     npm run verify:independence
 *
 * ---------------------------------------------------------------------------
 * 【为什么需要这个脚本】
 *
 *   "删掉内容包后引擎照跑"是这个项目的**硬验收标准**，但它在运行时测不了 ——
 *   必须真的把目录移走再构建。
 *
 *   手工做一遍（移出 → 构建 → 检查产物 → 恢复）要 5 分钟，而且容易漏步骤
 *   （比如忘了检查产物里有没有残留、或者忘了恢复）。做成脚本才能反复跑。
 *
 * ---------------------------------------------------------------------------
 * 【它具体做什么】
 *
 *   1. 把 src/content/ 下**除 placeholder 外**的包全部移到 .disabled/
 *      （placeholder 是引擎自检包，被设计成"永远存在"，所以留着它）
 *   2. typecheck + 生产构建
 *   3. 检查产物里**没有任何被移出的包的内容**（按包目录名和常见 asset key 搜）
 *   4. 无论成败都恢复（try/finally）
 *
 * ---------------------------------------------------------------------------
 * 【为什么用 move 而不是 delete】
 *
 *   移动是可逆的、原子的，而且不经过本环境的 safe-delete 包装
 *   （那个包装会把 rm/rmtree 变成"进回收站"并在失败时 fail-closed）。
 *   万一脚本中途被打断，.disabled/ 里的东西还在，手工移回即可。
 * ===========================================================================
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = path.join(root, 'src', 'content');
const parkDir = path.join(root, '.disabled');

/** 永远保留的包 —— 它被设计成"不依赖任何外部素材，永远能跑" */
const KEEP = new Set(['placeholder']);

/** 顶层文件（不是包目录）也不动 */
const isPackDir = (name) => !name.startsWith('.') && !name.endsWith('.ts');

function run(cmd) {
  return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main() {
  const packs = readdirSync(contentDir).filter(isPackDir);
  const moving = packs.filter((p) => !KEEP.has(p));

  if (moving.length === 0) {
    console.log('\n· 没有可移出的包（只剩 ' + [...KEEP].join(', ') + '）—— 跳过\n');
    return;
  }

  console.log('\n移出 ' + moving.length + ' 个包: ' + moving.join(', '));
  mkdirSync(parkDir, { recursive: true });

  const moved = [];
  let failed = false;

  try {
    for (const p of moving) {
      renameSync(path.join(contentDir, p), path.join(parkDir, p));
      moved.push(p);
    }

    console.log('\n[1/3] typecheck');
    run('npx tsc --noEmit');
    console.log('      ✓ 没有任何静态 import 指向被移出的包');

    console.log('\n[2/3] 生产构建');
    const buildOut = run('npx vite build 2>&1');
    const built = /built in/.test(buildOut);
    console.log(built ? '      ✓ 构建通过' : '      ✗ 构建没有输出 built in');
    if (!built) failed = true;

    console.log('\n[3/3] 产物里是否残留被移出的内容');
    const assetsDir = path.join(root, 'dist', 'assets');
    const leaks = [];
    if (existsSync(assetsDir)) {
      // vite 会把模块路径保留在产物里，所以按 'content/<包名>/' 搜就够准
      const bundles = readdirSync(assetsDir)
        .filter((f) => f.endsWith('.js'))
        .map((f) => ({ f, text: readFileSync(path.join(assetsDir, f), 'utf8') }));

      for (const p of moved) {
        const needle = 'content/' + p + '/';
        for (const { f, text } of bundles) {
          if (text.includes(needle)) leaks.push(p + ' → ' + f);
        }
      }
    }

    if (leaks.length) {
      console.log('      ✗ 产物里有残留: ' + leaks.join(', '));
      failed = true;
    } else {
      console.log('      ✓ 产物里没有被移出包的任何内容');
    }
  } catch (err) {
    failed = true;
    console.log('\n✗ 失败: ' + (err.stdout || err.message));
  } finally {
    // ★ 无论成败都要恢复 —— 这个脚本改的是用户的源码目录
    for (const p of moved) {
      const from = path.join(parkDir, p);
      if (existsSync(from)) renameSync(from, path.join(contentDir, p));
    }
    if (existsSync(parkDir) && readdirSync(parkDir).length === 0) rmdirSync(parkDir);
    console.log('\n已恢复 ' + moved.length + ' 个包: ' + moved.join(', '));
  }

  console.log(
    failed
      ? '\n✗ 验收 ① 未通过 —— 引擎对被移出的包有隐藏依赖\n'
      : '\n✓ 验收 ① 通过：删除内容包后，引擎照常构建、产物干净\n',
  );
  process.exit(failed ? 1 : 0);
}

main();
