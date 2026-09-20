# PHASE 24 — 火山引擎实体分割 provider（`--provider=volcengine`）

> 状态：**代码完成、鉴权未通**。见文末「卡在哪」一节。

## 为什么要有这个 provider

`colorkey` 有一条写死的适用边界：**背景必须近似均匀**。
油画笔触、树林、人群这类高频背景会让它把背景与主体的统计特征混在一起，
本项目里最典型的表现就是 —— **五只猫被合并成一个连通域**。

后果不是"抠得难看"，而是**结构性的**：合并成一个主体 → 只有一套动画轨道 →
五只猫只能整体飘浮，拿不到各自独立的运动（`MOTION_CYCLE` 给每个 subject
分配不同预设，前提是它们得是 5 个 subject）。

`EntitySegment` 之所以是解药，不是因为它"更准"，而是因为它的返回结构是
**每个实体一个独立图层**（`return_format=1`），外加 `entity_num`（实体计数）
和 `seg_score`（每个实体的置信度）。**"这是五个主体"是 API 直接告诉我们的，
不需要靠连通域去猜。**

### 与 rembg 的关键差别（容易搞混）

| | rembg | EntitySegment |
|---|---|---|
| 输出 | 一张"前景 vs 背景"掩码 | 每个实体**各自**一张图层 |
| 五只猫 | 给一张掩码，之后靠连通域拆 | 直接给 5 张图层 |
| 猫挨着时 | 连通域连成一片 → 拆不开 | 模型级实例分割 → 仍可分开 |

所以 rembg 解决不了本项目的这个问题，EntitySegment 能。

## 接口契约（已核对官方文档）

```
POST https://visual.volcengineapi.com/?Action=EntitySegment&Version=2024-06-06
Content-Type: application/json; charset=UTF-8
X-Date: 20240722T064541Z
X-Content-Sha256: <hex(sha256(body))>
Authorization: HMAC-SHA256 Credential=<AK>/<yyyymmdd>/cn-beijing/cv/request,
               SignedHeaders=host;x-content-sha256;x-date, Signature=<hex>

{ "req_key": "entity_seg",
  "binary_data_base64": ["<base64>"],
  "max_entity": 8,        // 1~100
  "return_format": 1,     // 1 = 每个实体一个独立图层  ★本 provider 的全部理由
  "refine_mask": 1 }      // 1 = 边缘增强
```

响应：

```jsonc
{ "code": 10000,
  "data": {
    "binary_data_base64": ["<图层1>", "<图层2>", ...],
    "entity_num": [2],
    "seg_score": [0.9998, 0.9997],
    "ori_width": [332], "ori_height": [400]
  } }
```

## 实现的三个易错点（都在代码注释里标了）

1. **鉴权是签名，不是 Bearer。**
   四段式 HMAC-SHA256 派生：`kDate = HMAC(secret, 短日期)` → `kRegion` →
   `kService` → `kSigning = HMAC(kService,"request")`（与 AWS SigV4 同构，
   但**没有** `AWS4` 前缀）。`X-Date` 与 `X-Content-Sha256` 必须参与签名。

2. **请求体上限 10 MB**（`ECReqBodySizeLimited`）。
   base64 会把体积放大约 33%，所以大图先按 `max_side`（默认 2048）缩边再编码；
   返回的置信度图再按原尺寸双线性还原 —— 在**置信度图**上缩放再阈值化，
   比在二值掩码上做最近邻缩放干净得多（不会出锯齿台阶）。

3. **返回的图层是置信度图，不是 RGBA 图。**
   文档原文："实体图层：取值范围 0～255，代表属于当前图层的置信度"。
   所以可能是单通道 `L`，也可能是置信度放在 alpha 的 `RGBA`。
   两种情况都要接住（`_layer_to_confidence()`），不能无脑取 alpha。

依赖只有标准库 —— 用 `urllib.request` 而非 `requests`，
保持整条流水线"pillow + numpy"两个依赖的现状。

## 用法

```bash
# 1) 配密钥（.env 已 gitignore）
cp .env.example .env
#    填 VOLC_ACCESS_KEY / VOLC_SECRET_KEY

# 2) 跑
npm run build-assets -- --provider=volcengine
npm run build-assets -- --provider=volcengine --max-entity=6 --mask-threshold=0.45

# 3) 只看这一张图分出了几个实体（会写掩码 PNG 到 generated/volc-probe/）
cd scripts/build-assets
python -m pipeline.providers.volcengine_provider ../../input/scene01.jpg
```

`--max-entity` / `--mask-threshold` / `--no-refine` 只对 volcengine 生效，
其余 provider 通过 `**_` 忽略它们。

## ★ 卡在哪：新版 IAM API Key 不被 OpenAPI 网关接受

用户提供的密钥对是 **新版 IAM API Key**（`Id` + 以 `Vx` 开头的 `Secret`，
与 `CreateApiKey` 文档返回的 `{"Id":"Ab3kX9mN…","Secret":"VxeyJrIj…"}` 同构），
**不是** 经典的 Access Key（AK/SK，ID 以 `AKL` 开头）。

实测证据（都对 `iam` 与 `cv` 两个服务各测过）：

| 鉴权写法 | 结果 |
|---|---|
| HMAC-SHA256 签名，`Credential=<Id>` | `InvalidAccessKey` — *"The security token[ETEqsK1pu5Nrt5Al] included in the request is invalid."* |
| 同上，Secret 去掉 `Vx` 前缀 / 换成 protobuf 内嵌的 16 字节 | 同样 `InvalidAccessKey` |
| `Authorization: Bearer <Secret>` | `InvalidAuthorization` — *"Invalid 'Authorization' header"* |
| `X-Api-Key: <Secret>` | `InvalidCredential` |

关键判据：**IAM 自己的 `ListUsers` 也返回 `InvalidAccessKey`**。
所以这不是"cv 服务不接受"，而是 **该凭证 ID 在 OpenAPI 网关上根本查不到** ——
任何签名变体都救不了（`InvalidAccessKey` 发生在验签**之前**）。

也就是说：这条链路只差一个**经典 AK/SK**，代码本身不需要改。

### 需要用户做的

到 控制台 → 密钥管理 取一对 **Access Key ID / Secret Access Key**
（ID 以 `AKL` 开头），填进 `.env` 后重试即可。

## 已验证的部分

- `--list-providers` 能列出 `volcengine`
- 签名链路可达服务端（返回的是结构化的业务错误，不是网络/格式错误）
- `build-assets:selftest`（17 项算子断言）全过
- `generated/volc-probe/` 的落盘逻辑与掩码还原逻辑已写好，等凭证打通即可验证

## 文件清单

| 文件 | 作用 |
|---|---|
| `scripts/build-assets/pipeline/providers/volcengine_provider.py` | provider 本体 + 手工探测入口 |
| `scripts/build-assets/pipeline/providers/base.py` | `load_builtin_providers()` 里注册 |
| `scripts/build-assets/pipeline/main.py` | `--max-entity` / `--mask-threshold` / `--no-refine` |
| `.env.example` | 密钥模板 |
| `.env` | 真实密钥（gitignore，不入库） |
