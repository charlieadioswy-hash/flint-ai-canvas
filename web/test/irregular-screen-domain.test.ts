import { describe, expect, test } from "bun:test";
import { defaultControlNetBinding } from "../src/lib/canvas/controlnet";
import { readNodeGenerationSpec } from "../src/lib/canvas/generation-contract";
import { buildIrregularScreenTemplate, isIrregularScreenScene, resolveIrregularScreenOutputSize, type IrregularScreenTemplateInput } from "../src/lib/canvas/irregular-screen-domain";
import { defaultImageCapabilityConfig } from "../src/lib/model-capabilities";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function input(): IrregularScreenTemplateInput {
    return {
        controlImage: { storageKey: "resource:control", width: 1600, height: 900, assetId: "asset-control" },
        outputMask: { storageKey: "resource:mask", width: 1600, height: 900 },
        prompt: "A colorful landscape", modelSelection: { kind: "channel", channelId: "channel", modelKey: "image-model" },
        controlParameters: { ...defaultControlNetBinding("unit").parameters, model: "canny-model", resizeMode: "stretch" },
        size: "1600x900", maskMode: "color",
    };
}

describe("irregular screen canvas template", () => {
    test("builds three standard image nodes with separate control and output-mask bindings", () => {
        const template = buildIrregularScreenTemplate(input());
        expect(template.nodes).toHaveLength(3);
        expect(template.nodes.every((node) => node.type === CanvasNodeType.Image)).toBe(true);
        expect(template.connections).toHaveLength(2);
        expect(isIrregularScreenScene(template.creationScene)).toBe(true);
        const generator = template.nodes.find((node) => node.id === template.generationNodeId)!;
        const spec = readNodeGenerationSpec(generator)!;
        expect(spec.prompt).toBe("A colorful landscape");
        expect(spec.options.size).toBe("1600x900");
        expect(spec.options.controlNet?.[0].parameters.model).toBe("canny-model");
        expect(spec.options.controlNet?.[0].maskBindingId).toBeUndefined();
        expect(spec.referenceBindings.map((binding) => binding.role)).toEqual(["control-image", "output-mask"]);
        expect(spec.options.outputMask?.mode).toBe("luminance");
        expect(template.nodes[0].metadata?.assetId).toBe("asset-control");
        expect(generator.width / generator.height).toBeCloseTo(16 / 9);
    });

    test("binds an optional content image as ordinary reference rather than structural control", () => {
        const providerOptions = { "liblib-image": { steps: 20 } };
        const template = buildIrregularScreenTemplate({ ...input(), contentReference: { storageKey: "resource:reference", width: 800, height: 1200 }, providerOptions });
        expect(template.nodes).toHaveLength(4);
        const generator = template.nodes.find((node) => node.id === template.generationNodeId)!;
        const spec = readNodeGenerationSpec(generator)!;
        expect(spec.referenceBindings.find((binding) => binding.nodeId === template.creationScene.nodeIds.contentReference)?.role).toBe("reference");
        expect(generator.metadata?.providerOptions).toEqual(providerOptions);
    });

    test("updating inputs retains node IDs, previous results, user placement and unrelated nodes/edges", () => {
        const first = buildIrregularScreenTemplate(input());
        const foreign: CanvasNodeData = { id: "unrelated", title: "Untouched", type: CanvasNodeType.Image, position: { x: 7, y: 9 }, width: 100, height: 100, metadata: { storageKey: "resource:unrelated" } };
        const nodes = first.nodes.map((node) => node.id === first.generationNodeId ? { ...node, position: { x: 1400, y: 300 }, metadata: { ...node.metadata, storageKey: "resource:previous-result", content: "cached-result", naturalWidth: 1600, naturalHeight: 900 } } : node);
        const extraConnection = { id: "unrelated-edge", fromNodeId: foreign.id, toNodeId: first.generationNodeId };
        const second = buildIrregularScreenTemplate({ ...input(), prompt: "Updated prompt", existingProject: { ...first, nodes: [...nodes, foreign], connections: [...first.connections, extraConnection] } });
        expect(second.creationScene.nodeIds).toEqual(first.creationScene.nodeIds);
        expect(second.nodes).toHaveLength(4);
        expect(second.nodes.find((node) => node.id === foreign.id)).toBe(foreign);
        expect(second.connections).toContain(extraConnection);
        const generator = second.nodes.find((node) => node.id === first.generationNodeId)!;
        expect(generator.position).toEqual({ x: 1400, y: 300 });
        expect(generator.metadata?.storageKey).toBe("resource:previous-result");
        expect(generator.metadata?.content).toBe("cached-result");
        expect(readNodeGenerationSpec(generator)?.prompt).toBe("Updated prompt");
        expect(second.connections).toHaveLength(3);
    });

    test("rebuilds a missing managed node without damaging other nodes", () => {
        const first = buildIrregularScreenTemplate(input());
        const second = buildIrregularScreenTemplate({ ...input(), existingProject: { ...first, nodes: first.nodes.filter((node) => node.id !== first.creationScene.nodeIds.controlImage) } });
        expect(second.nodes).toHaveLength(3);
        expect(second.creationScene.nodeIds.controlImage).not.toBe(first.creationScene.nodeIds.controlImage);
        expect(second.generationNodeId).toBe(first.generationNodeId);
    });

    test("does not accept mismatched source coordinates or stretched output", () => {
        expect(() => buildIrregularScreenTemplate({ ...input(), outputMask: { storageKey: "resource:mask", width: 800, height: 450 } })).toThrow("相同");
        expect(() => buildIrregularScreenTemplate({ ...input(), size: "1024x1024" })).toThrow("比例");
        expect(() => buildIrregularScreenTemplate({ ...input(), controlParameters: { ...input().controlParameters, resizeMode: "crop" } })).toThrow("坐标");
    });

    test("prefers near-identical aspect ratio presets even when custom dimensions are allowed", () => {
        const profile = defaultImageCapabilityConfig("liblib-image");
        profile.size = { ...profile.size, values: ["768x1024", "1024x576"], default: "768x1024" };
        const selected = resolveIrregularScreenOutputSize({ width: 3803, height: 2139 }, profile);
        expect(selected.size).toBe("1024x576");
        expect(selected.scaled).toBe(true);
        expect(selected.aspectRatioAdjusted).toBe(true);
        expect(profile.size.allowCustom).toBe(true);
    });

    test("chooses the configured default generation scale instead of the upload resolution", () => {
        const profile = defaultImageCapabilityConfig("liblib-image");
        profile.size = { ...profile.size, values: ["3840x2160", "1024x576", "2048x1152"], default: "1024x576" };
        expect(resolveIrregularScreenOutputSize({ width: 3840, height: 2160 }, profile)).toEqual({ width: 1024, height: 576, size: "1024x576", scaled: true, aspectRatioAdjusted: false });
        profile.size.default = "2048x1152";
        expect(resolveIrregularScreenOutputSize({ width: 3840, height: 2160 }, profile).size).toBe("2048x1152");
    });

    test("falls back to custom source dimensions only without a matching preset", () => {
        const profile = defaultImageCapabilityConfig("liblib-image");
        expect(resolveIrregularScreenOutputSize({ width: 1258, height: 710 }, profile)).toEqual({ width: 1258, height: 710, size: "1258x710", scaled: false, aspectRatioAdjusted: false });
        profile.size = { ...profile.size, allowCustom: false, values: ["1024x1024", "1024x576"] };
        expect(() => resolveIrregularScreenOutputSize({ width: 400, height: 900 }, profile)).toThrow("同等比例".replace("同等", "同"));
    });

    test("rejects corrupt scene identities", () => {
        expect(isIrregularScreenScene({ kind: "irregular-screen", version: 1, nodeIds: { controlImage: "a", outputMask: "a", generation: "b" } })).toBe(false);
    });
});
