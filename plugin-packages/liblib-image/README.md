# Liblib 图片与 ControlNet

通过官方异步 API 调用 Liblib 文生图与图生图。此插件使用影策内置协议适配器，复用任务宿主的签名、出站限制、轮询和结果保存。

安装插件后配置 AccessKey（apiKey）、SecretKey（secretKey）和明确的模板 UUID；密钥由后端注入，浏览器不计算签名。具体模板与控制模型 UUID 必须从当前官方目录配置。

首版支持 Canny 控制图，控制区域蒙版与最终输出范围蒙版分别处理。尚未使用真实账号验证平台模型与模板组合。
