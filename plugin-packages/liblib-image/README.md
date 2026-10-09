# Liblib 图片与 ControlNet

通过官方异步 API 调用 Liblib 文生图与图生图。此插件使用影策内置协议适配器，复用任务宿主的签名、出站限制、轮询和结果保存。

1.0.2 修复图生图输出尺寸映射：宿主发送 `resizedWidth/resizedHeight` 与普通图生图模式，不再复用文生图的 `width/height`。升级插件时须同步更新后端宿主。

安装插件后配置 AccessKey（apiKey）、SecretKey（secretKey）与渠道模型的生成默认参数；密钥由后端注入，浏览器不计算签名。后台按文生图和图生图分别保存模板 UUID，用户上传内容参考图时自动选择图生图模板。

支持 Canny 控制图，控制区域蒙版与最终输出范围蒙版分别处理。已验证 SDXL checkpoint `0ea388c7eb854be3ba3c6f65aac6bfd3` 与 Canny XL `b6806516962f4e1599a93ac4483c3d23` 组合；仅此 checkpoint 在已启用且兼容的 ControlNet 能力下提供默认组合，管理员可覆盖。其他模型须按实际官方目录配置。
