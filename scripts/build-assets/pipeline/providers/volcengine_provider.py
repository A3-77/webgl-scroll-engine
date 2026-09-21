"""
VolcengineSegmentProvider —— 接火山引擎视觉智能 EntitySegment（实体分割）
================================================================================
【为什么要有这个 provider】

色键控（colorkey）有一个写死的适用边界：**背景必须是近似均匀的**。
一旦背景有高频内容（油画笔触、树林、人群、纹理墙面），色键控就会把
"背景"和"主体"的统计特征混在一起，结果是**多个主体被合成一大块** ——
本项目里最典型的表现就是"五只猫合并成一个连通域"，于是它们只能整体运动，
拿不到各自独立的动画轨道。

EntitySegment 是解药的**结构性原因**：它的 `return_format=1`
不是返回一张总掩码，而是**返回每个实体各自一个图层**（外加 `entity_num`
实体计数、`seg_score` 每个实体的置信度）。也就是说 ——
"五个主体"这件事是 API 直接告诉我们的，不需要靠连通域猜。

--------------------------------------------------------------------------------
【与其他 provider 的分工】

  colorkey     本地 / 零成本 / 背景均匀时边缘最锐利        → 默认
  manual       手工掩码 / 最准 / 要人                     → 兜底
  rembg        本地 ML / 单个主体抠得很好 / 不拆分多实体    → 单主体场景
  volcengine   远程 API / **能拆分多个实体** / 要密钥和配额 → 多主体 + 复杂背景

注意 rembg 与 volcengine 的关键差别：rembg 输出的是"前景 vs 背景"一张掩码，
即使有五只猫它也给一张；后续连通域能拆开的前提是五只猫**互不接触**。
EntitySegment 是模型级别的实例分割，挨着也能分开。

--------------------------------------------------------------------------------
【接口的三个易错点（都踩过或按文档核对过）】

  1. 鉴权是**签名**，不是 Bearer。
     用的是火山引擎标准的 HMAC-SHA256 四段式签名（与 SigV4 同构但无 AWS4 前缀），
     必须带 `X-Date`、`X-Content-Sha256` 两个头参与签名，
     少一个就是 401 ECAuth，且错误信息不会告诉你缺了哪个。

  2. 请求体上限 10 MB（`ECReqBodySizeLimited`）。
     base64 会把体积放大约 33%，所以大图必须先缩边再编码，
     否则一张 8MB 的 JPG 编码后正好越界。缩完的掩码要按原尺寸还原。

  3. 返回的图层是**置信度图**不是 RGBA 图。
     文档原文："实体图层：取值范围 0～255，代表属于当前图层的置信度"。
     所以图层既可能是单通道 L，也可能是把置信度放在 alpha 通道的 RGBA。
     两种情况都要处理，不能无脑取 alpha。

【密钥放置】
  优先读环境变量，其次读项目根目录的 `.env`（已 gitignore，不会被提交）。
     VOLC_ACCESS_KEY=<API Key ID>
     VOLC_SECRET_KEY=<API Key Secret>
  复制 `.env.example` 改一下即可。**不要把密钥写进任何会被提交的文件。**
================================================================================
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .. import imaging as im
from .base import SegmentProvider, SegmentResult, register

# ------------------------------------------------------------------ 接口常量

HOST = "visual.volcengineapi.com"
ENDPOINT = f"https://{HOST}/"
SERVICE = "cv"
REGION = "cn-beijing"
ACTION = "EntitySegment"
VERSION = "2024-06-06"
REQ_KEY = "entity_seg"


def _project_root() -> Path:
    """
    parents[0]=providers  parents[1]=pipeline  parents[2]=build-assets
    parents[3]=scripts    parents[4]=项目根
    """
    return Path(__file__).resolve().parents[4]


def _load_dotenv(root: Path) -> None:
    """
    读项目根的 .env，写进 os.environ。

    为什么自己解析而不用 python-dotenv：
      整条流水线目前的依赖只有 pillow + numpy，为一个 20 行的 .env 解析
      引入新依赖不值得。这里只支持 `KEY=VALUE` 和 `#` 注释，够用了。

    ★ 已存在的环境变量**不覆盖** —— 命令行/CI 注入的优先级必须更高，
      否则本地 .env 会悄悄盖掉 CI 里的密钥，这类 bug 极难排查。
    """
    for name in (".env", ".env.local"):
        path = root / name
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


# ------------------------------------------------------------------ 签名

def _sha256_hex(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _build_authorization(ak: str, sk: str, x_date: str, payload_hash: str, query: str) -> str:
    """
    火山引擎标准签名（与 AWS SigV4 同构，但派生密钥没有 "AWS4" 前缀）。

    四段式：
      kDate    = HMAC(secret,      短日期)
      kRegion  = HMAC(kDate,       region)
      kService = HMAC(kRegion,     service)
      kSigning = HMAC(kService,    "request")

    规范请求的换行必须严格对齐 —— 多一个少一个空格都会得到
    一个"看起来完全正常"的 401，这是这套签名最坑的地方。
    """
    short_date = x_date[:8]

    canonical_headers = (
        f"host:{HOST}\n"
        f"x-content-sha256:{payload_hash}\n"
        f"x-date:{x_date}\n"
    )
    signed_headers = "host;x-content-sha256;x-date"

    canonical_request = "\n".join(
        [
            "POST",
            "/",
            query,  # 已经是按字段名升序的规范查询串
            canonical_headers,
            signed_headers,
            payload_hash,
        ]
    )

    credential_scope = f"{short_date}/{REGION}/{SERVICE}/request"
    string_to_sign = "\n".join(
        [
            "HMAC-SHA256",
            x_date,
            credential_scope,
            _sha256_hex(canonical_request.encode("utf-8")),
        ]
    )

    k_date = _hmac(sk.encode("utf-8"), short_date)
    k_region = _hmac(k_date, REGION)
    k_service = _hmac(k_region, SERVICE)
    k_signing = _hmac(k_service, "request")
    signature = hmac.new(
        k_signing, string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    return (
        f"HMAC-SHA256 Credential={ak}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )


# ------------------------------------------------------------------ provider

@register
class VolcengineSegmentProvider(SegmentProvider):
    name = "volcengine"

    def __init__(
        self,
        max_entity: int = 8,
        mask_threshold: float = 0.5,
        refine: bool = True,
        max_side: int = 2048,
        min_area_ratio: float = 0.002,
        bg_span: float = 0.9,
        timeout: float = 60.0,
        **_: Any,
    ) -> None:
        root = _project_root()
        _load_dotenv(root)

        ak = os.environ.get("VOLC_ACCESS_KEY", "").strip()
        sk = os.environ.get("VOLC_SECRET_KEY", "").strip()

        if not ak or not sk:
            raise SystemExit(
                "[segment] 火山引擎密钥缺失。\n"
                "  在项目根目录建 .env（已 gitignore，不会被提交）：\n"
                "    VOLC_ACCESS_KEY=<你的 API Key ID>\n"
                "    VOLC_SECRET_KEY=<你的 API Key Secret>\n"
                "  或直接注入环境变量，然后重跑：\n"
                "    npm run build-assets -- --provider=volcengine"
            )

        self.ak = ak
        self.sk = sk
        self.max_entity = max(1, min(100, int(max_entity)))
        self.mask_threshold = float(mask_threshold)
        self.refine = bool(refine)
        self.max_side = int(max_side)
        self.min_area_ratio = float(min_area_ratio)
        self.bg_span = float(bg_span)
        self.timeout = float(timeout)

    def describe(self) -> str:
        return (
            f"volcengine(EntitySegment, max_entity={self.max_entity}, "
            f"threshold={self.mask_threshold}, refine={int(self.refine)})"
        )

    # ---------------------------------------------------------------- 请求

    def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        payload = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        query = f"Action={ACTION}&Version={VERSION}"
        x_date = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        payload_hash = _sha256_hex(payload)

        req = urllib.request.Request(
            f"{ENDPOINT}?{query}",
            data=payload,
            method="POST",
            headers={
                "Host": HOST,
                "Content-Type": "application/json; charset=UTF-8",
                "Accept": "application/json",
                "X-Date": x_date,
                "X-Content-Sha256": payload_hash,
                "Authorization": _build_authorization(
                    self.ak, self.sk, x_date, payload_hash, query
                ),
                "User-Agent": "webgl-scroll-engine/build-assets",
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="ignore")[:600]
            # ★ 业务错误也走 HTTP 错误码（401/400）回来，但正文里有精确原因。
            #   把它挑出来，否则用户只能看到一个干巴巴的 HTTP 状态码。
            hint = ""
            try:
                parsed = json.loads(detail)
                err = (parsed.get("ResponseMetadata") or {}).get("Error") or {}
                result = parsed.get("Result") or {}
                hint = err.get("Message") or result.get("message") or ""
                if hint:
                    hint = f"\n  {err.get('Code', '')} {hint}"
            except Exception:
                pass
            raise SystemExit(
                f"[segment] 火山引擎 HTTP {e.code}{hint}\n  {detail}"
            ) from e
        except urllib.error.URLError as e:
            raise SystemExit(f"[segment] 火山引擎请求失败（网络/代理？）: {e.reason}") from e

    # ---------------------------------------------------------------- 解码

    @staticmethod
    def _layer_to_confidence(raw: bytes) -> np.ndarray:
        """
        把一个图层字节流解成 0..1 的置信度图。

        三种可能的形态都要接住（见文件头的第 3 个易错点）：
          L / I        —— 单通道，值本身就是置信度
          LA / RGBA / PA —— 置信度在 alpha 通道
          RGB          —— 兜底转灰度（不指望它准，但要能跑下去）
        """
        img = Image.open(io.BytesIO(raw))
        if img.mode in ("LA", "RGBA", "PA"):
            arr = np.asarray(img)[:, :, -1]
        elif img.mode in ("L", "I", "I;16"):
            arr = np.asarray(img)
        else:
            arr = np.asarray(img.convert("L"))

        arr = arr.astype(np.float32)
        # 16 位图的值域是 0..65535，按实际最大值归一化，别硬写 255
        peak = float(arr.max()) if arr.size else 0.0
        return arr / 65535.0 if peak > 255.0 else arr / 255.0

    def _fetch_layers(self, data: dict[str, Any]) -> list[bytes]:
        """取回图层字节流。优先 base64，退化到 URL（要再下载一次）。"""
        layers: list[bytes] = []
        for item in data.get("binary_data_base64") or []:
            if item:
                layers.append(base64.b64decode(item))
        if layers:
            return layers

        for url in data.get("image_urls") or []:
            if not url:
                continue
            with urllib.request.urlopen(url, timeout=self.timeout) as r:
                layers.append(r.read())
        return layers

    # ---------------------------------------------------------------- 分割

    def segment(self, image: np.ndarray) -> SegmentResult:
        H, W = image.shape[:2]

        # ★ 缩边：base64 会放大 33%，而请求体上限是 10MB（ECReqBodySizeLimited）。
        #   先缩再编码，掩码最后再按原尺寸还原。
        scale = 1.0
        send = image
        if max(H, W) > self.max_side:
            scale = self.max_side / float(max(H, W))
            send = np.asarray(
                Image.fromarray(image).resize(
                    (max(1, round(W * scale)), max(1, round(H * scale))),
                    Image.LANCZOS,
                )
            )

        buf = io.BytesIO()
        Image.fromarray(send).save(buf, format="PNG")
        encoded = base64.b64encode(buf.getvalue()).decode("ascii")

        body = {
            "req_key": REQ_KEY,
            "binary_data_base64": [encoded],
            "max_entity": self.max_entity,
            # 1 = 每个实体一个独立图层（本 provider 存在的全部理由）
            "return_format": 1,
            "refine_mask": 1 if self.refine else 0,
        }

        resp = self._post(body)

        # ★ 响应的两种壳（实测确认，文档只写了第一种）：
        #   视觉智能的**文档**写的是  {"code":10000,"data":{...},"request_id":...}
        #   实际网关返回的是      {"ResponseMetadata":{...},"Result":{同样那些字段}}
        #   只按文档读顶层 code 会拿到 None，然后误报成"返回码错误"。
        #   所以先剥壳再取值，两种形态都能吃下。
        envelope = resp.get("Result") if isinstance(resp.get("Result"), dict) else resp

        meta_err = (resp.get("ResponseMetadata") or {}).get("Error")
        if isinstance(meta_err, dict) and meta_err.get("Code"):
            raise SystemExit(
                f"[segment] EntitySegment 被拒绝: {meta_err.get('Code')} "
                f"{meta_err.get('Message')!r}\n"
                f"  request_id={(resp.get('ResponseMetadata') or {}).get('RequestId')}"
            )

        code = envelope.get("code", envelope.get("status"))
        if code != 10000:
            raise SystemExit(
                f"[segment] EntitySegment 返回 code={code} "
                f"message={envelope.get('message')!r}\n"
                f"  request_id={envelope.get('request_id')}"
            )

        data = envelope.get("data") or {}
        algo = data.get("algorithm_base_resp") or {}
        if algo.get("status_code") not in (0, None):
            raise SystemExit(
                f"[segment] 算法侧失败: status_code={algo.get('status_code')} "
                f"{algo.get('status_message')!r}"
            )

        layers = self._fetch_layers(data)
        scores = [float(s) for s in (data.get("seg_score") or [])]
        entity_num = data.get("entity_num") or []

        if not layers:
            return SegmentResult(
                mask=np.zeros((H, W), dtype=bool),
                subjects=[],
                provider=self.name,
                params=self._params(),
                notes=["火山引擎没有返回任何实体图层 —— 这张图可能没有被识别为多实体"],
                confidence="low",
                diagnostics={"entity_num": entity_num, "layers": 0},
            )

        min_area = self.min_area_ratio * H * W
        candidates: list[np.ndarray] = []
        subjects: list[np.ndarray] = []
        cut_small = 0
        cut_bg = 0

        for raw in layers:
            conf = self._layer_to_confidence(raw)

            # 缩过边就还原回原尺寸 —— 在置信度图上做双线性缩放再阈值化，
            # 比在二值掩码上做最近邻缩放干净得多（不会出现锯齿台阶）。
            if abs(scale - 1.0) > 1e-6:
                conf = np.asarray(
                    Image.fromarray((conf * 255).astype(np.uint8)).resize(
                        (W, H), Image.BILINEAR
                    )
                ).astype(np.float32) / 255.0

            mask = conf >= self.mask_threshold
            mask = im.fill_holes(mask)
            mask = im.opening(mask, 1)

            if int(mask.sum()) < min_area:
                cut_small += 1
                continue
            candidates.append(mask)

        # ------------------------------------------------------------ 背景过滤
        #
        # ★ EntitySegment 是「实例分割」，它把**背景也当成实体**返回。
        #   实测这张油画猫图：7 个图层里有 2 个是横跨整幅的背景
        #   （天空 42.6%、地面 30.4%），另外 5 个才是猫。
        #   直接把 7 个都当主体，画面上就会压着两张全屏色块 —— 完全毁掉。
        #
        # 【判据为什么是"跨幅"而不是"面积大"】
        #   面积阈值会误杀本来就很大的前景（比如一头占半幅的鲸鱼）。
        #   而**背景区域的典型特征是横跨整个画面** ——
        #   天空一定从左到右铺满，地面也是；猫只占 0.16 宽。
        #   所以判据是：包围盒宽度或高度 ≥ bg_span（默认 0.9）→ 背景。
        #
        # 【保底】如果过滤完一个不剩，说明判据不适用于这张图 ——
        #   宁可全留着（哪怕是背景）也不要返回空，空会让下游完全没有主体可排。
        for mask in candidates:
            ys, xs = np.where(mask)
            if xs.size == 0:
                continue
            span_w = (int(xs.max()) - int(xs.min()) + 1) / W
            span_h = (int(ys.max()) - int(ys.min()) + 1) / H
            if span_w >= self.bg_span or span_h >= self.bg_span:
                cut_bg += 1
                continue
            subjects.append(mask)

        if not subjects and candidates:
            subjects = candidates
            cut_bg = 0

        subjects.sort(key=lambda m: -int(m.sum()))

        merged = np.zeros((H, W), dtype=bool)
        for m in subjects:
            merged |= m

        # ★ 置信度来自模型自己给的 seg_score，不是我们猜的
        mean_score = sum(scores) / len(scores) if scores else 0.0
        confidence = "high" if mean_score >= 0.8 else "medium" if mean_score >= 0.5 else "low"

        return SegmentResult(
            mask=merged,
            subjects=subjects,
            background_color=None,
            provider=self.name,
            params=self._params(),
            notes=[
                f"EntitySegment 返回 {len(layers)} 个实体图层，保留 {len(subjects)} 个"
                + (f"（{cut_small} 个面积过小）" if cut_small else "")
                + (f"（{cut_bg} 个跨幅背景层）" if cut_bg else ""),
                f"模型自评 seg_score 均值 {mean_score:.3f}"
                + (f"，明细 {[round(s, 3) for s in scores]}" if scores else ""),
                "★ 每个图层是模型给出的独立实体 —— 五只猫即使挨着也能分开，"
                "这是色键控和 rembg 都做不到的",
            ],
            confidence=confidence,
            diagnostics={
                "entity_num": entity_num,
                "layers": len(layers),
                "kept": len(subjects),
                "cut_small": cut_small,
                "cut_background": cut_bg,
                "seg_score": scores,
                "mean_seg_score": mean_score,
                "send_side": int(max(send.shape[:2])),
                "scale": scale,
            },
        )

    def _params(self) -> dict[str, Any]:
        return {
            "action": ACTION,
            "version": VERSION,
            "req_key": REQ_KEY,
            "max_entity": self.max_entity,
            "return_format": 1,
            "refine_mask": int(self.refine),
            "mask_threshold": self.mask_threshold,
            "max_side": self.max_side,
            "min_area_ratio": self.min_area_ratio,
        }


# ------------------------------------------------------------------ 自检入口

if __name__ == "__main__":
    """
    手工验证一条链路：`python -m pipeline.providers.volcengine_provider <图片>`
    把每个实体的掩码写成 PNG 到 generated/volc-probe/，肉眼确认"有没有分开"。
    这个入口存在的理由：远程 API 的失败模式是**静默的**（返回一张糊掩码，
    但 HTTP 200），只有看过图才知道它对不对。
    """
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if not target or not target.is_file():
        raise SystemExit("用法: python -m pipeline.providers.volcengine_provider <图片路径>")

    src = Image.open(target).convert("RGB")
    provider = VolcengineSegmentProvider()
    print(f"provider = {provider.describe()}")
    print(f"image    = {target.name} {src.size}")

    result = provider.segment(np.asarray(src))
    print(f"confidence = {result.confidence}")
    for note in result.notes:
        print(f"  · {note}")

    out_dir = _project_root() / "generated" / "volc-probe"
    out_dir.mkdir(parents=True, exist_ok=True)
    for i, sub in enumerate(result.subjects, 1):
        Image.fromarray((sub.astype(np.uint8) * 255)).save(out_dir / f"{target.stem}-sub{i:02d}.png")
    print(f"掩码已写入 {out_dir}")
