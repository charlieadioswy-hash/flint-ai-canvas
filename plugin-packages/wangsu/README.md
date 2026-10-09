# Wangsu 网宿 AI 网关

为系统渠道提供独立的网宿协议，共 14 个 Provider，覆盖文本、图片、视频和语音合成。渠道统一填写网关 Base URL，模型单独选择 `Wangsu · …` 协议。

新版 API Token 对应 Base URL：`https://api.edgecloudapp.com/v2/llm`。不要在渠道地址后再添加 `/openai`、`/anthropic`、`/gemini`、`/v1` 或业务接口路径；插件负责拼接。

参数和结果映射由声明式插件实现；密钥、出站安全、计费、流式、任务轮询和文件持久化由宿主处理。当前仅供系统渠道、画布、创作和 Agent 使用，不出现在个人自定义渠道列表。

接口清单、模型差异和接入边界见 [docs/interface.md](docs/interface.md)。

维护命令：

```sh
node plugin-packages/generate-wangsu.mjs
node plugin-packages/embed-documentation.mjs wangsu
```

发布时将 `manifest.json`、`README.md`、`docs/interface.md` 打包为 `plugin-packages/wangsu.yingce-plugin`；源码与包必须同步更新。
