/**
 * ★ 媒介层 shader（PHASE 25）
 * ===========================================================================
 * 把一张渲染结果**重新表达成另一种材料**：单色化 → 网点 → 有序抖动
 * → 墨线 → 纸纹 → 持续颗粒。
 *
 * ---------------------------------------------------------------------------
 * 【它和 post.ts 里那些 shader 的根本区别】
 *
 *   post 的效果只读颜色缓冲。它们能加光、能错位通道、能叠噪声，
 *   但永远不知道"画面里什么东西在前面"。
 *
 *   本文件有两处**必须**读几何信息：
 *     ▸ 墨线要读 `tDepth` —— 靠深度不连续才能勾出轮廓
 *     ▸ 网点要读 `gl_FragCoord` —— 网格锚在**屏幕**上而不是贴在图上
 *   少了这两样，做出来的只是"印刷风格的滤镜"，不是"印刷"。
 *
 * ---------------------------------------------------------------------------
 * 【★ 三条容易写错的纪律，都踩过】
 *
 *   ① 墨线必须读**原始颜色**，不能读已经上完网点的颜色。
 *      网点本身是高频的墨点阵列 —— 拿它算亮度梯度，整张画面会被
 *      网点网格自己勾满边，看起来像加了一层噪点描边。
 *      所以本文件先 `vec3 src` 存住原始值，墨线只吃 src。
 *
 *   ② 深度差要用**相对差**，不能用绝对差。
 *      透视投影下远处的深度值天然大得多：绝对差会让近处的东西没边、
 *      远处的东西全是边。除以自身深度之后，远近才可比。
 *
 *   ③ 亮度梯度要**阈值化**，不能直接当强度用。
 *      强边缘处相邻像素可以从黑跳到白（梯度≈1.0），而毛发的微观起伏
 *      只有 0.1~0.2。不设阈值的话，毛发、布料、云这类高频纹理会被
 *      整片描成线 —— 浅色主体看起来像糊了一层脏东西。
 *      实测踩过：阈值给太低，猫的毛被描成一团乱麻。
 *
 * ---------------------------------------------------------------------------
 * 【★ 零行为变更契约】
 *
 *   所有强度为 0 时，本 shader 输出与输入**逐位相同**（每一步都是
 *   `mix(x, f(x), 0)`，而 `mix(a, b, 0)` 严格等于 a）。
 *   这是硬要求：不声明媒介层的内容包必须完全不受影响。
 * ===========================================================================
 */

export const MEDIUM_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2  uTexel;        // 1 / resolution
uniform float uNear;
uniform float uFar;
uniform float uTime;
uniform float uHasDepth;     // 0 = 没有深度缓冲，墨线自动降级为纯亮度梯度

uniform float uMono;
uniform float uBlackPoint;
uniform float uWhitePoint;
uniform float uContrast;
uniform float uHalftone;
uniform float uHalftoneScale;
uniform float uHalftoneAngle;
uniform float uDither;
uniform float uDitherLevels;
uniform float uInkEdge;
uniform float uInkThreshold;
uniform float uPaper;
uniform vec3  uPaperColor;
uniform vec3  uInkColor;
uniform float uGrain;
uniform float uGrainSpeed;

varying vec2 vUv;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

/* ------------------------------------------------------------ 工具 */

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

/**
 * 把非线性深度缓冲值还原成**线性**深度。
 *
 * 深度缓冲里存的不是距离 —— 它经过了透视除法，近处占了绝大部分精度。
 * 直接拿它做差，得到的"深度差"在近处被放大、远处被压缩，
 * 勾出来的边会随距离变粗变细。必须先线性化。
 */
float linearizeDepth(float d) {
  float ndc = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}

float lumaAt(vec2 uv) {
  return dot(texture2D(tDiffuse, uv).rgb, LUMA);
}

/**
 * Bayer 4×4 有序抖动。
 *
 * 用递归解析式而不是查表：GLSL1 里数组初始化很啰嗦，而且这里
 * 每像素只多两次 fract —— 比 16 次比较的查表还便宜。
 * 基元 bayer2 的四个值恰好是 [[0,2],[3,1]]/4，递归展开就是标准矩阵。
 */
float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x * 0.5 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) {
  return bayer2(a * 0.5) * 0.25 + bayer2(a);
}

/* ------------------------------------------------------------ 墨线 */

/**
 * 轮廓强度 0..1。
 *
 * @param uv       当前像素
 * @param srcLuma  原始亮度（★ 不是网点化之后的，理由见文件头纪律①）
 */
float inkLine(vec2 uv, float srcLuma) {
  // ---- 亮度梯度：抓物体内部的纹理轮廓 ----
  float lR = lumaAt(uv + vec2(uTexel.x, 0.0));
  float lL = lumaAt(uv - vec2(uTexel.x, 0.0));
  float lU = lumaAt(uv + vec2(0.0, uTexel.y));
  float lD = lumaAt(uv - vec2(0.0, uTexel.y));
  float lumGrad = length(vec2(lR - lL, lU - lD));

  // ---- 深度不连续：抓物体与背景的交界 ----
  // 没有深度缓冲时整项归零，墨线优雅降级成纯亮度梯度，不报错
  float depthEdge = 0.0;
  if (uHasDepth > 0.5) {
    float d0 = linearizeDepth(texture2D(tDepth, uv).x);
    float dR = linearizeDepth(texture2D(tDepth, uv + vec2(uTexel.x, 0.0)).x);
    float dL = linearizeDepth(texture2D(tDepth, uv - vec2(uTexel.x, 0.0)).x);
    float dU = linearizeDepth(texture2D(tDepth, uv + vec2(0.0, uTexel.y)).x);
    float dD = linearizeDepth(texture2D(tDepth, uv - vec2(0.0, uTexel.y)).x);

    // 相对差（纪律②）：除以自身深度，远近才可比
    float inv = 1.0 / max(d0, 1e-3);
    float gx = abs(dR - dL) * inv;
    float gy = abs(dU - dD) * inv;
    depthEdge = smoothstep(uInkThreshold, uInkThreshold * 4.0, gx + gy);
  }

  // 阈值化（纪律③）：只保留真正的轮廓，放过毛发级的微观起伏
  float lumEdge = smoothstep(0.10, 0.45, lumGrad);

  // ★★ 深度存在时，亮度项必须**得到深度的支持**才画满。
  //
  //   没有这一道门的话，「max(depthEdge, lumEdge)」会让**背景的纹理**
  //   也被描成线 —— 实测（inkEdge=1 + 红色墨）背景里补洞留下的块状痕迹
  //   整片变红，而真正的物体轮廓反而淹没在里面。
  //
  //   这正是字段注释里写的那件事："只用亮度梯度的话，背景的云、水波
  //   都会被描成线；加上深度之后，只有真正'立着的东西'才会被勾边。"
  //   但光把两项取 max 是**做不到**这一点的 —— 必须让深度当闸门。
  //
  //   留 0.25 的底不是为了好看：物体**内部**的纹理轮廓（猫的胡须、
  //   领带条纹）深度是连续的，完全掐掉会把它们一起丢掉。
  float gate = (uHasDepth > 0.5) ? (0.25 + 0.75 * depthEdge) : 1.0;

  return max(depthEdge, lumEdge * gate);
}

/* ------------------------------------------------------------ 单色分级 */

/**
 * ①' 单色分级 —— 把素材那点**窄色调范围**拉开。
 *
 * ★ 这一级是"照片能不能印出图形感"的分水岭，别把它当成可有可无的调色。
 *
 *   实测 cats 素材：整幅画面的亮度只分布在 0.30 ~ 0.91
 *   （p1 = 0.298，p99 = 0.909，见 docs/PHASE-25-媒介层.md §7.5）。
 *   直接拿它算墨量「1 - 亮度」，得到的是 0.09 ~ 0.70 —— 中位数只有 0.26，
 *   于是**每个格子里的网点都是小点**，整幅画印出来是一片浅灰米色。
 *   看起来像一张褪色的旧照片，而不是印刷品。
 *
 *   参考站点不需要这一级，是因为它们的场景是**美术指导过的**
 *   （深色背景 + 高饱和色块，本来就跨越全色阶）。
 *   本引擎的输入是普通照片，所以必须补上。
 *
 * 两级，顺序不能换：
 *   1. levels —— 黑白场拉伸。低于黑场的算全黑（网点铺满），高于白场的算全白
 *   2. contrast —— 绕 0.5 的 S 曲线，增益 = 1 + 对比 × 2
 *
 * ★ 这一级的输出**只喂给网点屏**，不改颜色、也不喂墨线：
 *   ▸ 不喂墨线是因为墨线看的是**梯度**，拉伸会把噪点放大成假边
 *   ▸ 不改颜色是因为"这张图是什么颜色"不该由印刷参数决定（见纪律②）
 */
float gradeTone(float l) {
  l = clamp((l - uBlackPoint) / max(uWhitePoint - uBlackPoint, 1e-3), 0.0, 1.0);
  return clamp((l - 0.5) * (1.0 + uContrast * 2.0) + 0.5, 0.0, 1.0);
}

/* ------------------------------------------------------------ 主函数 */

void main() {
  vec2 uv = vUv;
  vec4 srcTexel = texture2D(tDiffuse, uv);
  vec3 src = srcTexel.rgb;
  float srcLuma = dot(src, LUMA);

  // ---------------------------------------------------------- ① 单色化
  vec3 c = mix(src, vec3(srcLuma), uMono);

  // ①' 分级 —— 网点屏的墨量从这里来，不是从原始亮度来
  float inkTone = gradeTone(srcLuma);

  // ---------------------------------------------------------- ② 网点
  //
  // ★ 网格锚在**屏幕空间**（gl_FragCoord），不是 UV 空间。
  //   用 UV 的话，网点会随画面缩放一起伸缩 —— 看起来像"网点印在图上"。
  //   真实印刷的网点是相对纸面固定的，所以纸（屏幕）动、网点不动。
  if (uHalftone > 0.0) {
    float ang = radians(uHalftoneAngle);
    float ca = cos(ang);
    float sa = sin(ang);
    vec2 p = gl_FragCoord.xy / uHalftoneScale;
    // 旋转坐标系 = 旋转网格（反向）
    vec2 rp = vec2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
    vec2 cell = fract(rp) - 0.5;
    float dist = length(cell);

    // 点径 ∝ sqrt(墨量)。用 sqrt 而不是线性：
    // 点的**面积**才该正比于墨量，而面积 ∝ 半径²
    //
    // ★★ 系数必须 ≥ 0.7071（= sqrt(0.5)，格子的外接圆半径）。
    //    小于它的话，**最黑的像素也铺不满整个格子** ——
    //    画面在数学上就印不出实黑，只剩一片灰。
    //    这里取 0.78，留一点余量给抗锯齿的过渡带。
    float radius = sqrt(clamp(1.0 - inkTone, 0.0, 1.0)) * 0.78;

    // 抗锯齿：对 dist 取屏幕导数，得到"一个像素跨过多少格"
    float aa = max(fwidth(dist), 1e-5) * 1.2;
    float dotMask = 1.0 - smoothstep(radius - aa, radius + aa, dist);

    // 墨和纸都保留一点原色 —— 完全用纯黑纯白会把素材的色相抹掉，
    // 而素材驱动的引擎不该替用户决定"这张图是什么颜色"
    vec3 ink = mix(src * 0.15, uInkColor, 0.85);
    vec3 paper = mix(src, uPaperColor, 0.80);
    c = mix(c, mix(paper, ink, dotMask), uHalftone);
  }

  // ---------------------------------------------------------- ③ 有序抖动
  if (uDither > 0.0) {
    float b = bayer4(gl_FragCoord.xy);
    vec3 quant = floor(c * uDitherLevels + b) / uDitherLevels;
    c = mix(c, quant, uDither);
  }

  // ---------------------------------------------------------- ④ 墨线
  //
  // ★ 放在网点之后、纸纹之前，而且**读原始颜色**（纪律①）
  if (uInkEdge > 0.0) {
    float line = inkLine(uv, srcLuma);
    c = mix(c, uInkColor, line * uInkEdge);
  }

  // ---------------------------------------------------------- ⑤ 纸纹
  if (uPaper > 0.0) {
    // 两个尺度的 hash 叠加。单尺度看起来像电视雪花；
    // 粗+细两层才像"纸纤维的不均匀透光"
    float fine = hash21(uv * 1400.0);
    float coarse = hash21(uv * 210.0);
    float fiber = fine * 0.55 + coarse * 0.45;

    vec3 tint = mix(vec3(1.0), uPaperColor, 0.6);
    c *= mix(vec3(1.0), tint, uPaper * 0.8);
    c *= 1.0 - uPaper * (1.0 - fiber) * 0.28;
  }

  // ---------------------------------------------------------- ⑥ 持续颗粒
  //
  // ★ 由**墙上时钟**驱动，不是滚动。
  //   这就是"停下滚动画面依然是活的"的那一项 ——
  //   滚动和时间是两个独立驱动源，缺一个画面静止时就会冻住。
  if (uGrain > 0.0) {
    // 把时间量化成 24 步/秒再喂给 hash：逐帧连续变化会变成"流动的噪声"，
    // 量化之后才像胶片颗粒在"跳"
    float step24 = floor(uTime * uGrainSpeed * 24.0);
    float g = hash21(gl_FragCoord.xy + step24 * 37.0);
    c += (g - 0.5) * uGrain;
  }

  // alpha 原样透传 —— 场景可能用 alpha 表达别的东西，不要擅自改成 1.0
  gl_FragColor = vec4(c, srcTexel.a);
}
`;
