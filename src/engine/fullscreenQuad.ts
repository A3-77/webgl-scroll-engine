import * as THREE from 'three';
import { FULLSCREEN_VERTEX } from '../shaders/fullscreen';

export interface FullscreenQuad {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  geometry: THREE.PlaneGeometry;
  dispose(): void;
}

/**
 * 建一个"贴满屏幕"的 quad。
 *
 * 顶点着色器直接输出 NDC，所以相机只用来占位（三个 pass 共用一个即可）。
 * frustumCulled 必须关掉 —— 顶点着色器绕过了矩阵变换，three 的包围盒剔除会误判。
 */
export function createFullscreenQuad(
  material: THREE.ShaderMaterial,
  camera?: THREE.OrthographicCamera,
): FullscreenQuad {
  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  const scene = new THREE.Scene();
  scene.add(mesh);

  const cam = camera ?? new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  return {
    mesh,
    scene,
    camera: cam,
    geometry,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
