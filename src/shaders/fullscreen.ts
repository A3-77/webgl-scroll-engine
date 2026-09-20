/**
 * 全屏 quad 的顶点着色器。
 *
 * 配合 PlaneGeometry(2, 2) 使用：position.xy 已经落在 NDC 的 [-1, 1]，
 * 所以直接输出即可，完全绕开相机矩阵 —— 少一次矩阵乘法，也避免任何投影误差。
 */
export const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
