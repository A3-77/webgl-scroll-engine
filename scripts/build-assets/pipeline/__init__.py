"""
build-assets 的 Python 包
================================================================================
目录结构为什么是 `scripts/build-assets/pipeline/` 而不是 `scripts/build-assets/`：

  Python 的包名**必须是合法标识符**，不能含连字符。
  `scripts/build-assets` 这个目录名（用户规格里指定的、也是 npm script 的名字）
  没法直接 `import`。

  所以分两层：
    scripts/build-assets/            ← 目录名随用户规格，放 Node 入口 run.mjs
    scripts/build-assets/pipeline/   ← 真正的 Python 包，合法标识符

  run.mjs 用 `cwd=scripts/build-assets` + `python -m pipeline.main` 调用，
  两边都符合各自的命名规则，不需要任何 hack。

  这是**唯一**一处为了语言约束而偏离原始目录设计的地方。
================================================================================
"""

__all__ = ["main"]
