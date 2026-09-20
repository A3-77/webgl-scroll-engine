"""
分割 provider 集合。

对外只暴露三件事：`SegmentProvider` 接口、`SegmentResult` 数据结构、按名取 provider。
具体实现藏在子模块里 —— 想加一个新 provider（比如接某个视觉 API），
新建一个文件、加 `@register`、在 base.load_builtin_providers() 里 import 一下就行。
"""

from .base import (
    SegmentProvider,
    SegmentResult,
    get_provider,
    list_providers,
    load_builtin_providers,
    register,
)

__all__ = [
    "SegmentProvider",
    "SegmentResult",
    "get_provider",
    "list_providers",
    "load_builtin_providers",
    "register",
]
