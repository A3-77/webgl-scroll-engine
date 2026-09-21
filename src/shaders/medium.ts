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

  // 阈值化（纪律③）：只保留真正的轮廓，放过毛发级的微观起伏
  float lumEdge = smoothstep(0.10, 0.45, lumGrad);

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

  return max(depthEdge, lumEdge);
}

/* ------------------------------------------------------------ 主函数 */

void main() {
  vec2 uv = vUv;
  vec4 srcTexel = texture2D(tDiffuse, uv);
  vec3 src = srcTexel.rgb;
  float srcLuma = dot(src, LUMA);

  // ---------------------------------------------------------- ① 单色化
  vec3 c = mix(src, vec3(srcLuma), uMono);

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
    float radius = sqrt(clamp(1.0 - srcLuma, 0.0, 1.0)) * 0.62;

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
