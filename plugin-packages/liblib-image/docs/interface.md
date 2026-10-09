# Liblib 接口合同

协议 ID `liblib-image`。服务器以实际接口路径、毫秒时间戳和随机串计算 HMAC-SHA1，使用无填充 Base64URL；配置字段 `apiKey` 是 AccessKey，`secretKey` 是 SecretKey。

创建请求 `POST /api/generate/webui/text2img`；有一张普通参考图时使用 `/api/generate/webui/img2img`。顶层为 `templateUuid` 与 `generateParams`。查询为 `POST /api/generate/webui/status`，只提交原 `generateUuid`，恢复任务不重新创建。

文生图输出尺寸映射为 `generateParams.width/height`；图生图映射为 `generateParams.resizedWidth/resizedHeight`，同时传入普通内容参考图的 `sourceImage`、`mode: 0`（普通图生图）与 `resizeMode: 0`（完整画幅拉伸）。尺寸使用统一输出合同，不能替换为内容参考图或 ControlNet 原图尺寸；独立 ControlNet 单元仍携带各自真实 `width/height`。本协议不把输出范围蒙版转成 `mode: 4` 局部重绘。字段依据 [LiblibAI SDK 图生图示例](https://github.com/gravitywp/liblib-javascript#image-to-image)，飞书原文不可达时以该同模板示例核对。

`providerOptions.liblib-image` 提供 `family`、`templateUuid`、`checkPointId`、`steps`、`sampler`、`cfgScale`、`seed`、`negativePrompt`、`denoisingStrength`、`width`、`height`。`family=f1` 的官方固定基础算法模板不发送 `checkPointId`、`sampler`、`cfgScale`；`family=sd` 必须配置这些值。图生图必须配置 `denoisingStrength`。不默认写入未经确认的 UUID。

渠道模型的 `providerDefaults` 保存上述协议标量参数，并支持 `textToImageTemplateUuid`、`imageToImageTemplateUuid`、`controlNetModel`。服务端按是否有普通内容参考图选择模板，显式 `templateUuid` 优先；控制图不触发图生图。未指定控制模型的单元使用 `controlNetModel`。这些辅助字段仅用于解析配置，真实上游 payload 仍只有 `templateUuid` 与 `generateParams`。当前实际选定渠道的默认值与用户显式值在创建任务时合并并冻结，后台后续修改不影响已排队任务；自动切换渠道只带用户原有显式值。

仅已验证 checkpoint `0ea388c7eb854be3ba3c6f65aac6bfd3` 且启用兼容的 ControlNet 能力时提供默认值：`family=sd`、文生图模板 `e10adc3949ba59abbe56e057f20f883e`、图生图模板 `9c7d531dc75f476aa833b3d452b8f7ad`、Canny XL `b6806516962f4e1599a93ac4483c3d23`、`steps=20`、`sampler=15`、`cfgScale=7`、`seed=-1`、`denoisingStrength=0.75`。管理员配置覆盖这些值，其他 checkpoint 不套用此组合。

独立 `controlNet` 单元映射 `unitOrder`（1–4）、`sourceImage`、参考图 `width/height`、`preprocessor`、`annotationParameters`、`model`、`controlWeight`、`startingControlStep/endingControlStep`、`pixelPerfect`、`controlMode`、`resizeMode` 与可选 `maskImage`。首版 Canny 枚举为 1，参数为分辨率64–2048、阈值1–255。控制影响蒙版须与参考图同尺寸；该蒙版不保证外部像素为黑。

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
  "version": "1.0.2",
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
            "description": "默认 Canny 控制模型 UUID；控制单元未指定模型时使用。"
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
            "description": "独立控制单元，最多4组；首版支持Canny，不混入普通参考图。"
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
