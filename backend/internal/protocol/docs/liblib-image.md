# {{NAME}}

## 接口

{{OPERATIONS}}

当前适配器通过 Liblib 官方 WebUI 异步接口创建图片任务。有一张普通参考图时，创建路径切换为 `/api/generate/webui/img2img`；没有普通参考图时使用 `/api/generate/webui/text2img`。控制图来自独立的 ControlNet 单元，不计入普通图片参考输入，因此上传控制图不会改变文生图模式。查询使用 `/api/generate/webui/status`，发送原 `generateUuid`。上传素材使用 `/api/generate/upload/signature` 获取临时 OSS V4 postObject 凭证，再把文件发送到签名响应的目的地址。

## 模型

渠道必须声明真实的平台模型或模板标识。`family=f1` 使用固定基础算法模板，官方示例不发送 SD checkpoint、采样器和 CFG 参数。`family=sd` 使用普通 SD/SDXL 模板，`checkPointId` 缺省取渠道模型配置。模板 UUID、基础模型 UUID和控制模型 UUID是不同标识，不能将网页名称或 Hugging Face 仓库名称作为平台 UUID。当前没有内置未经验证的模型与模板组合。

## 参数

{{PARAMETERS}}

上表列出宿主可配置字段；渠道默认值合并后，最终请求还须通过组合校验：`family` 必须为 `f1` 或 `sd`，`templateUuid` 必须是有效 UUID，`steps` 必须是正整数。`family=sd` 还要求有效的 `checkPointId`（缺省取渠道上游模型）、非负整数 `sampler` 和非负数 `cfgScale`；`family=f1` 不发送这三个 SD 专用字段。`seed` 缺省为 -1，表示随机，显式值须为 -1 或非负整数。`negativePrompt` 为可选负向提示词。只处理一张普通参考图；有普通参考图时必须提供 0–1 的 `denoisingStrength`。

输出尺寸优先使用统一输出合同中的像素宽高，其次使用 `providerOptions.liblib-image` 中成对的 `width`、`height`，最后读取明确的像素尺寸字符串（如 `1024x576`）。宿主要求每边为 1–4096 的整数；这不替代上游模型或模板的尺寸限制。图片数量优先取统一输出合同，其次取图片数量字段，缺省为 1，最多为 4。

文生图将输出尺寸写入 `generateParams.width/height`；普通图生图使用 `resizedWidth/resizedHeight`，并发送 `sourceImage`、`mode: 0` 与 `resizeMode: 0`。这些尺寸来自统一输出合同，不是参考图真实尺寸；ControlNet 的 `width/height` 仍是控制图真实尺寸。映射依据 [LiblibAI SDK 图生图示例](https://github.com/gravitywp/liblib-javascript#image-to-image)。插件 1.2.0 需要同步升级后端内置适配器。

SD/SDXL 局部重绘要求一张内容原图和独立 `mask`，并显式开启模型的蒙版编辑能力；`family=f1` 当前不声明支持。两张图片的真实像素尺寸必须相同。`inpaintMaskMode` 默认 `alpha`，透明处重绘，保持通用画布的蒙版含义；黑白蒙版使用 `luminance`，白处重绘、黑处保留，透明像素视为黑。宿主转换为不透明灰度 PNG，再发送 `mode: 4` 与 `inpaintParam.maskImage`，其余采用 SDK 示例默认值 `maskBlur=4`、`maskPadding=32`、`maskMode=0`、`inpaintArea=0`、`inpaintingFill=1`。没有可重绘区域的蒙版会被拒绝。ControlNet 仍独立发送，输出范围蒙版只在保存结果时合成，不会自动成为重绘蒙版。SDK 明确示例支持局部重绘和 ControlNet 同时传入；离线测试不代表该账号、模板的实图效果已验收。

渠道 `providerDefaults` 可保存协议默认参数及 textToImageTemplateUuid、imageToImageTemplateUuid、controlNetModel。任务创建按实际选定渠道合并用户显式值，再根据普通参考图选择文生/图生模板；缺省控制模型先匹配已登记且兼容的默认值，再按预处理器推荐和兼容目录补选并冻结，不能将 Canny 专用模型套用于其他类型。辅助字段不会直接发送上游。已验证 SDXL checkpoint `0ea388c7eb854be3ba3c6f65aac6bfd3` 在启用兼容 ControlNet 时提供默认组合，其他 checkpoint 不推断模板和控制模型。

ControlNet 最多四组，执行顺序从1开始。Control Type 按[官方预处理器表](https://resonate.feishu.cn/wiki/UAMVw67NcifQHukf8fpccgS5n6d#share-Z2zjdfLzGoAJcrx0twhcLxb5nnJ)联动预处理器、专有参数及[模型目录](https://resonate.feishu.cn/wiki/UAMVw67NcifQHukf8fpccgS5n6d#share-VZ1odH3pbowJypxPP3Mc8cY2nic)，共享源为 `controlnet_catalog.json`，插件镜像为 `docs/controlnet-catalog.json`。`controlType` 可由非通用预处理器推导；None/invert 必须明确目标类型。Canny 使用 `canny` 对象，其他类型使用 `processorParameters`；`resolution` 映射为 `preprocessorResolution`，不能混入别的预处理器参数。Canny 检测分辨率64–2048、阈值1–255；其他参数严格使用各自目录范围。

Reference 选择 None 模型，省略上游 `model`；本产品当前要求 Inpaint 40–42 有该单元独立的控制蒙版，官方公共表仍将蒙版列为可选。Instant ID 59/60 通用单元按各自模型匹配，完整双图换脸是另一个专用工作流；F.1 主体参考 `entityControl=68` 保留专用示例证据，本次不开放执行。Revision 没有官方映射，不能将 T2I-Adapter 的 `clipVision=15` 当作替代。None 仅用于已处理的线稿/深度/骨骼及 PuLID 专例，invert 仅用于线稿。Qwen Image 模型保留目录信息，当前 `sd`/`f1` 模板不能调用。模型按官方基础算法和类型匹配，自定义模型必须登记兼容信息。控制权重0–2，起止比例0–1且起点不晚于终点。控制偏好可选择均衡、提示词优先或ControlNet优先；图像适配可选择直接缩放、等比裁切或等比补边。控制影响蒙版与参考图同尺寸，不会锁住生成图片外部像素；独立输出范围蒙版在结果保存阶段合成。

Liblib Canny 控制图若为含透明像素的 PNG，宿主按原尺寸将可见颜色合成到黑底后上传，避免透明像素中隐藏的 RGB 干扰边缘检测；远端 URL 也会读取、转换并重新上传。全不透明控制图保留原始字节或公开 URL。转换仅作用于供应商使用的 Canny 控制图副本，普通内容参考图、各类蒙版及平台原始资源保留各自内容；转换后仍须满足 10 MB 限制。

## 官方文档与鉴权

官方API使用说明：https://resonate.feishu.cn/wiki/UAMVw67NcifQHukf8fpccgS5n6d 。上传说明：https://resonate.feishu.cn/wiki/A9M2whHxsiKtu8kpIn3cZp0PnVw 。配置apiKey对应AccessKey，secretKey对应SecretKey；由后端使用实际接口路径、毫秒时间戳和随机串计算HMAC-SHA1，以无填充Base64URL发送签名。密钥不会传给OSS目的地址。上传签名和文件请求的正文不写入调用日志，临时凭证不会进入任务检查点。

## 当前实现与响应

业务code必须为0；生成状态1等待，2执行中，3已生成但未完成审核，4审核中，5最终成功，6失败，7超时。3和4必须继续查询，不能提取预览图提前结束。成功响应必须提供可用且审核通过的图片。任务首次接受的generateUuid会持久化，进程恢复只查询原任务；素材上传结果按账户及文件字节指纹保存，可复用相同素材。PNG/JPEG图片不得超过10MB，参考图宽高不得超过4096。未知状态、缺少任务ID、无图片成功响应以及格式或尺寸不符均返回真实错误。

{{CONTRACT}}
