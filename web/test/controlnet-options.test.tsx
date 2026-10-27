import { describe, expect, test } from "bun:test";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControlNetParameterFields } from "../src/components/controlnet-parameter-fields";
import { Select, type SelectProps } from "../src/components/ui/base/select";
import { CONTROLNET_PREPROCESSORS } from "../src/lib/canvas/controlnet-catalog.generated";
import { defaultControlNetBinding, validateControlNetBindings } from "../src/lib/canvas/controlnet";
import { controlNetBaseModel, controlNetBaseModelError, controlNetConfigurationError, controlNetDefaultModel, controlNetDefaultType, controlNetModelCatalog, controlNetModelId, controlNetModels, controlNetPreprocessors, controlNetTypeUnavailableReason, switchControlNetPreprocessor, switchControlNetType, type ControlNetProfile } from "../src/lib/canvas/controlnet-options";
import { screenControlParameters, screenDefaultSettings, screenModelError, screenModels, screenSettingsFromControl } from "../src/lib/canvas/irregular-screen-model";
import { defaultImageCapabilityConfig } from "../src/lib/model-capabilities";
import { createModelChannel, defaultConfig } from "../src/stores/use-config-store";
import type { ControlNetParameters } from "../src/lib/canvas/generation-contract.generated";

const cannyXL = "b6806516962f4e1599a93ac4483c3d23";
const depthXL = "6349e9dae8814084bd9c1585d335c24c";
const profile: ControlNetProfile = { supported: true, maxUnits: 4, baseModel: "sdxl", preprocessors: CONTROLNET_PREPROCESSORS.map((processor) => processor.id) };

function selectFields(parameters: ControlNetParameters, onChange: (next: ControlNetParameters) => void, selectedProfile = profile, defaults: Record<string, unknown> = {}) {
    const selections = new Map<string, SelectProps<string>>();
    const visit = (node: ReactNode) => Children.forEach(node, (child) => {
        if (!isValidElement<{ children?: ReactNode; ariaLabel?: string }>(child)) return;
        if (child.type === Select) selections.set(child.props.ariaLabel!, child.props as SelectProps<string>);
        visit(child.props.children);
    });
    visit(ControlNetParameterFields({ parameters, profile: selectedProfile, defaults, onChange }));
    return selections;
}

describe("ControlNet official types and model selection", () => {
    test("disabled types explain channel configuration, model allowlists and incompatible bases", () => {
        const parameters = { ...defaultControlNetBinding("unit").parameters, model: cannyXL };
        const cannyOnly = { ...profile, preprocessors: ["canny"] };
        const limitedModels = { ...profile, models: [cannyXL] };
        expect(controlNetTypeUnavailableReason("canny", cannyOnly)).toBe("");
        expect(controlNetTypeUnavailableReason("depth", cannyOnly)).toBe("后台未启用预处理器");
        expect(controlNetTypeUnavailableReason("depth", limitedModels)).toBe("后台未开放兼容模型");
        expect(controlNetTypeUnavailableReason("mlsd", profile)).toBe("当前底模无兼容控制模型");
        expect(controlNetTypeUnavailableReason("depth", { ...profile, supported: false })).toBe("后台未启用 ControlNet");
        expect(controlNetTypeUnavailableReason("depth", { ...profile, baseModel: undefined })).toBe("后台未配置基础算法");
        expect(controlNetTypeUnavailableReason("depth", profile, { family: "f1" })).toBe("基础算法配置冲突");
        expect(controlNetTypeUnavailableReason("revision", profile)).toBe("暂不支持");
        const fields = selectFields(parameters, () => {}, cannyOnly).get("Control Type（控制类型）")!;
        expect(fields.options?.find((option) => option.value === "depth")).toMatchObject({ disabled: true, label: "Depth（深度图）（后台未启用预处理器）" });
        const complete = selectFields(parameters, () => {}).get("Control Type（控制类型）")!;
        expect(complete.options?.find((option) => option.value === "depth")?.disabled).toBe(false);
        expect(complete.options?.find((option) => option.value === "mlsd")).toMatchObject({ disabled: true, label: "MLSD（直线）（当前底模无兼容控制模型）" });
    });

    test("type switching chooses an available processor when the model allowlist excludes the first one", () => {
        const embedding = "3a8267c7d45c11ee9b5e00163e365853";
        const limited = { ...profile, models: [embedding] };
        expect(controlNetTypeUnavailableReason("instant-id", limited)).toBe("");
        const selected = switchControlNetType(defaultControlNetBinding("unit").parameters, "instant-id", limited);
        expect(selected).toMatchObject({ preprocessor: "instant_id_face_embedding", model: embedding });
        expect(controlNetConfigurationError(selected, limited)).toBe("");
    });

    test("preprocessor allowlist aliases use the same case-insensitive policy as the backend", () => {
        const aliases = { ...profile, preprocessors: [" CANNY ", "DEPTH_LERES"] };
        expect(controlNetTypeUnavailableReason("depth", aliases)).toBe("");
        const selected = switchControlNetType(defaultControlNetBinding("unit").parameters, "depth", aliases);
        expect(selected.preprocessor).toBe("depth_leres");
        expect(controlNetConfigurationError(selected, aliases)).toBe("");
        expect(controlNetPreprocessors(aliases).map((processor) => processor.id)).toEqual(["canny", "depth_leres"]);
    });

    test("the real shared fields switch type, model and dedicated parameters together", () => {
        const initial = { ...defaultControlNetBinding("unit").parameters, model: cannyXL, strength: 1.2 };
        let selected = initial;
        const fields = selectFields(initial, (next) => { selected = next; });
        const types = fields.get("Control Type（控制类型）")!;
        expect(types.options?.some((option) => option.value === "depth" && !option.disabled)).toBe(true);
        expect(types.options?.find((option) => option.value === "revision")?.disabled).toBe(true);
        types.onChange?.("depth", { value: "depth" });
        expect(selected).toMatchObject({ controlType: "depth", preprocessor: "depth_midas", strength: 1.2, processorParameters: { resolution: 512 } });
        expect(selected).not.toHaveProperty("canny");
        expect(selected.model).not.toBe(cannyXL);
        expect(controlNetConfigurationError(selected, profile)).toBe("");
        expect(controlNetModels(profile, "depth").some((model) => model.id === selected.model)).toBe(true);
        expect(initial.canny).toBeDefined();

        const processors = selectFields(selected, (next) => { selected = next; }).get("Preprocessor（预处理器）")!;
        processors.onChange?.("depth_leres", { value: "depth_leres" });
        expect(selected.processorParameters).toEqual({ resolution: 512, removeNear: 0, removeBackground: 0 });
        const markup = renderToStaticMarkup(<ControlNetParameterFields parameters={selected} profile={profile} onChange={() => {}} />);
        expect(markup).toContain('aria-label="删除前景"');
        expect(markup).not.toContain('aria-label="低阈值"');
        selected = switchControlNetPreprocessor({ ...selected, processorParameters: { resolution: 1024, removeNear: 50, removeBackground: 30 } }, "depth_zoe");
        expect(selected.processorParameters).toEqual({ resolution: 512 });
    });

    test("model filtering respects type, base and explicit allowlists", () => {
        const limited = { ...profile, models: [cannyXL, depthXL] };
        expect(controlNetModels(limited, "canny").map((model) => model.id)).toEqual([cannyXL]);
        expect(controlNetModels(limited, "depth").map((model) => model.id)).toEqual([depthXL]);
        expect(controlNetModels({ ...limited, baseModel: "sd15" }, "depth")).toEqual([]);
        expect(controlNetModels(profile, "depth").length).toBeGreaterThan(1);
        const depth = switchControlNetType(defaultControlNetBinding("unit").parameters, "depth", limited);
        expect(controlNetConfigurationError({ ...depth, model: cannyXL }, limited)).toContain("不兼容");
        expect(controlNetConfigurationError(depth, { ...limited, preprocessors: ["canny"] })).toContain("未启用");
    });

    test("F.1 shared fields select compatible types, processors and models without reusing SDXL controls", () => {
        const unionF1 = "13c1e1b96ba64f9cbb2b54f89b5fe873";
        const inpaintF1 = "31df01fc271d484ca4d496179d69a665";
        const f1: ControlNetProfile = { ...profile, baseModel: "f1", preprocessors: ["canny", "depth_midas", "inpaint_global_harmonious"], models: [unionF1, inpaintF1, cannyXL, "a311363995dd4f2fa42ee3fc9582d920"] };
        const defaults = { family: "f1", controlNetModel: unionF1 };
        let selected = { ...defaultControlNetBinding("unit").parameters, model: cannyXL };
        const types = selectFields(selected, (next) => { selected = next; }, f1, defaults).get("Control Type（控制类型）")!;
        expect(types.options?.filter((option) => !option.disabled).map((option) => option.value)).toEqual(["canny", "depth", "inpaint"]);
        types.onChange?.("inpaint", { value: "inpaint" });
        expect(selected).toMatchObject({ controlType: "inpaint", preprocessor: "inpaint_global_harmonious", model: inpaintF1, processorParameters: {} });
        expect(selected).not.toHaveProperty("canny");
        const fields = selectFields(selected, (next) => { selected = next; }, f1, defaults);
        expect(fields.get("Preprocessor（预处理器）")?.options?.map((option) => option.value)).toEqual(["inpaint_global_harmonious"]);
        expect(fields.get("Model（控制模型）")?.options?.map((option) => option.value)).toEqual([inpaintF1]);
        expect(controlNetConfigurationError(selected, f1, defaults)).toBe("");
        fields.get("Control Type（控制类型）")!.onChange?.("depth", { value: "depth" });
        expect(selected).toMatchObject({ controlType: "depth", preprocessor: "depth_midas", model: unionF1, processorParameters: { resolution: 512 } });
    });

    test("F.1 IP-Adapter uses only SigLIP and cannot appear as a compatible CLIP or FaceID model", () => {
        const adapter = "c6ed70879cf011ef96d600163e37ec70";
        const f1: ControlNetProfile = { ...profile, baseModel: "f1", models: [adapter] };
        const defaults = { family: "f1", controlNetModel: adapter };
        const selected = switchControlNetType(defaultControlNetBinding("unit").parameters, "ip-adapter", f1, defaults);
        expect(selected).toMatchObject({ controlType: "ip-adapter", preprocessor: "ip-adapter-siglip", model: adapter });
        expect(controlNetConfigurationError(selected, f1, defaults)).toBe("");
        expect(controlNetModels(f1, "ip-adapter", defaults, "ip-adapter-siglip").map((model) => model.id)).toEqual([adapter]);
        const incompatible = controlNetPreprocessors(f1, "ip-adapter").filter((processor) => processor.id !== "ip-adapter-siglip");
        expect(incompatible.length).toBeGreaterThan(0);
        for (const processor of incompatible) {
            expect(controlNetModels(f1, "ip-adapter", defaults, processor.id)).toEqual([]);
            const stale = { ...selected, preprocessor: processor.id };
            expect(controlNetConfigurationError(stale, f1, defaults)).toContain("没有可用");
            expect(selectFields(stale, () => {}, f1, defaults).get("Model（控制模型）")?.options?.filter((option) => !option.disabled)).toEqual([]);
        }
    });

    test("base inference uses only explicit settings or known metadata", () => {
        const legacy = { ...profile, baseModel: undefined, models: [cannyXL] };
        expect(controlNetBaseModel(legacy)).toBe("sdxl");
        expect(controlNetBaseModel({ ...legacy, models: ["unknown-model"] })).toBeUndefined();
        expect(controlNetBaseModel({ ...legacy, models: [cannyXL, "7d917ec7e55c5805db737d3b493c91ce"] })).toBeUndefined();
        expect(controlNetBaseModel(undefined, { family: "sd" })).toBeUndefined();
        expect(controlNetBaseModel(undefined, { family: "f1" })).toBe("f1");
        expect(controlNetBaseModel(undefined, { family: "sd", checkPointId: "0ea388c7eb854be3ba3c6f65aac6bfd3" })).toBe("sdxl");
        expect(controlNetBaseModel(undefined, { checkPointId: " 0EA388C7EB854BE3BA3C6F65AAC6BFD3 " })).toBe("sdxl");
    });

    test("explicit and inferred base algorithms cannot override known generation family or checkpoint conflicts", () => {
        const checkpoint = "0ea388c7eb854be3ba3c6f65aac6bfd3";
        const parameters = { ...defaultControlNetBinding("unit").parameters, model: cannyXL };
        const conflicts: { baseModel?: ControlNetProfile["baseModel"]; defaults: Record<string, unknown>; models?: string[] }[] = [
            { baseModel: "sd15", defaults: { family: "sd", checkPointId: checkpoint } },
            { baseModel: "sd15", defaults: { checkPointId: ` ${checkpoint.toUpperCase()} ` } },
            { baseModel: "sdxl", defaults: { family: "f1", checkPointId: checkpoint } },
            { baseModel: "sd15", defaults: { family: "f1" } },
            { baseModel: "f1", defaults: { family: "sd" } },
            { defaults: { family: "sd" }, models: ["13c1e1b96ba64f9cbb2b54f89b5fe873"] },
        ];
        for (const conflict of conflicts) {
            const settings = { ...profile, baseModel: conflict.baseModel, models: conflict.models };
            expect(controlNetBaseModel(settings, conflict.defaults)).toBeUndefined();
            expect(controlNetBaseModelError(settings, conflict.defaults)).toContain("不一致");
            expect(controlNetConfigurationError(parameters, settings, conflict.defaults)).toContain("不一致");
            expect(controlNetModels(settings, "canny", conflict.defaults)).toEqual([]);
        }
        expect(controlNetBaseModel({ ...profile, baseModel: "sd15" }, { family: "sd", checkPointId: "administrator-configured-checkpoint" })).toBe("sd15");
        expect(controlNetBaseModel({ ...profile, baseModel: "f1" }, { family: "f1", checkPointId: checkpoint })).toBe("f1");
    });

    test("a disallowed preferred model falls back to the compatible allowlist", () => {
        const allowed = { ...profile, models: [depthXL] };
        expect(controlNetDefaultModel(allowed, "depth", { family: "sd", controlNetModel: cannyXL }, "depth_midas")).toBe(depthXL);
        const selected = switchControlNetType(defaultControlNetBinding("unit").parameters, "depth", allowed, { family: "sd", controlNetModel: cannyXL });
        expect(selected.model).toBe(depthXL);
        expect(controlNetConfigurationError(selected, allowed, { family: "sd", controlNetModel: cannyXL })).toBe("");
    });

    test("custom metadata cannot redefine official model compatibility", () => {
        const custom = { ...profile, modelCatalog: [{ id: ` ${cannyXL.toUpperCase()} `, name: "wrong depth", baseModel: "sd15" as const, controlTypes: ["depth"] }, { id: "new-depth", name: "custom depth", baseModel: "sdxl" as const, controlTypes: ["depth"] }, { id: " NEW-DEPTH ", name: "duplicate wrong base", baseModel: "sd15" as const, controlTypes: ["canny"] }] };
        expect(controlNetModelCatalog(custom).find((model) => model.id === cannyXL)).toMatchObject({ baseModel: "sdxl", controlTypes: ["canny"] });
        expect(controlNetModelCatalog(custom).filter((model) => controlNetModelId(model.id) === cannyXL)).toHaveLength(1);
        expect(controlNetModelCatalog(custom).filter((model) => controlNetModelId(model.id) === "new-depth")).toHaveLength(1);
        expect(controlNetModels(custom, "depth").some((model) => model.id === "new-depth")).toBe(true);
        expect(controlNetModels(custom, "depth").some((model) => model.id === cannyXL)).toBe(false);
    });

    test("UUID aliases preserve allowlists, defaults, inference and the visible model selection", () => {
        const alias = (id: string) => ` ${id.toUpperCase()} `;
        const limited = { ...profile, models: [alias(cannyXL), alias(depthXL)] };
        const defaults = { controlNetModel: alias(depthXL) };
        expect(controlNetBaseModel({ ...limited, baseModel: undefined, models: [alias(cannyXL)] })).toBe("sdxl");
        expect(controlNetDefaultType(limited, defaults)).toBe("depth");
        expect(controlNetDefaultModel(limited, "depth", defaults)).toBe(depthXL);
        const parameters = { ...defaultControlNetBinding("unit").parameters, model: alias(cannyXL) };
        expect(controlNetConfigurationError(parameters, limited)).toBe("");
        const fields = selectFields(parameters, () => {}, limited);
        expect(fields.get("Model（控制模型）")?.value).toBe(cannyXL);
        expect(fields.get("Model（控制模型）")?.options?.some((option) => option.disabled)).toBe(false);
        const pose = switchControlNetType(parameters, "openpose", { ...profile, baseModel: "sd15" }, { controlNetModel: alias("329f0073d45c11ee9b5e00163e365853") });
        expect(pose).toMatchObject({ preprocessor: "animal_openpose", model: "329f0073d45c11ee9b5e00163e365853" });
    });

    test("None keeps an explicit supported type and does not introduce Canny parameters", () => {
        const depth = switchControlNetType(defaultControlNetBinding("unit").parameters, "depth", profile);
        const none = switchControlNetPreprocessor(depth, "none");
        expect(none).toMatchObject({ controlType: "depth", preprocessor: "none", model: depth.model, processorParameters: {} });
        expect(none).not.toHaveProperty("canny");
        expect(controlNetConfigurationError(none, profile)).toBe("");
        expect(controlNetPreprocessors(profile, "reference").map((processor) => processor.id)).not.toContain("invert");
    });

    test("Reference uses None model without falling back to configured Canny UUID", () => {
        const limited = { ...profile, baseModel: "sd15" as const, models: ["7d917ec7e55c5805db737d3b493c91ce"] };
        const reference = switchControlNetType(defaultControlNetBinding("unit").parameters, "reference", limited, { controlNetModel: "7d917ec7e55c5805db737d3b493c91ce" });
        expect(reference.model).toBe("");
        expect(reference.preprocessor).toBe("reference_only");
        expect(controlNetModels(limited, "reference").map((model) => model.id)).toEqual([""]);
        expect(controlNetConfigurationError(reference, limited)).toBe("");
        const markup = renderToStaticMarkup(<ControlNetParameterFields parameters={reference} profile={limited} onChange={() => {}} />);
        expect(markup).toContain("无需额外控制模型");
        expect(markup).not.toContain("没有可用的");
    });

    test("InstantID processor switching selects the matching keypoint or embedding model", () => {
        const keypoints = switchControlNetType(defaultControlNetBinding("unit").parameters, "instant-id", profile);
        expect(keypoints.model).toBe("3560664ad45c11ee9b5e00163e365853");
        const embedding = switchControlNetPreprocessor(keypoints, "instant_id_face_embedding", profile);
        expect(embedding.model).toBe("3a8267c7d45c11ee9b5e00163e365853");
        expect(controlNetConfigurationError(embedding, profile)).toBe("");
        expect(controlNetConfigurationError({ ...embedding, model: keypoints.model }, profile)).toContain("不兼容");
        const markup = renderToStaticMarkup(<ControlNetParameterFields parameters={embedding} profile={profile} onChange={() => {}} />);
        expect(markup).toContain("Instant ID");
        expect(markup).toContain("单组结构控制不等同于");
    });

    test("processor recommendations change the suggested model without hiding the type catalog", () => {
        const sd15 = { ...profile, baseModel: "sd15" as const };
        const pose = switchControlNetType(defaultControlNetBinding("unit").parameters, "openpose", sd15);
        const animal = switchControlNetPreprocessor(pose, "animal_openpose", sd15);
        expect(animal.model).toBe("329f0073d45c11ee9b5e00163e365853");
        const catalog = controlNetModels(sd15, "openpose", {}, "animal_openpose");
        expect(catalog[0].id).toBe(animal.model);
        expect(catalog.length).toBeGreaterThan(1);
        const hand = switchControlNetPreprocessor(switchControlNetType(pose, "depth", sd15), "depth_hand_refiner", sd15);
        expect(hand.model).toBe("3497061cd45c11ee9b5e00163e365853");
    });
});

test("typed processor parameters validate ranges, integers and stale Canny data", () => {
    const unit = defaultControlNetBinding("unit");
    unit.parameters = switchControlNetType(unit.parameters, "mlsd", { ...profile, baseModel: "sd15" });
    expect(() => validateControlNetBindings([unit])).not.toThrow();
    expect(() => validateControlNetBindings([{ ...unit, parameters: { ...unit.parameters, canny: { resolution: 512, lowThreshold: 100, highThreshold: 200 } } }])).toThrow("Canny");
    expect(() => validateControlNetBindings([{ ...unit, parameters: { ...unit.parameters, processorParameters: { ...unit.parameters.processorParameters, valueThreshold: 3 } } }])).toThrow("值阈值");
    expect(() => validateControlNetBindings([{ ...unit, parameters: { ...unit.parameters, processorParameters: { ...unit.parameters.processorParameters, unexpected: 1 } } }])).toThrow("未知参数");
    expect(() => validateControlNetBindings([{ ...unit, parameters: { ...unit.parameters, processorParameters: { ...unit.parameters.processorParameters, resolution: 512.5 } } }])).toThrow("整数");
});

test("a Depth-only screen model is admitted and restores its saved settings without becoming Canny", () => {
    const image = defaultImageCapabilityConfig("liblib-image");
    image.controlNet = { ...profile, preprocessors: ["depth_leres"], models: [depthXL] };
    const channel = createModelChannel({ id: "depth", name: "Depth", scope: "system", models: ["base"], interfaceType: "liblib-image", modelCosts: [{ model: "base", capability: "image", protocol: "liblib-image", billingMode: "fixed_request", unitPriceMicrocredits: 1, capabilityConfig: { version: 1, image }, defaultOptions: { family: "sd", textToImageTemplateUuid: "text", imageToImageTemplateUuid: "image" } }] });
    const config = { ...defaultConfig, channels: [channel], model: "depth::base", imageModel: "depth::base" };
    expect(screenModelError(config, config.model)).toBe("");
    const defaults = screenDefaultSettings(config, config.model);
    expect(defaults).toMatchObject({ controlType: "depth", preprocessor: "depth_leres", controlModel: depthXL });
    const saved = { ...screenControlParameters(defaults), processorParameters: { resolution: 768, removeNear: 0, removeBackground: 35 } };
    const restored = screenSettingsFromControl(defaults, JSON.parse(JSON.stringify(saved)));
    expect(screenControlParameters(restored)).toEqual(saved);
    expect(screenControlParameters(restored)).not.toHaveProperty("canny");
    const conflict = structuredClone(config);
    conflict.channels[0].modelCosts![0].capabilityConfig!.image!.controlNet!.baseModel = "sd15";
    conflict.channels[0].modelCosts![0].defaultOptions!.checkPointId = "0ea388c7eb854be3ba3c6f65aac6bfd3";
    expect(screenModelError(conflict, conflict.model)).toContain("SDXL Checkpoint 不一致");
    expect(screenModels(conflict)).toEqual([]);
});
