# Liblib 接口合同

协议 ID `liblib-image`。服务器以实际接口路径、毫秒时间戳和随机串计算 HMAC-SHA1，使用无填充 Base64URL；配置字段 `apiKey` 是 AccessKey，`secretKey` 是 SecretKey。

创建请求 `POST /api/generate/webui/text2img`；有一张普通参考图时使用 `/api/generate/webui/img2img`。顶层为 `templateUuid` 与 `generateParams`。查询为 `POST /api/generate/webui/status`，只提交原 `generateUuid`，恢复任务不重新创建。

`providerOptions.liblib-image` 提供 `family`、`templateUuid`、`checkPointId`、`steps`、`sampler`、`cfgScale`、`seed`、`negativePrompt`、`denoisingStrength`、`width`、`height`。`family=f1` 的官方固定基础算法模板不发送 `checkPointId`、`sampler`、`cfgScale`；`family=sd` 必须配置这些值。图生图必须配置 `denoisingStrength`。不默认写入未经确认的 UUID。

独立 `controlNet` 单元映射 `unitOrder`（1–4）、`sourceImage`、参考图 `width/height`、`preprocessor`、`annotationParameters`、`model`、`controlWeight`、`startingControlStep/endingControlStep`、`pixelPerfect`、`controlMode`、`resizeMode` 与可选 `maskImage`。首版 Canny 枚举为 1，参数为分辨率64–2048、阈值1–255。控制影响蒙版须与参考图同尺寸；该蒙版不保证外部像素为黑。

本地素材采用上传签名与 OSS postObject 流程，格式PNG/JPEG且不超过10MB。OSS表单字段遵循官方V4规范；Liblib返回字段到V4表单字段的映射尚待真实账号验证。签名凭证仅在内存使用，不保存在任务正文或日志。

响应业务 `code` 必须为0。生成状态1等待，2执行中，3已生图，4审核中，5最终成功，6失败，7超时。3与4继续查询；成功必须有可用图片，审核拒绝的图片不返回。来源：[官方API说明](https://resonate.feishu.cn/wiki/UAMVw67NcifQHukf8fpccgS5n6d)、[上传说明](https://resonate.feishu.cn/wiki/A9M2whHxsiKtu8kpIn3cZp0PnVw)。

<!-- YINGCE_MANIFEST_CONTRACT_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "yingce.plugin/v2",
  "id": "liblib-image",
  "name": "Liblib 图片与 ControlNet",
  "version": "1.0.0",
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
            "name": "templateUuid",
            "type": "string",
            "required": true,
            "mapping": "providerOptions.liblib-image.templateUuid",
            "description": "当前文生图或图生图模式的官方模板 UUID，必须由渠道配置提供。"
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
