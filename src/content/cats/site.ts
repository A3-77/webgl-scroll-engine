/**
 * Cats 内容包 —— 站点配置
 * ---------------------------------------------------------------------------
 * 这是"素材驱动"包，场景与资产都由 build-assets 的 manifest 自动生成，
 * 所以这里**只**剩下与素材无关的东西：标题、字体、排版、过渡纹理。
 *
 * 用引擎默认的设计 token（中性系统字体栈），不做品牌化 ——
 * 这一版的目标是验证引擎，不是做一个好看的网站。
 */

import { DESIGN } from '../../config/design';
import { DEFAULT_TRANSITION_TEXTURES } from '../engine-assets';
// 依赖方向：content/ → schema/ ✓（契约层是唯一被两边共享的东西）
import type { AudioConfig, CarrierConfig, MediumConfig, PostConfig } from '../../schema';
import { POINTER_PARALLAX } from '../../schema';
import type { SiteConfig } from '../types';

/**
 * ★ Cats 包的胶片风格
 * ---------------------------------------------------------------------------
 * 为什么这里要显式声明一套，而不是直接用引擎默认值：
 *   DEFAULT_POST 是**中立**的（轻颗粒 + 轻色差），套在任何素材上都不会出错，
 *   但也因此没有性格。Cats 的素材是油画质感的猫，走"印刷/胶片"方向更合适 ——
 *   油墨网点、重颗粒、边缘色散，正好呼应参考站点 shader.se 的观感。
 *
 *   这就是「内容包声明审美，引擎只负责执行」这条分工的实际样子：
 *   换一套观感 = 改这个文件，引擎一行不动。
 *
 * 【几个值的来历】
 *   noise.opacity 0.11 —— 再高就开始盖掉画面细节（实测 0.15 时猫的胡须糊了）
 *   chromaticAberration.offset [0.0016, 0.0012] —— 约 2~3 像素 @1080p，
 *     静止时几乎看不见，切章时 ×2.2 才炸得出来
 *   scanline.density 1.6 —— 低于 1 会出摩尔纹
 *   bloom.intensity 0.7 —— 比默认低：油画本身亮部就多，泛光给大了会糊
 */
const POST: PostConfig = {
  enabled: true,
  frameBufferType: 'halfFloat',
  multisampling: 0,
  effects: [
    // 顺序有意义：先调色 → 再上质感 → 最后泛光。
    // 反过来的话，颗粒和色差会被 bloom 一起模糊掉，等于白加。
    {
      kind: 'brightnessContrast',
      brightness: 0.02,
      contrast: 1.06,
      pulse: 0,
    },
    {
      kind: 'hueSaturation',
      hue: 0,
      // 略降饱和：油画素材本身偏艳，压一点才有"印刷油墨"的味道
      saturation: 0.92,
      pulse: 0,
    },
    {
      kind: 'bloom',
      intensity: 0.7,
      luminanceThreshold: 0.66,
      luminanceSmoothing: 0.5,
      mipmapBlur: true,
      radius: 0.7,
      pulse: 0.4,
    },
    {
      kind: 'chromaticAberration',
      offset: [0.0016, 0.0012],
      radialModulation: true,
      modulationOffset: 0.3,
      // 切章瞬间色散炸开 —— 最抓眼球的一下
      pulse: 2.2,
    },
    {
      kind: 'noise',
      blend: 'overlay',
      opacity: 0.11,
      premultiply: false,
      pulse: 1.5,
    },
    {
      kind: 'scanline',
      density: 1.6,
      opacity: 0.045,
      pulse: 0.6,
    },
    {
      kind: 'vignette',
      offset: 0.28,
      darkness: 0.5,
      pulse: 0.5,
    },
  ],
};

/**
 * ★ Cats 包的声音
 * ---------------------------------------------------------------------------
 * 油画素材配的是"偏暗、安静、有空间感"的底噪：
 *   低频 drone（80Hz）+ 4 个去谐副本 + 一点混响 + 滚得快时滤波器打开。
 *
 * 【几个值的来历】
 *   pitch 80 —— 再低就变成"轰隆"，再高就开始抢戏
 *   voices 4 / detuneRange 14 —— 4 个副本 detune ±7 cents，
 *     听感是"一个音"而不是"四个音"，但明显更厚
 *   filterBase 320 → filterCeil 2600 —— 静止时闷、滚快时开，
 *     这是"画面在动，声音也在动"的关键
 *   tremolo 0.045 —— 只给一点点。0.1 以上就开始像"接触不良"
 *   transition.type 'both' —— 噪声（撕纸感）+ 短 bell（翻页感）叠一起
 *
 * ★ 默认 OFF：UI 上的开关点了才会真的响（浏览器自动播放策略）。
 */
const AUDIO: AudioConfig = {
  masterDb: -6,
  ambient: {
    enabled: true,
    pitch: 80,
    voices: 4,
    detuneRange: 14,
    filterBase: 320,
    filterCeil: 2600,
    reverb: 0.35,
    gainDb: -22,
  },
  transition: {
    enabled: true,
    type: 'both',
    duration: 0.18,
    gainDb: -12,
    filterFreq: 1800,
  },
  motion: {
    filterOpen: 1,
    tremolo: 0.045,
    velocityRef: 55,
  },
};

/**
 * ★ Cats 包的 3D 过渡载体（PHASE 23）
 * ---------------------------------------------------------------------------
 * 这是"画面不只是两张图叠化"的那一环：
 * 一个 3D 物体沿自动生成的曲线飞过，**溶解边界跟着它走** ——
 * 于是切章读起来是"画面被擦开"，而不是"两张图在混合"。
 *
 * 【为什么是 plane 而不是 GLB】
 *   素材驱动的包不该依赖任何外部模型文件。程序化的"一片纸"
 *   零素材依赖，而且形状最接近参考站点 shader.se 的飞机轮廓。
 *   真要做"飞机"的内容包，把 kind 换成 'glb' + model 指到自己的资产即可。
 *
 * 【几个值的来历】
 *   preset 'fly-across' —— SKY 的走向（左下远处 → 右上近处），
 *     比 'fly-through'（冲向镜头）温和，不抢画面内容
 *   follow 0.8 —— 溶解中心 80% 跟着载体走。给 1.0 会太"被牵着"，
 *     留 0.2 让章节自己的 fadeCenter 还有一点影响，边界更耐看
 *   organic 1 —— 多频正弦的完整强度（SKY 用的就是 1）
 *   emissive 0.4 —— 比默认 0.35 高一点：油画的亮部本来就多，
 *     不自发光的话载体会被背景吃掉
 *   scale 1.6 —— plane 原始尺寸 1.6×0.5 的世界单位，再放大就太抢戏
 */
const CARRIER: CarrierConfig = {
  enabled: true,
  preset: 'fly-across',
  kind: 'shape',
  shape: 'plane',
  scale: 2.2,
  // ★ 平面必须 billboard。用 'tangent' 的话平面法线朝前进方向，
  //   而它是横向飞过画面的 —— 屏幕上只剩一条细线，实测几乎看不见。
  orient: 'billboard',
  // ★ 深墨色剪影。素材是浅灰底的油画，纸白载体在上面完全隐形；
  //   深色在浅底上才读得出"有个东西飞过"。
  color: '#2b2622',
  follow: 0.8,
  organic: 1,
  // ★ 自发光给足（0.9）。深色物体靠"暗"是看不见的，
  //   要靠 bloom 在它边缘勾出一圈光晕才读得出"有个东西在飞"。
  //   0.12 实测太弱，载体在浅色背景上只是一块脏斑。
  emissive: 0.9,
  // ★ 必须半透明。素材是浅灰底的油画 ——
  //   不透明的深色 plane 在浅底上就是一个"洞"（实测比不加载体还难看）。
  //   0.42 读起来是"一片玻璃飞过"：看得见，又不挡内容。
  opacity: 0.42,
  onlyDuringTransition: true,
};

/**
 * ★ 媒介层（PHASE 25）—— 把画面印出来，而不是给它加滤镜。
 *
 * 【为什么 cats 包要用它】
 *   这套素材是**油画**（笔触、颜料堆叠、明显的色块边界）。
 *   油画 + 印刷网点 = "一张被印在纸上的油画"，
 *   这个组合在视觉上是自洽的 —— 印刷本来就是油画的复制方式。
 *
 * 【几个旋钮为什么取这些值】
 *   mono 0.45 —— 不用给到 1。完全灰度会把彩虹帽、蓝领带的色彩信息抹掉，
 *     而素材驱动的引擎不该替用户决定"这张图该不该有颜色"。
 *     0.45 保住了色调，同时让网点读起来像"印刷"而不是"噪点"。
 *
 *   halftoneScale 6 —— 落在"看得见网点结构"的区间（5~8）。
 *     给 2~4 太细密，和素材自身的笔触纹理打架；
 *     给 12+ 网点本身就成了图形语言，会盖过猫。
 *
 *   inkThreshold 0.08 —— 比出厂预设（0.06）保守一点。
 *     油画笔触本身就有大量亮度起伏，阈值太低会把每道笔触都描成线
 *     （实测效果是"猫糊了一层脏东西"）。0.08 只留下真正的轮廓。
 *
 *   paper 0.3 —— 纸纹要能感觉到但看不出来。它同时承担一个作用：
 *     给画面一个统一的底色，把五个主体"钉"在同一张纸上，
 *     否则它们看起来像五个各自剪下来贴上去的贴纸。
 *
 * ★ 分级（blackPoint / whitePoint / contrast）—— **这三个值是量出来的，不是调出来的**
 *
 *   做法：把 background.webp + 五张 subject-*.png 的亮度直方图统计一遍
 *   （只统计 alpha > 0.5 的主体像素），看它的实际色阶落在哪：
 *
 *     背景      p1 0.371  p50 0.731  p95 0.871  p99 0.904
 *     主体合并  p1 0.071  p50 0.808  p95 0.897  p99 0.917
 *     画面整体  p1 0.298  p50 0.744  p95 0.882  p99 0.909
 *
 *   为什么非做不可：不拉的话墨量「1 - 亮度」只有 0.09 ~ 0.70（中位数 0.26），
 *   每个格子里都是小点，整幅画印出来是一片浅灰米色 —— 像褪色旧照片。
 *   实测对照见 docs/PHASE-25-媒介层.md §7.5。
 *
 *   blackPoint 0.28 —— 略低于画面的 p1（0.298）。
 *     取 p1 会把最暗的那 1% 压成实黑，正好是我们要的"最深的几处阴影"。
 *
 *   whitePoint 0.97 —— **故意高于 p99（0.909）**，不是取 p99。
 *     取 p99 的话，猫的毛（p50 = 0.808，p95 = 0.897）会被直接推到白点以上，
 *     半径归零 —— 实测效果是"猫变成一张没有网点的白纸，只有背景有网点"，
 *     主体反而比背景更不像印刷品。
 *     抬到 0.97 之后猫毛保住 0.31 的点径（背景是 0.43），主体和背景都有网点，
 *     而真正的高光（0.92 以上）依然干净地留白。
 *
 *   contrast 只给 0.15 —— 这组素材本身**偏亮**（p50 = 0.744），
 *   绕 0.5 的 S 曲线会把中位往亮处推、反而减少墨量。
 *   所以主要靠 levels 拉伸，S 曲线只做一点点分离。
 *
 *   ★ 实测过：这一级再怎么调，都不可能把这组素材调成"双峰印品"
 *     （扫了 20 组参数，输出标准差上限约 0.215；参考站点版画是 0.263~0.344）。
 *     原因是源素材的亮度标准差只有 0.132 —— 一组高调浅色油画。
 *     实测数据见 docs/PHASE-25-媒介层.md §7.8。**这不是旋钮没调好，是素材如此。**
 */
const MEDIUM: MediumConfig = {
  enabled: true,
  mono: 0.45,
  blackPoint: 0.28,
  whitePoint: 0.97,
  contrast: 0.15,
  halftone: 0.55,
  halftoneScale: 6,
  halftoneAngle: 45,
  // ★ dither 默认 0 —— 这是**有意的**。
  //   有序抖动会把画面量化成 N 级色阶，从而产生大片实黑/纸白（"海报感"）。
  //   实测 dither 1.0 + levels 3 + contrast 0.5 → 近纸白 30.8%、标准差 0.241，
  //   与参考站点的 newsprint 版画（29.1% / 0.300）在同一区间。
  //   但那组素材是**油画** —— 用户要的是"一张被印在纸上的油画"，
  //   不是"一张被做成海报的油画"。所以留着当旋钮，谁想要海报感谁自己拧。
  dither: 0,
  inkEdge: 0.45,
  inkThreshold: 0.08,
  paper: 0.3,
  paperColor: '#efe7d6',
  inkColor: '#1a1714',
  // ★ 持续颗粒 —— 由墙上时钟驱动，**停下滚动它依然在跳**。
  //   这是"画面是活的"那一项：滚动和时间是两个独立驱动源，
  //   缺了它，用户停止滚动时画面会完全冻住。
  grain: 0.06,
  grainSpeed: 1,
  // 和 post 吃同一个活跃度 —— 切章时网点变粗与色差炸开严格同步
  pulse: 0.4,
};

export const SITE: SiteConfig = {
  title: 'WebGL Scroll Engine — Cats',
  font: DESIGN.font,
  type: DESIGN.type,
  transitionTextures: { ...DEFAULT_TRANSITION_TEXTURES },
  post: POST,
  audio: AUDIO,
  carrier: CARRIER,
  // ★ 媒介层（PHASE 25）。不声明 → 不跑任何 pass，画面与之前逐位相同。
  medium: MEDIUM,
  // ★ 指针视差（PHASE 26）。不声明 → 相机一个像素都不动。
  //   直接用出厂预设：幅度照搬参考站点（0.035 ≈ 目标距离处 ±2°），
  //   横纵不对称 [0.35, 0.25]（人眼对横向更敏感，纵向给满会晕），
  //   0.12s 一阶低通（指针是跳变输入，不平滑会"啪"地跳一下）。
  pointer: POINTER_PARALLAX,
};
