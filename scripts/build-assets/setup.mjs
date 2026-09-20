#!/usr/bin/env node
/**
 * 一步建好素材流水线的 Python 环境
 * ============================================================================
 *   npm run build-assets:setup
 *
 * 做的事：
 *   1. 在项目根建 .venv（已存在就复用）
 *   2. 装 numpy + pillow
 *   3. 打印诊断结果（解释器路径、版本、依赖版本）
 *
 * 为什么用项目内 .venv 而不是全局装：
 *   全局装会污染用户环境，而且不同项目的 numpy 版本可能打架。
 *   .venv 是 Python 的既有惯例，.gitignore 掉即可，用户删掉重跑就恢复。
 * ============================================================================
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const isWin = process.platform === 'win32';

const venvDir = path.join(projectRoot, '.venv');
const venvPython = isWin
  ? path.join(venvDir, 'Scripts', 'python.exe')
  : path.join(venvDir, 'bin', 'python');

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n✗ ${label} 失败（退出码 ${r.status}）`);
    process.exit(1);
  }
}

/* ---------------------------------------------- 找一个能建 venv 的 Python */

function findBasePython() {
  if (process.env.EW_PYTHON) return { cmd: process.env.EW_PYTHON, args: [] };

  const tries = isWin
    ? [
        { cmd: 'python', args: [] },
        { cmd: 'py', args: ['-3'] },
        { cmd: 'python3', args: [] },
      ]
    : [
        { cmd: 'python3', args: [] },
        { cmd: 'python', args: [] },
      ];

  for (const t of tries) {
    const probe = spawnSync(t.cmd, [...t.args, '-c', 'import venv, sys; print(sys.executable)'], {
      encoding: 'utf8',
    });
    if (probe.status === 0) return t;
  }
  return null;
}

/* -------------------------------------------------------------- 主流程 */

function main() {
  console.log('▸ 准备素材流水线的 Python 环境\n');

  if (existsSync(venvPython)) {
    console.log(`  .venv 已存在，复用: ${path.relative(projectRoot, venvPython)}`);
  } else {
    const base = findBasePython();
    if (!base) {
      console.error(
        [
          '✗ 找不到可用的 Python 3。',
          '',
          '  请先安装 Python 3.9+（https://www.python.org/downloads/），',
          '  或者用 EW_PYTHON 指定已有解释器：',
          '    EW_PYTHON=/path/to/python npm run build-assets:setup',
          '',
        ].join('\n'),
      );
      process.exit(1);
    }

    console.log(`  用 ${base.cmd} 创建 .venv …`);
    run(base.cmd, [...base.args, '-m', 'venv', venvDir], '创建虚拟环境');
    console.log(`  ✓ .venv → ${path.relative(projectRoot, venvDir)}`);
  }

  console.log('\n▸ 安装依赖 (numpy, pillow) …');
  run(venvPython, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'], '升级 pip');
  run(venvPython, ['-m', 'pip', 'install', '--quiet', 'numpy', 'pillow'], '安装依赖');

  console.log('\n▸ 诊断');
  const diag = spawnSync(
    venvPython,
    [
      '-c',
      [
        'import sys, numpy, PIL',
        'print(f"  python   {sys.version.split()[0]}  ({sys.executable})")',
        'print(f"  numpy    {numpy.__version__}")',
        'print(f"  pillow   {PIL.__version__}")',
      ].join('\n'),
    ],
    { encoding: 'utf8' },
  );
  process.stdout.write(diag.stdout || '');
  if (diag.status !== 0) {
    console.error(diag.stderr || '');
    process.exit(1);
  }

  console.log('\n✓ 就绪。接下来：');
  console.log('    npm run build-assets        # 处理 input/ 下的图片');
  console.log('    npm run dev                 # 启动开发服务器\n');
}

main();
