/**
 * 内容包脚手架 —— 一条命令创建一个新的素材驱动内容包
 * ===========================================================================
 *     npm run new-pack <id> [--label "显示名"] [--force]
 *
 * 生成 src/content/<id>/{index.ts,site.ts}，生成后**直接就能跑** ——
 * 不需要改任何别的地方，因为 content.config.ts 用 import.meta.glob
 * 自动发现内容包。
 *
 * ---------------------------------------------------------------------------
 * 【为什么需要这个】
 *
 *   这是"通用引擎"和"一个具体的网站"之间的分界线。
 *   没有脚手架的话，别人拿到这个仓库，得先读懂
 *   schema / ContentPack / build 钩子 / composeContent 这一串东西，
 *   才知道从哪下手 —— 那它就不是引擎，是一个"能跑起来的示例"。
 *
 * ---------------------------------------------------------------------------
 * 【生成什么】
 *
 *   素材驱动包（默认）：读 build-assets 产出的 manifest，自动构图。
 *   这也是这个引擎的主要用法 —— 用户只管丢图。
 *
 *   生成的两个文件刻意都很短，因为重复的流程都在 content/build.ts 里：
 *     index.ts  声明 id / label / site + 一行 build
 *     site.ts   标题、字体、排版 token、过渡纹理
 *
 *   ★ 模板里**不出现反引号**（除了最外层）—— 因为 shader 那次教训：
 *     模板字符串套模板字符串极易出错，能避就避。
 * ===========================================================================
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const contentDir = path.join(projectRoot, 'src', 'content');

/* ------------------------------------------------------------ 参数解析 */

function parseArgs(argv) {
  const positional = [];
  const flags = { force: false, label: null };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force' || a === '-f') flags.force = true;
    else if (a === '--label' || a === '-l') flags.label = argv[++i];
    else if (a.startsWith('--label=')) flags.label = a.slice('--label='.length);
    else positional.push(a);
  }
  return { positional, flags };
}

/** 包 id 会被用作目录名、URL 参数、以及 ContentPack.id —— 限制得严一点 */
function validateId(id) {
  if (!id) return '缺少包 id。用法：npm run new-pack <id>';
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    return (
      '包 id 只能用「小写字母开头 + 小写字母/数字/连字符」，' +
      '例如 cats、my-project、landing-v2'
    );
  }
  if (id === 'placeholder') return 'placeholder 是引擎自检包，不要覆盖它';
  return null;
}

/** 包 id → 人类可读的默认显示名（'my-project' → 'My Project'） */
function defaultLabel(id) {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/* ------------------------------------------------------------ 模板 */

function siteTemplate(label) {
  return [
    '/**',
    ' * ' + label + ' 内容包 —— 站点配置',
    ' * ---------------------------------------------------------------------------',
    ' * 这里放**与素材无关**的东西：浏览器标题、字体、排版 token、过渡纹理。',
    ' * 场景和资产由 build-assets 的 manifest 自动生成，不在这里声明。',
    ' *',
    ' * 目前用的是引擎默认的设计 token（中性系统字体栈）。',
    ' * 想品牌化就改这里的 font / type —— 它们会被写成 CSS 变量，',
    ' * 整站的字号阶梯一次性跟着变。',
    ' */',
    '',
    "import { DESIGN } from '../../config/design';",
    "import { DEFAULT_TRANSITION_TEXTURES } from '../engine-assets';",
    "import type { SiteConfig } from '../types';",
    '',
    'export const SITE: SiteConfig = {',
    "  title: '" + label + "',",
    '  font: DESIGN.font,',
    '  type: DESIGN.type,',
    '  // 过渡用的噪声图与法线图。换一张噪声 = 完全不同的边界质感。',
    '  transitionTextures: { ...DEFAULT_TRANSITION_TEXTURES },',
    '};',
    '',
  ].join('\n');
}

function indexTemplate(id, label) {
  return [
    '/**',
    ' * ' + label + ' 内容包',
    ' * ---------------------------------------------------------------------------',
    ' * 素材驱动：场景由 build-assets 产出的 manifest 自动构图。',
    ' * 这个文件里**没有一行场景配置** —— 换 input/ 里的图 + 重跑 build-assets',
    ' * 就能换内容，不需要改任何代码。',
    ' *',
    ' * 【调构图参数】',
    ' *   全部旋钮见 asset-pipeline/compose.ts 的 DEFAULTS。传进来即可：',
    ' *',
    ' *     build: ({ aspect }) => buildContent({ aspect, dolly: -9, dist: [16, 40] }),',
    ' *',
    ' * 【用另一份 manifest】',
    ' *   一个项目里放两套互不相干的素材时，用 build-assets 的 --out 写到别的目录：',
    ' *',
    ' *     build: ({ aspect }) => buildContent({ aspect, manifestUrl: "/content-x/manifest.json" }),',
    ' */',
    '',
    "import { buildContent } from '../build';",
    "import type { BuildContext, ContentPack, ResolvedContent } from '../types';",
    "import { SITE } from './site';",
    '',
    'export const pack: ContentPack = {',
    "  id: '" + id + "',",
    "  label: '" + label + "',",
    '  description:',
    "    '素材驱动 · 场景由 build-assets 的 manifest 自动构图。' +",
    "    '换 input/ 里的图片即可换内容，不需要改任何代码。',",
    '',
    '  site: SITE,',
    '',
    '  build: ({ aspect }: BuildContext): Promise<ResolvedContent> => buildContent({ aspect }),',
    '};',
    '',
    'export { SITE };',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------ 主流程 */

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const id = positional[0];

  const idError = validateId(id);
  if (idError) {
    console.error('\n✗ ' + idError + '\n');
    process.exit(1);
  }

  const label = flags.label || defaultLabel(id);
  const dir = path.join(contentDir, id);

  if (existsSync(dir) && !flags.force) {
    console.error(
      [
        '',
        '✗ src/content/' + id + '/ 已经存在。',
        '',
        '  想覆盖它加 --force（会丢掉原有内容）：',
        '      npm run new-pack ' + id + ' --force',
        '',
        '  只是想换内容？直接编辑 src/content/' + id + '/site.ts。',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'site.ts'), siteTemplate(label), 'utf8');
  writeFileSync(path.join(dir, 'index.ts'), indexTemplate(id, label), 'utf8');

  console.log(
    [
      '',
      '✓ 创建了内容包 "' + id + '"（' + label + '）',
      '',
      '    src/content/' + id + '/index.ts    ← 包声明 + build 钩子',
      '    src/content/' + id + '/site.ts     ← 标题 / 字体 / 过渡纹理',
      '',
      '  它会被自动发现（content.config.ts 用 import.meta.glob 扫描 src/content/*/）。',
      '',
      '  接下来：',
      '    1. 把图片放进 input/（文件名决定章节顺序，如 scene01.jpg）',
      '    2. npm run build-assets',
      '    3. npm run dev' + (id === 'cats' ? '' : '  然后访问  ?content=' + id),
      '',
      '  改 site.ts 里的 title / font / type 就能换掉标题与字体。',
      '',
    ].join('\n'),
  );
}

main();
