/**
 * Bloom 后处理（亮度提取 → 可分离高斯模糊 → 叠加）
 *
 * 真实站点用的是 pmndrs/postprocessing 的 BloomEffect，
 * 内部是 LuminancePass + MipmapBlurPass，实测降采样到 640×406（约 1/2）后开始上采样。
 *
 * 这里用等价的三段式实现：
 *   bright pass  → 按亮度阈值提取高光（带 soft knee，避免硬切）
 *   blur pass    → 5 tap 可分离高斯，横竖各跑一遍，分辨率减半
 *   composite    → 原图 + bloom * strength
 *
 * 为什么过渡 shader 里已经有"边界发光"了还需要 Bloom？
 *   两者不是一回事：
 *     ▸ shader 里的 glow 是「在同一个像素上做颜色乘法」，只能提亮边界本身；
 *     ▸ Bloom 是「把高光糊出去」，让光溢到邻域像素 —— 这是"发光"感的真正来源。
 *   真实站点两个都用了。
 */

export const BLOOM_BRIGHT_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uThreshold;
uniform float uSoftKnee;

varying vec2 vUv;

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float luma = dot(c, vec3(0.299, 0.587, 0.114));

  // soft knee：阈值附近平滑过渡，避免高光边缘出现硬边
  float knee = uThreshold * uSoftKnee + 1e-5;
  float soft = clamp(luma - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-5);

  float contrib = max(soft, luma - uThreshold) / max(luma, 1e-5);
  gl_FragColor = vec4(c * contrib, 1.0);
}
`;

export const BLOOM_BLUR_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uDirection;

varying vec2 vUv;

void main() {
  // 5 tap 线性采样高斯（权重来自标准 9 tap 折叠成 5 tap 的结果）
  vec3 sum  = texture2D(tDiffuse, vUv).rgb * 0.227027;
  sum += texture2D(tDiffuse, vUv + uDirection * 1.3846).rgb * 0.316216;
  sum += texture2D(tDiffuse, vUv - uDirection * 1.3846).rgb * 0.316216;
  sum += texture2D(tDiffuse, vUv + uDirection * 3.2308).rgb * 0.070270;
  sum += texture2D(tDiffuse, vUv - uDirection * 3.2308).rgb * 0.070270;
  gl_FragColor = vec4(sum, 1.0);
}
`;

export const BLOOM_COMPOSITE_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float uStrength;

varying vec2 vUv;

void main() {
  vec3 base  = texture2D(tDiffuse, vUv).rgb;
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  gl_FragColor = vec4(base + bloom * uStrength, 1.0);
}
`;
