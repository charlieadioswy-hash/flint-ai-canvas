import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Keep shared wire templates in their existing packages; only gateway paths and
// documented Wangsu extensions are owned here. This generates Wangsu alone.
const root = dirname(fileURLToPath(import.meta.url));
const baseUrl = "https://api.edgecloudapp.com/v2/llm";
const scopes = ["admin.system-channel", "canvas", "creation", "agent"];
const ref = (path) => ({ $ref: path });
const omit = (value) => ({ $omitEmpty: value });
const coalesce = (...values) => ({ $coalesce: values });
const iff = (condition, then, otherwise = null) => ({ $if: { condition, then, else: otherwise } });
const eq = (a, b) => ({ $eq: [a, b] });
const not = (value) => ({ $not: value });
const len = (value) => ({ $len: value });
const gt = (a, b) => ({ $gt: [a, b] });
const and = (...values) => ({ $and: values });
const or = (...values) => ({ $or: values });
const oneOf = (value, values) => ({ $in: [value, values] });
const map = (from, alias, value) => ({ $map: { from, as: alias, in: value } });
const filter = (from, alias, where) => ({ $filter: { from, as: alias, where } });
const first = (value) => ({ $first: value });
const lower = (value) => ({ $lower: value });
const upper = (value) => ({ $upper: value });
const sorted = (value) => ({ $sortByOrder: value });
const param = (name, mapping, description, type = "object") => ({ name, type, mapping, description });
const model = lower(ref("request.model"));
const images = sorted(ref("request.images"));
const roleImages = (roles) => filter(images, "media", oneOf(ref("media.role"), roles));
const mask = roleImages(["mask"]);
const sourceImages = filter(images, "media", not(eq(ref("media.role"), "mask")));
const options = (id, key) => ref(`request.providerOptions.${id}.${key}`);
const providers = [];

async function cloneProvider(packageID, sourceID, id, label, prefix = "") {
  const source = JSON.parse(await readFile(join(root, packageID, "manifest.json"), "utf8"));
  const template = source.contributes.providers.find((item) => item.id === sourceID);
  if (!template) throw new Error(`missing source provider ${sourceID}`);
  const result = JSON.parse(JSON.stringify(template).replaceAll(`request.providerOptions.${sourceID}.`, `request.providerOptions.${id}.`));
  Object.assign(result, { id, label: `Wangsu · ${label}`, baseUrl, scopes });
  delete result.legacyAliases;
  for (const operation of ["create", "agent", "poll", "cancel", "result"]) {
    if (!result[operation]) continue;
    const spec = result[operation];
    // Gemini and Anthropic versions belong to their native wire endpoint.
    const path = spec.path.replace(/^\/v1(?=\/)/, "");
    spec.path = prefix + path;
    spec.basePath = true;
    delete spec.originPath;
  }
  providers.push(result);
  return result;
}

for (const [id, label, prefix, pkg, source] of [
  ["wangsu-chat", "Chat 兼容", "", "openai-chat-completions", "chat-completion"],
  ["wangsu-responses", "Responses 兼容", "", "openai-responses", "openai-response"],
  ["wangsu-openai-chat", "OpenAI Chat 直连", "/openai", "openai-chat-completions", "chat-completion"],
  ["wangsu-openai-responses", "OpenAI Responses 直连", "/openai", "openai-responses", "openai-response"],
  ["wangsu-anthropic", "Anthropic Messages", "/anthropic/v1", "anthropic-messages", "claude-api"],
  ["wangsu-gemini", "Gemini 文本", "/gemini", "google-gemini-generate-content", "gemini-generate-content"],
]) {
  const provider = await cloneProvider(pkg, source, id, label, prefix);
  if (source === "openai-response") {
    provider.response.text = coalesce(ref("response.output_text"), map(
      filter(ref("response.output"), "item", eq(ref("item.type"), "message")), "item",
      map(filter(ref("item.content"), "part", eq(ref("part.type"), "output_text")), "part", ref("part.text"))));
  }
  if (id === "wangsu-chat") {
    const fields = ["eca_enable_search", "eca_rag", "eca_thinking_config", "eca_context_management"];
    for (const key of fields) {
      provider.create.body[key] = omit(options(id, key));
      provider.agent.body[key] = omit(options(id, key));
    }
    provider.parameters.push(param("providerOptions", fields.join("/"), "文档声明的网宿扩展参数；以模型支持范围为准。"));
  }
  if (id === "wangsu-gemini") {
    // A multimodal Chat content array is not a Gemini text string. Build parts
    // explicitly, and preserve history as text messages.
    const history = filter(ref("request.messages"), "message", not(eq(ref("message.role"), "system")));
    provider.create.body.contents = map(history, "message", {
      role: iff(eq(ref("message.role"), "assistant"), "model", "user"),
      parts: iff(eq(ref("messageIndex"), { $add: [len(history), -1] }), { $concatArrays: [
          [{ text: ref("request.prompt") }],
          map(sourceImages, "media", iff(ref("media.dataUrl"), {
            inlineData: { mimeType: { $dataMime: ref("media.dataUrl") }, data: { $dataPayload: ref("media.dataUrl") } },
          }, { fileData: { mimeType: omit(ref("media.mimeType")), fileUri: ref("media.url") } })),
        ] }, [{ text: ref("message.content") }]),
    });
  }
}

for (const [id, label, prefix] of [["wangsu-images", "Images 兼容", ""], ["wangsu-openai-images", "OpenAI Images 直连", "/openai"]]) {
  const provider = await cloneProvider("openai-images", "openai-image", id, label, prefix);
  const hasImages = gt(len(sourceImages), 0);
  Object.assign(provider.create, {
    pathTemplate: iff(hasImages, `${prefix}/images/edits`, `${prefix}/images/generations`),
    contentTypeTemplate: iff(hasImages, "multipart/form-data", "application/json"),
    files: [
      { name: "image", source: sourceImages, filename: "source.png" },
      { name: "mask", source: mask, filename: "mask.png" },
    ],
  });
  delete provider.create.body.images;
  delete provider.create.body.mask;
  // The Qwen generation contract has no output_format/background/quality.
  const qwen = oneOf(model, ["qwen-image", "qwen-image-plus"]);
  for (const name of ["output_format", "background", "quality", "output_compression", "moderation", "style"]) {
    provider.create.body[name] = omit(iff(not(qwen), provider.create.body[name]));
  }
  provider.create.body.response_format = omit(coalesce(options(id, "response_format"), iff(qwen, "b64_json")));
  provider.validations = [
    { assert: or(eq(len(mask), 0), hasImages), message: "蒙版编辑必须提供源图片" },
    { assert: or(not(qwen), eq(len(images), 0)), message: "Qwen Image 文生图模型不支持此图片编辑接口，请使用 Qwen Image Edit 对应协议" },
  ];
}

const geminiImage = await cloneProvider("google-gemini-image", "gemini-image", "wangsu-gemini-image", "Gemini 图片", "/gemini");
geminiImage.validations = [{ assert: eq(len(mask), 0), message: "Gemini 图片不支持蒙版编辑" }];
const chatImage = await cloneProvider("openai-chat-completions", "chat-completion", "wangsu-chat-image", "Chat 图片兼容");
const geminiChatImage = { $eq: [{ $at: [{ $split: [model, "-"] }, 0] }, "gemini"] };
chatImage.capabilities = ["image"];
chatImage.parameters = structuredClone(geminiImage.parameters);
delete chatImage.agent;
delete chatImage.agentResponse;
chatImage.create.body = {
  model: ref("request.model"), messages: ref("request.messages"), stream: false,
  modalities: iff(geminiChatImage, ["image", "text"]),
  eca_image_config: iff(geminiChatImage, {
    aspect_ratio: omit(iff(not(eq(ref("request.aspectRatio"), "auto")), ref("request.aspectRatio"))),
    image_size: geminiImage.create.body.generationConfig.imageConfig.imageSize,
  }),
};
chatImage.response = {
  status: "succeeded",
  images: map(filter(ref("response.choices.0.message.content"), "part", eq(ref("part.type"), "image_url")), "part", ref("part.image_url.url")),
  usage: ref("response.usage"), errorPaths: ["error.code", "error.type"], messagePaths: ["error.message"],
};
chatImage.validations = [{ assert: eq(len(mask), 0), message: "Chat 图片协议不支持蒙版编辑" }];

const video = await cloneProvider("openai-videos", "newapi", "wangsu-videos", "视频兼容");
const seedance = oneOf(model, ["doubao-seedance-2-0-260128", "doubao-seedance-2-0-fast-260128", "doubao-seedance-2-5-260628"]);
const veo = oneOf(model, ["veo-3.1-generate-001", "veo-3.1-fast-generate-001"]);
const hailuo = oneOf(model, ["minimax-hailuo-02", "minimax-hailuo-2.3"]);
const references = filter(sourceImages, "media", not(oneOf(ref("media.role"), ["first_frame", "last_frame"])));
const frame = (role) => first(map(roleImages([role]), "media", ref("media.value")));
const hasReferences = gt(len(references), 0);
const duration = ref("request.duration");
video.create.contentType = "application/json";
delete video.create.files;
video.create.body = {
  model: ref("request.model"), prompt: ref("request.prompt"),
  seconds: omit(iff(or(gt(duration, 0), and(seedance, eq(duration, -1))), duration)),
  size: omit(iff(hailuo, upper(ref("request.resolution")), ref("request.resolution"))),
  eca_aspect_ratio: omit(ref("request.aspectRatio")),
  eca_first_frame: omit(frame("first_frame")), eca_last_frame: omit(frame("last_frame")),
  eca_audio: iff(not(hailuo), ref("request.generateAudio")),
  input_reference: omit(iff(or(seedance, veo), map(references, "media", { image: ref("media.value") }), map(references, "media", {
    image: [ref("media.value")], eca_id: omit(ref("media.metadata.eca_id")), eca_voice: omit(ref("media.metadata.eca_voice")),
  }))),
  eca_video_reference: omit(map(ref("request.videos"), "media", { video: ref("media.value"), audio: omit(ref("media.metadata.audio")) })),
  eca_audio_reference: omit(map(ref("request.audios"), "media", { audio: ref("media.value") })),
  seed: omit(options(video.id, "seed")),
  watermark: iff(seedance, ref("request.watermark")),
  eca_voice: omit(options(video.id, "eca_voice")),
};
video.parameters.push(param("providerOptions", "seed/eca_voice", "视频厂商扩展参数。"));
video.validations = [
  { assert: eq(len(mask), 0), message: "网宿视频协议不支持蒙版" },
  { assert: or(not(hailuo), and(eq(len(ref("request.videos")), 0), eq(len(ref("request.audios")), 0), eq(len(references), 0))), message: "Hailuo 支持首尾帧输入，不支持多模态参考素材" },
  { assert: or(not(and(hailuo, eq(duration, 10))), eq(lower(ref("request.resolution")), "768p")), message: "Hailuo 10 秒视频仅支持 768P" },
  { assert: or(not(and(veo, hasReferences)), and(eq(duration, 8), eq(ref("request.aspectRatio"), "16:9"), eq(len(roleImages(["first_frame", "last_frame"])), 0), { $lte: [len(references), 3] })), message: "Veo 参考图模式要求最多 3 张、16:9、8 秒，且不能同时使用首尾帧" },
  { assert: or(not(veo), eq(len(roleImages(["last_frame"])), 0), gt(len(roleImages(["first_frame"])), 0)), message: "Veo 尾帧必须同时提供首帧" },
  { assert: { $lte: [len(roleImages(["first_frame"])), 1] }, message: "首帧最多一张" },
  { assert: { $lte: [len(roleImages(["last_frame"])), 1] }, message: "尾帧最多一张" },
];
// The gateway does not document cancellation. Deleting a resource is not a
// safe substitute for cancelling upstream generation.
delete video.cancel;
video.response.status = { $switch: { cases: [
  { when: oneOf(lower(ref("response.status")), ["created", "queued"]), then: "pending" },
  { when: eq(lower(ref("response.status")), "expired"), then: "failed" },
], default: video.response.status } };

const nativeVideo = await cloneProvider("openai-videos", "newapi", "wangsu-openai-videos", "OpenAI 视频直连", "/openai");
delete nativeVideo.cancel;
delete nativeVideo.create.body.resolution_name;
nativeVideo.create.body.size = omit(coalesce(options(nativeVideo.id, "size"), {
  $switch: { cases: [
    { when: eq(ref("request.aspectRatio"), "16:9"), then: "1280x720" },
    { when: eq(ref("request.aspectRatio"), "9:16"), then: "720x1280" },
  ], default: ref("request.aspectRatio") },
}));
nativeVideo.validations = [
  { assert: { $lte: [len(sourceImages), 1] }, message: "OpenAI 视频直连最多支持一张参考图" },
  { assert: and(eq(len(mask), 0), eq(len(roleImages(["last_frame"])), 0), eq(len(ref("request.videos")), 0), eq(len(ref("request.audios")), 0)), message: "OpenAI 视频直连不支持尾帧、蒙版、参考视频或参考音频" },
];

await cloneProvider("openai-audio", "openai-audio", "wangsu-audio", "语音合成兼容");
await cloneProvider("openai-audio", "openai-audio", "wangsu-openai-audio", "OpenAI 语音合成直连", "/openai");

const manifest = {
  apiVersion: "yingce.plugin/v2", id: "wangsu", name: "Wangsu 网宿 AI 网关", version: "1.0.0", author: "Wangsu / 影策",
  description: "网宿系统渠道专用的文本、图片、视频和语音合成协议。",
  documentation: "接口说明见 README.md 与 docs/interface.md。",
  permissions: ["generation.run", "media.read"],
  configuration: { fields: [{ name: "apiKey", type: "secret", label: "网宿 API Token", required: true }] },
  contributes: { providers },
};
await mkdir(join(root, "wangsu"), { recursive: true });
await writeFile(join(root, "wangsu", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`generated ${providers.length} Wangsu providers`);
