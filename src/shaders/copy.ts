/**
 * 纯拷贝 —— 把一张纹理原样搬到另一个渲染目标。
 *
 * ---------------------------------------------------------------------------
 * 【为什么需要它】
 *
 *   PHASE 18 把后处理换成 pmndrs/postprocessing 之后，链的输入不再是
 *   "一个 Scene"，而是"过渡系统已经合成好的那张纹理"（Composer 的 rtComposite）。
 *
 *   而 EffectComposer 的第一个 pass 约定是从 **自己的** inputBuffer 里取上一帧的
 *   结果 —— 它并不知道外面还有一张纹理。所以必须有一个 pass 负责
 *   「把外部纹理搬进 composer 的缓冲」，后面的 EffectPass 才能接着处理。
 *
 *   这就是 SourcePass（见 engine/systems/SourcePass.ts）用的材质。
 *
 * ---------------------------------------------------------------------------
 * 【为什么不用 postprocessing 自带的 CopyPass】
 *
 *   CopyPass 拷贝的是 **inputBuffer → outputBuffer**，也就是"上一个 pass 的结果"。
 *   它没法指定"从外面拿一张纹理"。传进来的纹理是外部所有者的，
 *   本材质的 tDiffuse 每帧由 SourcePass 直接赋值。
 * ---------------------------------------------------------------------------
 */
export const COPY_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;

varying vec2 vUv;

void main() {
  gl_FragColor = texture2D(tDiffuse, vUv);
}
`;
