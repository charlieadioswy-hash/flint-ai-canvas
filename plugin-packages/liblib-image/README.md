# Liblib 图片与 ControlNet

通过官方异步 API 调用 Liblib 文生图与图生图。此插件使用影策内置协议适配器，复用任务宿主的签名、出站限制、轮询和结果保存。

1.2.0 接通官方 Control Type 目录，按类型联动预处理器、基础算法、Model UUID 与专有参数。目录覆盖官方表的 64 个预处理器；模型目录按 UUID 合并，保留官方名称和出处。Instant ID 59/60 支持通用控制单元，完整双图换脸仍需专用工作流。Revision 未公开映射，F.1 主体参考专用流程尚未接通，界面说明限制；Qwen Image 模型保留目录信息，当前 `sd`/`f1` 生成模板不支持调用。

SD/SDXL 局部重绘将内容原图和独立重绘蒙版映射到 `mode: 4`，可以与适配的 ControlNet 单元同时使用。宿主将画布透明蒙版转换为 Liblib 黑白蒙版；普通图生图继续使用 `mode: 0` 和 `resizedWidth/resizedHeight`。升级插件时须同步更新后端宿主，并由管理员按模板实际能力开启模型的蒙版编辑。

安装插件后配置 AccessKey（apiKey）、SecretKey（secretKey）与渠道模型的生成默认参数；密钥由后端注入，浏览器不计算签名。后台按文生图和图生图分别保存模板 UUID，用户上传内容参考图时自动选择图生图模板。

支持 Canny、SoftEdge、MLSD、Scribble/Sketch、Lineart、Depth、Segment、Normal、OpenPose、Tile/Blur、Reference、IP-Adapter、T2I-Adapter、Shuffle、Recolor、Inpaint、Instant ID 等官方控制类型。None 用于已处理的线稿/深度/骨骼图及官方 PuLID 专例，invert 用于线稿；两者均保留明确的目标 Control Type。Reference 使用 None 模型，不发送伪造 UUID。当前产品的 Inpaint 40–42 单元要求独立控制区域蒙版。完整机器目录见 `docs/controlnet-catalog.json`。

控制区域蒙版与最终输出范围蒙版分别处理。已验证 SDXL checkpoint `0ea388c7eb854be3ba3c6f65aac6bfd3` 与 Canny XL `b6806516962f4e1599a93ac4483c3d23` 组合；仅此 checkpoint 在已启用且兼容的 ControlNet 能力下提供默认组合，管理员可覆盖。默认 `controlNetModel` 先检查类型、预处理器与基础算法兼容性，不能把 Canny 专用模型套用到其他类型；其他类型按官方预处理器推荐和兼容目录选择。自定义模型须登记实际兼容信息。

透明 PNG Canny 控制图上传前会按原尺寸合成到黑底，避免透明区域隐藏的 RGB 干扰边缘检测；不透明控制图保持原始字节。此处理只改变 Liblib 使用的控制图副本，平台原图、内容参考图和蒙版各自保留。
