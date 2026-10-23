# Liblib 接口合同

协议 ID `liblib-image`。服务器以实际接口路径、毫秒时间戳和随机串计算 HMAC-SHA1，使用无填充 Base64URL；配置字段 `apiKey` 是 AccessKey，`secretKey` 是 SecretKey。

创建请求 `POST /api/generate/webui/text2img`；有一张普通参考图时使用 `/api/generate/webui/img2img`。顶层为 `templateUuid` 与 `generateParams`。查询为 `POST /api/generate/webui/status`，只提交原 `generateUuid`，恢复任务不重新创建。

文生图输出尺寸映射为 `generateParams.width/height`；图生图映射为 `generateParams.resizedWidth/resizedHeight`，同时传入普通内容参考图的 `sourceImage`、`mode: 0`（普通图生图）与 `resizeMode: 0`（完整画幅拉伸）。尺寸使用统一输出合同，不能替换为内容参考图或 ControlNet 原图尺寸；独立 ControlNet 单元仍携带各自真实 `width/height`。本协议不把输出范围蒙版转成 `mode: 4` 局部重绘。字段依据 [LiblibAI SDK 图生图示例](https://github.com/gravitywp/liblib-javascript#image-to-image)，飞书原文不可达时以该同模板示例核对。

`providerOptions.liblib-image` 提供 `family`、`templateUuid`、`checkPointId`、`steps`、`sampler`、`cfgScale`、`seed`、`negativePrompt`、`denoisingStrength`、`inpaintMaskMode`、`width`、`height`。`family=f1` 的官方固定基础算法模板不发送 `checkPointId`、`sampler`、`cfgScale`；`family=sd` 必须配置这些值。图生图必须配置 `denoisingStrength`。不默认写入未经确认的 UUID。

局部重绘复用任务顶层 `mask`（协议图片角色 `mask`），必须另外提供一张普通内容原图，且两者真实像素尺寸完全相同。仅已核实的 `family=sd` 路径接收，模型还须显式声明 `references.maskSupported`。默认 `inpaintMaskMode=alpha` 延续通用画布的透明处重绘；黑白蒙版显式使用 `luminance`，白处重绘、黑处保留，透明像素视为黑。宿主读取真实像素、拒绝没有重绘区域的蒙版，转换为不透明灰度 PNG 后上传；此蒙版转换不改变内容原图或控制图。该字段仅决定宿主如何解释图片，不直接发给供应商。

同时存在原图和重绘蒙版时发送 `mode: 4` 与 `inpaintParam`，采用 SDK 示例的 `maskBlur: 4`、`maskPadding: 32`、`maskMode: 0`、`inpaintArea: 0`、`inpaintingFill: 1`，`maskImage` 为转换后的上传地址；输出尺寸仍为 `resizedWidth/resizedHeight`。Canny 继续在独立 `controlNet[]` 中引导边缘，其 `maskImage` 只限定控制影响范围。最终 `outputMask` 只在宿主保存结果时裁出黑底，不会隐式启用局部重绘或代替重绘蒙版。SDK 的同一图生图示例同时声明局部重绘与 ControlNet；离线测试确认本地参数和像素转换，当前模板、账号及内容效果仍需实图验收。

渠道模型的 `providerDefaults` 保存上述协议标量参数，并支持 `textToImageTemplateUuid`、`imageToImageTemplateUuid`、`controlNetModel`。服务端按是否有普通内容参考图选择模板，显式 `templateUuid` 优先；控制图不触发图生图。未指定控制模型的单元先使用已登记且与 Control Type、预处理器及基础算法兼容的 `controlNetModel`，否则按官方预处理器推荐和兼容目录选择；不能把 Canny 专用模型套用于其他类型。Reference 允许空模型并省略上游 `model`。这些辅助字段仅用于解析配置，真实上游 payload 仍只有 `templateUuid` 与 `generateParams`。当前实际选定渠道的默认值与用户显式值在创建任务时合并并冻结，后台后续修改不影响已排队任务；自动切换渠道只带用户原有显式值。

仅已验证 checkpoint `0ea388c7eb854be3ba3c6f65aac6bfd3` 且启用兼容的 ControlNet 能力时提供默认值：`family=sd`、文生图模板 `e10adc3949ba59abbe56e057f20f883e`、图生图模板 `9c7d531dc75f476aa833b3d452b8f7ad`、Canny XL `b6806516962f4e1599a93ac4483c3d23`、`steps=20`、`sampler=15`、`cfgScale=7`、`seed=-1`、`denoisingStrength=0.75`。管理员配置覆盖这些值，其他 checkpoint 不套用此组合。

独立 `controlNet` 单元映射 `unitOrder`（1–4）、`sourceImage`、参考图 `width/height`、`preprocessor`、`annotationParameters`、`model`、`controlWeight`、`startingControlStep/endingControlStep`、`pixelPerfect`、`controlMode`、`resizeMode` 与可选 `maskImage`。控制影响蒙版须与参考图同尺寸；该蒙版不保证外部像素为黑。

### Control Type、预处理器与 Model

1.2.0 使用与宿主和前端相同的 `docs/controlnet-catalog.json`，覆盖[官方 64 项预处理器表](https://resonate.feishu.cn/wiki/UAMVw67NcifQHukf8fpccgS5n6d#share-Z2zjdfLzGoAJcrx0twhcLxb5nnJ)、[模型名称与 UUID 表](https://resonate.feishu.cn/wiki/UAMVw67NcifQHukf8fpccgS5n6d#share-VZ1odH3pbowJypxPP3Mc8cY2nic)及 F.1 主体参考示例。相同 UUID 的多个官方类型合并到 `controlTypes`；F.1 Union Pro 在预处理器表额外推荐的 Scribble、Lineart、OpenPose，以及 xinsir_anime_painter 被推荐的 Lineart 同时保留。预处理器的 `recommendedModels` 按官方完整名称与基础算法匹配为 UUID，用于优先默认和排序；推荐表不替代完整模型表，不把其他兼容变体视为不支持。明确区分的 Instant ID 两个模型使用 `preprocessors` 约束。模型基础算法区分 `sd15`、`sdxl`、`f1`、`qwen-image`，不得混配。自定义 UUID 必须由管理员在模型能力目录登记类型和基础算法后使用。

公共任务合同的 `parameters.controlType` 保存类型；旧 Canny 可省略该字段，其类型由预处理器推导。`parameters.preprocessor` 使用稳定英文 ID，宿主按目录映射整数枚举和 `annotationParameters` 对象键。Canny 继续使用独立 `canny` 对象，其他预处理器使用 `processorParameters` 数值对象：中立键 `resolution` 映射为 `preprocessorResolution`，其余参数按目录 `wireName` 映射。所有专有参数都必须存在且符合各自整数/数值范围；切换预处理器时不能携带旧参数、Canny 对象或未知键。None 和 invert 没有专有参数，必须明确选择对应的 Control Type，不能由它们猜模型类型。None 仅用于已处理的线稿、深度图、骨骼图与官方 PuLID 专例；invert 仅用于白色线条、黑色背景并使用线稿模型的输入，不能泛化到任意控制类型。

例如 Depth LeRes 使用 `preprocessor: "depth_leres"` 与 `processorParameters: { "resolution": 512, "removeNear": 0, "removeBackground": 0 }`，上游写为 `preprocessor: 3` 和 `annotationParameters.depthLeres`。MLSD 使用 `valueThreshold`（0.01–2）和 `distanceThreshold`（0.01–20）；Tile 的部分预处理器只有 `downSamplingRate` 或 `variation`/`sharpness`，不能隐式加上分辨率。Reference 使用 `styleFidelity`，并省略 `model`；Canny 的分辨率范围为 64–2048、阈值为 1–255。每个枚举、对象键、参数范围和默认值都在随包目录中列出。

本产品当前要求 Inpaint 40、41、42 单元提供独立控制蒙版，不能以顶层局部重绘蒙版或最终 `outputMask` 替代；官方公共表将 `maskImage` 标为可选，专用 Inpaint 文生图示例确实提供该字段。Instant ID 59/60 可用于通用控制单元，并分别匹配 `control_instant_id_sdxl` / `ip-adapter_instant_id_sdxl`；[完整换脸示例](https://resonate.feishu.cn/wiki/UAMVw67NcifQHukf8fpccgS5n6d#share-QXsCdTFkloh1Vfxi9PhcDbcQnnh)使用专用模板和两组有顺序的人脸输入，不能把单组结构控制等同于该流程。主体参考 `entityControl=68` 的[官方示例](https://resonate.feishu.cn/wiki/UAMVw67NcifQHukf8fpccgS5n6d#share-Y0SAdKA8Yob6yuxMtMWci1A7nKe)仅用于 F.1 文生图，并使用专用模板及 `unitOrder=0`；本次保留目录证据但不开放执行。Revision 未出现在官方预处理器/模型表中；`clipVision=15` 属于 T2I-Adapter，不能当作 Revision 映射。Qwen Image 模型只保留官方目录信息，当前 `family=sd/f1` 拒绝运行。宿主通用单元沿用公共表的 `unitOrder` 1–4，不将专用示例的0扩展到通用流程。

含透明像素的 PNG Canny 控制图在上传前按原尺寸合成到黑底，保留可见颜色和内部边缘，屏蔽透明区域隐藏的 RGB；远端透明控制图也会重新上传。全不透明控制图保持原始字节或公开 URL。此处理仅作用于 Liblib 的 `control_image` 上传副本，普通内容图、各类蒙版、平台资源及界面原图保持各自内容，合成后仍不得超过 10 MB。

本地素材采用上传签名与 OSS postObject 流程，格式PNG/JPEG且不超过10MB。OSS表单字段遵循官方V4规范。签名凭证仅在内存使用，不保存在任务正文或日志。

响应业务 `code` 必须为0。生成状态1等待，2执行中，3已生图，4审核中，5最终成功，6失败，7超时。3与4继续查询；成功必须有可用图片，审核拒绝的图片不返回。来源：[官方API说明](https://resonate.feishu.cn/wiki/UAMVw67NcifQHukf8fpccgS5n6d)、[上传说明](https://resonate.feishu.cn/wiki/A9M2whHxsiKtu8kpIn3cZp0PnVw)。

<!-- YINGCE_MANIFEST_CONTRACT_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "yingce.plugin/v2",
  "id": "liblib-image",
  "name": "Liblib 图片与 ControlNet",
  "version": "1.2.0",
  "author": "影策",
  "description": "Liblib 官方异步图片 API：独立控制图、服务端签名、上传与审核后结果。",
  "runtime": {
    "backend": "host:liblib-image"
  },
  "permissions": [
    "generation.run",
    "media.read"
  ],
  "configuration": {
    "fields": [
      {
        "name": "apiKey",
        "type": "secret",
        "label": "AccessKey",
        "required": true
      },
      {
        "name": "secretKey",
        "type": "secret",
        "label": "SecretKey",
        "required": true
      }
    ]
  },
  "contributes": {
    "providers": [
      {
        "id": "liblib-image",
        "label": "Liblib 图片与 ControlNet",
        "capabilities": [
          "image"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation"
        ],
        "baseUrl": "https://openapi.liblibai.cloud",
        "supportsControlNet": true,
        "auth": {
          "type": "liblib-hmac-sha1",
          "field": "apiKey",
          "secretField": "secretKey"
        },
        "parameters": [
          {
            "name": "family",
            "type": "string",
            "required": true,
            "values": [
              "f1",
              "sd"
            ],
            "mapping": "providerOptions.liblib-image.family",
            "description": "模板基础算法：F.1 固定基础模型，或 SD/SDXL 自定义 checkpoint。"
          },
          {
            "name": "textToImageTemplateUuid",
            "type": "string",
            "mapping": "providerOptions.liblib-image.textToImageTemplateUuid",
            "description": "文生图默认模板 UUID；没有普通参考图时使用。"
          },
          {
            "name": "imageToImageTemplateUuid",
            "type": "string",
            "mapping": "providerOptions.liblib-image.imageToImageTemplateUuid",
            "description": "图生图默认模板 UUID；有普通内容参考图时使用。"
          },
          {
            "name": "controlNetModel",
            "type": "string",
            "mapping": "providerOptions.liblib-image.controlNetModel",
            "description": "默认控制模型 UUID；仅在 Control Type、预处理器与基础算法兼容时使用，否则按推荐和兼容目录选择。"
          },
          {
            "name": "templateUuid",
            "type": "string",
            "mapping": "providerOptions.liblib-image.templateUuid",
            "description": "可选固定模板 UUID，覆盖按生成方式选择的默认模板。"
          },
          {
            "name": "checkPointId",
            "type": "string",
            "mapping": "providerOptions.liblib-image.checkPointId",
            "description": "SD/SDXL 基础模型 UUID；缺省取渠道 model，F.1 固定模板不发送此项。"
          },
          {
            "name": "steps",
            "type": "integer",
            "required": true,
            "mapping": "providerOptions.liblib-image.steps",
            "description": "采样步数，正整数。"
          },
          {
            "name": "sampler",
            "type": "integer",
            "mapping": "providerOptions.liblib-image.sampler",
            "description": "SD/SDXL 必填的官方采样器整数枚举；F.1 模板不发送。"
          },
          {
            "name": "cfgScale",
            "type": "number",
            "mapping": "providerOptions.liblib-image.cfgScale",
            "description": "SD/SDXL 必填的提示词引导系数；F.1 模板不发送。"
          },
          {
            "name": "seed",
            "type": "integer",
            "mapping": "providerOptions.liblib-image.seed",
            "description": "随机种子；-1 表示随机。"
          },
          {
            "name": "negativePrompt",
            "type": "string",
            "mapping": "providerOptions.liblib-image.negativePrompt",
            "description": "可选负向提示词。"
          },
          {
            "name": "denoisingStrength",
            "type": "number",
            "mapping": "providerOptions.liblib-image.denoisingStrength",
            "description": "图生图必填的重绘幅度，0–1。"
          },
          {
            "name": "inpaintMaskMode",
            "type": "string",
            "values": [
              "alpha",
              "luminance"
            ],
            "mapping": "providerOptions.liblib-image.inpaintMaskMode",
            "description": "局部重绘蒙版解释：alpha（默认）透明处重绘；luminance 白色处重绘。仅 SD/SDXL，须同时提供内容原图与独立重绘蒙版。"
          },
          {
            "name": "width",
            "type": "integer",
            "mapping": "providerOptions.liblib-image.width",
            "description": "输出宽度；优先使用统一明确像素尺寸。"
          },
          {
            "name": "height",
            "type": "integer",
            "mapping": "providerOptions.liblib-image.height",
            "description": "输出高度；优先使用统一明确像素尺寸。"
          },
          {
            "name": "controlNet",
            "type": "controlNet[]",
            "mapping": "controlNet",
            "description": "独立控制单元，最多4组；Control Type 联动官方预处理器、兼容模型和专有参数，不混入普通参考图。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/api/generate/webui/text2img",
          "originPath": true,
          "contentType": "application/json"
        },
        "poll": {
          "method": "POST",
          "path": "/api/generate/webui/status",
          "originPath": true,
          "contentType": "application/json"
        },
        "response": {
          "status": "pending"
        }
      }
    ]
  },
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>"
}
```
<!-- YINGCE_MANIFEST_CONTRACT_END -->
