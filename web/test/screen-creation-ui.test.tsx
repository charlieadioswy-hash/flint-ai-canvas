import { afterEach, expect, spyOn, test } from "bun:test";
import { App } from "antd";
import { Children, isValidElement, type ChangeEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { WorkspaceSidebarNav } from "../src/components/layout/workspace-sidebar-nav";
import { CachedResourceImage } from "../src/components/cached-resource-image";
import { ModelPicker } from "../src/components/model-picker";
import { Select, type SelectProps } from "../src/components/ui/base/select";
import { Checkbox, type CheckboxProps } from "../src/components/ui/base/checkbox";
import { defaultImageCapabilityConfig } from "../src/lib/model-capabilities";
import { screenControlParameters, screenInpaintError, screenModelError, screenPickerConfig, screenProviderOptions } from "../src/lib/canvas/irregular-screen-model";
import { ControlNetParameterFields } from "../src/components/controlnet-parameter-fields";
import { ScreenCreationGenerationMode, ScreenCreationWorkspace } from "../src/pages/screen-creation/screen-creation-workspace";
import { ScreenCreationMaskGuide } from "../src/pages/screen-creation/screen-creation-mask-guide";
import { ScreenCreationPreviewImage } from "../src/pages/screen-creation/screen-creation-preview-image";
import { ScreenCreationAdvanced } from "../src/pages/screen-creation/screen-creation-advanced";
import type { ScreenCreationWorkspaceProps } from "../src/pages/screen-creation/screen-creation-types";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot } from "../src/stores/use-config-store";
import { useUserStore } from "../src/stores/use-user-store";

const noop = () => {};
const controlId = "b6806516962f4e1599a93ac4483c3d23";
const initialUserState = useUserStore.getInitialState();
let restoreUserSnapshot: (() => void) | undefined;
afterEach(() => {
    restoreUserSnapshot?.();
    restoreUserSnapshot = undefined;
});

function fixture(): ScreenCreationWorkspaceProps {
    const profile = defaultImageCapabilityConfig("liblib-image");
    profile.controlNet = { supported: true, maxUnits: 4, preprocessors: ["canny"], models: [controlId] };
    const channel = createModelChannel({
        id: "screen-ui-test",
        name: "屏幕模型",
        scope: "system",
        models: ["screen"],
        modelCosts: [{ model: "screen", capability: "image", protocol: "liblib-image", billingMode: "fixed_request", unitPriceMicrocredits: 1_000_000, capabilityConfig: { version: 1, image: profile }, defaultOptions: { controlNetModel: controlId } }],
    });
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel], model: "screen-ui-test::screen", imageModel: "screen-ui-test::screen" } }).config;
    return {
        config,
        model: "screen-ui-test::screen",
        setModel: noop,
        profile,
        size: "1600x900",
        setSize: noop,
        mask: null,
        reference: null,
        uploadMask: noop,
        uploadReference: noop,
        clearMask: noop,
        clearReference: noop,
        maskMode: "alpha",
        setMaskMode: noop,
        generationMode: "text2img",
        setGenerationMode: noop,
        inpaint: false,
        setInpaint: noop,
        applyExample: noop,
        prompt: "",
        setPrompt: noop,
        advanced: { controlModel: controlId, strength: 0.9, start: 0, end: 0.9, lowThreshold: 100, highThreshold: 200, resolution: 1024, steps: 20, sampler: 15, cfgScale: 7, seed: -1, denoisingStrength: 0.75, negativePrompt: "" },
        setAdvanced: noop,
        results: [],
        selectedResultId: "",
        setSelectedResultId: noop,
        busy: false,
        uploading: false,
        loading: false,
        canGenerate: false,
        disabledReason: "请先上传屏幕蒙版",
        quoteLabel: "预计 1 积分",
        generate: noop,
        recentScenes: [],
        openScene: noop,
        newScene: noop,
        openCanvas: noop,
        downloadResult: noop,
    };
}

function render(overrides: Partial<ScreenCreationWorkspaceProps> = {}) {
    return renderToStaticMarkup(<ScreenCreationWorkspace {...fixture()} {...overrides} />);
}

function buttonAttributes(markup: string, label: string) {
    const button = [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find((match) => match[2].replace(/<[^>]*>/g, "").trim() === label);
    expect(button).toBeDefined();
    return button![1];
}

function renderedControlOptions(props: ScreenCreationWorkspaceProps) {
    let controlSelect: ReactElement<SelectProps<string>> | undefined;
    const visit = (node: ReactNode) => {
        Children.forEach(node, (child) => {
            if (!isValidElement<{ children?: ReactNode; ariaLabel?: string }>(child)) return;
            if (child.type === Select && child.props.ariaLabel === "Model（控制模型）") controlSelect = child as ReactElement<SelectProps<string>>;
            visit(child.props.children);
        });
    };
    visit(ControlNetParameterFields({ parameters: screenControlParameters(props.advanced), profile: props.profile?.controlNet, defaults: props.config.channels[0].modelCosts?.[0].defaultOptions, disabled: false, onChange: noop }));
    expect(controlSelect).toBeDefined();
    return controlSelect!.props.options || [];
}

test("first screen keeps detailed settings collapsed and exposes both source previews without a result", () => {
    const markup = render();
    const disclosure = markup.match(/<details\b([^>]*class="screen-creation-advanced"[^>]*)>/);
    expect(disclosure).not.toBeNull();
    expect(disclosure![1]).not.toMatch(/\bopen(?:=|\s|$)/);
    const common = markup.slice(0, disclosure!.index);
    const advanced = markup.slice(disclosure!.index, markup.indexOf('<div class="screen-creation-submit"'));
    for (const label of ["细节迭代次数", "低阈值", "避免出现的内容", "复现种子"]) {
        expect(common).not.toContain(label);
        expect(advanced).toContain(label);
    }
    expect(buttonAttributes(markup, "原始蒙版")).not.toContain("disabled");
    expect(buttonAttributes(markup, "有效区域")).toContain('aria-pressed="true"');
    expect(buttonAttributes(markup, "生成画面")).toContain("disabled");
    expect(markup).toContain('aria-label="上传屏幕蒙版"');
    expect(markup).not.toContain('aria-label="上传内容原图"');
    expect(markup).not.toContain('aria-label="上传内容参考图"');
    expect(markup).not.toContain('aria-label="蒙版重绘"');
    expect(buttonAttributes(markup, "文生图")).toContain('aria-pressed="true"');
    expect(buttonAttributes(markup, "图生图")).toContain('aria-pressed="false"');
});

test("new masks accept only transparent PNG while legacy interpretation remains read-only", () => {
    const markup = render();
    const inputs = [...markup.matchAll(/<input\b([^>]*type="file"[^>]*)>/g)];
    expect(inputs.find((input) => input[1].includes('aria-label="上传屏幕蒙版"'))?.[1]).toContain('accept="image/png"');
    expect(render({ generationMode: "img2img" })).toMatch(/<input\b[^>]*accept="image\/png,image\/jpeg"[^>]*aria-label="上传内容原图"/);
    for (const rule of ["不超过 10 MB", "宽、高各不超过 4096 像素", "透明处为屏幕外，不透明处显示内容"]) expect(markup).toContain(rule);
    expect(markup).not.toContain("蒙版识别方式");
    expect(markup).not.toContain("历史蒙版仍按原规则读取");
    const mask = { url: "blob:legacy-mask", name: "legacy.png", width: 1200, height: 600 };
    for (const maskMode of ["auto", "luminance", "color"] as const) {
        const legacy = render({ mask, maskMode });
        expect(legacy).toContain("历史蒙版仍按原规则读取，替换时请上传透明PNG");
        expect(legacy).not.toContain("蒙版识别方式");
    }
    expect(render({ mask, maskMode: "alpha" })).not.toContain("历史蒙版仍按原规则读取");
});

test("mask help renders opaque corner faces over a transparent SVG and explains the checkerboard", () => {
    const markup = renderToStaticMarkup(<ScreenCreationMaskGuide />);
    const svg = markup.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/)![1];
    expect(markup).toContain("screen-creation-transparency-grid");
    expect(svg).toContain('class="screen-creation-mask-face"');
    expect(svg).toContain('class="screen-creation-mask-face is-side"');
    expect(svg).toContain('class="screen-creation-mask-corner"');
    expect(svg).not.toContain("<rect");
    expect(markup).toContain("彩色不透明区域仍可保留转角线");
    expect(markup).toContain("棋盘格仅用于展示透明度，请勿画进蒙版");
});

test("advanced controls use plain labels with accessible professional explanations", () => {
    const markup = render({ generationMode: "img2img" });
    for (const [label, technical] of [
        ["细节迭代次数", "steps"],
        ["描述贴合程度", "CFG"],
        ["画面变化幅度", "denoising"],
        ["控制强度", "strength"],
        ["开始控制时点", "start"],
        ["结束控制时点", "end"],
        ["复现种子", "seed"],
        ["画面生成方法", "sampler"],
        ["避免出现的内容", "negative prompt"],
    ]) {
        expect(markup).toContain(`aria-label="${label}"`);
        expect(markup).toContain(`aria-label="${label}说明"`);
        expect(markup).toMatch(new RegExp(`aria-description="[^"]*${technical}[^"]*"`));
    }
    expect(markup).not.toContain("Liblib 生成参数");
    expect(markup).not.toContain("蒙版识别方式");
    for (const label of ["预处理器分辨率", "低阈值", "高阈值"]) expect(markup).toContain(`aria-label="${label}"`);
});

test("the real screen type selection initializes Inpaint weights without Canny parameter fields", () => {
    const props = fixture();
    props.profile!.controlNet!.preprocessors.push("inpaint_only");
    props.profile!.controlNet!.models!.push("a311363995dd4f2fa42ee3fc9582d920");
    props.advanced = { ...props.advanced, controlType: "canny", preprocessor: "canny", strength: 0.3, start: 0.2, end: 0.4, seed: 12345 };
    props.setAdvanced = (patch) => { props.advanced = { ...props.advanced, ...patch }; };
    let fields: ReactElement<Parameters<typeof ControlNetParameterFields>[0]> | undefined;
    const visit = (node: ReactNode) => Children.forEach(node, (child) => {
        if (!isValidElement<{ children?: ReactNode }>(child)) return;
        if (child.type === ControlNetParameterFields) fields = child as typeof fields;
        visit(child.props.children);
    });
    visit(ScreenCreationAdvanced({ ...props, disabled: false }));
    expect(fields).toBeDefined();
    let controlType: ReactElement<SelectProps<string>> | undefined;
    const selectType = (node: ReactNode) => Children.forEach(node, (child) => {
        if (!isValidElement<{ children?: ReactNode; ariaLabel?: string }>(child)) return;
        if (child.type === Select && child.props.ariaLabel === "Control Type（控制类型）") controlType = child as ReactElement<SelectProps<string>>;
        selectType(child.props.children);
    });
    selectType(ControlNetParameterFields(fields!.props));
    expect(controlType?.props.options?.find((option) => option.value === "inpaint")?.disabled).toBe(false);
    controlType!.props.onChange?.("inpaint", { value: "inpaint" });
    expect(screenControlParameters(props.advanced)).toMatchObject({ controlType: "inpaint", preprocessor: "inpaint_only", model: "a311363995dd4f2fa42ee3fc9582d920", strength: 1, start: 0, end: 1, pixelPerfect: false, processorParameters: {} });
    expect(screenControlParameters(props.advanced)).not.toHaveProperty("canny");
    expect(props.advanced.seed).toBe(12345);
    const markup = render(props);
    expect(markup).not.toContain('aria-label="低阈值"');
    expect(markup).not.toContain('aria-label="预处理器分辨率"');
    let pixelPerfect: ReactElement<CheckboxProps> | undefined;
    const findPixelPerfect = (node: ReactNode) => Children.forEach(node, (child) => {
        if (!isValidElement<{ children?: ReactNode; "aria-label"?: string }>(child)) return;
        if (child.type === Checkbox && child.props["aria-label"] === "完美像素（Pixel Perfect）") pixelPerfect = child as ReactElement<CheckboxProps>;
        findPixelPerfect(child.props.children);
    });
    findPixelPerfect(ScreenCreationAdvanced({ ...props, disabled: false }));
    expect(pixelPerfect?.props.checked).toBe(false);
    pixelPerfect!.props.onChange?.({ target: { checked: true } } as ChangeEvent<HTMLInputElement>);
    expect(screenControlParameters(props.advanced).pixelPerfect).toBe(true);
    expect(render({ ...props, busy: true })).toMatch(/<input\b[^>]*disabled=""[^>]*aria-label="完美像素（Pixel Perfect）"/);
});

test("mask repaint lives in image-to-image advanced settings and requires matching dimensions", () => {
    const mask = { url: "blob:mask", name: "mask.png", width: 1200, height: 600 };
    const inpaint = render({ generationMode: "img2img", inpaint: true, mask, reference: { ...mask, url: "blob:original", name: "original.png" } });
    expect(buttonAttributes(inpaint, "图生图")).toContain('aria-pressed="true"');
    expect(inpaint).toMatch(/<input\b[^>]*aria-label="蒙版重绘"[^>]*checked=""/);
    const advancedStart = inpaint.indexOf('class="screen-creation-advanced"');
    expect(inpaint.indexOf('aria-label="蒙版重绘"')).toBeGreaterThan(advancedStart);
    expect(inpaint).toContain('aria-label="上传内容原图"');
    expect(inpaint).toContain("内容原图必填");
    expect(inpaint).toContain("请上传 1200 × 600 像素的原图");
    expect(inpaint).toContain("原图尺寸必须与屏幕蒙版完全一致");
    expect(inpaint).toContain("调整屏幕范围内的原图变化");
    expect(inpaint).not.toContain('aria-label="上传内容参考图"');
    expect(inpaint).toContain("1600x900");
    expect(inpaint).toContain('aria-label="输出尺寸"');
    expect(inpaint).toContain("输出尺寸可按蒙版的相同比例缩放");
    expect(inpaint).toContain("最终屏外保持黑色");
    expect(inpaint).not.toContain("屏外保留原图");
    const regular = render({ generationMode: "img2img", mask });
    expect(buttonAttributes(regular, "图生图")).toContain('aria-pressed="true"');
    expect(regular).toContain('aria-label="上传内容原图"');
    expect(regular).not.toContain("<small>可选</small>");
    expect(regular).not.toContain("请上传 1200 × 600 像素的原图");
    const text = render({ generationMode: "text2img", mask, reference: { ...mask, url: "blob:stale-original" } });
    expect(buttonAttributes(text, "文生图")).toContain('aria-pressed="true"');
    expect(text).not.toContain('aria-label="上传内容原图"');
    expect(text).not.toContain('aria-label="蒙版重绘"');
    expect(text).not.toContain("blob:stale-original");
});

test("unavailable mask repaint remains independent from image-to-image availability", () => {
    const markup = render({ generationMode: "img2img", inpaintUnavailableReason: "当前模型不支持蒙版重绘，请选择其他模型" });
    expect(markup).toMatch(/<input\b[^>]*disabled=""[^>]*aria-label="蒙版重绘"/);
    expect(buttonAttributes(markup, "图生图")).not.toContain("disabled");
    expect(buttonAttributes(markup, "文生图")).not.toContain("disabled");
    expect(markup).toContain("当前模型不支持蒙版重绘，请选择其他模型");
    expect(buttonAttributes(render({ imageToImageUnavailableReason: "当前模型缺少图生图模板" }), "图生图")).toContain("disabled");
    expect(buttonAttributes(render({ busy: true }), "文生图")).toContain("disabled");
});

test("an enabled mask repaint can be turned off after switching to a model without masks", () => {
    const props = fixture();
    props.config.channels[0].modelCosts![0].defaultOptions = { family: "sd", controlNetModel: controlId, textToImageTemplateUuid: "text-template", imageToImageTemplateUuid: "image-template" };
    props.generationMode = "img2img";
    props.inpaint = true;
    const original = { url: "blob:original", storageKey: "resource:original", name: "original.png", width: 1600, height: 900 };
    props.reference = original;
    props.inpaintUnavailableReason = screenInpaintError(props.config, props.model);
    expect(props.inpaintUnavailableReason).toContain("未启用蒙版重绘");
    props.setInpaint = (value) => { props.inpaint = value; };
    let repaint: ReactElement<CheckboxProps> | undefined;
    const visit = (node: ReactNode) => Children.forEach(node, (child) => {
        if (!isValidElement<{ children?: ReactNode; "aria-label"?: string }>(child)) return;
        if (child.type === Checkbox && child.props["aria-label"] === "蒙版重绘") repaint = child as ReactElement<CheckboxProps>;
        visit(child.props.children);
    });
    visit(ScreenCreationAdvanced({ ...props, disabled: false }));
    expect(repaint?.props.checked).toBe(true);
    expect(repaint?.props.disabled).toBe(false);
    expect(render({ ...props, busy: true })).toMatch(/<input\b[^>]*disabled=""[^>]*aria-label="蒙版重绘"/);
    repaint!.props.onChange?.({ target: { checked: false } } as ChangeEvent<HTMLInputElement>);
    expect(props.inpaint).toBe(false);
    expect(props.generationMode).toBe("img2img");
    expect(props.reference).toBe(original);
    expect(screenModelError(props.config, props.model, true)).toBe("");
    expect(screenProviderOptions(props.config, props.model, props.advanced, props.generationMode, props.inpaint)["liblib-image"]).toMatchObject({ templateUuid: "image-template" });
    expect(screenProviderOptions(props.config, props.model, props.advanced, props.generationMode, props.inpaint)["liblib-image"]).not.toHaveProperty("inpaintMaskMode");
    const markup = render(props);
    expect(markup).toContain("original.png");
    expect(markup).toMatch(/<input\b[^>]*disabled=""[^>]*aria-label="蒙版重绘"/);
});

test("mode buttons only choose a mode and the example entry respects active work", () => {
    const selected: string[] = [];
    const element = ScreenCreationGenerationMode({ generationMode: "text2img", setGenerationMode: (value) => selected.push(value), disabled: false });
    const actions: (() => void)[] = [];
    const visit = (node: ReactNode) =>
        Children.forEach(node, (child) => {
            if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return;
            if (child.type === "button" && child.props.onClick) actions.push(child.props.onClick);
            visit(child.props.children);
        });
    visit(element);
    expect(actions).toHaveLength(2);
    actions[1]();
    actions[0]();
    expect(selected).toEqual(["img2img", "text2img"]);
    expect(buttonAttributes(render(), "使用科幻跑车示例")).not.toContain("disabled");
    expect(buttonAttributes(render({ uploading: true }), "使用科幻跑车示例")).toContain("disabled");
    expect(render({ applyExample: undefined })).not.toContain("使用科幻跑车示例");
});

test("unsaved mask, derived region and reference images have browser-ready local previews", () => {
    const markup = render({
        generationMode: "img2img",
        mask: { url: "blob:local-mask", name: "mask.png", width: 1200, height: 600 },
        reference: { url: "blob:local-reference", name: "reference.jpg", width: 1200, height: 600 },
        effectiveMaskUrl: "blob:derived-region",
    });
    const sources = [...markup.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
    expect(sources).toEqual(["blob:local-mask", "blob:local-reference", "blob:derived-region"]);
    expect(markup).not.toContain("图片暂时无法显示");
    expect(markup).toContain('class="screen-creation-preview-image"');
});

test("saved previews retain resource authorization instead of reusing an old session blob", () => {
    const saved = ScreenCreationPreviewImage({ src: "blob:previous-local-mask", storageKey: "resource:saved-mask", alt: "已保存蒙版", fallback: null });
    expect(saved.type).toBe(CachedResourceImage);
    expect(saved.props.storageKey).toBe("resource:saved-mask");
    expect(saved.props.src).toBe("");
    const remote = ScreenCreationPreviewImage({ src: "https://example.test/result.png", storageKey: "resource:result", fallback: null });
    expect(remote.type).toBe(CachedResourceImage);
    expect(remote.props.src).toBe("https://example.test/result.png");
});

test("available models have a readable recommendation while unknown saved models are marked unavailable", () => {
    const markup = render();
    expect(markup).toContain("xinsir_controlnet-canny-sdxl_V2");
    expect(markup).not.toContain('placeholder="控制模型 UUID / 标识"');
    expect(markup).toContain("<summary>查看模型标识</summary><code>" + controlId + "</code>");
    const unavailable = render({ advanced: { ...fixture().advanced, controlModel: "unlisted-control" } });
    expect(unavailable).toContain("原控制模型已不可用，请重新选择");
    expect(unavailable).not.toContain("当前场景的轮廓模型");
});

test("the real ModelPicker accepts only the screen-specific system catalog", () => {
    const props = fixture();
    const system = props.config.channels[0];
    const validCost = { ...system.modelCosts![0], displayName: "有效屏幕模型", defaultOptions: { family: "sd", controlNetModel: controlId, textToImageTemplateUuid: "text-template" } };
    system.models.push("missing-template");
    system.modelCosts = [validCost, { ...validCost, model: "missing-template", displayName: "缺少模板模型", defaultOptions: { family: "sd", controlNetModel: controlId } }];
    props.config.channels.push(createModelChannel({ ...system, id: "personal", scope: "user", name: "个人渠道", models: ["personal-model"], modelCosts: [{ ...validCost, model: "personal-model", displayName: "个人图片模型" }] }));
    const original = structuredClone(props.config);
    const config = screenPickerConfig(props.config);
    const renderPicker = (value: string) => renderToStaticMarkup(<ModelPicker config={config} value={value} capability="image" requirements={{ capability: "image", controlNetUnits: 1 }} onChange={noop} showSelectedPrice={false} />);

    expect(renderPicker("screen-ui-test::screen")).toContain("有效屏幕模型");
    for (const [value, label] of [
        ["screen-ui-test::missing-template", "缺少模板模型"],
        ["personal::personal-model", "个人图片模型"],
    ]) {
        const markup = renderPicker(value);
        expect(markup).toContain("选择模型");
        expect(markup).not.toContain(label);
    }
    expect(props.config).toEqual(original);
});

test("empty model state explains the next action without requiring users to understand provider settings", () => {
    const markup = render({ config: { ...defaultConfig, models: [], imageModels: [], channels: [] }, model: "", profile: undefined, disabledReason: "技术校验：ControlNet providerOptions templateUuid" });
    expect(markup).toContain("请联系管理员启用异形屏生图模型，再开始创作。");
    expect(markup).not.toContain("技术校验");
    expect(buttonAttributes(markup, "生成画面")).toContain("disabled");
});

test("a stale default or saved control never becomes selectable outside the configured model allowlist", () => {
    const props = fixture();
    const staleControl = "old-control-not-in-catalog";
    props.config.channels[0].modelCosts![0].defaultOptions = { controlNetModel: staleControl };
    props.advanced.controlModel = staleControl;
    const options = renderedControlOptions(props);
    expect(options.filter((option) => !option.disabled).map((option) => option.value)).toEqual([controlId]);
    expect(options.find((option) => option.value === staleControl)?.disabled).toBe(true);
});

test("generation readiness and active work control the real submit button and editable fields", () => {
    const ready = render({ canGenerate: true, disabledReason: undefined, prompt: "水下世界" });
    expect(buttonAttributes(ready, "生成画面")).not.toContain("disabled");
    const running = render({ canGenerate: true, busy: true, statusText: "正在生成屏幕画面…" });
    expect(buttonAttributes(running, "正在生成")).toContain("disabled");
    expect(running).toMatch(/<fieldset[^>]*disabled/);
    expect(running).toContain('role="status"');
    expect(running).toContain("正在生成屏幕画面…");
    const recoverable = render({ canGenerate: true, disabledReason: undefined, generateLabel: "继续读取结果", quoteLabel: "继续读取原任务，不会重新提交" });
    expect(buttonAttributes(recoverable, "继续读取结果")).not.toContain("disabled");
    expect(recoverable).toContain("继续读取原任务，不会重新提交");
});

test("screen creation stays directly below canvas and remains selected when short drama is disabled", () => {
    for (const shortDramaEnabled of [false, true]) {
        const snapshot = spyOn(useUserStore, "getInitialState").mockImplementation(() => ({ ...initialUserState, user: null, features: { ...initialUserState.features, shortDramaEnabled } }));
        restoreUserSnapshot = () => snapshot.mockRestore();
        const markup = renderToStaticMarkup(
            <App>
                <MemoryRouter initialEntries={["/screen-creation/canvas-test"]}>
                    <WorkspaceSidebarNav collapsed={false} onNavigate={noop} onOpenSearch={noop} onExpand={noop} onCollapse={noop} />
                </MemoryRouter>
            </App>,
        );
        const links = [...markup.matchAll(/<a\b([^>]*data-nav-id="([^"]+)"[^>]*)>/g)];
        const canvasIndex = links.findIndex((link) => link[2] === "canvas");
        expect(canvasIndex).toBeGreaterThanOrEqual(0);
        const screen = links[canvasIndex + 1];
        expect(screen?.[2]).toBe("screen-creation");
        expect(screen?.[1]).toContain('href="/screen-creation"');
        expect(screen?.[1]).toContain("is-active");
        snapshot.mockRestore();
        restoreUserSnapshot = undefined;
    }
});
