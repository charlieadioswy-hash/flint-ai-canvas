import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoSettingsPanel } from "../src/components/video-settings-panel";
import { canvasThemes } from "../src/lib/canvas-theme";
import { agentVideoApproval, agentVideoApprovalInput } from "../src/lib/canvas/agent-media-approval";
import type { CanvasResourceReference } from "../src/lib/canvas/canvas-resource-references";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import type { ModelPriceTier } from "../src/lib/model-pricing";
import type { ModelInputSummary, ModelRequirements } from "../src/lib/model-selection";
import { createModelChannel, defaultConfig, type AiConfig } from "../src/stores/use-config-store";

const textInput: ModelInputSummary = { textCount: 1, imageCount: 0, videoCount: 0, audioCount: 0, characterCount: 0 };
const hailuoSelectors: Record<string, string>[] = [
    { vquality: "768p", videoSeconds: "6" },
    { vquality: "768p", videoSeconds: "10" },
    { vquality: "1080p", videoSeconds: "6" },
    { vquality: "512p", videoSeconds: "6", operation: "image_to_video" },
    { vquality: "512p", videoSeconds: "10", operation: "image_to_video" },
];

function videoConfig(selectors: Record<string, string>[] = hailuoSelectors, model = "MiniMax-Hailuo-02"): AiConfig {
    const tiers: ModelPriceTier[] = selectors.map((selector) => ({
        selector,
        resolution: selector.vquality || "*",
        videoSeconds: Number(selector.videoSeconds || 0),
        billingMode: "per_second",
        unitPriceMicrocredits: 1,
        inputTokenPriceMicrocredits: 0,
        outputTokenPriceMicrocredits: 0,
        cachedTokenPriceMicrocredits: 0,
    }));
    const channel = createModelChannel({
        id: "wangsu",
        scope: "system",
        models: [model],
        modelCosts: [{ model, protocol: "wangsu-videos", capability: "video", pricePolicy: "channel", billingMode: "per_second", unitPriceMicrocredits: 1, logicalPriceTiers: tiers, capabilityConfig: defaultModelCapabilityConfig("wangsu-videos", model) }],
    });
    return { ...defaultConfig, channels: [channel], model: `${channel.id}::${model}`, size: "", vquality: "768", videoSeconds: "6" };
}

function panel(config: AiConfig, requirements: ModelRequirements = { capability: "video", input: textInput }) {
    return renderToStaticMarkup(<VideoSettingsPanel config={config} requirements={requirements} theme={canvasThemes.dark} onConfigChange={() => {}} />);
}

function buttonDisabled(html: string, label: string) {
    const button = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find((match) => match[2]!.replace(/<[^>]+>/g, "") === label);
    expect(button).toBeDefined();
    return /\bdisabled(?:=|\s|$)/.test(button![1]!);
}

describe("video settings use the request SKU selector", () => {
    test("blocks unpriced Hailuo 512P text generation at both durations", () => {
        for (const videoSeconds of ["6", "10"]) {
            const html = panel({ ...videoConfig(), videoSeconds });
            expect(buttonDisabled(html, "512P")).toBe(true);
            expect(buttonDisabled(html, "768P")).toBe(false);
        }
        const stale512 = panel({ ...videoConfig(), vquality: "512" });
        expect(buttonDisabled(stale512, "6s")).toBe(true);
        expect(buttonDisabled(stale512, "10s")).toBe(true);
        expect(buttonDisabled(panel(videoConfig(), {}), "512P")).toBe(true);
    });

    test("keeps Hailuo image and character generation at 512P while blocking 1080P/10s", () => {
        for (const input of [
            { ...textInput, imageCount: 1 },
            { ...textInput, characterCount: 1 },
        ]) {
            const requirements: ModelRequirements = { capability: "video", input, videoSeconds: "6", options: { vquality: "768", videoSeconds: 6 } };
            const html = panel({ ...videoConfig(), vquality: "512", videoSeconds: "10" }, requirements);
            expect(buttonDisabled(html, "512P")).toBe(false);
            expect(buttonDisabled(html, "6s")).toBe(false);
            expect(buttonDisabled(html, "10s")).toBe(false);
            expect(buttonDisabled(html, "1080P")).toBe(true);
        }
        expect(buttonDisabled(panel(videoConfig(), { videoOperation: "image_to_video" }), "512P")).toBe(false);
    });

    test("matches video, audio and image-count conditions instead of only resolution and duration", () => {
        const cases: Array<{ selector: Record<string, string>; input: ModelInputSummary }> = [
            { selector: { operation: "video_to_video" }, input: { ...textInput, videoCount: 1 } },
            { selector: { operation: "audio_to_video" }, input: { ...textInput, audioCount: 1 } },
            { selector: { operation: "image_to_video", imageCount: "2" }, input: { ...textInput, imageCount: 2 } },
        ];
        for (const { selector, input } of cases) {
            const config = videoConfig([{ vquality: "512p", videoSeconds: "6", ...selector }]);
            expect(buttonDisabled(panel(config), "512P")).toBe(true);
            expect(buttonDisabled(panel(config, { capability: "video", input }), "512P")).toBe(false);
        }
        expect(buttonDisabled(panel(videoConfig([{ vquality: "512p", videoSeconds: "6", operation: "image_to_video", imageCount: "2" }]), { input: { ...textInput, imageCount: 1 } }), "512P")).toBe(true);
    });

    test("does not lock models without price tiers and removes the false Fast 720P claim", () => {
        expect(buttonDisabled(panel(videoConfig([])), "512P")).toBe(false);
        const html = panel({ ...videoConfig([], "doubao-seedance-2-0-fast-260128"), size: "16:9", vquality: "480", videoSeconds: "5" });
        expect(buttonDisabled(html, "480P")).toBe(false);
        expect(html).not.toContain("fast 模型自动使用 720P");
    });
});

test("Agent approval retains real reference types and transient images for pricing", () => {
    const approval = agentVideoApproval({ toolName: "generate_media", arguments: { mode: "video", prompt: "镜头运动", sourceNodeId: "script", referenceNodeIds: ["image", "video", "audio", "character"], referenceTransientIds: ["annotation"] } })!;
    const references: CanvasResourceReference[] = (["image", "video", "audio", "character"] as const).map((kind) => ({ id: kind, nodeId: kind, kind, label: kind, title: kind, active: false }));
    expect(agentVideoApprovalInput(approval, references)).toEqual({ textCount: 1, imageCount: 2, videoCount: 1, audioCount: 1, characterCount: 1 });
    const imageApproval = { ...approval, referenceNodeIds: [], referenceTransientIds: ["annotation"] };
    expect(buttonDisabled(panel({ ...videoConfig(), vquality: "512", videoSeconds: "10" }, { capability: "video", input: agentVideoApprovalInput(imageApproval, []) }), "512P")).toBe(false);
});
