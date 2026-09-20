"""
流水线主编排
================================================================================
    python -m pipeline.main [选项]

完整流程：
    input/*.jpg
      → 分割（可插拔 provider）
      → 主体拆分
      → 透明 PNG + 干净底 + 校验预览
      → generated/content.json

之后由 TS 侧把 manifest 转成 SceneConfig（见 src/asset-pipeline/）。
================================================================================
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

from . import compositor as comp
from . import metadata as meta
from .providers import get_provider, list_providers, load_builtin_providers
from .providers.manual import ManualMaskProvider

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


# ------------------------------------------------------------------ 路径


def project_root() -> Path:
    """scripts/build-assets/pipeline/main.py → 上溯 3 层到项目根。"""
    return Path(__file__).resolve().parents[3]


# ------------------------------------------------- 清理上一轮的孤儿产物

#: 记录"上一轮生成了哪些场景"的状态文件（写在 out_dir 里）
STATE_FILE = ".generated-scenes.json"


def prune_stale_outputs(out_dir: Path, generated_dir: Path, current_ids: set[str]) -> list[str]:
    """
    删掉「上一轮生成过、这一轮不再存在」的场景产物。

    ★ 为什么需要这个：
      把 input/scene03.jpg 删掉再重跑，manifest 里确实没有 scene03 了，
      但 public/content/scene03/ 和 generated/preview-scene03.png 会**留在磁盘上**。
      它们不会被引用（manifest 里没有），所以不会渲染错，
      但会让目录越积越乱，而且用户会以为那张图还在。

    ★ 为什么不能直接清空 out_dir：
      public/content/ 里除了 build-assets 的产物，还可能有**手写内容包的资产**
      （例如 placeholder/）。无脑清空会直接毁掉那些内容包。
      所以只删"自己上次生成的" —— 靠一个状态文件记住上一轮的场景 id 列表。
      首次运行时没有状态文件，那就什么都不删。

    ★ 为什么用 unlink + rmdir 而不是 shutil.rmtree：
      本环境的删除被包装成"进回收站"，rmtree 会 fail-closed 直接抛异常。
      逐文件删是唯一可靠的路径。
    """
    state_path = out_dir / STATE_FILE
    previous: set[str] = set()
    if state_path.exists():
        try:
            previous = set(json.loads(state_path.read_text(encoding="utf-8")).get("scenes", []))
        except (json.JSONDecodeError, OSError, AttributeError):
            # 状态文件坏了不该让整个构建失败 —— 退化成"不清理"，下次会重建
            previous = set()

    removed: list[str] = []
    for scene_id in sorted(previous - current_ids):
        scene_dir = out_dir / scene_id
        if scene_dir.is_dir():
            # 深度倒序删，保证先删文件再删目录
            for item in sorted(scene_dir.rglob("*"), key=lambda p: len(p.parts), reverse=True):
                if item.is_file():
                    item.unlink()
                elif item.is_dir():
                    item.rmdir()
            scene_dir.rmdir()
        preview = generated_dir / f"preview-{scene_id}.png"
        if preview.is_file():
            preview.unlink()
        removed.append(scene_id)

    state_path.write_text(
        json.dumps({"scenes": sorted(current_ids)}, indent=2) + "\n", encoding="utf-8"
    )
    return removed


# ------------------------------------------------------------------ CLI


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="build-assets",
        description="把 input/ 下的图片切分成可渲染的场景素材（透明 PNG + 干净底 + manifest）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  npm run build-assets                       # 默认：colorkey provider
  npm run build-assets -- --provider=manual --masks-dir=input/masks
  npm run build-assets -- --only=scene01     # 只处理一个场景
  npm run build-assets -- --check            # 只校验产物，不重新生成
  npm run build-assets -- --list-providers   # 看有哪些分割算法可用
""",
    )
    p.add_argument("--input", default="input", help="输入目录（默认 input/）")
    p.add_argument("--out", default="public/content", help="素材输出目录（默认 public/content/）")
    p.add_argument("--manifest", default="generated/content.json", help="manifest 输出路径")
    p.add_argument("--report", default="generated/report.html", help="HTML 报告输出路径")
    p.add_argument(
        "--provider",
        default="colorkey",
        help="分割算法（colorkey / manual / rembg / volcengine）。用 --list-providers 查看详情",
    )
    p.add_argument("--masks-dir", default=None, help="manual provider 的掩码目录")
    p.add_argument("--only", default=None, help="只处理指定场景，逗号分隔，如 scene01,scene02")
    p.add_argument("--no-preview", action="store_true", help="不生成校验预览图")
    p.add_argument("--no-report", action="store_true", help="不生成 HTML 报告")
    p.add_argument("--check", action="store_true", help="只校验已有产物是否完整，不重新生成")
    p.add_argument("--list-providers", action="store_true", help="列出可用 provider 后退出")
    # 分割调参（透传给 provider）
    p.add_argument("--threshold", type=float, default=None, help="colorkey 背景距离阈值（下限）")
    p.add_argument("--min-area-ratio", type=float, default=None, help="colorkey 最小面积比")
    p.add_argument("--waist-ratio", type=float, default=None, help="colorkey 腰部检测灵敏度")
    p.add_argument(
        "--no-adaptive",
        action="store_true",
        help="关闭 colorkey 的自适应阈值（退回固定阈值；背景非均匀时会严重误判）",
    )
    p.add_argument(
        "--chroma-gate",
        type=float,
        default=None,
        help="colorkey 色度门阈值 sat×dist（0 = 关闭；默认 260，仅在背景非均匀时生效）",
    )
    # volcengine 专用（其余 provider 会忽略它们，见 SegmentProvider 的 **_ 约定）
    p.add_argument(
        "--max-entity",
        type=int,
        default=None,
        help="volcengine 最多输出几个实体（1~100，默认 8）",
    )
    p.add_argument(
        "--mask-threshold",
        type=float,
        default=None,
        help="volcengine 置信度图二值化阈值（0..1，默认 0.5）",
    )
    p.add_argument(
        "--no-refine",
        action="store_true",
        help="关闭 volcengine 的边缘增强（refine_mask=0）",
    )
    return p


# ------------------------------------------------------------------ 工具


def log(msg: str) -> None:
    print(msg, flush=True)


def load_image(path: Path) -> np.ndarray:
    """读成 RGB uint8 (H, W, 3)。带 alpha 的输入会被合成到白底上。"""
    im = Image.open(path)
    if im.mode == "RGBA":
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[3])
        im = bg
    else:
        im = im.convert("RGB")
    return np.asarray(im)


def discover_scenes(input_dir: Path, only: str | None) -> list[Path]:
    if not input_dir.exists():
        raise SystemExit(
            f"[build-assets] 输入目录不存在: {input_dir}\n"
            f"  → 把要处理的图片放进这个目录，例如 scene01.jpg / scene02.jpg"
        )

    files = sorted(
        p for p in input_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS
    )
    if not files:
        raise SystemExit(
            f"[build-assets] {input_dir} 里没有图片。\n"
            f"  → 支持的格式: {', '.join(sorted(IMAGE_EXTS))}"
        )

    if only:
        wanted = {s.strip() for s in only.split(",") if s.strip()}
        files = [f for f in files if f.stem in wanted]
        if not files:
            raise SystemExit(
                f"[build-assets] --only={only} 没有匹配到任何输入。\n"
                f"  → 可用: {', '.join(p.stem for p in sorted(input_dir.iterdir()))}"
            )

    return files


# ------------------------------------------------------------------ 校验


def run_check(root: Path, manifest_path: Path, out_dir: Path) -> int:
    """
    只校验：manifest 存在吗？它引用的文件都在吗？尺寸对得上吗？

    这个模式的价值在于**它可以在 CI 里跑**，或者用户改完图忘记重新构建时，
    能立刻发现"页面在引用一个不存在的文件"。
    """
    if not manifest_path.exists():
        log(f"✗ manifest 不存在: {manifest_path}")
        log("  → 先运行 npm run build-assets")
        return 1

    mf = meta.read_manifest(manifest_path)
    problems: list[str] = []
    total_subjects = 0

    for scene in mf.scenes:
        bg = root / "public" / scene.background
        if not bg.exists():
            problems.append(f"{scene.id}: 背景缺失 {scene.background}")
        for sub in scene.subjects:
            total_subjects += 1
            f = root / "public" / sub.path
            if not f.exists():
                problems.append(f"{scene.id}/{sub.id}: 主体图缺失 {sub.path}")
                continue
            # 尺寸交叉验证：manifest 记的像素尺寸必须和实际文件一致
            with Image.open(f) as im:
                if list(im.size) != sub.size:
                    problems.append(
                        f"{scene.id}/{sub.id}: 尺寸不符 manifest={sub.size} 实际={list(im.size)}"
                    )
                if im.mode != "RGBA":
                    problems.append(f"{scene.id}/{sub.id}: 不是 RGBA（mode={im.mode}）")

    log(f"manifest: {manifest_path}")
    log(f"场景: {len(mf.scenes)}   主体: {total_subjects}")
    if problems:
        log(f"\n✗ 发现 {len(problems)} 个问题:")
        for p in problems:
            log(f"  · {p}")
        return 1

    log("\n✓ 产物完整，与 manifest 一致")
    return 0


# ------------------------------------------------------------------ 主流程


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = project_root()

    load_builtin_providers()

    if args.list_providers:
        log("可用的分割 provider:")
        for name in list_providers():
            try:
                inst = get_provider(name, masks_dir=args.masks_dir or "input/masks")
                log(f"  · {name:10s} {inst.describe()}")
            except SystemExit as e:
                log(f"  · {name:10s} (不可用: {str(e).splitlines()[0]})")
        return 0

    manifest_path = root / args.manifest
    out_dir = root / args.out

    # ★ 素材必须落在 public/ 下，否则浏览器根本取不到它。
    #   这里**主动失败**而不是继续跑 —— 因为继续跑的后果是
    #   manifest 里写着一堆 URL、页面却全是 404，排查起来远比报错麻烦。
    public_dir = root / "public"
    if not out_dir.resolve().is_relative_to(public_dir.resolve()):
        raise SystemExit(
            f"[build-assets] --out 必须位于 public/ 之内，当前是 {out_dir}\n"
            f"  理由：manifest 里的素材路径是相对 public/ 的 URL，\n"
            f"        放到 public/ 之外的素材浏览器取不到。\n"
            f"  例如：--out public/content-v2"
        )

    if args.check:
        return run_check(root, manifest_path, out_dir)

    # ---- provider ----
    provider_kwargs: dict[str, object] = {}
    if args.provider == "manual":
        provider_kwargs["masks_dir"] = args.masks_dir or (root / "input" / "masks")
    if args.threshold is not None:
        provider_kwargs["threshold"] = args.threshold
    if args.min_area_ratio is not None:
        provider_kwargs["min_area_ratio"] = args.min_area_ratio
    if args.waist_ratio is not None:
        provider_kwargs["waist_ratio"] = args.waist_ratio
    if args.no_adaptive:
        provider_kwargs["adaptive"] = False
    if args.chroma_gate is not None:
        provider_kwargs["chroma_gate"] = args.chroma_gate
    if args.provider == "volcengine":
        if args.max_entity is not None:
            provider_kwargs["max_entity"] = args.max_entity
        if args.mask_threshold is not None:
            provider_kwargs["mask_threshold"] = args.mask_threshold
        if args.no_refine:
            provider_kwargs["refine"] = False

    provider = get_provider(args.provider, **provider_kwargs)

    inputs = discover_scenes(root / args.input, args.only)

    log("=" * 74)
    log(f"build-assets   provider = {provider.describe()}")
    log(f"  输入  {args.input}  ({len(inputs)} 张)")
    log(f"  输出  {args.out}")
    log("=" * 74)

    cparams = comp.CompositorParams(write_preview=not args.no_preview)
    manifest = meta.ContentManifest(generatedAt=meta.now_iso())
    report_rows: list[dict] = []

    t_start = time.time()

    for src in inputs:
        scene_id = src.stem
        t0 = time.time()
        log(f"\n▸ {src.name}")

        image = load_image(src)
        H, W = image.shape[:2]
        log(f"  尺寸 {W}×{H}")

        # ---- 分割 ----
        if isinstance(provider, ManualMaskProvider):
            result = provider.segment_named(image, scene_id)
        else:
            result = provider.segment(image)

        for note in result.notes:
            log(f"  · {note}")

        if not result.subjects:
            log("  ⚠️ 没有检测到主体 —— 跳过这个场景")
            manifest.diagnostics[scene_id] = result.notes + ["未检测到主体，已跳过"]
            continue

        log(f"  主体 {len(result.subjects)} 个")

        # ---- 合成 ----
        scene_dir = out_dir / scene_id
        bg_name = f"background.{cparams.background_format}"
        bg_path, bg_notes = comp.build_background(
            image, result.mask, scene_dir / bg_name, cparams
        )
        for n in bg_notes:
            log(f"  · {n}")

        subjects_out: list[meta.SubjectEntry] = []
        preview_items: list[tuple[np.ndarray, comp.SubjectOutput, Path]] = []

        # 按面积降序 → subject-01 永远是最大的那个（"主角"）
        order = sorted(range(len(result.subjects)), key=lambda i: -int(result.subjects[i].sum()))

        for rank, idx in enumerate(order, start=1):
            sid = f"subject-{rank:02d}"
            sub_path = scene_dir / f"{sid}.png"
            info = comp.build_subject(image, result.subjects[idx], result.background_color, sub_path, cparams)
            info.id = sid

            rel = str(sub_path.relative_to(root / "public")).replace("\\", "/")
            subjects_out.append(
                meta.SubjectEntry(
                    id=sid,
                    path=rel,
                    box=info.box,
                    center=info.center,
                    aspect=round(info.aspect, 4),
                    areaRatio=round(info.area_ratio, 4),
                    pixelCount=info.pixel_count,
                    size=list(info.size),
                )
            )
            preview_items.append((result.subjects[idx], info, sub_path))
            log(
                f"    {sid}  {info.size[0]}×{info.size[1]}px  "
                f"面积 {info.area_ratio * 100:.1f}%  中心 ({info.center['x']:.2f}, {info.center['y']:.2f})"
            )

        # ---- 预览 ----
        preview_rel = ""
        if cparams.write_preview:
            prev_path = root / "generated" / f"preview-{scene_id}.png"
            preview_rel = comp.write_preview(image, scene_dir / bg_name, preview_items, prev_path)
            log(f"  预览 {Path(preview_rel).relative_to(root)}")

        rel_bg = str((scene_dir / bg_name).relative_to(root / "public")).replace("\\", "/")

        manifest.scenes.append(
            meta.SceneEntry(
                id=scene_id,
                source={"width": W, "height": H, "aspect": round(W / H, 4)},
                background=rel_bg,
                subjects=subjects_out,
                provider=result.provider,
                generatedAt=meta.now_iso(),
                backgroundColor=(
                    [int(round(float(c))) for c in result.background_color]
                    if result.background_color is not None
                    else []
                ),
                confidence=result.confidence,
                metrics=result.diagnostics,
            )
        )
        manifest.diagnostics[scene_id] = result.notes + bg_notes

        report_rows.append(
            {
                "scene": scene_id,
                "source": src,
                "width": W,
                "height": H,
                "background": root / "public" / rel_bg,
                "preview": Path(preview_rel) if preview_rel else None,
                "subjects": subjects_out,
                "sceneDir": scene_dir,
                "notes": result.notes + bg_notes,
                "elapsed": time.time() - t0,
                "confidence": result.confidence,
                "metrics": result.diagnostics,
                "mask": result.mask,
            }
        )

        log(f"  ✓ {time.time() - t0:.1f}s")

    # ---- 落盘 ----
    meta.write_manifest(manifest, manifest_path)
    log(f"\n✓ manifest → {manifest_path.relative_to(root)}")

    # ★ 同时写一份到 public/ 下。
    #   理由：TS 侧的内容包要在**运行时** fetch 这份 manifest 来自动构图
    #   （这样加一张图只需重跑 build-assets，不改任何 TS 代码 —— 验收 7）。
    #   而 public/ 之外的文件浏览器取不到。
    #   generated/ 那份保留，因为它是给人看和给 --check 用的。
    served_manifest = out_dir / "manifest.json"
    served_manifest.parent.mkdir(parents=True, exist_ok=True)
    served_manifest.write_text(
        manifest_path.read_text(encoding="utf-8"), encoding="utf-8"
    )
    log(f"✓ manifest → {served_manifest.relative_to(root)}（运行时读取的副本）")

    # ---- 清理上一轮的孤儿产物 ----
    # 顺序很重要：必须在 manifest 写完之后 —— 万一清理抛异常，
    # 至少 manifest 是完整的（内容可用），而不是"删了一半但没有 manifest"。
    stale = prune_stale_outputs(out_dir, root / "generated", {s.id for s in manifest.scenes})
    if stale:
        log(
            f"✓ 清理了 {len(stale)} 个已不存在的场景产物: {', '.join(stale)}"
            f"（input/ 里已经没有对应的图了）"
        )

    if not args.no_report and report_rows:
        from .report import write_report

        report_path = root / args.report
        write_report(report_path, manifest, report_rows, root, provider.describe())
        log(f"✓ 报告 → {report_path.relative_to(root)}")

    total_sub = sum(len(s.subjects) for s in manifest.scenes)
    log(
        f"\n完成：{len(manifest.scenes)} 个场景 / {total_sub} 个主体 / "
        f"耗时 {time.time() - t_start:.1f}s"
    )

    # ★ 把低置信度的场景在最后**集中列出来**。
    #   理由：用户扫一眼终端就能知道"哪几张图的素材不能直接用"，
    #   不用去翻上面几十行日志，也不用等到渲染出来才发现主体缺了一块。
    weak = [s for s in manifest.scenes if s.confidence != "high"]
    if weak:
        log("")
        log(f"⚠️  {len(weak)} 个场景的分割置信度不是 high：")
        for s in weak:
            m = s.metrics
            log(
                f"    {s.id}  confidence={s.confidence}  "
                f"阈值={m.get('thresholdUsed', '?')}（自适应={m.get('adaptiveTriggered', '?')}）  "
                f"对比裕度={m.get('contrastMargin', '?')}"
            )
        log("     → 打开 generated/report.html 核对掩码；")
        log("       若主体有缺失：--provider rembg（需装 rembg）或 input/masks/<名字>.png 手工掩码")

    log("")
    log("下一步：npm run dev  →  打开终端里打印的本地地址")
    return 0


if __name__ == "__main__":
    sys.exit(main())
