/**
 * 守卫：GLSL 模板字符串里不能出现反引号
 * ===========================================================================
 * 【为什么需要这个测试】
 *
 * 本项目把 GLSL 内联在 TS 的模板字符串里（`export const X_FRAGMENT = <glsl 标记>`
 * 后面跟一个反引号，最后以 反引号 + 分号 收尾）。
 * 于是在**注释里写一个反引号**就会提前终止字符串，剩下的 GLSL 变成 JS，
 * 整个文件语法错误。这个坑在本项目已经踩了三次（SKILL §4.1）。
 *
 * 【为什么 typecheck 不够】
 *
 * typecheck 确实能抓到它，但报错信息指不到点子上 —— 本次报的是
 * `src/shaders/medium.ts(162,15): error TS1005: ',' expected.`，
 * 而真正的问题是"第 162 行的注释里有一对反引号"。
 * 更糟的是**成对**的反引号会让总数保持偶数，
 * 所以"数一下反引号是不是偶数"这种检查完全抓不到 —— 配对关系平移了。
 *
 * 【★ 这个测试必须把源码当**文本**读，不能 import 它】
 *
 * 因为出问题时那个文件是**语法错误**的，import 它会连测试文件一起加载失败，
 * 守卫就永远不会跑。用 Vite 的 `?raw` 导入拿到的是一段字符串，
 * Vite 只做文件读取、不做语法分析，所以文件坏着也能跑。
 * —— 这正是"验收脚本自己也需要被验收"（SKILL §6.7）的一个实例。
 *
 * （不用 `node:fs` 是因为本项目没装 `@types/node`，
 *   tsconfig 的 types 只有 `vite/client`；`?raw` 用的是现成的基础设施。）
 *
 * 【判定规则】
 *
 * 模板字符串在本项目的写法是固定的两行：
 *     开启：以反引号**结尾**的非注释行
 *     关闭：内容恰好是 反引号 + 分号 的行
 * 两者之间不允许出现任何反引号。
 * 模板**之外**的注释（文件头那种）随便写反引号 —— 那里是普通注释。
 */

import { describe, expect, it } from 'vitest';

/** key 形如 './medium.ts'，value 是源码原文 */
const SOURCES = import.meta.glob(['./*.ts', '!./*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface Violation {
  file: string;
  line: number;
  text: string;
}

/** 扫一份 shader 源码，返回"模板字符串内部出现反引号"的位置 */
function scan(file: string, source: string): Violation[] {
  const out: Violation[] = [];
  let inside = false;
  let openedAt = 0;

  source.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const lineNo = i + 1;

    if (!inside) {
      // 开启：以反引号结尾，且不是注释行
      const isComment = line.startsWith('*') || line.startsWith('//');
      if (!isComment && line.endsWith('`')) {
        inside = true;
        openedAt = lineNo;
      }
      return;
    }

    // 关闭
    if (line === '`;' || line === '`') {
      inside = false;
      return;
    }

    if (line.includes('`')) {
      out.push({ file, line: lineNo, text: raw.trim() });
    }
  });

  // 没闭合说明开启/关闭的写法漂移了，守卫自己已经失效 —— 必须报出来
  if (inside) {
    out.push({ file, line: openedAt, text: '⚠ 模板字符串找不到闭合行，守卫规则可能已失效' });
  }

  return out;
}

const files = Object.keys(SOURCES).sort();

describe('shader 源码守卫', () => {
  it('确实扫到了 shader 文件（防止 glob 写错导致空跑通过）', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.some((f) => f.endsWith('medium.ts'))).toBe(true);
    // 反向断言：测试文件本身不该被扫进来
    expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false);
  });

  it('★ 每个 shader 的模板字符串内部都没有反引号', () => {
    const bad: Violation[] = [];
    for (const f of files) {
      bad.push(...scan(f, SOURCES[f]));
    }

    const detail = bad.map((v) => `${v.file}:${v.line}  ${v.text}`).join('\n');
    expect(
      bad,
      `模板字符串里出现了反引号（会截断 GLSL，导致 TS1005 且报错行指不准）：\n${detail}`,
    ).toEqual([]);
  });
});
