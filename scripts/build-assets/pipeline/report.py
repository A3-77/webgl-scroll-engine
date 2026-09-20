"""
HTML 报告 —— 让"分割对不对"一眼可见
================================================================================
为什么值得单独写一个报告：
  manifest 里的数字（面积比 0.183、中心 0.42,0.55）**看不出分割对不对**。
  只有把"原图 / 干净底 / 抠出来的每个主体"并排放在一起，
  才能立刻发现"猫耳朵被削掉了""两只猫粘成一只""边缘一圈白晕"。

  所以报告是**验收工具**，不是装饰。它落在 generated/report.html，
  不参与构建，双击即可打开（图片全部内联成 base64，不依赖外部文件）。
================================================================================
"""

from __future__ import annotations

import html
from pathlib import Path
from typing import Any

from PIL import Image

from . import metadata as meta


def _data_uri(path: Path, max_w: int = 520) -> str:
    """把图片编码成 data URI，并限制宽度以免报告体积爆炸。"""
    import base64
    import io

    im = Image.open(path)
    if im.width > max_w:
        scale = max_w / im.width
        im = im.resize((max_w, max(1, int(im.height * scale))), Image.LANCZOS)

    buf = io.BytesIO()
    if im.mode == "RGBA":
        # 透明背景在浏览器里会透出报告底色 —— 垫一层棋盘格底更直观
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        bg.alpha_composite(im)
        im = bg.convert("RGB")
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=88)
    else:
        im.convert("RGB").save(buf, "JPEG", quality=88)

    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _checker_data_uri(path: Path, max_w: int = 520) -> str:
    """带棋盘底的 data URI —— 用来展示透明 PNG 的抠图效果。"""
    import base64
    import io

    im = Image.open(path).convert("RGBA")
    if im.width > max_w:
        scale = max_w / im.width
        im = im.resize((max_w, max(1, int(im.height * scale))), Image.LANCZOS)

    # 画棋盘
    tile = 12
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    px = bg.load()
    for y in range(0, im.height, tile):
        for x in range(0, im.width, tile):
            if ((x // tile) + (y // tile)) % 2:
                for yy in range(y, min(y + tile, im.height)):
                    for xx in range(x, min(x + tile, im.width)):
                        px[xx, yy] = (216, 216, 216, 255)

    bg.alpha_composite(im)
    buf = io.BytesIO()
    bg.convert("RGB").save(buf, "JPEG", quality=88)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _mask_overlay_data_uri(src_path: Path, mask, max_w: int = 520) -> str:
    """
    把分割掩码叠在原图上 —— **整份报告里信息量最大的一张图**。

    为什么不能只靠"主体 PNG 贴棋盘底"来验收：
      棋盘底只告诉你"抠出来的东西长什么样"，
      但**看不到漏掉了什么** —— 漏掉的部分压根不在 PNG 里。
      叠在原图上才能同时看见"抓到的"（品红）和"没抓到的"（原色）。
      实测中正是这张图暴露了 scene02 的前胸和左脸整块丢失。
    """
    import base64
    import io

    import numpy as np

    im = Image.open(src_path).convert("RGB")
    if im.size != (mask.shape[1], mask.shape[0]):
        im = im.resize((mask.shape[1], mask.shape[0]), Image.LANCZOS)

    base = np.asarray(im).astype(np.float32)
    tint = np.array([255.0, 40.0, 120.0], np.float32).reshape(1, 1, 3)
    a = 0.45 * mask[..., None].astype(np.float32)
    out = base * (1.0 - a) + tint * a

    out_im = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
    if out_im.width > max_w:
        s = max_w / out_im.width
        out_im = out_im.resize((max_w, max(1, int(out_im.height * s))), Image.LANCZOS)

    buf = io.BytesIO()
    out_im.save(buf, "JPEG", quality=88)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _confidence_badge(conf: str) -> str:
    color = {"high": "#1d9e75", "medium": "#ba7517", "low": "#c0392b"}.get(conf, "#6b6862")
    label = {"high": "可靠", "medium": "勉强", "low": "不可靠"}.get(conf, conf)
    return (
        f'<span style="display:inline-block;padding:1px 8px;border-radius:99px;'
        f'background:{color};color:#fff;font-size:11px;font-weight:600">{label}</span>'
    )


def write_report(
    out_path: Path,
    manifest: meta.ContentManifest,
    rows: list[dict[str, Any]],
    root: Path,
    provider_desc: str,
) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)

    parts: list[str] = []
    total_subjects = sum(len(r["subjects"]) for r in rows)

    parts.append(
        f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>build-assets 报告</title>
<style>
  :root {{
    --bg:#faf9f7; --card:#fff; --ink:#1c1b19; --dim:#6b6862; --faint:#a8a49c;
    --line:#e6e3dd; --ok:#1d9e75; --warn:#ba7517; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; padding:40px 28px 80px; background:var(--bg); color:var(--ink);
         font:400 14px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; }}
  .wrap {{ max-width:1180px; margin:0 auto; }}
  h1 {{ margin:0 0 6px; font-size:26px; font-weight:600; letter-spacing:-.02em; }}
  h2 {{ margin:44px 0 14px; font-size:19px; font-weight:600; letter-spacing:-.01em; }}
  h3 {{ margin:26px 0 10px; font-size:14px; font-weight:600; color:var(--dim);
        text-transform:uppercase; letter-spacing:.1em; }}
  .sub {{ color:var(--dim); margin:0 0 22px; }}
  .meta {{ display:flex; flex-wrap:wrap; gap:10px 30px; padding:16px 20px; margin:0 0 8px;
           background:var(--card); border:1px solid var(--line); border-radius:12px; }}
  .meta div {{ font-size:13px; }}
  .meta dt {{ color:var(--faint); font-size:11px; text-transform:uppercase; letter-spacing:.09em; margin:0 0 2px; }}
  .meta dd {{ margin:0; font-family:var(--mono); font-size:13px; }}
  .grid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:18px; }}
  .card {{ background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }}
  .card > figcaption {{ padding:9px 13px; font-size:12px; font-family:var(--mono);
                        color:var(--dim); border-bottom:1px solid var(--line); }}
  .card img {{ display:block; width:100%; height:auto; }}
  .subs {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(168px,1fr)); gap:14px; }}
  .subj {{ background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }}
  .subj img {{ display:block; width:100%; height:auto; background:#fff; }}
  .subj .body {{ padding:9px 11px; }}
  .subj .id {{ font-family:var(--mono); font-size:12px; font-weight:600; margin-bottom:5px; }}
  .subj dl {{ margin:0; display:grid; grid-template-columns:auto 1fr; gap:1px 8px; font-size:11.5px; }}
  .subj dt {{ color:var(--faint); }}
  .subj dd {{ margin:0; font-family:var(--mono); }}
  ul.notes {{ margin:8px 0 0; padding-left:18px; color:var(--dim); font-size:13px; }}
  ul.notes li {{ margin:2px 0; }}
  code {{ font-family:var(--mono); font-size:12.5px; background:#f1efea; padding:1px 5px; border-radius:4px; }}
  .hint {{ margin-top:14px; padding:13px 16px; border-left:3px solid var(--warn);
           background:#fdf7ec; border-radius:0 8px 8px 0; font-size:13px; color:#6b4d12; }}
  table {{ width:100%; border-collapse:collapse; font-size:13px; background:var(--card);
           border:1px solid var(--line); border-radius:12px; overflow:hidden; }}
  th, td {{ padding:9px 13px; text-align:left; border-bottom:1px solid var(--line); }}
  th {{ color:var(--faint); font-size:11px; text-transform:uppercase; letter-spacing:.08em; font-weight:500; }}
  td {{ font-family:var(--mono); font-size:12.5px; }}
  tr:last-child td {{ border-bottom:none; }}
</style>
</head>
<body><div class="wrap">
<h1>build-assets 报告</h1>
<p class="sub">分割结果的可视化验收 —— 数字看不出对错，图可以。</p>

<div class="meta">
  <div><dt>provider</dt><dd>{html.escape(provider_desc)}</dd></div>
  <div><dt>场景</dt><dd>{len(rows)}</dd></div>
  <div><dt>主体总数</dt><dd>{total_subjects}</dd></div>
  <div><dt>生成时间</dt><dd>{html.escape(manifest.generatedAt)}</dd></div>
</div>
"""
    )

    # ---- 每个场景 ----
    for row in rows:
        scene = row["scene"]
        conf = row.get("confidence", "high")
        parts.append(f'<h2>{html.escape(scene)} {_confidence_badge(conf)}</h2>')
        parts.append(
            f'<div class="meta">'
            f'<div><dt>源图</dt><dd>{html.escape(str(row["source"].name))}</dd></div>'
            f'<div><dt>尺寸</dt><dd>{row["width"]}×{row["height"]}</dd></div>'
            f'<div><dt>主体数</dt><dd>{len(row["subjects"])}</dd></div>'
            f'<div><dt>耗时</dt><dd>{row["elapsed"]:.1f}s</dd></div>'
            f"</div>"
        )

        # 低置信度时把警告**放在最上面**，而不是埋在诊断列表里
        if conf != "high":
            m = row.get("metrics", {})
            parts.append(
                f'<div class="hint"><strong>这个场景的分割置信度是 '
                f'<code>{html.escape(conf)}</code>。</strong> '
                f'实际使用阈值 <code>{m.get("thresholdUsed", "?")}</code>'
                f'（下限 {m.get("thresholdFloor", "?")}，'
                f'自适应{"已触发" if m.get("adaptiveTriggered") else "未触发"}），'
                f'主体对比裕度 <code>{m.get("contrastMargin", "?")}</code>。'
                f'<br>对比裕度 &lt; 1 表示主体的中位亮度差**本身就低于阈值** —— '
                f'这种掩码一定会缺掉主体的低对比区域。'
                f'看下面的 ② 掩码图确认缺在哪，然后换 <code>--provider rembg</code> '
                f'或放一张 <code>input/masks/{html.escape(scene)}.png</code> 手工掩码。</div>'
            )

        # ① 原图 / ② 掩码 / ③ 干净底 / ④ 拼回校验
        cards = []
        cards.append(
            f'<figure class="card"><figcaption>① 原图 (input)</figcaption>'
            f'<img src="{_data_uri(row["source"])}" alt="原图"></figure>'
        )
        if row.get("mask") is not None:
            cards.append(
                f'<figure class="card"><figcaption>② 掩码 (品红=判定为主体) — '
                f'看这里能立刻发现漏检</figcaption>'
                f'<img src="{_mask_overlay_data_uri(row["source"], row["mask"])}" alt="掩码"></figure>'
            )
        bg_path = row["background"]
        if bg_path.exists():
            cards.append(
                f'<figure class="card"><figcaption>③ 干净底 (background) — 主体已抹掉</figcaption>'
                f'<img src="{_data_uri(bg_path)}" alt="干净底"></figure>'
            )
        if row["preview"] and row["preview"].exists():
            cards.append(
                f'<figure class="card"><figcaption>④ 拼回校验 (background + 透明PNG 按原位贴回)</figcaption>'
                f'<img src="{_data_uri(row["preview"])}" alt="拼回校验"></figure>'
            )
        parts.append('<div class="grid">' + "".join(cards) + "</div>")

        # 每个主体
        parts.append("<h3>抠出的主体</h3>")
        subj_html = []
        for sub in row["subjects"]:
            f = root / "public" / sub.path
            img = _checker_data_uri(f) if f.exists() else ""
            subj_html.append(
                f'<div class="subj">'
                f'<img src="{img}" alt="{sub.id}">'
                f'<div class="body">'
                f'<div class="id">{html.escape(sub.id)}</div>'
                f"<dl>"
                f"<dt>尺寸</dt><dd>{sub.size[0]}×{sub.size[1]}</dd>"
                f"<dt>面积比</dt><dd>{sub.areaRatio * 100:.1f}%</dd>"
                f"<dt>中心</dt><dd>{sub.center['x']:.2f}, {sub.center['y']:.2f}</dd>"
                f"<dt>宽高比</dt><dd>{sub.aspect:.3f}</dd>"
                f"</dl></div></div>"
            )
        parts.append('<div class="subs">' + "".join(subj_html) + "</div>")

        # 诊断
        if row["notes"]:
            parts.append("<h3>诊断</h3><ul class='notes'>")
            for n in row["notes"]:
                parts.append(f"<li>{html.escape(str(n))}</li>")
            parts.append("</ul>")

    # ---- 汇总表 ----
    parts.append("<h2>主体汇总</h2>")
    parts.append(
        "<table><thead><tr><th>场景</th><th>置信度</th><th>主体</th><th>尺寸(px)</th>"
        "<th>面积比</th><th>中心(x,y)</th><th>宽高比</th><th>文件</th></tr></thead><tbody>"
    )
    for row in rows:
        conf = row.get("confidence", "high")
        for sub in row["subjects"]:
            parts.append(
                f"<tr><td>{html.escape(row['scene'])}</td>"
                f"<td>{_confidence_badge(conf)}</td>"
                f"<td>{html.escape(sub.id)}</td>"
                f"<td>{sub.size[0]}×{sub.size[1]}</td><td>{sub.areaRatio * 100:.1f}%</td>"
                f"<td>{sub.center['x']:.2f}, {sub.center['y']:.2f}</td>"
                f"<td>{sub.aspect:.3f}</td><td>{html.escape(sub.path)}</td></tr>"
            )
    parts.append("</tbody></table>")

    parts.append(
        '<div class="hint"><strong>怎么用这份报告判断分割质量：</strong><br>'
        "<b>先看 ② 掩码图</b> —— 这是唯一能同时显示「抓到了什么」和「漏了什么」的图。"
        "主体上还有大片原色（没被品红覆盖）= 漏检。<br>"
        "再看 <b>④ 拼回校验</b> —— 和 ① 原图几乎一致说明分割+反混合没问题；"
        "边缘一圈白晕 = 反混合强度不够；主体被削掉一块 = 阈值过高"
        "（<code>--threshold</code> 调低，或用 <code>--no-adaptive</code> 关掉自适应阈值）；"
        "两只猫粘成一只 = 腰部检测不敏感（<code>--waist-ratio</code> 调高）。<br>"
        "如果 ② 显示主体本身和背景就分不开（掩码成片缺失、阈值已经很高），"
        "那不是调参能解决的 —— 换 <code>--provider rembg</code>，"
        "或把手工掩码放到 <code>input/masks/&lt;场景名&gt;.png</code> "
        "再用 <code>--provider manual</code>。</div>"
    )

    parts.append("</div></body></html>")

    out_path.write_text("\n".join(parts), encoding="utf-8")
