#!/usr/bin/env node
/**
 * build-assets 的 Node 入口
 * ============================================================================
 * `npm run build-assets` 实际执行的就是这个文件。
 *
 * 它只做三件事，不碰任何图像处理逻辑：
 *   1. 找到可用的 Python 解释器
 *   2. 校验它装了 numpy + pillow（缺了就给出**可直接复制粘贴**的安装命令）
 *   3. 用正确的 cwd 调 `python -m pipeline.main`，把参数透传过去，退出码透传回来
 *
 * 为什么不把图像处理也写在 Node 里：
 *   连通域标记、形态学、金字塔填充这些在 numpy 里是几十行，
 *   在 Node 里要么自己重写、要么引 sharp/opencv 之类的重依赖。
 *   构建期脚本用 Python 是最省事也最可维护的选择。
 * ============================================================================
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');

const isWin = process.platform === 'win32';

/* ------------------------------------------------------------ 找 Python */

/**
 * 按优先级列出候选解释器。
 *
 * ★ 返回**列表**而不是"第一个能跑的"，这一点很关键。
 *   真实踩过：PATH 上的 `python` 能跑（是个干净的 3.13），但没装 numpy；
 *   而项目 `.venv` 或托管环境里有 numpy 却排在后面。
 *   旧实现取第一个"能跑"的 → 报"缺少依赖 numpy, pillow"，
 *   而实际上机器上**就有一个装好依赖的解释器**，只是没被选中。
 *   现在由调用方按"能跑 **且** 依赖齐"来挑。
 */
function listPythons() {
  const candidates = [];

  // 1. 显式指定优先
  if (process.env.EW_PYTHON) candidates.push({ cmd: process.env.EW_PYTHON, why: 'EW_PYTHON' });

  // 2. 项目内的 .venv（最推荐 —— 隔离、可复现、跟着项目走）
  candidates.push({
    cmd: isWin
      ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
      : path.join(projectRoot, '.venv', 'bin', 'python'),
    why: '项目 .venv',
    mustExist: true,
  });

  // 3. WorkBuddy 托管的 Python 环境。
  //    这不是通用路径，但它在本机是**默认会命中**的那个 ——
  //    因为 npm 脚本是从这个工具链里跑的，用户不该为了跑一条 npm 命令
  //    先去手工配一个虚拟环境。
  const home = os.homedir();
  if (home) {
    candidates.push({
      cmd: isWin
        ? path.join(home, '.workbuddy-ai', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe')
        : path.join(home, '.workbuddy-ai', 'binaries', 'python', 'envs', 'default', 'bin', 'python'),
      why: 'WorkBuddy 托管环境',
      mustExist: true,
    });
  }

  // 4. PATH 上的 python3 / python
  candidates.push({ cmd: isWin ? 'python' : 'python3', why: 'PATH' });
  if (isWin) candidates.push({ cmd: 'py', why: 'PATH (py launcher)', args: ['-3'] });
  candidates.push({ cmd: 'python', why: 'PATH' });

  const usable = [];
  for (const c of candidates) {
    if (c.mustExist && !existsSync(c.cmd)) continue;
    const probe = spawnSync(c.cmd, [...(c.args ?? []), '-c', 'import sys; print(sys.version_info[:2])'], {
      encoding: 'utf8',
      shell: false,
    });
    if (probe.status === 0) {
      usable.push({ ...c, version: (probe.stdout || '').trim() });
    }
  }
  return usable;
}

/* ------------------------------------------------------ 检查依赖是否齐 */

const REQUIREMENTS = [
  { mod: 'numpy', pkg: 'numpy', why: '全部像素运算' },
  { mod: 'PIL', pkg: 'pillow', why: '图片读写与编码' },
];

function missingDeps(python) {
  const missing = [];
  for (const r of REQUIREMENTS) {
    const probe = spawnSync(
      python.cmd,
      [...(python.args ?? []), '-c', `import ${r.mod}`],
      { encoding: 'utf8' },
    );
    if (probe.status !== 0) missing.push(r);
  }
  return missing;
}

/* ---------------------------------------------------------------- 主流程 */

function main() {
  const passthrough = process.argv.slice(2);

  const usable = listPythons();
  if (!usable.length) {
    console.error(
      [
        '',
        '✗ 找不到可用的 Python 3。',
        '',
        '  素材流水线需要 Python（用于连通域标记 / 形态学 / 金字塔填充）。',
        '  请任选一种方式：',
        '',
        '    A. 项目内建虚拟环境（推荐，隔离且可复现）',
        '         npm run build-assets:setup',
        '',
        '    B. 用已有的 Python',
        '         python -m venv .venv',
        isWin
          ? '         .venv\\Scripts\\pip install numpy pillow'
          : '         .venv/bin/pip install numpy pillow',
        '',
        '    C. 指定解释器路径',
        '         EW_PYTHON=/path/to/python npm run build-assets',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  // ★ 挑「能跑 **且** 依赖齐」的第一个。
  //   只有全都不齐时，才退回到第一个能跑的来报错 —— 这样错误信息里
  //   给出的安装命令至少是针对一个真实存在的解释器的。
  let python = null;
  for (const c of usable) {
    if (missingDeps(c).length === 0) {
      python = c;
      break;
    }
  }

  if (!python) {
    python = usable[0];
    const missing = missingDeps(python);
    const pip = isWin
      ? path.join(projectRoot, '.venv', 'Scripts', 'pip.exe')
      : path.join(projectRoot, '.venv', 'bin', 'pip');
    const pipCmd = python.why === '项目 .venv' ? pip : `${python.cmd} -m pip`;
    console.error(
      [
        '',
        `✗ 找到 ${usable.length} 个 Python，但没有一个装齐了依赖。`,
        `  最靠前的那个是 ${python.cmd}（来源：${python.why}），缺: ${missing.map((m) => m.pkg).join(', ')}`,
        '',
        ...missing.map((m) => `    ${m.pkg.padEnd(8)} — ${m.why}`),
        '',
        '  安装（推荐项目内虚拟环境，隔离且可复现）：',
        '    npm run build-assets:setup',
        '',
        '  或者装进上面那个解释器：',
        `    ${pipCmd} install ${missing.map((m) => m.pkg).join(' ')}`,
        '',
        '  也可以直接指定一个装好依赖的解释器：',
        '    EW_PYTHON=/path/to/python npm run build-assets',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  // cwd 必须是 scripts/build-assets，`python -m pipeline.main` 才能找到包
  //
  // --selftest 是个例外：它跑的是 pipeline.selftest（算子自检），
  // 不是 pipeline.main 的参数。在这里拦掉，免得 argparse 报 unknown argument。
  const selftest = passthrough.includes('--selftest');
  const module = selftest ? 'pipeline.selftest' : 'pipeline.main';
  const args = selftest ? passthrough.filter((a) => a !== '--selftest') : passthrough;

  const result = spawnSync(
    python.cmd,
    [...(python.args ?? []), '-m', module, ...args],
    { cwd: here, stdio: 'inherit', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
  );

  if (result.error) {
    console.error('✗ 执行失败:', result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

main();
