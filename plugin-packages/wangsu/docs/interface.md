# 网宿生成协议

## 配置

`apiKey` 填网宿 API Token；渠道 Base URL 填完整网关根地址，例如 `https://api.edgecloudapp.com/v2/llm`。V2 网关地址 `/v2/gws/{GATEWAY_ID}` 也保留完整路径，Token 必须和所选网关匹配。

所有操作声明 `basePath: true`：以配置的完整 Base URL 为根追加业务路径，不应用 OpenAI 默认 `/v1`。`originPath` 会替换整个根路径，因此与 `basePath` 互斥。默认路径规则只作用于原有协议，不受本插件影响。

## 协议清单

| Provider ID | 能力 | 相对 Base URL 的创建路径 |
| --- | --- | --- |
| `wangsu-chat` | 文本 | `/chat/completions` |
| `wangsu-responses` | 文本 | `/responses` |
| `wangsu-openai-chat` | 文本 | `/openai/chat/completions` |
| `wangsu-openai-responses` | 文本 | `/openai/responses` |
| `wangsu-anthropic` | 文本 | `/anthropic/v1/messages` |
| `wangsu-gemini` | 文本 | `/gemini/v1beta/models/{model}:generateContent` |
| `wangsu-images` | 图片 | `/images/generations` 或 `/images/edits` |
| `wangsu-openai-images` | 图片 | `/openai/images/generations` 或 `/openai/images/edits` |
| `wangsu-gemini-image` | 图片 | `/gemini/v1beta/models/{model}:generateContent` |
| `wangsu-chat-image` | 图片 | `/chat/completions` |
| `wangsu-videos` | 视频 | `/videos` |
| `wangsu-openai-videos` | 视频 | `/openai/videos` |
| `wangsu-audio` | 语音合成 | `/audio/speech` |
| `wangsu-openai-audio` | 语音合成 | `/openai/audio/speech` |

图片生成与编辑是同一图片协议的两个操作，根据是否传入源图自动选择；Gemini 文本与图片共享线协议，但有不同的输入能力和输出解析，因此在模型配置中分开选择。一个渠道可以包含多种网宿协议模型。

## 鉴权和文本

OpenAI 兼容和原生入口均使用 `Authorization: Bearer`。Anthropic 使用 `x-api-key` 和 `anthropic-version: 2023-06-01`；Gemini 使用 `x-goog-api-key`。密钥通过宿主从渠道读取，不写入 URL、插件包和日志。

Chat 的 `messages`、Responses 的 `input/instructions`、Anthropic 的 `messages/system/max_tokens`、Gemini 的 `contents/parts/generationConfig` 复用对应的标准请求结构。Chat、Responses、Anthropic 支持文本与 Agent SSE，非流式响应和上游回落 JSON 同样解析；Gemini 本插件使用非流式 `generateContent`。

标准参数按原 Provider 模板映射；扩展选项放在 `providerOptions.<所选网宿协议 ID>` 命名空间。Chat 兼容扩展包含 `eca_enable_search/eca_rag/eca_thinking_config/eca_context_management`。不可将旧协议的命名空间当作新协议选项。每种协议的完整字段和响应表达式在本文末尾 manifest 中列出。

## 图片

Images 文生图发送 JSON：`model/prompt/n/size/quality` 等；有源图时发送 multipart `image`，蒙版使用 `mask`。兼容和 OpenAI 直连均使用文档明确支持的 multipart 编辑，避免把 `images:[{image_url}]` 当成兼容编辑请求。

结果解析 `data[].url` 或 `data[].b64_json`。GPT Image 2.5 支持更高质量档位，按后台模型能力展示；Qwen Image/Plus 仅配置文生图，不发送其文档未声明的编辑、质量和输出格式参数。

Gemini 图片发送 `generationConfig.responseModalities` 与 `imageConfig.aspectRatio/imageSize`，解析 `candidates[].content.parts[].inlineData`。Chat 图片发送多模态 `messages`，Gemini 型号附带 `modalities` 和 `eca_image_config`，Qwen Edit 省略这两个专属字段；解析 `choices[0].message.content[]` 的 `image_url`，区分 URL 与 DataURL。图片调用使用非流式响应，两者不支持蒙版编辑。

## 视频

兼容视频使用 JSON，创建 `/videos`，查询 `/videos/{id}`，完成后下载 `/videos/{id}/content`。首尾帧使用 `eca_first_frame/eca_last_frame`，比例使用 `eca_aspect_ratio`，音频开关使用 `eca_audio`；不发送旧适配器的 `resolution_name`。

- Seedance：`size` 为分辨率档位，参考图为 `input_reference:[{image:URL}]`，参考视频和音频分别为 `eca_video_reference:[{video:URL}]`、`eca_audio_reference:[{audio:URL}]`。
- Hailuo：分辨率转为大写 `512P/768P/1080P`；10 秒要求 `768P`。支持的档位、时长、首尾帧数量按具体型号后台能力约束。
- Veo：参考图最多 3 张，参考模式要求 16:9、8 秒，且与首尾帧互斥；尾帧必须同时提供首帧。
- 通用主体参考：`input_reference` 的每个主体使用 `image:[URL]`，可带 `eca_id/eca_voice`；以模型专属文档为准。
- OpenAI 直连视频：使用原生 multipart，单张 `input_reference`，`size` 为像素尺寸。16:9 与 9:16 默认映射为 1280x720 与 720x1280；不用于接收网宿多参考扩展的 Seedance/Hailuo/Kling 模型。

创建返回的 `id` 用于后续查询；不校验 `object` 必须是 `video`，因为部分型号返回 `video_generation`。识别 `created/queued/in_progress/processing/completed/failed/expired`，错误保留真实失败语义。下载与轮询不会再次提交生成任务。

网宿未声明生成取消合同，本插件不提供取消操作，也不把删除资源当作取消。Seedance 的上游 `seconds:-1` 在适配器中保留；平台现有时长合同和计费要求正数，UI 当前只提供固定秒数。

## 音频与边界

语音合成使用 `model/input/voice/response_format/speed/instructions`，下载二进制音频；当前未实现网宿音频 SSE。

这里的“生成协议”对应产品现有的 text/image/video/audio 能力。官网的 embeddings、moderations、音频转写/翻译分别属于向量、审核和识别能力，未伪装为生成协议。Legacy completions、图片 variations 没有当前目录中可核验的绑定模型。Gemini Interactions 为另一套请求、响应和事件格式，尚未接入；不能选择 Gemini generateContent 冒充。

本地契约测试覆盖路径、鉴权、请求字段、响应解析和失败状态；供应商在线可用性、Token 模型权限和模型生成效果需要单独进行真实调用验证。

## 官方依据

- [模型与接口目录](http://doc.model-store.ai/ai-gateway/model/support-doc)
- [OpenAI 直连](http://doc.model-store.ai/ai-gateway/model/api-detail?code=api-openai-direct-mode1)
- [Anthropic 直连](http://doc.model-store.ai/ai-gateway/model/api-detail?code=api-anthropic-direct-mode1)
- [Gemini 直连](http://doc.model-store.ai/ai-gateway/model/api-detail?code=api-gemini-direct-mode1)
- [Chat 兼容](http://doc.model-store.ai/ai-gateway/model/api-detail?code=api-chat-completions1)
- [图片编辑](http://doc.model-store.ai/ai-gateway/model/api-detail?code=api-images-edits1)
- [GPT Image 2.5 原生编辑](http://doc.model-store.ai/ai-gateway/model/api-detail?code=gpt-image-2-5-flare-openai-images-edits)
- [视频兼容](http://doc.model-store.ai/ai-gateway/model/api-detail?code=api-videos1)

<!-- YINGCE_MANIFEST_CONTRACT_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "yingce.plugin/v2",
  "id": "wangsu",
  "name": "Wangsu 网宿 AI 网关",
  "version": "1.0.0",
  "author": "Wangsu / 影策",
  "description": "网宿系统渠道专用的文本、图片、视频和语音合成协议。",
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>",
  "permissions": [
    "generation.run",
    "media.read"
  ],
  "configuration": {
    "fields": [
      {
        "name": "apiKey",
        "type": "secret",
        "label": "网宿 API Token",
        "required": true
      }
    ]
  },
  "contributes": {
    "providers": [
      {
        "id": "wangsu-chat",
        "label": "Wangsu · Chat 兼容",
        "capabilities": [
          "text"
        ],
        "scopes": [
          "admin.system-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://api.edgecloudapp.com/v2/llm",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "上游模型 ID。"
          },
          {
            "name": "messages",
            "type": "message[]",
            "required": true,
            "mapping": "provider message container",
            "description": "包含历史消息和当前用户输入。"
          },
          {
            "name": "instructions",
            "type": "string",
            "required": false,
            "mapping": "system/instructions",
            "description": "系统指令。"
          },
          {
            "name": "temperature",
            "type": "number",
            "required": false,
            "mapping": "temperature",
            "description": "采样温度。"
          },
          {
            "name": "top_p",
            "type": "number",
            "required": false,
            "mapping": "top_p",
            "description": "核采样参数。"
          },
          {
            "name": "max_tokens",
            "type": "integer",
            "required": false,
            "mapping": "max_tokens/max_output_tokens",
            "description": "最大输出 token。"
          },
          {
            "name": "tools",
            "type": "array",
            "required": false,
            "mapping": "tools/toolConfig",
            "description": "工具定义。"
          },
          {
            "name": "tool_choice",
            "type": "object|string",
            "required": false,
            "mapping": "tool_choice",
            "description": "工具选择策略。"
          },
          {
            "name": "response_format",
            "type": "object",
            "required": false,
            "mapping": "response_format/text",
            "description": "结构化输出配置。"
          },
          {
            "name": "stream",
            "type": "boolean",
            "required": false,
            "mapping": "stream",
            "description": "流式开关；后台任务当前以最终响应归一。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "mapping": "eca_enable_search/eca_rag/eca_thinking_config/eca_context_management",
            "description": "文档声明的网宿扩展参数；以模型支持范围为准。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/chat/completions",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "messages": {
              "$ref": "request.messages"
            },
            "temperature": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.temperature"
              }
            },
            "top_p": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.top_p"
              }
            },
            "max_tokens": {
              "$omitEmpty": {
                "$coalesce": [
                  {
                    "$ref": "request.extra.max_tokens"
                  },
                  {
                    "$ref": "request.providerOptions.wangsu-chat.max_tokens"
                  }
                ]
              }
            },
            "tools": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.tools"
              }
            },
            "tool_choice": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.tool_choice"
              }
            },
            "response_format": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.response_format"
              }
            },
            "stream": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.stream"
              }
            },
            "stop": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.stop"
              }
            },
            "seed": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.seed"
              }
            },
            "frequency_penalty": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.frequency_penalty"
              }
            },
            "presence_penalty": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.presence_penalty"
              }
            },
            "logprobs": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.logprobs"
              }
            },
            "top_logprobs": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.top_logprobs"
              }
            },
            "user": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.user"
              }
            },
            "eca_enable_search": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.eca_enable_search"
              }
            },
            "eca_rag": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.eca_rag"
              }
            },
            "eca_thinking_config": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.eca_thinking_config"
              }
            },
            "eca_context_management": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.eca_context_management"
              }
            }
          },
          "basePath": true
        },
        "agent": {
          "method": "POST",
          "path": "/chat/completions",
          "contentType": "application/json",
          "body": {
            "$merge": [
              {
                "$ref": "request.extra.agent.chatCompletion"
              },
              {
                "model": {
                  "$ref": "request.model"
                }
              }
            ],
            "eca_enable_search": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.eca_enable_search"
              }
            },
            "eca_rag": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.eca_rag"
              }
            },
            "eca_thinking_config": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.eca_thinking_config"
              }
            },
            "eca_context_management": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-chat.eca_context_management"
              }
            }
          },
          "basePath": true
        },
        "response": {
          "status": "succeeded",
          "textPaths": [
            "choices.0.message.content",
            "choices.0.text"
          ],
          "reasoningPaths": [
            "choices.0.message.reasoning_content"
          ],
          "usage": {
            "$ref": "response.usage"
          },
          "errorPaths": [
            "error.code"
          ],
          "messagePaths": [
            "error.message"
          ]
        },
        "agentResponse": {
          "textPaths": [
            "choices.0.message.content",
            "choices.0.text"
          ],
          "reasoningPaths": [
            "choices.0.message.reasoning_content"
          ],
          "toolCallsPath": "choices.0.message.tool_calls",
          "toolCallIdPaths": [
            "id"
          ],
          "toolCallNamePaths": [
            "function.name"
          ],
          "toolCallArgumentsPaths": [
            "function.arguments"
          ]
        }
      },
      {
        "id": "wangsu-responses",
        "label": "Wangsu · Responses 兼容",
        "capabilities": [
          "text"
        ],
        "scopes": [
          "admin.system-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://api.edgecloudapp.com/v2/llm",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "上游模型 ID。"
          },
          {
            "name": "messages",
            "type": "message[]",
            "required": true,
            "mapping": "provider message container",
            "description": "包含历史消息和当前用户输入。"
          },
          {
            "name": "instructions",
            "type": "string",
            "required": false,
            "mapping": "system/instructions",
            "description": "系统指令。"
          },
          {
            "name": "temperature",
            "type": "number",
            "required": false,
            "mapping": "temperature",
            "description": "采样温度。"
          },
          {
            "name": "top_p",
            "type": "number",
            "required": false,
            "mapping": "top_p",
            "description": "核采样参数。"
          },
          {
            "name": "max_tokens",
            "type": "integer",
            "required": false,
            "mapping": "max_tokens/max_output_tokens",
            "description": "最大输出 token。"
          },
          {
            "name": "tools",
            "type": "array",
            "required": false,
            "mapping": "tools/toolConfig",
            "description": "工具定义。"
          },
          {
            "name": "tool_choice",
            "type": "object|string",
            "required": false,
            "mapping": "tool_choice",
            "description": "工具选择策略。"
          },
          {
            "name": "response_format",
            "type": "object",
            "required": false,
            "mapping": "response_format/text",
            "description": "结构化输出配置。"
          },
          {
            "name": "stream",
            "type": "boolean",
            "required": false,
            "mapping": "stream",
            "description": "流式开关；后台任务当前以最终响应归一。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/responses",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "input": {
              "$filter": {
                "from": {
                  "$ref": "request.messages"
                },
                "as": "message",
                "where": {
                  "$ne": [
                    {
                      "$ref": "message.role"
                    },
                    "system"
                  ]
                }
              }
            },
            "instructions": {
              "$omitEmpty": {
                "$ref": "request.instructions"
              }
            },
            "temperature": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-responses.temperature"
              }
            },
            "top_p": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-responses.top_p"
              }
            },
            "max_output_tokens": {
              "$omitEmpty": {
                "$coalesce": [
                  {
                    "$ref": "request.extra.max_output_tokens"
                  },
                  {
                    "$ref": "request.providerOptions.wangsu-responses.max_output_tokens"
                  }
                ]
              }
            },
            "tools": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-responses.tools"
              }
            },
            "tool_choice": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-responses.tool_choice"
              }
            },
            "text": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-responses.text"
              }
            },
            "reasoning": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-responses.reasoning"
              }
            },
            "previous_response_id": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-responses.previous_response_id"
              }
            },
            "store": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-responses.store"
              }
            },
            "metadata": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-responses.metadata"
              }
            },
            "stream": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-responses.stream"
              }
            },
            "truncation": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-responses.truncation"
              }
            },
            "user": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-responses.user"
              }
            }
          },
          "basePath": true
        },
        "agent": {
          "method": "POST",
          "path": "/responses",
          "contentType": "application/json",
          "body": {
            "$merge": [
              {
                "$ref": "request.extra.agent.responses"
              },
              {
                "model": {
                  "$ref": "request.model"
                }
              }
            ]
          },
          "basePath": true
        },
        "response": {
          "status": "succeeded",
          "textPaths": [
            "output_text"
          ],
          "reasoningPaths": [
            "reasoning.summary.0.text"
          ],
          "usage": {
            "$ref": "response.usage"
          },
          "errorPaths": [
            "error.code"
          ],
          "messagePaths": [
            "error.message"
          ],
          "text": {
            "$coalesce": [
              {
                "$ref": "response.output_text"
              },
              {
                "$map": {
                  "from": {
                    "$filter": {
                      "from": {
                        "$ref": "response.output"
                      },
                      "as": "item",
                      "where": {
                        "$eq": [
                          {
                            "$ref": "item.type"
                          },
                          "message"
                        ]
                      }
                    }
                  },
                  "as": "item",
                  "in": {
                    "$map": {
                      "from": {
                        "$filter": {
                          "from": {
                            "$ref": "item.content"
                          },
                          "as": "part",
                          "where": {
                            "$eq": [
                              {
                                "$ref": "part.type"
                              },
                              "output_text"
                            ]
                          }
                        }
                      },
                      "as": "part",
                      "in": {
                        "$ref": "part.text"
                      }
                    }
                  }
                }
              }
            ]
          }
        },
        "agentResponse": {
          "textPaths": [
            "output_text"
          ],
          "reasoningPaths": [
            "reasoning.summary.0.text"
          ],
          "toolCallsPath": "output",
          "toolCallIdPaths": [
            "call_id",
            "id"
          ],
          "toolCallNamePaths": [
            "name"
          ],
          "toolCallArgumentsPaths": [
            "arguments"
          ]
        }
      },
      {
        "id": "wangsu-openai-chat",
        "label": "Wangsu · OpenAI Chat 直连",
        "capabilities": [
          "text"
        ],
        "scopes": [
          "admin.system-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://api.edgecloudapp.com/v2/llm",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "上游模型 ID。"
          },
          {
            "name": "messages",
            "type": "message[]",
            "required": true,
            "mapping": "provider message container",
            "description": "包含历史消息和当前用户输入。"
          },
          {
            "name": "instructions",
            "type": "string",
            "required": false,
            "mapping": "system/instructions",
            "description": "系统指令。"
          },
          {
            "name": "temperature",
            "type": "number",
            "required": false,
            "mapping": "temperature",
            "description": "采样温度。"
          },
          {
            "name": "top_p",
            "type": "number",
            "required": false,
            "mapping": "top_p",
            "description": "核采样参数。"
          },
          {
            "name": "max_tokens",
            "type": "integer",
            "required": false,
            "mapping": "max_tokens/max_output_tokens",
            "description": "最大输出 token。"
          },
          {
            "name": "tools",
            "type": "array",
            "required": false,
            "mapping": "tools/toolConfig",
            "description": "工具定义。"
          },
          {
            "name": "tool_choice",
            "type": "object|string",
            "required": false,
            "mapping": "tool_choice",
            "description": "工具选择策略。"
          },
          {
            "name": "response_format",
            "type": "object",
            "required": false,
            "mapping": "response_format/text",
            "description": "结构化输出配置。"
          },
          {
            "name": "stream",
            "type": "boolean",
            "required": false,
            "mapping": "stream",
            "description": "流式开关；后台任务当前以最终响应归一。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/openai/chat/completions",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "messages": {
              "$ref": "request.messages"
            },
            "temperature": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-chat.temperature"
              }
            },
            "top_p": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-chat.top_p"
              }
            },
            "max_tokens": {
              "$omitEmpty": {
                "$coalesce": [
                  {
                    "$ref": "request.extra.max_tokens"
                  },
                  {
                    "$ref": "request.providerOptions.wangsu-openai-chat.max_tokens"
                  }
                ]
              }
            },
            "tools": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-chat.tools"
              }
            },
            "tool_choice": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-chat.tool_choice"
              }
            },
            "response_format": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-chat.response_format"
              }
            },
            "stream": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-chat.stream"
              }
            },
            "stop": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-chat.stop"
              }
            },
            "seed": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-chat.seed"
              }
            },
            "frequency_penalty": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-chat.frequency_penalty"
              }
            },
            "presence_penalty": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-chat.presence_penalty"
              }
            },
            "logprobs": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-chat.logprobs"
              }
            },
            "top_logprobs": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-chat.top_logprobs"
              }
            },
            "user": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-chat.user"
              }
            }
          },
          "basePath": true
        },
        "agent": {
          "method": "POST",
          "path": "/openai/chat/completions",
          "contentType": "application/json",
          "body": {
            "$merge": [
              {
                "$ref": "request.extra.agent.chatCompletion"
              },
              {
                "model": {
                  "$ref": "request.model"
                }
              }
            ]
          },
          "basePath": true
        },
        "response": {
          "status": "succeeded",
          "textPaths": [
            "choices.0.message.content",
            "choices.0.text"
          ],
          "reasoningPaths": [
            "choices.0.message.reasoning_content"
          ],
          "usage": {
            "$ref": "response.usage"
          },
          "errorPaths": [
            "error.code"
          ],
          "messagePaths": [
            "error.message"
          ]
        },
        "agentResponse": {
          "textPaths": [
            "choices.0.message.content",
            "choices.0.text"
          ],
          "reasoningPaths": [
            "choices.0.message.reasoning_content"
          ],
          "toolCallsPath": "choices.0.message.tool_calls",
          "toolCallIdPaths": [
            "id"
          ],
          "toolCallNamePaths": [
            "function.name"
          ],
          "toolCallArgumentsPaths": [
            "function.arguments"
          ]
        }
      },
      {
        "id": "wangsu-openai-responses",
        "label": "Wangsu · OpenAI Responses 直连",
        "capabilities": [
          "text"
        ],
        "scopes": [
          "admin.system-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://api.edgecloudapp.com/v2/llm",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "上游模型 ID。"
          },
          {
            "name": "messages",
            "type": "message[]",
            "required": true,
            "mapping": "provider message container",
            "description": "包含历史消息和当前用户输入。"
          },
          {
            "name": "instructions",
            "type": "string",
            "required": false,
            "mapping": "system/instructions",
            "description": "系统指令。"
          },
          {
            "name": "temperature",
            "type": "number",
            "required": false,
            "mapping": "temperature",
            "description": "采样温度。"
          },
          {
            "name": "top_p",
            "type": "number",
            "required": false,
            "mapping": "top_p",
            "description": "核采样参数。"
          },
          {
            "name": "max_tokens",
            "type": "integer",
            "required": false,
            "mapping": "max_tokens/max_output_tokens",
            "description": "最大输出 token。"
          },
          {
            "name": "tools",
            "type": "array",
            "required": false,
            "mapping": "tools/toolConfig",
            "description": "工具定义。"
          },
          {
            "name": "tool_choice",
            "type": "object|string",
            "required": false,
            "mapping": "tool_choice",
            "description": "工具选择策略。"
          },
          {
            "name": "response_format",
            "type": "object",
            "required": false,
            "mapping": "response_format/text",
            "description": "结构化输出配置。"
          },
          {
            "name": "stream",
            "type": "boolean",
            "required": false,
            "mapping": "stream",
            "description": "流式开关；后台任务当前以最终响应归一。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/openai/responses",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "input": {
              "$filter": {
                "from": {
                  "$ref": "request.messages"
                },
                "as": "message",
                "where": {
                  "$ne": [
                    {
                      "$ref": "message.role"
                    },
                    "system"
                  ]
                }
              }
            },
            "instructions": {
              "$omitEmpty": {
                "$ref": "request.instructions"
              }
            },
            "temperature": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-responses.temperature"
              }
            },
            "top_p": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-responses.top_p"
              }
            },
            "max_output_tokens": {
              "$omitEmpty": {
                "$coalesce": [
                  {
                    "$ref": "request.extra.max_output_tokens"
                  },
                  {
                    "$ref": "request.providerOptions.wangsu-openai-responses.max_output_tokens"
                  }
                ]
              }
            },
            "tools": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-responses.tools"
              }
            },
            "tool_choice": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-responses.tool_choice"
              }
            },
            "text": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-responses.text"
              }
            },
            "reasoning": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-responses.reasoning"
              }
            },
            "previous_response_id": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-responses.previous_response_id"
              }
            },
            "store": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-responses.store"
              }
            },
            "metadata": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-responses.metadata"
              }
            },
            "stream": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-responses.stream"
              }
            },
            "truncation": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-responses.truncation"
              }
            },
            "user": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-responses.user"
              }
            }
          },
          "basePath": true
        },
        "agent": {
          "method": "POST",
          "path": "/openai/responses",
          "contentType": "application/json",
          "body": {
            "$merge": [
              {
                "$ref": "request.extra.agent.responses"
              },
              {
                "model": {
                  "$ref": "request.model"
                }
              }
            ]
          },
          "basePath": true
        },
        "response": {
          "status": "succeeded",
          "textPaths": [
            "output_text"
          ],
          "reasoningPaths": [
            "reasoning.summary.0.text"
          ],
          "usage": {
            "$ref": "response.usage"
          },
          "errorPaths": [
            "error.code"
          ],
          "messagePaths": [
            "error.message"
          ],
          "text": {
            "$coalesce": [
              {
                "$ref": "response.output_text"
              },
              {
                "$map": {
                  "from": {
                    "$filter": {
                      "from": {
                        "$ref": "response.output"
                      },
                      "as": "item",
                      "where": {
                        "$eq": [
                          {
                            "$ref": "item.type"
                          },
                          "message"
                        ]
                      }
                    }
                  },
                  "as": "item",
                  "in": {
                    "$map": {
                      "from": {
                        "$filter": {
                          "from": {
                            "$ref": "item.content"
                          },
                          "as": "part",
                          "where": {
                            "$eq": [
                              {
                                "$ref": "part.type"
                              },
                              "output_text"
                            ]
                          }
                        }
                      },
                      "as": "part",
                      "in": {
                        "$ref": "part.text"
                      }
                    }
                  }
                }
              }
            ]
          }
        },
        "agentResponse": {
          "textPaths": [
            "output_text"
          ],
          "reasoningPaths": [
            "reasoning.summary.0.text"
          ],
          "toolCallsPath": "output",
          "toolCallIdPaths": [
            "call_id",
            "id"
          ],
          "toolCallNamePaths": [
            "name"
          ],
          "toolCallArgumentsPaths": [
            "arguments"
          ]
        }
      },
      {
        "id": "wangsu-anthropic",
        "label": "Wangsu · Anthropic Messages",
        "capabilities": [
          "text"
        ],
        "scopes": [
          "admin.system-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://api.edgecloudapp.com/v2/llm",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "anthropic",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "上游模型 ID。"
          },
          {
            "name": "messages",
            "type": "message[]",
            "required": true,
            "mapping": "provider message container",
            "description": "包含历史消息和当前用户输入。"
          },
          {
            "name": "instructions",
            "type": "string",
            "required": false,
            "mapping": "system/instructions",
            "description": "系统指令。"
          },
          {
            "name": "temperature",
            "type": "number",
            "required": false,
            "mapping": "temperature",
            "description": "采样温度。"
          },
          {
            "name": "top_p",
            "type": "number",
            "required": false,
            "mapping": "top_p",
            "description": "核采样参数。"
          },
          {
            "name": "max_tokens",
            "type": "integer",
            "required": false,
            "mapping": "max_tokens/max_output_tokens",
            "description": "最大输出 token。"
          },
          {
            "name": "tools",
            "type": "array",
            "required": false,
            "mapping": "tools/toolConfig",
            "description": "工具定义。"
          },
          {
            "name": "tool_choice",
            "type": "object|string",
            "required": false,
            "mapping": "tool_choice",
            "description": "工具选择策略。"
          },
          {
            "name": "response_format",
            "type": "object",
            "required": false,
            "mapping": "response_format/text",
            "description": "结构化输出配置。"
          },
          {
            "name": "stream",
            "type": "boolean",
            "required": false,
            "mapping": "stream",
            "description": "流式开关；后台任务当前以最终响应归一。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/anthropic/v1/messages",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "max_tokens": {
              "$coalesce": [
                {
                  "$ref": "request.extra.max_tokens"
                },
                {
                  "$ref": "request.providerOptions.wangsu-anthropic.max_tokens"
                },
                4096
              ]
            },
            "system": {
              "$omitEmpty": {
                "$coalesce": [
                  {
                    "$ref": "request.instructions"
                  },
                  {
                    "$ref": "request.providerOptions.wangsu-anthropic.system"
                  }
                ]
              }
            },
            "messages": {
              "$filter": {
                "from": {
                  "$ref": "request.messages"
                },
                "as": "message",
                "where": {
                  "$ne": [
                    {
                      "$ref": "message.role"
                    },
                    "system"
                  ]
                }
              }
            },
            "temperature": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-anthropic.temperature"
              }
            },
            "top_p": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-anthropic.top_p"
              }
            },
            "top_k": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-anthropic.top_k"
              }
            },
            "stop_sequences": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-anthropic.stop_sequences"
              }
            },
            "tools": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-anthropic.tools"
              }
            },
            "tool_choice": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-anthropic.tool_choice"
              }
            },
            "metadata": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-anthropic.metadata"
              }
            },
            "stream": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-anthropic.stream"
              }
            },
            "thinking": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-anthropic.thinking"
              }
            },
            "service_tier": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-anthropic.service_tier"
              }
            }
          },
          "headers": {
            "anthropic-version": {
              "$coalesce": [
                {
                  "$ref": "request.providerOptions.wangsu-anthropic.anthropic-version"
                },
                "2023-06-01"
              ]
            },
            "anthropic-beta": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-anthropic.anthropic-beta"
              }
            }
          },
          "basePath": true
        },
        "agent": {
          "method": "POST",
          "path": "/anthropic/v1/messages",
          "contentType": "application/json",
          "body": {
            "$merge": [
              {
                "$ref": "request.extra.agent.claude"
              },
              {
                "model": {
                  "$ref": "request.model"
                }
              }
            ]
          },
          "headers": {
            "anthropic-version": "2023-06-01"
          },
          "basePath": true
        },
        "response": {
          "status": "succeeded",
          "text": {
            "$map": {
              "from": {
                "$filter": {
                  "from": {
                    "$ref": "response.content"
                  },
                  "as": "part",
                  "where": {
                    "$eq": [
                      {
                        "$ref": "part.type"
                      },
                      "text"
                    ]
                  }
                }
              },
              "as": "part",
              "in": {
                "$ref": "part.text"
              }
            }
          },
          "reasoning": {
            "$map": {
              "from": {
                "$filter": {
                  "from": {
                    "$ref": "response.content"
                  },
                  "as": "part",
                  "where": {
                    "$eq": [
                      {
                        "$ref": "part.type"
                      },
                      "thinking"
                    ]
                  }
                }
              },
              "as": "part",
              "in": {
                "$ref": "part.thinking"
              }
            }
          },
          "usage": {
            "$ref": "response.usage"
          },
          "errorPaths": [
            "error.type"
          ],
          "messagePaths": [
            "error.message"
          ]
        },
        "agentResponse": {
          "textPaths": [
            "content.0.text"
          ],
          "reasoningPaths": [
            "content.0.thinking"
          ],
          "toolCallsPath": "content",
          "toolCallIdPaths": [
            "id"
          ],
          "toolCallNamePaths": [
            "name"
          ],
          "toolCallArgumentsPaths": [
            "input"
          ]
        }
      },
      {
        "id": "wangsu-gemini",
        "label": "Wangsu · Gemini 文本",
        "capabilities": [
          "text"
        ],
        "scopes": [
          "admin.system-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://api.edgecloudapp.com/v2/llm",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "google-api-key",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "上游模型 ID。"
          },
          {
            "name": "messages",
            "type": "message[]",
            "required": true,
            "mapping": "provider message container",
            "description": "包含历史消息和当前用户输入。"
          },
          {
            "name": "instructions",
            "type": "string",
            "required": false,
            "mapping": "system/instructions",
            "description": "系统指令。"
          },
          {
            "name": "temperature",
            "type": "number",
            "required": false,
            "mapping": "temperature",
            "description": "采样温度。"
          },
          {
            "name": "top_p",
            "type": "number",
            "required": false,
            "mapping": "top_p",
            "description": "核采样参数。"
          },
          {
            "name": "max_tokens",
            "type": "integer",
            "required": false,
            "mapping": "max_tokens/max_output_tokens",
            "description": "最大输出 token。"
          },
          {
            "name": "tools",
            "type": "array",
            "required": false,
            "mapping": "tools/toolConfig",
            "description": "工具定义。"
          },
          {
            "name": "tool_choice",
            "type": "object|string",
            "required": false,
            "mapping": "tool_choice",
            "description": "工具选择策略。"
          },
          {
            "name": "response_format",
            "type": "object",
            "required": false,
            "mapping": "response_format/text",
            "description": "结构化输出配置。"
          },
          {
            "name": "stream",
            "type": "boolean",
            "required": false,
            "mapping": "stream",
            "description": "流式开关；后台任务当前以最终响应归一。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/gemini/v1beta/models/{{model}}:generateContent",
          "contentType": "application/json",
          "body": {
            "contents": {
              "$map": {
                "from": {
                  "$filter": {
                    "from": {
                      "$ref": "request.messages"
                    },
                    "as": "message",
                    "where": {
                      "$not": {
                        "$eq": [
                          {
                            "$ref": "message.role"
                          },
                          "system"
                        ]
                      }
                    }
                  }
                },
                "as": "message",
                "in": {
                  "role": {
                    "$if": {
                      "condition": {
                        "$eq": [
                          {
                            "$ref": "message.role"
                          },
                          "assistant"
                        ]
                      },
                      "then": "model",
                      "else": "user"
                    }
                  },
                  "parts": {
                    "$if": {
                      "condition": {
                        "$eq": [
                          {
                            "$ref": "messageIndex"
                          },
                          {
                            "$add": [
                              {
                                "$len": {
                                  "$filter": {
                                    "from": {
                                      "$ref": "request.messages"
                                    },
                                    "as": "message",
                                    "where": {
                                      "$not": {
                                        "$eq": [
                                          {
                                            "$ref": "message.role"
                                          },
                                          "system"
                                        ]
                                      }
                                    }
                                  }
                                }
                              },
                              -1
                            ]
                          }
                        ]
                      },
                      "then": {
                        "$concatArrays": [
                          [
                            {
                              "text": {
                                "$ref": "request.prompt"
                              }
                            }
                          ],
                          {
                            "$map": {
                              "from": {
                                "$filter": {
                                  "from": {
                                    "$sortByOrder": {
                                      "$ref": "request.images"
                                    }
                                  },
                                  "as": "media",
                                  "where": {
                                    "$not": {
                                      "$eq": [
                                        {
                                          "$ref": "media.role"
                                        },
                                        "mask"
                                      ]
                                    }
                                  }
                                }
                              },
                              "as": "media",
                              "in": {
                                "$if": {
                                  "condition": {
                                    "$ref": "media.dataUrl"
                                  },
                                  "then": {
                                    "inlineData": {
                                      "mimeType": {
                                        "$dataMime": {
                                          "$ref": "media.dataUrl"
                                        }
                                      },
                                      "data": {
                                        "$dataPayload": {
                                          "$ref": "media.dataUrl"
                                        }
                                      }
                                    }
                                  },
                                  "else": {
                                    "fileData": {
                                      "mimeType": {
                                        "$omitEmpty": {
                                          "$ref": "media.mimeType"
                                        }
                                      },
                                      "fileUri": {
                                        "$ref": "media.url"
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        ]
                      },
                      "else": [
                        {
                          "text": {
                            "$ref": "message.content"
                          }
                        }
                      ]
                    }
                  }
                }
              }
            },
            "systemInstruction": {
              "$if": {
                "condition": {
                  "$ref": "request.instructions"
                },
                "then": {
                  "parts": [
                    {
                      "text": {
                        "$ref": "request.instructions"
                      }
                    }
                  ]
                },
                "else": null
              }
            },
            "generationConfig": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-gemini.generationConfig"
              }
            },
            "safetySettings": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-gemini.safetySettings"
              }
            },
            "tools": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-gemini.tools"
              }
            },
            "toolConfig": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-gemini.toolConfig"
              }
            },
            "cachedContent": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-gemini.cachedContent"
              }
            }
          },
          "basePath": true
        },
        "agent": {
          "method": "POST",
          "path": "/gemini/v1beta/models/{{model}}:generateContent",
          "contentType": "application/json",
          "body": {
            "$ref": "request.extra.agent.gemini"
          },
          "basePath": true
        },
        "response": {
          "status": "succeeded",
          "text": {
            "$map": {
              "from": {
                "$ref": "response.candidates.0.content.parts"
              },
              "as": "part",
              "in": {
                "$omitEmpty": {
                  "$ref": "part.text"
                }
              }
            }
          },
          "usage": {
            "$ref": "response.usageMetadata"
          },
          "errorPaths": [
            "error.code"
          ],
          "messagePaths": [
            "error.message"
          ]
        },
        "agentResponse": {
          "textPaths": [
            "candidates.0.content.parts.0.text"
          ],
          "toolCallsPath": "candidates.0.content.parts",
          "toolCallIdPaths": [
            "functionCall.id"
          ],
          "toolCallNamePaths": [
            "functionCall.name"
          ],
          "toolCallArgumentsPaths": [
            "functionCall.args"
          ],
          "toolCallThoughtSignaturePaths": [
            "thoughtSignature",
            "thought_signature"
          ]
        }
      },
      {
        "id": "wangsu-images",
        "label": "Wangsu · Images 兼容",
        "capabilities": [
          "image"
        ],
        "scopes": [
          "admin.system-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://api.edgecloudapp.com/v2/llm",
        "requiresPublicMediaUrls": true,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "图片模型 ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt",
            "description": "图片提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "provider image/reference fields",
            "description": "参考图或编辑源图，role 由业务层确定。"
          },
          {
            "name": "imageCount",
            "type": "integer",
            "required": false,
            "mapping": "n/sample_count",
            "description": "输出数量。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "size/aspect_ratio",
            "description": "比例或尺寸，语义按协议说明。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "resolution/imageSize",
            "description": "分辨率档位。"
          },
          {
            "name": "quality",
            "type": "string",
            "required": false,
            "mapping": "quality",
            "description": "质量档位。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "provider-specific fields",
            "description": "插件命名空间内的厂商扩展字段。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/images/generations",
          "pathTemplate": {
            "$if": {
              "condition": {
                "$gt": [
                  {
                    "$len": {
                      "$filter": {
                        "from": {
                          "$sortByOrder": {
                            "$ref": "request.images"
                          }
                        },
                        "as": "media",
                        "where": {
                          "$not": {
                            "$eq": [
                              {
                                "$ref": "media.role"
                              },
                              "mask"
                            ]
                          }
                        }
                      }
                    }
                  },
                  0
                ]
              },
              "then": "/images/edits",
              "else": "/images/generations"
            }
          },
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "n": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$gt": [
                      {
                        "$ref": "request.imageCount"
                      },
                      0
                    ]
                  },
                  "then": {
                    "$ref": "request.imageCount"
                  },
                  "else": 1
                }
              }
            },
            "size": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$in": [
                      {
                        "$lower": {
                          "$trim": {
                            "$ref": "request.aspectRatio"
                          }
                        }
                      },
                      [
                        "",
                        "auto"
                      ]
                    ]
                  },
                  "then": null,
                  "else": {
                    "$ref": "request.aspectRatio"
                  }
                }
              }
            },
            "quality": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$not": {
                      "$in": [
                        {
                          "$lower": {
                            "$ref": "request.model"
                          }
                        },
                        [
                          "qwen-image",
                          "qwen-image-plus"
                        ]
                      ]
                    }
                  },
                  "then": {
                    "$omitEmpty": {
                      "$switch": {
                        "cases": [
                          {
                            "when": {
                              "$in": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$ref": "request.quality"
                                    }
                                  }
                                },
                                [
                                  "1k"
                                ]
                              ]
                            },
                            "then": "low"
                          },
                          {
                            "when": {
                              "$in": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$ref": "request.quality"
                                    }
                                  }
                                },
                                [
                                  "2k"
                                ]
                              ]
                            },
                            "then": "medium"
                          },
                          {
                            "when": {
                              "$in": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$ref": "request.quality"
                                    }
                                  }
                                },
                                [
                                  "4k"
                                ]
                              ]
                            },
                            "then": "high"
                          },
                          {
                            "when": {
                              "$in": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$ref": "request.quality"
                                    }
                                  }
                                },
                                [
                                  "",
                                  "auto"
                                ]
                              ]
                            },
                            "then": null
                          }
                        ],
                        "default": {
                          "$ref": "request.quality"
                        }
                      }
                    }
                  },
                  "else": null
                }
              }
            },
            "background": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$not": {
                      "$in": [
                        {
                          "$lower": {
                            "$ref": "request.model"
                          }
                        },
                        [
                          "qwen-image",
                          "qwen-image-plus"
                        ]
                      ]
                    }
                  },
                  "then": {
                    "$omitEmpty": {
                      "$coalesce": [
                        {
                          "$ref": "request.providerOptions.wangsu-images.background"
                        },
                        {
                          "$if": {
                            "condition": {
                              "$eq": [
                                {
                                  "$ref": "request.extra.transparentBackground"
                                },
                                "true"
                              ]
                            },
                            "then": "transparent",
                            "else": null
                          }
                        }
                      ]
                    }
                  },
                  "else": null
                }
              }
            },
            "output_format": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$not": {
                      "$in": [
                        {
                          "$lower": {
                            "$ref": "request.model"
                          }
                        },
                        [
                          "qwen-image",
                          "qwen-image-plus"
                        ]
                      ]
                    }
                  },
                  "then": {
                    "$omitEmpty": {
                      "$coalesce": [
                        {
                          "$ref": "request.providerOptions.wangsu-images.output_format"
                        },
                        "png"
                      ]
                    }
                  },
                  "else": null
                }
              }
            },
            "output_compression": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$not": {
                      "$in": [
                        {
                          "$lower": {
                            "$ref": "request.model"
                          }
                        },
                        [
                          "qwen-image",
                          "qwen-image-plus"
                        ]
                      ]
                    }
                  },
                  "then": {
                    "$omitEmpty": {
                      "$ref": "request.providerOptions.wangsu-images.output_compression"
                    }
                  },
                  "else": null
                }
              }
            },
            "moderation": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$not": {
                      "$in": [
                        {
                          "$lower": {
                            "$ref": "request.model"
                          }
                        },
                        [
                          "qwen-image",
                          "qwen-image-plus"
                        ]
                      ]
                    }
                  },
                  "then": {
                    "$omitEmpty": {
                      "$ref": "request.providerOptions.wangsu-images.moderation"
                    }
                  },
                  "else": null
                }
              }
            },
            "response_format": {
              "$omitEmpty": {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.wangsu-images.response_format"
                  },
                  {
                    "$if": {
                      "condition": {
                        "$in": [
                          {
                            "$lower": {
                              "$ref": "request.model"
                            }
                          },
                          [
                            "qwen-image",
                            "qwen-image-plus"
                          ]
                        ]
                      },
                      "then": "b64_json",
                      "else": null
                    }
                  }
                ]
              }
            },
            "style": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$not": {
                      "$in": [
                        {
                          "$lower": {
                            "$ref": "request.model"
                          }
                        },
                        [
                          "qwen-image",
                          "qwen-image-plus"
                        ]
                      ]
                    }
                  },
                  "then": {
                    "$omitEmpty": {
                      "$ref": "request.providerOptions.wangsu-images.style"
                    }
                  },
                  "else": null
                }
              }
            },
            "user": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-images.user"
              }
            }
          },
          "basePath": true,
          "contentTypeTemplate": {
            "$if": {
              "condition": {
                "$gt": [
                  {
                    "$len": {
                      "$filter": {
                        "from": {
                          "$sortByOrder": {
                            "$ref": "request.images"
                          }
                        },
                        "as": "media",
                        "where": {
                          "$not": {
                            "$eq": [
                              {
                                "$ref": "media.role"
                              },
                              "mask"
                            ]
                          }
                        }
                      }
                    }
                  },
                  0
                ]
              },
              "then": "multipart/form-data",
              "else": "application/json"
            }
          },
          "files": [
            {
              "name": "image",
              "source": {
                "$filter": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.images"
                    }
                  },
                  "as": "media",
                  "where": {
                    "$not": {
                      "$eq": [
                        {
                          "$ref": "media.role"
                        },
                        "mask"
                      ]
                    }
                  }
                }
              },
              "filename": "source.png"
            },
            {
              "name": "mask",
              "source": {
                "$filter": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.images"
                    }
                  },
                  "as": "media",
                  "where": {
                    "$in": [
                      {
                        "$ref": "media.role"
                      },
                      [
                        "mask"
                      ]
                    ]
                  }
                }
              },
              "filename": "mask.png"
            }
          ]
        },
        "response": {
          "status": "succeeded",
          "images": {
            "$map": {
              "from": {
                "$ref": "response.data"
              },
              "as": "item",
              "in": {
                "url": {
                  "$omitEmpty": {
                    "$ref": "item.url"
                  }
                },
                "dataUrl": {
                  "$if": {
                    "condition": {
                      "$ref": "item.b64_json"
                    },
                    "then": {
                      "$concat": [
                        "data:image/png;base64,",
                        {
                          "$ref": "item.b64_json"
                        }
                      ]
                    },
                    "else": null
                  }
                }
              }
            }
          },
          "usage": {
            "$ref": "response.usage"
          },
          "errorPaths": [
            "error.code"
          ],
          "messagePaths": [
            "error.message"
          ]
        },
        "validations": [
          {
            "assert": {
              "$or": [
                {
                  "$eq": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          "as": "media",
                          "where": {
                            "$in": [
                              {
                                "$ref": "media.role"
                              },
                              [
                                "mask"
                              ]
                            ]
                          }
                        }
                      }
                    },
                    0
                  ]
                },
                {
                  "$gt": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          "as": "media",
                          "where": {
                            "$not": {
                              "$eq": [
                                {
                                  "$ref": "media.role"
                                },
                                "mask"
                              ]
                            }
                          }
                        }
                      }
                    },
                    0
                  ]
                }
              ]
            },
            "message": "蒙版编辑必须提供源图片"
          },
          {
            "assert": {
              "$or": [
                {
                  "$not": {
                    "$in": [
                      {
                        "$lower": {
                          "$ref": "request.model"
                        }
                      },
                      [
                        "qwen-image",
                        "qwen-image-plus"
                      ]
                    ]
                  }
                },
                {
                  "$eq": [
                    {
                      "$len": {
                        "$sortByOrder": {
                          "$ref": "request.images"
                        }
                      }
                    },
                    0
                  ]
                }
              ]
            },
            "message": "Qwen Image 文生图模型不支持此图片编辑接口，请使用 Qwen Image Edit 对应协议"
          }
        ]
      },
      {
        "id": "wangsu-openai-images",
        "label": "Wangsu · OpenAI Images 直连",
        "capabilities": [
          "image"
        ],
        "scopes": [
          "admin.system-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://api.edgecloudapp.com/v2/llm",
        "requiresPublicMediaUrls": true,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "图片模型 ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt",
            "description": "图片提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "provider image/reference fields",
            "description": "参考图或编辑源图，role 由业务层确定。"
          },
          {
            "name": "imageCount",
            "type": "integer",
            "required": false,
            "mapping": "n/sample_count",
            "description": "输出数量。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "size/aspect_ratio",
            "description": "比例或尺寸，语义按协议说明。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "resolution/imageSize",
            "description": "分辨率档位。"
          },
          {
            "name": "quality",
            "type": "string",
            "required": false,
            "mapping": "quality",
            "description": "质量档位。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "provider-specific fields",
            "description": "插件命名空间内的厂商扩展字段。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/openai/images/generations",
          "pathTemplate": {
            "$if": {
              "condition": {
                "$gt": [
                  {
                    "$len": {
                      "$filter": {
                        "from": {
                          "$sortByOrder": {
                            "$ref": "request.images"
                          }
                        },
                        "as": "media",
                        "where": {
                          "$not": {
                            "$eq": [
                              {
                                "$ref": "media.role"
                              },
                              "mask"
                            ]
                          }
                        }
                      }
                    }
                  },
                  0
                ]
              },
              "then": "/openai/images/edits",
              "else": "/openai/images/generations"
            }
          },
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "n": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$gt": [
                      {
                        "$ref": "request.imageCount"
                      },
                      0
                    ]
                  },
                  "then": {
                    "$ref": "request.imageCount"
                  },
                  "else": 1
                }
              }
            },
            "size": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$in": [
                      {
                        "$lower": {
                          "$trim": {
                            "$ref": "request.aspectRatio"
                          }
                        }
                      },
                      [
                        "",
                        "auto"
                      ]
                    ]
                  },
                  "then": null,
                  "else": {
                    "$ref": "request.aspectRatio"
                  }
                }
              }
            },
            "quality": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$not": {
                      "$in": [
                        {
                          "$lower": {
                            "$ref": "request.model"
                          }
                        },
                        [
                          "qwen-image",
                          "qwen-image-plus"
                        ]
                      ]
                    }
                  },
                  "then": {
                    "$omitEmpty": {
                      "$switch": {
                        "cases": [
                          {
                            "when": {
                              "$in": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$ref": "request.quality"
                                    }
                                  }
                                },
                                [
                                  "1k"
                                ]
                              ]
                            },
                            "then": "low"
                          },
                          {
                            "when": {
                              "$in": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$ref": "request.quality"
                                    }
                                  }
                                },
                                [
                                  "2k"
                                ]
                              ]
                            },
                            "then": "medium"
                          },
                          {
                            "when": {
                              "$in": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$ref": "request.quality"
                                    }
                                  }
                                },
                                [
                                  "4k"
                                ]
                              ]
                            },
                            "then": "high"
                          },
                          {
                            "when": {
                              "$in": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$ref": "request.quality"
                                    }
                                  }
                                },
                                [
                                  "",
                                  "auto"
                                ]
                              ]
                            },
                            "then": null
                          }
                        ],
                        "default": {
                          "$ref": "request.quality"
                        }
                      }
                    }
                  },
                  "else": null
                }
              }
            },
            "background": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$not": {
                      "$in": [
                        {
                          "$lower": {
                            "$ref": "request.model"
                          }
                        },
                        [
                          "qwen-image",
                          "qwen-image-plus"
                        ]
                      ]
                    }
                  },
                  "then": {
                    "$omitEmpty": {
                      "$coalesce": [
                        {
                          "$ref": "request.providerOptions.wangsu-openai-images.background"
                        },
                        {
                          "$if": {
                            "condition": {
                              "$eq": [
                                {
                                  "$ref": "request.extra.transparentBackground"
                                },
                                "true"
                              ]
                            },
                            "then": "transparent",
                            "else": null
                          }
                        }
                      ]
                    }
                  },
                  "else": null
                }
              }
            },
            "output_format": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$not": {
                      "$in": [
                        {
                          "$lower": {
                            "$ref": "request.model"
                          }
                        },
                        [
                          "qwen-image",
                          "qwen-image-plus"
                        ]
                      ]
                    }
                  },
                  "then": {
                    "$omitEmpty": {
                      "$coalesce": [
                        {
                          "$ref": "request.providerOptions.wangsu-openai-images.output_format"
                        },
                        "png"
                      ]
                    }
                  },
                  "else": null
                }
              }
            },
            "output_compression": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$not": {
                      "$in": [
                        {
                          "$lower": {
                            "$ref": "request.model"
                          }
                        },
                        [
                          "qwen-image",
                          "qwen-image-plus"
                        ]
                      ]
                    }
                  },
                  "then": {
                    "$omitEmpty": {
                      "$ref": "request.providerOptions.wangsu-openai-images.output_compression"
                    }
                  },
                  "else": null
                }
              }
            },
            "moderation": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$not": {
                      "$in": [
                        {
                          "$lower": {
                            "$ref": "request.model"
                          }
                        },
                        [
                          "qwen-image",
                          "qwen-image-plus"
                        ]
                      ]
                    }
                  },
                  "then": {
                    "$omitEmpty": {
                      "$ref": "request.providerOptions.wangsu-openai-images.moderation"
                    }
                  },
                  "else": null
                }
              }
            },
            "response_format": {
              "$omitEmpty": {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.wangsu-openai-images.response_format"
                  },
                  {
                    "$if": {
                      "condition": {
                        "$in": [
                          {
                            "$lower": {
                              "$ref": "request.model"
                            }
                          },
                          [
                            "qwen-image",
                            "qwen-image-plus"
                          ]
                        ]
                      },
                      "then": "b64_json",
                      "else": null
                    }
                  }
                ]
              }
            },
            "style": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$not": {
                      "$in": [
                        {
                          "$lower": {
                            "$ref": "request.model"
                          }
                        },
                        [
                          "qwen-image",
                          "qwen-image-plus"
                        ]
                      ]
                    }
                  },
                  "then": {
                    "$omitEmpty": {
                      "$ref": "request.providerOptions.wangsu-openai-images.style"
                    }
                  },
                  "else": null
                }
              }
            },
            "user": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-images.user"
              }
            }
          },
          "basePath": true,
          "contentTypeTemplate": {
            "$if": {
              "condition": {
                "$gt": [
                  {
                    "$len": {
                      "$filter": {
                        "from": {
                          "$sortByOrder": {
                            "$ref": "request.images"
                          }
                        },
                        "as": "media",
                        "where": {
                          "$not": {
                            "$eq": [
                              {
                                "$ref": "media.role"
                              },
                              "mask"
                            ]
                          }
                        }
                      }
                    }
                  },
                  0
                ]
              },
              "then": "multipart/form-data",
              "else": "application/json"
            }
          },
          "files": [
            {
              "name": "image",
              "source": {
                "$filter": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.images"
                    }
                  },
                  "as": "media",
                  "where": {
                    "$not": {
                      "$eq": [
                        {
                          "$ref": "media.role"
                        },
                        "mask"
                      ]
                    }
                  }
                }
              },
              "filename": "source.png"
            },
            {
              "name": "mask",
              "source": {
                "$filter": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.images"
                    }
                  },
                  "as": "media",
                  "where": {
                    "$in": [
                      {
                        "$ref": "media.role"
                      },
                      [
                        "mask"
                      ]
                    ]
                  }
                }
              },
              "filename": "mask.png"
            }
          ]
        },
        "response": {
          "status": "succeeded",
          "images": {
            "$map": {
              "from": {
                "$ref": "response.data"
              },
              "as": "item",
              "in": {
                "url": {
                  "$omitEmpty": {
                    "$ref": "item.url"
                  }
                },
                "dataUrl": {
                  "$if": {
                    "condition": {
                      "$ref": "item.b64_json"
                    },
                    "then": {
                      "$concat": [
                        "data:image/png;base64,",
                        {
                          "$ref": "item.b64_json"
                        }
                      ]
                    },
                    "else": null
                  }
                }
              }
            }
          },
          "usage": {
            "$ref": "response.usage"
          },
          "errorPaths": [
            "error.code"
          ],
          "messagePaths": [
            "error.message"
          ]
        },
        "validations": [
          {
            "assert": {
              "$or": [
                {
                  "$eq": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          "as": "media",
                          "where": {
                            "$in": [
                              {
                                "$ref": "media.role"
                              },
                              [
                                "mask"
                              ]
                            ]
                          }
                        }
                      }
                    },
                    0
                  ]
                },
                {
                  "$gt": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          "as": "media",
                          "where": {
                            "$not": {
                              "$eq": [
                                {
                                  "$ref": "media.role"
                                },
                                "mask"
                              ]
                            }
                          }
                        }
                      }
                    },
                    0
                  ]
                }
              ]
            },
            "message": "蒙版编辑必须提供源图片"
          },
          {
            "assert": {
              "$or": [
                {
                  "$not": {
                    "$in": [
                      {
                        "$lower": {
                          "$ref": "request.model"
                        }
                      },
                      [
                        "qwen-image",
                        "qwen-image-plus"
                      ]
                    ]
                  }
                },
                {
                  "$eq": [
                    {
                      "$len": {
                        "$sortByOrder": {
                          "$ref": "request.images"
                        }
                      }
                    },
                    0
                  ]
                }
              ]
            },
            "message": "Qwen Image 文生图模型不支持此图片编辑接口，请使用 Qwen Image Edit 对应协议"
          }
        ]
      },
      {
        "id": "wangsu-gemini-image",
        "label": "Wangsu · Gemini 图片",
        "capabilities": [
          "image"
        ],
        "scopes": [
          "admin.system-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://api.edgecloudapp.com/v2/llm",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "google-api-key",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "图片模型 ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt",
            "description": "图片提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "provider image/reference fields",
            "description": "参考图或编辑源图，role 由业务层确定。"
          },
          {
            "name": "imageCount",
            "type": "integer",
            "required": false,
            "mapping": "n/sample_count",
            "description": "输出数量。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "size/aspect_ratio",
            "description": "比例或尺寸，语义按协议说明。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "resolution/imageSize",
            "description": "分辨率档位。"
          },
          {
            "name": "quality",
            "type": "string",
            "required": false,
            "mapping": "quality",
            "description": "质量档位。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "provider-specific fields",
            "description": "插件命名空间内的厂商扩展字段。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/gemini/v1beta/models/{{model}}:generateContent",
          "contentType": "application/json",
          "body": {
            "contents": [
              {
                "role": "user",
                "parts": {
                  "$concatArrays": [
                    [
                      {
                        "text": {
                          "$ref": "request.prompt"
                        }
                      }
                    ],
                    {
                      "$map": {
                        "from": {
                          "$ref": "request.images"
                        },
                        "as": "media",
                        "in": {
                          "$if": {
                            "condition": {
                              "$ref": "media.dataUrl"
                            },
                            "then": {
                              "inlineData": {
                                "mimeType": {
                                  "$dataMime": {
                                    "$ref": "media.dataUrl"
                                  }
                                },
                                "data": {
                                  "$dataPayload": {
                                    "$ref": "media.dataUrl"
                                  }
                                }
                              }
                            },
                            "else": {
                              "fileData": {
                                "mimeType": {
                                  "$omitEmpty": {
                                    "$ref": "media.mimeType"
                                  }
                                },
                                "fileUri": {
                                  "$ref": "media.url"
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  ]
                }
              }
            ],
            "generationConfig": {
              "responseModalities": {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.wangsu-gemini-image.responseModalities"
                  },
                  [
                    "TEXT",
                    "IMAGE"
                  ]
                ]
              },
              "imageConfig": {
                "aspectRatio": {
                  "$omitEmpty": {
                    "$ref": "request.aspectRatio"
                  }
                },
                "imageSize": {
                  "$omitEmpty": {
                    "$coalesce": [
                      {
                        "$switch": {
                          "cases": [
                            {
                              "when": {
                                "$in": [
                                  {
                                    "$lower": {
                                      "$ref": "request.quality"
                                    }
                                  },
                                  [
                                    "1k",
                                    "low"
                                  ]
                                ]
                              },
                              "then": "1K"
                            },
                            {
                              "when": {
                                "$in": [
                                  {
                                    "$lower": {
                                      "$ref": "request.quality"
                                    }
                                  },
                                  [
                                    "2k",
                                    "medium"
                                  ]
                                ]
                              },
                              "then": "2K"
                            },
                            {
                              "when": {
                                "$in": [
                                  {
                                    "$lower": {
                                      "$ref": "request.quality"
                                    }
                                  },
                                  [
                                    "4k",
                                    "high"
                                  ]
                                ]
                              },
                              "then": "4K"
                            }
                          ],
                          "default": null
                        }
                      },
                      {
                        "$switch": {
                          "cases": [
                            {
                              "when": {
                                "$in": [
                                  {
                                    "$lower": {
                                      "$ref": "request.resolution"
                                    }
                                  },
                                  [
                                    "1k",
                                    "low"
                                  ]
                                ]
                              },
                              "then": "1K"
                            },
                            {
                              "when": {
                                "$in": [
                                  {
                                    "$lower": {
                                      "$ref": "request.resolution"
                                    }
                                  },
                                  [
                                    "2k",
                                    "medium"
                                  ]
                                ]
                              },
                              "then": "2K"
                            },
                            {
                              "when": {
                                "$in": [
                                  {
                                    "$lower": {
                                      "$ref": "request.resolution"
                                    }
                                  },
                                  [
                                    "4k",
                                    "high"
                                  ]
                                ]
                              },
                              "then": "4K"
                            }
                          ],
                          "default": null
                        }
                      }
                    ]
                  }
                }
              },
              "temperature": {
                "$omitEmpty": {
                  "$ref": "request.providerOptions.wangsu-gemini-image.temperature"
                }
              },
              "topP": {
                "$omitEmpty": {
                  "$ref": "request.providerOptions.wangsu-gemini-image.topP"
                }
              },
              "topK": {
                "$omitEmpty": {
                  "$ref": "request.providerOptions.wangsu-gemini-image.topK"
                }
              },
              "seed": {
                "$omitEmpty": {
                  "$ref": "request.providerOptions.wangsu-gemini-image.seed"
                }
              }
            },
            "safetySettings": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-gemini-image.safetySettings"
              }
            },
            "systemInstruction": {
              "$omitEmpty": {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.wangsu-gemini-image.systemInstruction"
                  },
                  {
                    "$if": {
                      "condition": {
                        "$ref": "request.instructions"
                      },
                      "then": {
                        "parts": [
                          {
                            "text": {
                              "$ref": "request.instructions"
                            }
                          }
                        ]
                      },
                      "else": null
                    }
                  }
                ]
              }
            }
          },
          "basePath": true
        },
        "response": {
          "status": "succeeded",
          "images": {
            "$map": {
              "from": {
                "$filter": {
                  "from": {
                    "$ref": "response.candidates.0.content.parts"
                  },
                  "as": "part",
                  "where": {
                    "$or": [
                      {
                        "$ref": "part.inlineData"
                      },
                      {
                        "$ref": "part.inline_data"
                      }
                    ]
                  }
                }
              },
              "as": "part",
              "in": {
                "dataUrl": {
                  "$concat": [
                    "data:",
                    {
                      "$coalesce": [
                        {
                          "$ref": "part.inlineData.mimeType"
                        },
                        {
                          "$ref": "part.inline_data.mime_type"
                        },
                        "image/png"
                      ]
                    },
                    ";base64,",
                    {
                      "$coalesce": [
                        {
                          "$ref": "part.inlineData.data"
                        },
                        {
                          "$ref": "part.inline_data.data"
                        }
                      ]
                    }
                  ]
                }
              }
            }
          },
          "text": {
            "$map": {
              "from": {
                "$filter": {
                  "from": {
                    "$ref": "response.candidates.0.content.parts"
                  },
                  "as": "part",
                  "where": {
                    "$ref": "part.text"
                  }
                }
              },
              "as": "part",
              "in": {
                "$ref": "part.text"
              }
            }
          },
          "usage": {
            "$ref": "response.usageMetadata"
          },
          "errorPaths": [
            "error.code"
          ],
          "messagePaths": [
            "error.message"
          ]
        },
        "validations": [
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$sortByOrder": {
                          "$ref": "request.images"
                        }
                      },
                      "as": "media",
                      "where": {
                        "$in": [
                          {
                            "$ref": "media.role"
                          },
                          [
                            "mask"
                          ]
                        ]
                      }
                    }
                  }
                },
                0
              ]
            },
            "message": "Gemini 图片不支持蒙版编辑"
          }
        ]
      },
      {
        "id": "wangsu-chat-image",
        "label": "Wangsu · Chat 图片兼容",
        "capabilities": [
          "image"
        ],
        "scopes": [
          "admin.system-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://api.edgecloudapp.com/v2/llm",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "图片模型 ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt",
            "description": "图片提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "provider image/reference fields",
            "description": "参考图或编辑源图，role 由业务层确定。"
          },
          {
            "name": "imageCount",
            "type": "integer",
            "required": false,
            "mapping": "n/sample_count",
            "description": "输出数量。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "size/aspect_ratio",
            "description": "比例或尺寸，语义按协议说明。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "resolution/imageSize",
            "description": "分辨率档位。"
          },
          {
            "name": "quality",
            "type": "string",
            "required": false,
            "mapping": "quality",
            "description": "质量档位。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "provider-specific fields",
            "description": "插件命名空间内的厂商扩展字段。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/chat/completions",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "messages": {
              "$ref": "request.messages"
            },
            "stream": false,
            "modalities": {
              "$if": {
                "condition": {
                  "$eq": [
                    {
                      "$at": [
                        {
                          "$split": [
                            {
                              "$lower": {
                                "$ref": "request.model"
                              }
                            },
                            "-"
                          ]
                        },
                        0
                      ]
                    },
                    "gemini"
                  ]
                },
                "then": [
                  "image",
                  "text"
                ],
                "else": null
              }
            },
            "eca_image_config": {
              "$if": {
                "condition": {
                  "$eq": [
                    {
                      "$at": [
                        {
                          "$split": [
                            {
                              "$lower": {
                                "$ref": "request.model"
                              }
                            },
                            "-"
                          ]
                        },
                        0
                      ]
                    },
                    "gemini"
                  ]
                },
                "then": {
                  "aspect_ratio": {
                    "$omitEmpty": {
                      "$if": {
                        "condition": {
                          "$not": {
                            "$eq": [
                              {
                                "$ref": "request.aspectRatio"
                              },
                              "auto"
                            ]
                          }
                        },
                        "then": {
                          "$ref": "request.aspectRatio"
                        },
                        "else": null
                      }
                    }
                  },
                  "image_size": {
                    "$omitEmpty": {
                      "$coalesce": [
                        {
                          "$switch": {
                            "cases": [
                              {
                                "when": {
                                  "$in": [
                                    {
                                      "$lower": {
                                        "$ref": "request.quality"
                                      }
                                    },
                                    [
                                      "1k",
                                      "low"
                                    ]
                                  ]
                                },
                                "then": "1K"
                              },
                              {
                                "when": {
                                  "$in": [
                                    {
                                      "$lower": {
                                        "$ref": "request.quality"
                                      }
                                    },
                                    [
                                      "2k",
                                      "medium"
                                    ]
                                  ]
                                },
                                "then": "2K"
                              },
                              {
                                "when": {
                                  "$in": [
                                    {
                                      "$lower": {
                                        "$ref": "request.quality"
                                      }
                                    },
                                    [
                                      "4k",
                                      "high"
                                    ]
                                  ]
                                },
                                "then": "4K"
                              }
                            ],
                            "default": null
                          }
                        },
                        {
                          "$switch": {
                            "cases": [
                              {
                                "when": {
                                  "$in": [
                                    {
                                      "$lower": {
                                        "$ref": "request.resolution"
                                      }
                                    },
                                    [
                                      "1k",
                                      "low"
                                    ]
                                  ]
                                },
                                "then": "1K"
                              },
                              {
                                "when": {
                                  "$in": [
                                    {
                                      "$lower": {
                                        "$ref": "request.resolution"
                                      }
                                    },
                                    [
                                      "2k",
                                      "medium"
                                    ]
                                  ]
                                },
                                "then": "2K"
                              },
                              {
                                "when": {
                                  "$in": [
                                    {
                                      "$lower": {
                                        "$ref": "request.resolution"
                                      }
                                    },
                                    [
                                      "4k",
                                      "high"
                                    ]
                                  ]
                                },
                                "then": "4K"
                              }
                            ],
                            "default": null
                          }
                        }
                      ]
                    }
                  }
                },
                "else": null
              }
            }
          },
          "basePath": true
        },
        "response": {
          "status": "succeeded",
          "images": {
            "$map": {
              "from": {
                "$filter": {
                  "from": {
                    "$ref": "response.choices.0.message.content"
                  },
                  "as": "part",
                  "where": {
                    "$eq": [
                      {
                        "$ref": "part.type"
                      },
                      "image_url"
                    ]
                  }
                }
              },
              "as": "part",
              "in": {
                "$ref": "part.image_url.url"
              }
            }
          },
          "usage": {
            "$ref": "response.usage"
          },
          "errorPaths": [
            "error.code",
            "error.type"
          ],
          "messagePaths": [
            "error.message"
          ]
        },
        "validations": [
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$sortByOrder": {
                          "$ref": "request.images"
                        }
                      },
                      "as": "media",
                      "where": {
                        "$in": [
                          {
                            "$ref": "media.role"
                          },
                          [
                            "mask"
                          ]
                        ]
                      }
                    }
                  }
                },
                0
              ]
            },
            "message": "Chat 图片协议不支持蒙版编辑"
          }
        ]
      },
      {
        "id": "wangsu-videos",
        "label": "Wangsu · 视频兼容",
        "capabilities": [
          "video"
        ],
        "scopes": [
          "admin.system-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://api.edgecloudapp.com/v2/llm",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "视频模型 ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt/content/input",
            "description": "视频提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "first/last/reference image",
            "description": "显式 role 图片输入。"
          },
          {
            "name": "videos",
            "type": "media[]",
            "required": false,
            "mapping": "reference video",
            "description": "参考视频。"
          },
          {
            "name": "audios",
            "type": "media[]",
            "required": false,
            "mapping": "reference audio/voice",
            "description": "参考音频或音色。"
          },
          {
            "name": "duration",
            "type": "integer",
            "required": false,
            "mapping": "duration/seconds",
            "description": "时长秒数。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "ratio/aspect_ratio/size",
            "description": "画幅比例或尺寸。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "resolution",
            "description": "分辨率档位。"
          },
          {
            "name": "generateAudio",
            "type": "boolean",
            "required": false,
            "mapping": "generate_audio",
            "description": "是否生成音频。"
          },
          {
            "name": "watermark",
            "type": "boolean",
            "required": false,
            "mapping": "watermark",
            "description": "水印开关。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "provider-specific fields",
            "description": "插件命名空间内的厂商扩展字段。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "mapping": "seed/eca_voice",
            "description": "视频厂商扩展参数。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/videos",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "seconds": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$or": [
                      {
                        "$gt": [
                          {
                            "$ref": "request.duration"
                          },
                          0
                        ]
                      },
                      {
                        "$and": [
                          {
                            "$in": [
                              {
                                "$lower": {
                                  "$ref": "request.model"
                                }
                              },
                              [
                                "doubao-seedance-2-0-260128",
                                "doubao-seedance-2-0-fast-260128",
                                "doubao-seedance-2-5-260628"
                              ]
                            ]
                          },
                          {
                            "$eq": [
                              {
                                "$ref": "request.duration"
                              },
                              -1
                            ]
                          }
                        ]
                      }
                    ]
                  },
                  "then": {
                    "$ref": "request.duration"
                  },
                  "else": null
                }
              }
            },
            "size": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$in": [
                      {
                        "$lower": {
                          "$ref": "request.model"
                        }
                      },
                      [
                        "minimax-hailuo-02",
                        "minimax-hailuo-2.3"
                      ]
                    ]
                  },
                  "then": {
                    "$upper": {
                      "$ref": "request.resolution"
                    }
                  },
                  "else": {
                    "$ref": "request.resolution"
                  }
                }
              }
            },
            "eca_aspect_ratio": {
              "$omitEmpty": {
                "$ref": "request.aspectRatio"
              }
            },
            "eca_first_frame": {
              "$omitEmpty": {
                "$first": {
                  "$map": {
                    "from": {
                      "$filter": {
                        "from": {
                          "$sortByOrder": {
                            "$ref": "request.images"
                          }
                        },
                        "as": "media",
                        "where": {
                          "$in": [
                            {
                              "$ref": "media.role"
                            },
                            [
                              "first_frame"
                            ]
                          ]
                        }
                      }
                    },
                    "as": "media",
                    "in": {
                      "$ref": "media.value"
                    }
                  }
                }
              }
            },
            "eca_last_frame": {
              "$omitEmpty": {
                "$first": {
                  "$map": {
                    "from": {
                      "$filter": {
                        "from": {
                          "$sortByOrder": {
                            "$ref": "request.images"
                          }
                        },
                        "as": "media",
                        "where": {
                          "$in": [
                            {
                              "$ref": "media.role"
                            },
                            [
                              "last_frame"
                            ]
                          ]
                        }
                      }
                    },
                    "as": "media",
                    "in": {
                      "$ref": "media.value"
                    }
                  }
                }
              }
            },
            "eca_audio": {
              "$if": {
                "condition": {
                  "$not": {
                    "$in": [
                      {
                        "$lower": {
                          "$ref": "request.model"
                        }
                      },
                      [
                        "minimax-hailuo-02",
                        "minimax-hailuo-2.3"
                      ]
                    ]
                  }
                },
                "then": {
                  "$ref": "request.generateAudio"
                },
                "else": null
              }
            },
            "input_reference": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$or": [
                      {
                        "$in": [
                          {
                            "$lower": {
                              "$ref": "request.model"
                            }
                          },
                          [
                            "doubao-seedance-2-0-260128",
                            "doubao-seedance-2-0-fast-260128",
                            "doubao-seedance-2-5-260628"
                          ]
                        ]
                      },
                      {
                        "$in": [
                          {
                            "$lower": {
                              "$ref": "request.model"
                            }
                          },
                          [
                            "veo-3.1-generate-001",
                            "veo-3.1-fast-generate-001"
                          ]
                        ]
                      }
                    ]
                  },
                  "then": {
                    "$map": {
                      "from": {
                        "$filter": {
                          "from": {
                            "$filter": {
                              "from": {
                                "$sortByOrder": {
                                  "$ref": "request.images"
                                }
                              },
                              "as": "media",
                              "where": {
                                "$not": {
                                  "$eq": [
                                    {
                                      "$ref": "media.role"
                                    },
                                    "mask"
                                  ]
                                }
                              }
                            }
                          },
                          "as": "media",
                          "where": {
                            "$not": {
                              "$in": [
                                {
                                  "$ref": "media.role"
                                },
                                [
                                  "first_frame",
                                  "last_frame"
                                ]
                              ]
                            }
                          }
                        }
                      },
                      "as": "media",
                      "in": {
                        "image": {
                          "$ref": "media.value"
                        }
                      }
                    }
                  },
                  "else": {
                    "$map": {
                      "from": {
                        "$filter": {
                          "from": {
                            "$filter": {
                              "from": {
                                "$sortByOrder": {
                                  "$ref": "request.images"
                                }
                              },
                              "as": "media",
                              "where": {
                                "$not": {
                                  "$eq": [
                                    {
                                      "$ref": "media.role"
                                    },
                                    "mask"
                                  ]
                                }
                              }
                            }
                          },
                          "as": "media",
                          "where": {
                            "$not": {
                              "$in": [
                                {
                                  "$ref": "media.role"
                                },
                                [
                                  "first_frame",
                                  "last_frame"
                                ]
                              ]
                            }
                          }
                        }
                      },
                      "as": "media",
                      "in": {
                        "image": [
                          {
                            "$ref": "media.value"
                          }
                        ],
                        "eca_id": {
                          "$omitEmpty": {
                            "$ref": "media.metadata.eca_id"
                          }
                        },
                        "eca_voice": {
                          "$omitEmpty": {
                            "$ref": "media.metadata.eca_voice"
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            "eca_video_reference": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$ref": "request.videos"
                  },
                  "as": "media",
                  "in": {
                    "video": {
                      "$ref": "media.value"
                    },
                    "audio": {
                      "$omitEmpty": {
                        "$ref": "media.metadata.audio"
                      }
                    }
                  }
                }
              }
            },
            "eca_audio_reference": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$ref": "request.audios"
                  },
                  "as": "media",
                  "in": {
                    "audio": {
                      "$ref": "media.value"
                    }
                  }
                }
              }
            },
            "seed": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-videos.seed"
              }
            },
            "watermark": {
              "$if": {
                "condition": {
                  "$in": [
                    {
                      "$lower": {
                        "$ref": "request.model"
                      }
                    },
                    [
                      "doubao-seedance-2-0-260128",
                      "doubao-seedance-2-0-fast-260128",
                      "doubao-seedance-2-5-260628"
                    ]
                  ]
                },
                "then": {
                  "$ref": "request.watermark"
                },
                "else": null
              }
            },
            "eca_voice": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-videos.eca_voice"
              }
            }
          },
          "basePath": true
        },
        "poll": {
          "method": "GET",
          "path": "/videos/{{taskId}}",
          "basePath": true
        },
        "result": {
          "method": "GET",
          "path": "/videos/{{taskId}}/content",
          "headers": {
            "Accept": "video/mp4"
          },
          "basePath": true
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.id"
              },
              {
                "$ref": "response.task_id"
              },
              {
                "$ref": "response.taskId"
              },
              {
                "$ref": "response.data.id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$switch": {
              "cases": [
                {
                  "when": {
                    "$in": [
                      {
                        "$lower": {
                          "$ref": "response.status"
                        }
                      },
                      [
                        "created",
                        "queued"
                      ]
                    ]
                  },
                  "then": "pending"
                },
                {
                  "when": {
                    "$eq": [
                      {
                        "$lower": {
                          "$ref": "response.status"
                        }
                      },
                      "expired"
                    ]
                  },
                  "then": "failed"
                }
              ],
              "default": {
                "$coalesce": [
                  {
                    "$ref": "response.status"
                  },
                  {
                    "$ref": "response.state"
                  },
                  {
                    "$ref": "response.data.status"
                  },
                  "pending"
                ]
              }
            }
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.error.message"
              },
              {
                "$ref": "response.message"
              },
              {
                "$ref": "response.fail_reason"
              }
            ]
          },
          "videos": {
            "$coalesce": [
              {
                "$ref": "response.url"
              },
              {
                "$ref": "response.video_url"
              },
              {
                "$ref": "response.output.url"
              }
            ]
          },
          "errorPaths": [
            "error.code"
          ],
          "resultEphemeral": true,
          "messagePaths": [
            "error.message"
          ]
        },
        "validations": [
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$sortByOrder": {
                          "$ref": "request.images"
                        }
                      },
                      "as": "media",
                      "where": {
                        "$in": [
                          {
                            "$ref": "media.role"
                          },
                          [
                            "mask"
                          ]
                        ]
                      }
                    }
                  }
                },
                0
              ]
            },
            "message": "网宿视频协议不支持蒙版"
          },
          {
            "assert": {
              "$or": [
                {
                  "$not": {
                    "$in": [
                      {
                        "$lower": {
                          "$ref": "request.model"
                        }
                      },
                      [
                        "minimax-hailuo-02",
                        "minimax-hailuo-2.3"
                      ]
                    ]
                  }
                },
                {
                  "$and": [
                    {
                      "$eq": [
                        {
                          "$len": {
                            "$ref": "request.videos"
                          }
                        },
                        0
                      ]
                    },
                    {
                      "$eq": [
                        {
                          "$len": {
                            "$ref": "request.audios"
                          }
                        },
                        0
                      ]
                    },
                    {
                      "$eq": [
                        {
                          "$len": {
                            "$filter": {
                              "from": {
                                "$filter": {
                                  "from": {
                                    "$sortByOrder": {
                                      "$ref": "request.images"
                                    }
                                  },
                                  "as": "media",
                                  "where": {
                                    "$not": {
                                      "$eq": [
                                        {
                                          "$ref": "media.role"
                                        },
                                        "mask"
                                      ]
                                    }
                                  }
                                }
                              },
                              "as": "media",
                              "where": {
                                "$not": {
                                  "$in": [
                                    {
                                      "$ref": "media.role"
                                    },
                                    [
                                      "first_frame",
                                      "last_frame"
                                    ]
                                  ]
                                }
                              }
                            }
                          }
                        },
                        0
                      ]
                    }
                  ]
                }
              ]
            },
            "message": "Hailuo 支持首尾帧输入，不支持多模态参考素材"
          },
          {
            "assert": {
              "$or": [
                {
                  "$not": {
                    "$and": [
                      {
                        "$in": [
                          {
                            "$lower": {
                              "$ref": "request.model"
                            }
                          },
                          [
                            "minimax-hailuo-02",
                            "minimax-hailuo-2.3"
                          ]
                        ]
                      },
                      {
                        "$eq": [
                          {
                            "$ref": "request.duration"
                          },
                          10
                        ]
                      }
                    ]
                  }
                },
                {
                  "$eq": [
                    {
                      "$lower": {
                        "$ref": "request.resolution"
                      }
                    },
                    "768p"
                  ]
                }
              ]
            },
            "message": "Hailuo 10 秒视频仅支持 768P"
          },
          {
            "assert": {
              "$or": [
                {
                  "$not": {
                    "$and": [
                      {
                        "$in": [
                          {
                            "$lower": {
                              "$ref": "request.model"
                            }
                          },
                          [
                            "veo-3.1-generate-001",
                            "veo-3.1-fast-generate-001"
                          ]
                        ]
                      },
                      {
                        "$gt": [
                          {
                            "$len": {
                              "$filter": {
                                "from": {
                                  "$filter": {
                                    "from": {
                                      "$sortByOrder": {
                                        "$ref": "request.images"
                                      }
                                    },
                                    "as": "media",
                                    "where": {
                                      "$not": {
                                        "$eq": [
                                          {
                                            "$ref": "media.role"
                                          },
                                          "mask"
                                        ]
                                      }
                                    }
                                  }
                                },
                                "as": "media",
                                "where": {
                                  "$not": {
                                    "$in": [
                                      {
                                        "$ref": "media.role"
                                      },
                                      [
                                        "first_frame",
                                        "last_frame"
                                      ]
                                    ]
                                  }
                                }
                              }
                            }
                          },
                          0
                        ]
                      }
                    ]
                  }
                },
                {
                  "$and": [
                    {
                      "$eq": [
                        {
                          "$ref": "request.duration"
                        },
                        8
                      ]
                    },
                    {
                      "$eq": [
                        {
                          "$ref": "request.aspectRatio"
                        },
                        "16:9"
                      ]
                    },
                    {
                      "$eq": [
                        {
                          "$len": {
                            "$filter": {
                              "from": {
                                "$sortByOrder": {
                                  "$ref": "request.images"
                                }
                              },
                              "as": "media",
                              "where": {
                                "$in": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  [
                                    "first_frame",
                                    "last_frame"
                                  ]
                                ]
                              }
                            }
                          }
                        },
                        0
                      ]
                    },
                    {
                      "$lte": [
                        {
                          "$len": {
                            "$filter": {
                              "from": {
                                "$filter": {
                                  "from": {
                                    "$sortByOrder": {
                                      "$ref": "request.images"
                                    }
                                  },
                                  "as": "media",
                                  "where": {
                                    "$not": {
                                      "$eq": [
                                        {
                                          "$ref": "media.role"
                                        },
                                        "mask"
                                      ]
                                    }
                                  }
                                }
                              },
                              "as": "media",
                              "where": {
                                "$not": {
                                  "$in": [
                                    {
                                      "$ref": "media.role"
                                    },
                                    [
                                      "first_frame",
                                      "last_frame"
                                    ]
                                  ]
                                }
                              }
                            }
                          }
                        },
                        3
                      ]
                    }
                  ]
                }
              ]
            },
            "message": "Veo 参考图模式要求最多 3 张、16:9、8 秒，且不能同时使用首尾帧"
          },
          {
            "assert": {
              "$or": [
                {
                  "$not": {
                    "$in": [
                      {
                        "$lower": {
                          "$ref": "request.model"
                        }
                      },
                      [
                        "veo-3.1-generate-001",
                        "veo-3.1-fast-generate-001"
                      ]
                    ]
                  }
                },
                {
                  "$eq": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          "as": "media",
                          "where": {
                            "$in": [
                              {
                                "$ref": "media.role"
                              },
                              [
                                "last_frame"
                              ]
                            ]
                          }
                        }
                      }
                    },
                    0
                  ]
                },
                {
                  "$gt": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          "as": "media",
                          "where": {
                            "$in": [
                              {
                                "$ref": "media.role"
                              },
                              [
                                "first_frame"
                              ]
                            ]
                          }
                        }
                      }
                    },
                    0
                  ]
                }
              ]
            },
            "message": "Veo 尾帧必须同时提供首帧"
          },
          {
            "assert": {
              "$lte": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$sortByOrder": {
                          "$ref": "request.images"
                        }
                      },
                      "as": "media",
                      "where": {
                        "$in": [
                          {
                            "$ref": "media.role"
                          },
                          [
                            "first_frame"
                          ]
                        ]
                      }
                    }
                  }
                },
                1
              ]
            },
            "message": "首帧最多一张"
          },
          {
            "assert": {
              "$lte": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$sortByOrder": {
                          "$ref": "request.images"
                        }
                      },
                      "as": "media",
                      "where": {
                        "$in": [
                          {
                            "$ref": "media.role"
                          },
                          [
                            "last_frame"
                          ]
                        ]
                      }
                    }
                  }
                },
                1
              ]
            },
            "message": "尾帧最多一张"
          }
        ]
      },
      {
        "id": "wangsu-openai-videos",
        "label": "Wangsu · OpenAI 视频直连",
        "capabilities": [
          "video"
        ],
        "scopes": [
          "admin.system-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://api.edgecloudapp.com/v2/llm",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "视频模型 ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt/content/input",
            "description": "视频提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "first/last/reference image",
            "description": "显式 role 图片输入。"
          },
          {
            "name": "videos",
            "type": "media[]",
            "required": false,
            "mapping": "reference video",
            "description": "参考视频。"
          },
          {
            "name": "audios",
            "type": "media[]",
            "required": false,
            "mapping": "reference audio/voice",
            "description": "参考音频或音色。"
          },
          {
            "name": "duration",
            "type": "integer",
            "required": false,
            "mapping": "duration/seconds",
            "description": "时长秒数。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "ratio/aspect_ratio/size",
            "description": "画幅比例或尺寸。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "resolution",
            "description": "分辨率档位。"
          },
          {
            "name": "generateAudio",
            "type": "boolean",
            "required": false,
            "mapping": "generate_audio",
            "description": "是否生成音频。"
          },
          {
            "name": "watermark",
            "type": "boolean",
            "required": false,
            "mapping": "watermark",
            "description": "水印开关。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "provider-specific fields",
            "description": "插件命名空间内的厂商扩展字段。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/openai/videos",
          "contentType": "multipart/form-data",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "seconds": {
              "$toString": {
                "$ref": "request.duration"
              }
            },
            "size": {
              "$omitEmpty": {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.wangsu-openai-videos.size"
                  },
                  {
                    "$switch": {
                      "cases": [
                        {
                          "when": {
                            "$eq": [
                              {
                                "$ref": "request.aspectRatio"
                              },
                              "16:9"
                            ]
                          },
                          "then": "1280x720"
                        },
                        {
                          "when": {
                            "$eq": [
                              {
                                "$ref": "request.aspectRatio"
                              },
                              "9:16"
                            ]
                          },
                          "then": "720x1280"
                        }
                      ],
                      "default": {
                        "$ref": "request.aspectRatio"
                      }
                    }
                  }
                ]
              }
            },
            "variants": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.wangsu-openai-videos.variants"
              }
            }
          },
          "files": [
            {
              "name": "input_reference",
              "source": {
                "$first": {
                  "$filter": {
                    "from": {
                      "$sortByOrder": {
                        "$ref": "request.images"
                      }
                    },
                    "as": "media",
                    "where": {
                      "$ne": [
                        {
                          "$ref": "media.role"
                        },
                        "mask"
                      ]
                    }
                  }
                }
              },
              "filename": "input-reference.png"
            }
          ],
          "basePath": true
        },
        "poll": {
          "method": "GET",
          "path": "/openai/videos/{{taskId}}",
          "basePath": true
        },
        "result": {
          "method": "GET",
          "path": "/openai/videos/{{taskId}}/content",
          "headers": {
            "Accept": "video/mp4"
          },
          "basePath": true
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.id"
              },
              {
                "$ref": "response.task_id"
              },
              {
                "$ref": "response.taskId"
              },
              {
                "$ref": "response.data.id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$coalesce": [
              {
                "$ref": "response.status"
              },
              {
                "$ref": "response.state"
              },
              {
                "$ref": "response.data.status"
              },
              "pending"
            ]
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.error.message"
              },
              {
                "$ref": "response.message"
              },
              {
                "$ref": "response.fail_reason"
              }
            ]
          },
          "videos": {
            "$coalesce": [
              {
                "$ref": "response.url"
              },
              {
                "$ref": "response.video_url"
              },
              {
                "$ref": "response.output.url"
              }
            ]
          },
          "errorPaths": [
            "error.code"
          ],
          "resultEphemeral": true,
          "messagePaths": [
            "error.message"
          ]
        },
        "validations": [
          {
            "assert": {
              "$lte": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$sortByOrder": {
                          "$ref": "request.images"
                        }
                      },
                      "as": "media",
                      "where": {
                        "$not": {
                          "$eq": [
                            {
                              "$ref": "media.role"
                            },
                            "mask"
                          ]
                        }
                      }
                    }
                  }
                },
                1
              ]
            },
            "message": "OpenAI 视频直连最多支持一张参考图"
          },
          {
            "assert": {
              "$and": [
                {
                  "$eq": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          "as": "media",
                          "where": {
                            "$in": [
                              {
                                "$ref": "media.role"
                              },
                              [
                                "mask"
                              ]
                            ]
                          }
                        }
                      }
                    },
                    0
                  ]
                },
                {
                  "$eq": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          "as": "media",
                          "where": {
                            "$in": [
                              {
                                "$ref": "media.role"
                              },
                              [
                                "last_frame"
                              ]
                            ]
                          }
                        }
                      }
                    },
                    0
                  ]
                },
                {
                  "$eq": [
                    {
                      "$len": {
                        "$ref": "request.videos"
                      }
                    },
                    0
                  ]
                },
                {
                  "$eq": [
                    {
                      "$len": {
                        "$ref": "request.audios"
                      }
                    },
                    0
                  ]
                }
              ]
            },
            "message": "OpenAI 视频直连不支持尾帧、蒙版、参考视频或参考音频"
          }
        ]
      },
      {
        "id": "wangsu-audio",
        "label": "Wangsu · 语音合成兼容",
        "capabilities": [
          "audio"
        ],
        "scopes": [
          "admin.system-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://api.edgecloudapp.com/v2/llm",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "音频模型 ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "input",
            "description": "待合成文本。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "provider-specific fields",
            "description": "插件命名空间内的厂商扩展字段。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/audio/speech",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "input": {
              "$ref": "request.prompt"
            },
            "voice": {
              "$coalesce": [
                {
                  "$ref": "request.extra.audioVoice"
                },
                {
                  "$ref": "request.providerOptions.wangsu-audio.voice"
                },
                "alloy"
              ]
            },
            "response_format": {
              "$coalesce": [
                {
                  "$ref": "request.extra.audioFormat"
                },
                {
                  "$ref": "request.providerOptions.wangsu-audio.response_format"
                },
                "mp3"
              ]
            },
            "speed": {
              "$coalesce": [
                {
                  "$if": {
                    "condition": {
                      "$ne": [
                        {
                          "$toFloat": {
                            "$ref": "request.extra.audioSpeed"
                          }
                        },
                        0
                      ]
                    },
                    "then": {
                      "$toFloat": {
                        "$ref": "request.extra.audioSpeed"
                      }
                    },
                    "else": null
                  }
                },
                {
                  "$ref": "request.providerOptions.wangsu-audio.speed"
                },
                1
              ]
            },
            "instructions": {
              "$omitEmpty": {
                "$coalesce": [
                  {
                    "$ref": "request.extra.audioInstructions"
                  },
                  {
                    "$ref": "request.providerOptions.wangsu-audio.instructions"
                  }
                ]
              }
            }
          },
          "basePath": true
        },
        "response": {
          "binaryPayload": true,
          "resultKind": "audio",
          "status": "succeeded",
          "errorPaths": [
            "error.code"
          ],
          "messagePaths": [
            "error.message"
          ]
        }
      },
      {
        "id": "wangsu-openai-audio",
        "label": "Wangsu · OpenAI 语音合成直连",
        "capabilities": [
          "audio"
        ],
        "scopes": [
          "admin.system-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://api.edgecloudapp.com/v2/llm",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "音频模型 ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "input",
            "description": "待合成文本。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "provider-specific fields",
            "description": "插件命名空间内的厂商扩展字段。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/openai/audio/speech",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "input": {
              "$ref": "request.prompt"
            },
            "voice": {
              "$coalesce": [
                {
                  "$ref": "request.extra.audioVoice"
                },
                {
                  "$ref": "request.providerOptions.wangsu-openai-audio.voice"
                },
                "alloy"
              ]
            },
            "response_format": {
              "$coalesce": [
                {
                  "$ref": "request.extra.audioFormat"
                },
                {
                  "$ref": "request.providerOptions.wangsu-openai-audio.response_format"
                },
                "mp3"
              ]
            },
            "speed": {
              "$coalesce": [
                {
                  "$if": {
                    "condition": {
                      "$ne": [
                        {
                          "$toFloat": {
                            "$ref": "request.extra.audioSpeed"
                          }
                        },
                        0
                      ]
                    },
                    "then": {
                      "$toFloat": {
                        "$ref": "request.extra.audioSpeed"
                      }
                    },
                    "else": null
                  }
                },
                {
                  "$ref": "request.providerOptions.wangsu-openai-audio.speed"
                },
                1
              ]
            },
            "instructions": {
              "$omitEmpty": {
                "$coalesce": [
                  {
                    "$ref": "request.extra.audioInstructions"
                  },
                  {
                    "$ref": "request.providerOptions.wangsu-openai-audio.instructions"
                  }
                ]
              }
            }
          },
          "basePath": true
        },
        "response": {
          "binaryPayload": true,
          "resultKind": "audio",
          "status": "succeeded",
          "errorPaths": [
            "error.code"
          ],
          "messagePaths": [
            "error.message"
          ]
        }
      }
    ]
  }
}
```
<!-- YINGCE_MANIFEST_CONTRACT_END -->
