# {{NAME}}

## 接口

{{OPERATIONS}}

当前适配器通过 Liblib 官方 WebUI 异步接口创建图片任务。有一张普通参考图时，创建路径切换为 `/api/generate/webui/img2img`；没有普通参考图时使用 `/api/generate/webui/text2img`。控制图来自独立的 ControlNet 单元，不计入普通图片参考输入，因此上传控制图不会改变文生图模式。查询使用 `/api/generate/webui/status`，发送原 `generateUuid`。上传素材使用 `/api/generate/upload/signature` 获取临时 OSS V4 postObject 凭证，再把文件发送到签名响应的目的地址。

## 模型

渠道必须声明真实的平台模型或模板标识。`family=f1` 使用固定基础算法模板，官方示例不发送 SD checkpoint、采样器和 CFG 参数。`family=sd` 使用普通 SD/SDXL 模板，`checkPointId` 缺省取渠道模型配置。模板 UUID、基础模型 UUID和控制模型 UUID是不同标识，不能将网页名称或 Hugging Face 仓库名称作为平台 UUID。当前没有内置未经验证的模型与模板组合。

## 参数

`providerOptions.liblib-image` 提供 family、templateUuid、checkPointId、steps、sampler、cfgScale、seed、negativePrompt、denoisingStrength以及可选输出width/height。统一输出合同提供像素宽高和图片数量。首版只处理一张普通参考图，图生图必须给出0–1的重绘幅度。采样步数须是正整数，随机种子-1表示随机，其余为非负整数。

文生图将输出尺寸写入 `generateParams.width/height`；图生图使用 `resizedWidth/resizedHeight`，并发送 `sourceImage`、`mode: 0` 与 `resizeMode: 0`。这些尺寸来自统一输出合同，不是参考图真实尺寸；ControlNet 的 `width/height` 仍是控制图真实尺寸。`mode: 4` 是局部重绘，不用于普通内容参考图或后处理输出蒙版。映射依据 [LiblibAI SDK 图生图示例](https://github.com/gravitywp/liblib-javascript#image-to-image)。插件 1.0.2 需要同步升级后端内置适配器。

渠道 `providerDefaults` 可保存协议默认参数及 textToImageTemplateUuid、imageToImageTemplateUuid、controlNetModel。任务创建按实际选定渠道合并用户显式值，再根据普通参考图选择文生/图生模板，填补缺省控制模型并冻结；辅助字段不会直接发送上游。已验证 SDXL checkpoint `0ea388c7eb854be3ba3c6f65aac6bfd3` 在启用兼容 ControlNet 时提供默认组合，其他 checkpoint 不推断模板和控制模型。

ControlNet 最多四组，执行顺序从1开始。首版 Canny 对应平台预处理器1，检测分辨率64–2048、阈值1–255。控制权重0–2，起止比例0–1且起点不晚于终点。控制偏好可选择均衡、提示词优先或ControlNet优先；图像适配可选择直接缩放、等比裁切或等比补边。可选控制影响蒙版要求白色蒙版、黑色底色并与参考图同尺寸。控制影响蒙版不会锁住生成图片外部像素；独立输出范围蒙版在结果保存阶段合成。

## 官方文档与鉴权

官方API使用说明：https://resonate.feishu.cn/wiki/UAMVw67NcifQHukf8fpccgS5n6d 。上传说明：https://resonate.feishu.cn/wiki/A9M2whHxsiKtu8kpIn3cZp0PnVw 。配置apiKey对应AccessKey，secretKey对应SecretKey；由后端使用实际接口路径、毫秒时间戳和随机串计算HMAC-SHA1，以无填充Base64URL发送签名。密钥不会传给OSS目的地址。上传签名和文件请求的正文不写入调用日志，临时凭证不会进入任务检查点。

## 当前实现与响应

业务code必须为0；生成状态1等待，2执行中，3已生成但未完成审核，4审核中，5最终成功，6失败，7超时。3和4必须继续查询，不能提取预览图提前结束。成功响应必须提供可用且审核通过的图片。任务首次接受的generateUuid会持久化，进程恢复只查询原任务；素材上传结果按账户及文件字节指纹保存，可复用相同素材。PNG/JPEG图片不得超过10MB，参考图宽高不得超过4096。未知状态、缺少任务ID、无图片成功响应以及格式或尺寸不符均返回真实错误。

{{CONTRACT}}
