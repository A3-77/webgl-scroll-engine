"""
元数据 —— 把流水线的产物写成 generated/content.json
================================================================================
这个 JSON 是 **Python 段和 TS 段之间的契约**：
  Python 只负责"图切好了、量出来了"，不负责"该怎么排布"。
  排布是 TS 段（src/asset-pipeline/）的事，因为那部分必须与 src/schema 的类型
  严格一致，放在 TS 里才能被编译器检查。

结构必须与 src/schema/asset.ts 里的 SceneManifest / ContentManifest 对齐。
两边都有类型定义（Python dataclass + TS interface），
改一边必须改另一边 —— 这是**有意为之的显式耦合**，
比"隐式约定一个 JSON 形状"要安全得多。
================================================================================
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MANIFEST_VERSION = 1


@dataclass
class SubjectEntry:
    id: str
    path: str
    box: dict[str, float]
    center: dict[str, float]
    aspect: float
    areaRatio: float
    pixelCount: int
    #: 像素尺寸 —— TS 侧自动构图时要用（算"占视口多少"）
    size: list[int]


@dataclass
class SceneEntry:
    id: str
    source: dict[str, Any]
    background: str
    subjects: list[SubjectEntry] = field(default_factory=list)
    provider: str = "unknown"
    generatedAt: str = ""
    #: 背景估计色 [R, G, B]（0..255）。
    #: TS 侧用它当 canvas 底色 —— 否则素材加载完成前会闪一帧白，
    #: 而这类图的背景通常是浅灰，白闪很显眼。
    backgroundColor: list[int] = field(default_factory=list)
    #: 分割置信度："high" | "medium" | "low"
    #: 透传到 TS 侧，让引擎可以在运行时提示"这个场景的素材可能有问题"，
    #: 而不是让用户到渲染结果里才发现主体缺了一块。
    confidence: str = "high"
    #: 机器可读的分割诊断量（thresholdUsed / adaptiveTriggered / contrastMargin …）
    metrics: dict[str, Any] = field(default_factory=dict)


@dataclass
class ContentManifest:
    version: int = MANIFEST_VERSION
    generator: str = "scripts/build-assets"
    generatedAt: str = ""
    scenes: list[SceneEntry] = field(default_factory=list)
    #: 每个场景的诊断信息（人类可读），方便排查"为什么只切出 4 只猫"
    diagnostics: dict[str, list[str]] = field(default_factory=dict)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def write_manifest(manifest: ContentManifest, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    data = asdict(manifest)
    # 保证 key 顺序稳定，便于 git diff
    out_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def read_manifest(path: Path) -> ContentManifest:
    """读回 manifest（--check 模式与增量重建用）。"""
    data = json.loads(path.read_text(encoding="utf-8"))
    scenes = []
    for s in data.get("scenes", []):
        subs = [SubjectEntry(**sub) for sub in s.get("subjects", [])]
        scenes.append(
            SceneEntry(
                id=s["id"],
                source=s["source"],
                background=s["background"],
                subjects=subs,
                provider=s.get("provider", "unknown"),
                generatedAt=s.get("generatedAt", ""),
                backgroundColor=s.get("backgroundColor", []),
                confidence=s.get("confidence", "high"),
                metrics=s.get("metrics", {}),
            )
        )
    return ContentManifest(
        version=data.get("version", MANIFEST_VERSION),
        generator=data.get("generator", "scripts/build-assets"),
        generatedAt=data.get("generatedAt", ""),
        scenes=scenes,
        diagnostics=data.get("diagnostics", {}),
    )
