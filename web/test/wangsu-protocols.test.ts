import { afterEach, describe, expect, test } from "bun:test";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import { initialChannelModelValues, changeChannelModelCapability, updateChannelModelUpstreamCapabilities } from "../src/pages/admin/components/channel-model-editor-form";
import { aiApiUrl, geminiApiUrl } from "../src/services/api/image-transport";
import { requestImageQuestion } from "../src/services/api/image";
import { createModelChannel, defaultConfig, resolveModelRequestConfig } from "../src/stores/use-config-store";
import type { ModelProtocolDefinition } from "../src/lib/model-protocols";

const baseUrl = "https://api.edgecloudapp.com/v2/llm";
const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
});

function configFor(protocol: string) {
    const channel = createModelChannel({
        id: "wangsu",
        name: "Wangsu",
        baseUrl,
        apiKey: "test-token",
        apiFormat: "openai",
        models: ["test-model"],
        modelCosts: [{ model: "test-model", capability: "text", protocol, billingMode: "fixed_request", unitPriceMicrocredits: 0 }],
    });
    return { ...defaultConfig, channels: [channel], model: "wangsu::test-model", textModel: "wangsu::test-model" };
}

describe("Wangsu independent protocols", () => {
    test("keeps provider IDs while selecting their text wire format", () => {
        for (const [protocol, format] of [
            ["wangsu-chat", "openai"],
            ["wangsu-openai-responses", "openai"],
            ["wangsu-anthropic", "claude"],
            ["wangsu-gemini", "gemini"],
        ]) {
            const resolved = resolveModelRequestConfig(configFor(protocol), "wangsu::test-model");
            expect(resolved.interfaceType).toBe(protocol);
            expect(resolved.apiFormat).toBe(format);
        }
    });
    test("appends each protocol path to the uniform base URL", () => {
        for (const [interfaceType, endpoint, path] of [
            ["wangsu-chat", "/chat/completions", "/chat/completions"],
            ["wangsu-responses", "/responses", "/responses"],
            ["wangsu-openai-chat", "/chat/completions", "/openai/chat/completions"],
            ["wangsu-openai-responses", "/responses", "/openai/responses"],
            ["wangsu-anthropic", "/messages", "/anthropic/v1/messages"],
            ["wangsu-openai-images", "/images/generations", "/openai/images/generations"],
        ])
            expect(aiApiUrl({ baseUrl, interfaceType }, endpoint)).toBe(baseUrl + path);
        expect(geminiApiUrl({ baseUrl, model: "gemini-3-pro", interfaceType: "wangsu-gemini" }, "streamGenerateContent")).toBe(`${baseUrl}/gemini/v1beta/models/gemini-3-pro:streamGenerateContent`);
        expect(aiApiUrl({ baseUrl: "/api/ai/system/channel-id", interfaceType: "wangsu-openai-chat" }, "/chat/completions")).toBe("/api/ai/system/channel-id/chat/completions");
    });
    test("Wangsu Chat sends messages to Chat Completions through the authenticated relay", async () => {
        let body: Record<string, unknown> = {};
        let upstream = "";
        globalThis.fetch = (async (_url, init) => {
            body = JSON.parse(String(init?.body));
            upstream = new Headers(init?.headers).get("X-Canvas-Upstream-URL") || "";
            expect(init?.credentials).toBe("include");
            return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
        }) as typeof fetch;
        expect(await requestImageQuestion(configFor("wangsu-chat"), [{ role: "user", content: "Reply with OK" }], () => undefined)).toBe("OK");
        expect(upstream).toBe(`${baseUrl}/chat/completions`);
        expect(body.messages).toEqual([{ role: "user", content: "Reply with OK" }]);
        expect(body.input).toBeUndefined();
    });
    test("image defaults match the selected family", () => {
        const qwen = defaultModelCapabilityConfig("wangsu-images", "qwen-image").image!;
        expect(qwen.references).toMatchObject({ maxImages: 0, maskSupported: false });
        const gpt = defaultModelCapabilityConfig("wangsu-openai-images", "gpt-image-2.5-flare").image!;
        expect(gpt.maxOutputs).toBe(10);
        expect(gpt.quality.values).toEqual(["auto", "low", "medium", "high", "xhigh", "max"]);
        expect(gpt.references.maskSupported).toBe(true);
        for (const protocol of ["wangsu-gemini-image", "wangsu-chat-image"]) {
            const gemini = defaultModelCapabilityConfig(protocol, "gemini-3-pro-image").image!;
            expect(gemini.size.parameter).toBe("aspect_ratio");
            expect(gemini.quality.values).toEqual(["1k", "2k", "4k"]);
            expect(gemini.references.maskSupported).toBe(false);
        }
    });
    test("video defaults follow gateway model contracts", () => {
        const hailuo = defaultModelCapabilityConfig("wangsu-videos", "MiniMax-Hailuo-02").video!;
        expect(hailuo.duration.values).toEqual([6, 10]);
        expect(hailuo.resolutions).toEqual(["512P", "768P", "1080P"]);
        expect(defaultModelCapabilityConfig("wangsu-videos", "MiniMax-Hailuo-2.3").video!.resolutions).toEqual(["768P", "1080P"]);
        expect(hailuo.references.maxVideos).toBe(0);
        const seedance = defaultModelCapabilityConfig("wangsu-videos", "doubao-seedance-2-5-260628").video!;
        expect(seedance.duration.max).toBe(30);
        expect(seedance.generateAudio.default).toBe(true);
        expect(seedance.resolutions).toEqual(["480p", "720p", "1080p"]);
        expect(defaultModelCapabilityConfig("wangsu-videos", "doubao-seedance-2-0-fast-260128").video!.references.maxVideos).toBe(1);
        const kling = defaultModelCapabilityConfig("wangsu-videos", "kling-v3").video!;
        expect(kling.duration.default).toBe(5);
        expect(kling.resolutions).toEqual([]);
    });
    test("native OpenAI video defaults stay independent from gateway model overrides", () => {
        for (const name of ["sora-2", "MiniMax-Hailuo-02", "doubao-seedance-2-5-260628"]) {
            const video = defaultModelCapabilityConfig("wangsu-openai-videos", name).video!;
            expect(video.duration).toEqual({ selection: "enum", values: [4, 8, 12], default: 4 });
            expect(video.ratios).toEqual(["16:9", "9:16"]);
            expect(video.references).toMatchObject({ maxImages: 1, maxVideos: 0, maxAudios: 0 });
            expect(video.operations).toEqual(["text_to_video", "image_to_video"]);
        }
    });
    test("Veo defaults expose supported reference generation settings", () => {
        for (const name of ["veo-3.1-generate-001", "veo-3.1-fast-generate-001"]) {
            const video = defaultModelCapabilityConfig("wangsu-videos", name).video!;
            expect(video.duration).toEqual({ selection: "enum", values: [4, 6, 8], default: 8 });
            expect(video.resolutions).toEqual(["720p", "1080p", "4k"]);
            expect(video.defaultRatio).toBe("16:9");
            expect(video.references.maxImages).toBe(3);
            expect(video.operations).toContain("reference_to_video");
        }
    });
    test("admin protocol selection and upstream changes refresh untouched defaults", () => {
        const definition: ModelProtocolDefinition = { value: "wangsu-videos", capability: "video", label: "Wangsu 视频", create: "POST /videos", contentType: "application/json", media: "video" };
        const draft = initialChannelModelValues(null, [definition]);
        const selected = changeChannelModelCapability({ ...draft, capability: "video", protocol: "wangsu-videos", modelKey: "MiniMax-Hailuo-02" }, [definition]);
        expect(selected.capabilityConfig?.video?.duration.values).toEqual([6, 10]);
        const changed = { ...selected, providerModelKey: "doubao-seedance-2-5-260628" };
        expect(updateChannelModelUpstreamCapabilities(changed, "MiniMax-Hailuo-02").capabilityConfig?.video?.duration.max).toBe(30);
        changed.capabilityConfig!.video!.references.promptMaxChars = 1234;
        expect(updateChannelModelUpstreamCapabilities(changed, "MiniMax-Hailuo-02")).toBe(changed);
    });
});
