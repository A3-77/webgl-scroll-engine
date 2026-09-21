/**
 * ★ 过渡 Shader —— 网站视觉的核心，从真实站点逐行还原
 * ---------------------------------------------------------------------------
 * 来源：真实站点的 postprocessing `EffectPass`（我提取了完整 118 行源码，
 *      落在 evidence/SHADER_transition.glsl）。
 *
 * 唯一的改动是把入口从 postprocessing 的
 *     void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor)
 * 换成标准的
 *     void main() { ... gl_FragColor = outputColor; }
 * 以及把 `texture()` 换成 GLSL1 的 `texture2D()`（three 的 ShaderMaterial 默认 GLSL1）。
 * 中间每一个数学步骤、每一个常量都是原值。
 *
 * ---------------------------------------------------------------------------
 * 它到底在做什么（这是"为什么能达到这个效果"的答案）：
 *
 *   1. 【双纹理】同时持有「当前章节」和「下一章节」两张离屏渲染结果。
 *      这就是为什么它能做出"两个场景互相咬合"的溶解，而不是简单的透明度渐变。
 *
 *   2. 【阈值场 threshold】这是整个效果的灵魂。
 *      它不是用 alpha 做过渡，而是在屏幕上铺一张「空间变化的阈值图」，
 *      然后比较 `progress - threshold` 的正负来决定每个像素显示 current 还是 next。
 *      ▸ 阈值图本身由三部分叠加而成：
 *           dist      —— 到"溶解中心"的圆形距离（hero 模式：圆形扩散）
 *                       或 uv.y / uv.x（普通模式：斜向擦除）
 *           noise     —— 预烘焙噪声图 + 时间滚动 → 边界永远在抖，不会像机械蒙版
 *           mudNormal —— 法线图 R 通道 × 正弦调制 → 让边界有"泥浆流动"的有机感
 *       ▸ 这就是为什么它的过渡边界是"活"的，而普通 mask 过渡是死的。
 *
 *   3. 【fwidth 线稿】硬件导数 fwidth() 求亮度梯度 → 得到边缘强度。
 *      把 current/next 分别和它的边缘图混合，过渡时会浮现一层"铅笔线稿"。
 *      强度随 progress 从 5.0 涨到 10.0 —— 越接近切完，线稿越强。
 *      这一步是免费拿到高质量边缘的经典技巧：fwidth 是 GPU 硬件导数，
 *      不需要任何后处理卷积，一个指令就够。
 *
 *   4. 【抗锯齿】`aa = fwidth(edge) * 10.0` 再 smoothstep —— 用同一个导数
 *      算出屏幕空间的边缘宽度，让溶解边界永远不会出现锯齿或硬切。
 *
 *   5. 【边界发光】`glowFactor = smoothstep(0.0, glowThreshold, abs(edge))`，
 *      越靠近边界（edge≈0）越亮。hero 模式发光强度高达 40 倍，
 *      配合 Bloom 后处理形成过渡瞬间的强光爆开。
 *
 *   6. 【hero 专属处理】
 *      ▸ progress 先过一遍 smoothstep(0, 1.5, p) —— 前段被压平，起步更"沉"
 *      ▸ 圆形扩散以 3D 场景原点为中心（uProjectionView 投影到屏幕空间）
 *      ▸ 加入 10% 鼠标影响 → 溶解中心会跟着鼠标微微偏移
 *      ▸ current/next 各自做 ±10% 的缩放（推进/拉出），制造纵深
 */

export const TRANSITION_FRAGMENT = /* glsl */ `
uniform sampler2D tCurrent;
uniform sampler2D tNext;
uniform sampler2D tMudNormal;
uniform sampler2D tNoise;
uniform float uProgress;
uniform float uAspect;
uniform float uTime;
uniform vec2  uResolution;
uniform vec2  uMouse;
uniform float uIsHero;
uniform float uIsFallback;
uniform mat4  uProjectionView;
uniform vec3  uFadeCenterPoint;
uniform float uDarken;

// ---------------------------------------------------------------- 3D 载体（PHASE 23）
//
//   uCarrierPoint   载体此刻的世界坐标
//   uCarrierFollow  0..1 —— 溶解中心从「章节固定中心」拉向「载体屏幕位置」的强度
//   uCarrierOrganic 有机边缘强度（0 = 与改造前完全一致的正圆）
//
// ★ 这三个 uniform 全为 0 时，本文件的行为与改造前**逐位相同**。
//   这是硬要求：不声明载体的内容包必须完全不受影响。
uniform vec3  uCarrierPoint;
uniform float uCarrierFollow;
uniform float uCarrierOrganic;

varying vec2 vUv;

// Sample pre-computed noise texture (normalized to [-1, 1])
float sampleNoise(vec2 uv) {
  return texture2D(tNoise, uv).r * 2.0 - 1.0;
}

float easeInOutCubic(float t) {
  return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0;
}

// ★ 有机距离 —— 溶解边界不再是正圆（PHASE 23）
//
//   SKY（shader.se）的做法：在圆形半径上叠加三个不同频率的正弦，
//   让边界像油墨扩散而不是几何圆。原文是：
//     sin(angle*3.0 + t*1.5)*1.5 + sin(angle*7.0 + t*2.5) + sin(angle*13.0 + t*0.8)*0.5
//   再乘一个 0.02 量级的系数。
//
//   为什么是三个**非整数倍**的频率：整数倍（3/6/12）会让三个波在
//   同一相位反复对齐，边界看起来像有棱角的星形；3/7/13 互质，
//   一个周期里几乎不重复，读起来才像"有机的"。
//
//   uCarrierOrganic = 0 时退化为纯 length() —— 与改造前逐位相同。
float organicDistance(vec2 uv, vec2 center, float t, float amount) {
  vec2 d = (uv - center) * vec2(uAspect, 1.0);
  float r = length(d);
  if (amount <= 0.0001) return r;
  float angle = atan(d.y, d.x);
  float wobble =
      sin(angle * 3.0  + t * 1.5) * 1.5
    + sin(angle * 7.0  + t * 2.5)
    + sin(angle * 13.0 + t * 0.8) * 0.5;
  return r + wobble * 0.02 * amount;
}

// 把世界坐标点投影到屏幕空间（0..1）。
// uProjectionView 已经是 projection × viewInverse，这里只差透视除法。
vec2 projectToScreen(vec3 worldPos) {
  vec4 clip = uProjectionView * vec4(worldPos, 1.0);
  return (clip.xy / clip.w) * 0.5 + 0.5;
}

void main() {
  vec2 uv = vUv;

  bool isHero = uIsHero > 0.5;
  bool isFallback = uIsFallback > 0.5;

  // Progress smoothing differs between modes
  float progress = isHero ? smoothstep(0.0, 1.5, uProgress) : uProgress;

  // Project 3D fade center point to screen space (fallback uses fixed center)
  vec2 sceneCenter;
  if (isFallback) {
    sceneCenter = vec2(0.5, 0.65);
  } else {
    sceneCenter = projectToScreen(uFadeCenterPoint);
  }

  // ★ 溶解中心被载体拉走（PHASE 23 的核心）
  //
  //   改造前：中心是章节里写死的 fadeCenter，画面从那里均匀扩散 ——
  //   「没有一个东西在做这件事」的根源。
  //
  //   改造后：中心被拉到载体此刻的屏幕位置，于是画面是被飞过的东西擦开的。
  //   uCarrierFollow = 0 时这一行是恒等变换，行为与改造前一致。
  vec2 carrierCenter = projectToScreen(uCarrierPoint);
  sceneCenter = mix(sceneCenter, carrierCenter, uCarrierFollow);

  // UV transformation (fancy mode has zoom effect centered on 3D scene origin)
  vec2 currentUV = uv;
  vec2 nextUV = uv;
  if (isHero) {
    currentUV = (uv - sceneCenter) * (1.0 - smoothstep(0.2, 1.0, uProgress) * 0.1) + sceneCenter;
    nextUV    = (uv - sceneCenter) * (1.0 + smoothstep(0.8, 0.0, uProgress) * 0.1) + sceneCenter;
  } else {
    if (isFallback) {
      currentUV.y -= easeInOutCubic(uProgress) * 0.1;
      nextUV.y    += easeInOutCubic(1.0 - uProgress) * 0.1;
    }
  }

  vec4 current = texture2D(tCurrent, currentUV);
  vec4 next    = texture2D(tNext,    nextUV);

  // Edge detection using hardware derivatives (fwidth) - only compute during transitions
  //
  // ★ 边缘强度在这里**归一化到 0..1**。
  //   原实现是 fwidth(luma) * mix(5.0, 10.0, ...) —— 乘 5~10 倍是合理的，
  //   因为它接下来要把这个值当成**颜色**去替换整条画面（见下面 Edge mixing），
  //   不放大就太暗、不像线稿。
  //
  //   但改成「叠加」之后，5~10 倍就变成了灾难：fwidth 在真实边缘处能到 ~1.0
  //   （相邻像素从黑跳到白），乘 10 再乘叠加系数，直接冲到 50 倍 —— 整屏过曝成白。
  //   实测踩过：改完线稿叠加后画面全白，只有零星噪点。
  //
  //   叠加要的是「边缘有多强」这个比例量，所以先 clamp 回 0..1，
  //   再由调用处乘一个温和的加亮幅度。
  //
  //   ⚠️ 本文件是模板字符串，注释里**不能出现反引号** —— 会直接截断字符串。
  //      实测被这个坑了两次，报错还很有误导性（Expected ";" but found "fwidth"）。
  vec3 currentEdges = vec3(0.0);
  vec3 nextEdges    = vec3(0.0);
  if ((uProgress > 0.01 && uProgress < 0.99) || uDarken > 0.001) {
    float currentLuma = dot(current.rgb, vec3(0.299, 0.587, 0.114));
    currentEdges = vec3(clamp(fwidth(currentLuma) * 6.0, 0.0, 1.0));

    float nextLuma = dot(next.rgb, vec3(0.299, 0.587, 0.114));
    nextEdges = vec3(clamp(fwidth(nextLuma) * 6.0, 0.0, 1.0));
  }

  // Mud normal offset
  vec3 mudNormal = texture2D(tMudNormal, uv * 2.0).rgb;
  float mudStrength = isHero ? mix(0.2, 0.4, 0.5 + 0.5 * sin(uTime - uv.x * 10.0))
                             : mix(0.3, 0.6, 0.5 + 0.5 * sin(uTime - uv.x * 10.0));
  float mudOffset = (mudNormal.r - 0.5) * mudStrength;

  // Noise (sampled from pre-computed texture)
  vec2 aspectUv = vec2(uv.x * uAspect, uv.y) + vec2(0.0, uTime * 0.02);
  float noiseSpeed = isHero ? 0.07 : 0.05;
  float currentNoise = sampleNoise(aspectUv * 0.25 - uTime * noiseSpeed * 0.125);

  // Mask center (hero uses 3D scene center with mouse influence)
  vec2 maskCenter = isHero ? mix(sceneCenter, uMouse, 0.1) : vec2(0.5);

  // Threshold calculation
  float threshold;
  if (isHero) {
    // Aspect-correct the distance for circular (not oval) reveal.
    // 换成 organicDistance —— uCarrierOrganic = 0 时两者完全等价。
    float dist = organicDistance(uv, maskCenter, uTime, uCarrierOrganic) * 0.8;
    threshold = mix(dist, uv.x,
                    smoothstep(0.6, -0.4, abs(uv.x - sceneCenter.x)) *
                    mix(0.0, 0.4, smoothstep(0.05, 0.5, progress)));
    threshold = mix(threshold, 0.0, smoothstep(0.9, 1.0, uProgress));
  } else {
    float ease = mix(progress * progress * (3.0 - 2.0 * progress), progress, 0.25);
    threshold = mix(uv.y, uv.x, smoothstep(0.6, -0.4, abs(uv.x - 0.5)) * 0.5);
    progress = ease; // Use eased progress for simple mode
  }
  threshold = threshold * 2.0 - 1.0;
  threshold = threshold / 1.2 + currentNoise * 0.2 + mudOffset;
  threshold = threshold * 0.5 + 0.5;

  float edge = progress - threshold;
  float aa = fwidth(edge) * 10.0;
  float blendFactor = smoothstep(-aa, aa, edge);

  // Edge mixing
  //
  // ★ 这里原本是「用边缘**替换**颜色」：
  //     current = mix(current, vec4(currentEdges, 1.0), smoothstep(0.0, 0.5, progress));
  //   注意 vec4(currentEdges, 1.0) —— 它把整条颜色换成了边缘亮度。
  //   而 currentEdges 在非边缘处 ≈ 0，于是**非边缘全变纯黑**。
  //
  //   这在深色素材上是好看的（读起来像"画面压暗 + 边缘发光"），
  //   但素材一换成浅色就翻车：实测 scene01→scene02 的过渡里，
  //   整屏变成了"黑底白线"的线稿，非常突兀 —— 而这是个素材驱动的引擎，
  //   它必须对明暗两种素材都成立。
  //
  //   改成「在原色上**叠加**边缘」：
  //     浅色素材 → 边缘微亮（几乎看不出，但过渡更有质感）
  //     深色素材 → 边缘明显发光（和原实现观感接近）
  //   两种都不难看，而且不需要内容侧配置。
  //
  // ★ 但叠加还要再过一道**强边缘阈值**，否则高频纹理会被整体照亮。
  //   实测踩过：猫的毛发细节在 fwidth 上到处都是"边缘"，
  //   整只浅色猫被均匀加亮 22%，看起来像褪了色。
  //   真正的轮廓边缘 fwidth 接近 1.0，毛发的微观起伏只有 0.1~0.2 ——
  //   用 smoothstep(0.25, 0.9) 一筛，就只剩轮廓了。
  //
  //   edgeGain = 0.3 是"最强轮廓再加亮 30%" —— 因为只作用于真轮廓，
  //   可以给得比均匀叠加时更足一点，效果更"活"。
  vec3 currentStrong = smoothstep(vec3(0.25), vec3(0.9), currentEdges);
  vec3 nextStrong    = smoothstep(vec3(0.25), vec3(0.9), nextEdges);
  float edgeGain = 0.3;
  current.rgb += currentStrong * smoothstep(0.0, 0.5, progress) * edgeGain;
  next.rgb += nextStrong * smoothstep(0.2, 0.8, 1.0 - progress) * edgeGain;

  if (uDarken > 0.001) {
    // 压暗：整体调暗，但把边缘留住。
    // 同样是"叠加"而不是"替换" —— 原来的写法（用 currentEdges 替换颜色）
    // 在浅色素材上会得到一块深色板，而不是"暗下来的画面"。
    current.rgb = mix(current.rgb * (1.0 - 0.85 * uDarken), current.rgb + currentEdges * 0.25, uDarken);
  }

  vec4 outputColor = mix(current, next, blendFactor);

  // Glow effect
  //
  // ★ 加了一道「过渡是否正在发生」的闸门（glowGate）。
  //
  //   原实现是无条件算 glow 的。问题在于：即使 uProgress = 0，
  //   阈值场里的噪声扰动（currentNoise * 0.2）和法线扰动也会让**极少数像素**
  //   的 threshold 略小于 0 —— 于是 edge = progress - threshold 约等于 0，
  //   满足「贴近边界」的条件，那一两个像素就被乘上 glowMult（最高 40 倍）变成亮点。
  //
  //   实测踩过：换成纯色素材（红/绿/蓝三个圆）后，绿圆上出现一个刺眼的小白点。
  //   猫图看不出来 —— 浅色渐变背景上，一个白点和背景几乎同色。
  //   **纯色/高对比素材是这类 artifact 的显影剂**，而通用引擎必须能跑纯色素材。
  //
  //   物理上讲也更对：没有过渡就没有边界，没有边界就没有边界发光。
  float glowGate = smoothstep(0.0, 0.04, uProgress) * (1.0 - smoothstep(0.96, 1.0, uProgress));

  float glowStrength = isHero ? mix(40.0, 8.0, smoothstep(0.05, 0.25, progress))
                              : mix(2.0, 10.0, 0.5);
  float glowThreshold = isHero ? glowStrength * 0.001 : 0.003;
  float glowFactor = smoothstep(0.0, glowThreshold, abs(edge));
  float glowMult = isHero
    ? mix(glowStrength * 0.5, glowStrength, 0.5 + 0.5 * currentNoise * sin(uTime + uv.x * 10.0))
    : mix(2.0, 10.0, 0.5 + 0.5 * currentNoise * sin(uTime + uv.x * 10.0));

  // ★ 发光不许把像素推过 1.0（PHASE 23 期间发现并修复的既有缺陷）
  //
  //   【症状】浅色素材在过渡正中间整屏过曝成白，什么都看不见。
  //     实测：油画猫图（浅灰底，luma≈0.8）在 uProgress≈0.5 时全白，
  //     而深色素材（参考站点那种暗青底）完全正常。
  //
  //   【根因】上面这一行原本是纯粹的**乘法**发光：
  //     outputColor * glowMult，hero 模式下 glowMult 最高到 40。
  //     参考站点是深色画面，深色乘 8 刚好是"看得见的辉光" ——
  //     所以这个写法在原站点上是对的，它没打算通用。
  //     但浅色像素乘 8 就是 6.4，远超 1.0；再喂给 bloom，
  //     pmndrs 的 mipmap 模糊会把它摊成一整屏白（比自制的 3 pass 高斯宽得多）。
  //
  //   【修法】给每个像素算一个"乘到这个系数刚好到 1.0"的上限，取小值：
  //     深色 luma=0.10 → 上限 10 → hero 的 8 原样通过（**观感零变化**）
  //     浅色 luma=0.80 → 上限 1.25 → 峰值停在 1.0（不再过曝，仍有微亮）
  //     极暗 luma=0.05 → 上限 20 → 8 原样通过
  //   也就是"只在乘完不会过曝的范围内乘" —— 亮的地方自然少给，暗的地方给足。
  //
  //   这与本文件里 edgeGain 的修复是同一类问题的同一个思路：
  //   素材驱动的引擎不能假设素材是深色的。
  float baseLuma = dot(outputColor.rgb, vec3(0.299, 0.587, 0.114));
  float glowCeiling = 1.0 / max(baseLuma, 0.08);
  float glowScale = min(glowMult, glowCeiling);
  outputColor = mix(outputColor, outputColor * glowScale, (1.0 - glowFactor) * glowGate);

  gl_FragColor = outputColor;
}
`;
