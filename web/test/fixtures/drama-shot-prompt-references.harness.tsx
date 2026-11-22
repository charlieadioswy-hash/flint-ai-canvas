import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CanvasResourceReference } from "../../src/lib/canvas/canvas-resource-references";
import type { DramaCast, DramaShot } from "../../src/services/api/drama";
import type { DramaShotMediaConfig } from "../../src/services/api/drama-shot-media";

const dom = new Window({ url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "Element", "Node", "HTMLElement", "SVGElement", "HTMLTextAreaElement", "MutationObserver", "ResizeObserver"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom : dom[key] });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), getComputedStyle: dom.getComputedStyle.bind(dom) });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CanvasResourceMentionTextarea } = await import("../../src/components/canvas/canvas-resource-mention-textarea");
const { editableMentionTokenEndingAt, renderEditableContent, repairEditableMentionBoundaries, serializeEditableValue, setEditableSelection, splitMentionText } = await import("../../src/components/canvas/canvas-mention-editable");
const { buildShotPromptReferences, WorkflowShotPromptEditor } = await import("../../src/pages/projects/workflow-shot-prompt");
afterAll(() => dom.happyDOM.abort());

function reference(overrides: Partial<CanvasResourceReference> = {}): CanvasResourceReference {
    return { id: "hero", nodeId: "hero", kind: "image", label: "参考图1", title: "林晚", active: true, mentionToken: "参考图1", textAliases: ["林晚", "阿晚"], ...overrides };
}

function plainText(parts: ReturnType<typeof splitMentionText>) {
    return parts.map((part) => (part.type === "mention" ? part.token : part.text)).join("");
}

function cast(overrides: Partial<DramaCast> = {}): DramaCast {
    return {
        id: "hero",
        projectId: "project",
        kind: "character",
        name: "林晚",
        aliasesJson: '["阿晚"]',
        role: "主角",
        description: "沉着冷静",
        appearance: "长发，青衣",
        voiceInstructions: "",
        importance: 1,
        imageStatus: "",
        imageVersion: 0,
        locked: false,
        position: 0,
        ...overrides,
    };
}

function shot(overrides: Partial<DramaShot> = {}): DramaShot {
    return {
        id: "shot",
        projectId: "project",
        episodeId: "episode",
        position: 1,
        segmentIndex: 0,
        segmentTitle: "相遇",
        scene: "王府大厅",
        castIdsJson: "[]",
        lookCastIdsJson: "[]",
        propIdsJson: "[]",
        speaker: "",
        dialogue: "",
        action: "",
        shotSize: "近景",
        camera: "固定",
        transition: "",
        durationMs: 5000,
        imagePrompt: "",
        videoPrompt: "",
        sourceQuote: "",
        ...overrides,
    };
}

function mediaConfig(overrides: Partial<DramaShotMediaConfig> = {}): DramaShotMediaConfig {
    return { model: { channelId: "", modelKey: "" }, prompt: "", operation: "text_to_image", aspectRatio: "9:16", resolution: "720p", generateAudio: false, referenceResourceIds: [], ...overrides };
}

test("中文姓名紧接动作时识别引用并完整保留正文", () => {
    const prompt = "林晚推开门走进长廊，抬头看向窗外。";
    const parts = splitMentionText(prompt, [reference()]);
    expect(parts.filter((part) => part.type === "mention").map((part) => part.token)).toEqual(["林晚"]);
    expect(plainText(parts)).toBe(prompt);
    expect(parts.at(-1)).toEqual({ type: "text", text: "推开门走进长廊，抬头看向窗外。" });
});

test("角色别名保持命中的原文而不替换成规范名称或编号", () => {
    const prompt = "阿晚回头看向林晚，低声说：阿晚就在这里。";
    const parts = splitMentionText(prompt, [reference()]);
    expect(parts.filter((part) => part.type === "mention").map((part) => part.token)).toEqual(["阿晚", "林晚", "阿晚"]);
    expect(plainText(parts)).toBe(prompt);
    expect(plainText(parts)).not.toContain("参考图1");
});

test("重复姓名和对白逐处保留，不把相同引用去重或吞掉台词", () => {
    const prompt = "林晚说：“林晚，你听见了吗？”林晚又说：“我听见了，林晚。”";
    const parts = splitMentionText(prompt, [reference()]);
    expect(parts.filter((part) => part.type === "mention")).toHaveLength(4);
    expect(plainText(parts)).toBe(prompt);
    const editor = document.createElement("div");
    renderEditableContent(editor, prompt, [reference()]);
    expect(editor.querySelectorAll("[data-mention-token]")).toHaveLength(4);
    expect(serializeEditableValue(editor)).toBe(prompt);
});

test("同一位置优先完整的较长姓名，随后仍能识别较短姓名", () => {
    const prompt = "林晚晴看向林晚，林晚晴随后转身。";
    const longName = reference({ id: "hero-long", nodeId: "hero-long", title: "林晚晴", label: "参考图2", mentionToken: "参考图2", textAliases: ["林晚晴"] });
    const parts = splitMentionText(prompt, [reference(), longName]);
    expect(parts.filter((part) => part.type === "mention").map((part) => ({ token: part.token, id: part.reference.id }))).toEqual([
        { token: "林晚晴", id: "hero-long" },
        { token: "林晚", id: "hero" },
        { token: "林晚晴", id: "hero-long" },
    ]);
    expect(plainText(parts)).toBe(prompt);
});

test("自然文本胶囊不修补中文边界，也不被当作显式标签尾部", () => {
    const prompt = "阿晚走进房间。";
    const editor = document.createElement("div");
    renderEditableContent(editor, prompt, [reference()]);
    const chip = editor.querySelector<HTMLElement>("[data-mention-token]")!;
    expect(chip.dataset.mentionToken).toBe("阿晚");
    expect(chip.dataset.mentionPlainText).toBe("true");
    expect(repairEditableMentionBoundaries(editor)).toBe(false);
    expect(editableMentionTokenEndingAt(editor, "阿晚".length)).toBeNull();
    expect(serializeEditableValue(editor)).toBe(prompt);
});

test("显式名称标签仍在后续文字粘连时补充边界", () => {
    const editor = document.createElement("div");
    renderEditableContent(editor, "@cat", [reference({ label: "cat", mentionToken: "@cat", textAliases: [] })]);
    editor.append(document.createTextNode("走进房间"));
    expect(editableMentionTokenEndingAt(editor, "@cat".length)).toBe("@cat");
    expect(repairEditableMentionBoundaries(editor)).toBe(true);
    expect(serializeEditableValue(editor)).toBe("@cat 走进房间");
});

test("真实编辑器在自然姓名胶囊后粘贴中文时不插入空格", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const writes: string[] = [];
    const references = [reference()];
    const render = (value: string) =>
        root.render(
            <CanvasResourceMentionTextarea
                value={value}
                references={references}
                onChange={(next) => {
                    writes.push(next);
                    render(next);
                }}
                aria-label="镜头提示词"
            />,
        );
    try {
        await act(async () => render("林晚"));
        const editor = host.querySelector<HTMLElement>('[role="textbox"]')!;
        expect(editor.querySelector<HTMLElement>("[data-mention-token]")?.dataset.mentionPlainText).toBe("true");
        await act(async () => {
            editor.focus();
            setEditableSelection(editor, "林晚".length);
            const paste = new dom.Event("paste", { bubbles: true, cancelable: true });
            Object.defineProperty(paste, "clipboardData", { value: { getData: () => "走进房间" } });
            editor.dispatchEvent(paste);
        });
        expect(writes.at(-1)).toBe("林晚走进房间");
        expect(serializeEditableValue(editor)).toBe("林晚走进房间");
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

test("没有图片的角色、场景和道具仍可按名称引用且不占参考图编号", () => {
    const casts = [cast(), cast({ id: "hall", kind: "scene", name: "王府大厅", aliasesJson: '["大厅"]' }), cast({ id: "sword", kind: "prop", name: "青铜剑", aliasesJson: "[]" }), cast({ id: "unrelated", name: "无关角色", aliasesJson: "[]" })];
    const references = buildShotPromptReferences(shot({ castIdsJson: '["hero"]', sceneCastId: "hall", propIdsJson: '["sword"]' }), casts, mediaConfig(), "image");
    expect(references.map((item) => item.mentionToken)).toEqual(["林晚", "王府大厅", "青铜剑"]);
    expect(references.every((item) => item.active && !item.storageKey && item.title.includes("未生成图片"))).toBe(true);
    const prompt = "林晚走进王府大厅拿起青铜剑。";
    const parts = splitMentionText(prompt, references);
    expect(parts.filter((part) => part.type === "mention").map((part) => part.token)).toEqual(["林晚", "王府大厅", "青铜剑"]);
    expect(plainText(parts)).toBe(prompt);
    expect(references.some((item) => item.label.startsWith("参考图"))).toBe(false);
});

test("单字资产经真实引用菜单插入后，序列化与重新载入都保留显式引用", async () => {
    const currentShot = shot({ propIdsJson: '["sword"]' });
    const casts = [cast({ id: "sword", kind: "prop", name: "剑", aliasesJson: "[]" })];
    const references = buildShotPromptReferences(currentShot, casts, mediaConfig(), "image");
    expect(splitMentionText("握剑前行。", references).filter((part) => part.type === "mention")).toHaveLength(0);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const actions: { current: import("../../src/components/canvas/canvas-resource-mention-textarea").CanvasResourceMentionTextareaActions | null } = { current: null };
    let saved = "";
    const render = (value: string, key = "editing") =>
        root.render(
            <CanvasResourceMentionTextarea
                key={key}
                actionsRef={actions}
                value={value}
                references={references}
                onChange={(next) => {
                    saved = next;
                    render(next);
                }}
                aria-label="单字资产提示词"
            />,
        );
    try {
        await act(async () => render(""));
        await act(async () => {
            actions.current?.focus();
            actions.current?.insertTextAtSelection("@");
        });
        const menu = document.querySelector<HTMLElement>("[data-canvas-resource-mention-menu]")!;
        expect(menu).not.toBeNull();
        const candidate = Array.from(menu.querySelectorAll<HTMLButtonElement>(".canvas-resource-mention-item")).find((item) => item.textContent?.includes("剑"))!;
        expect(candidate).toBeDefined();
        await act(async () => candidate.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, cancelable: true })));
        const editor = host.querySelector<HTMLElement>('[role="textbox"]')!;
        expect(saved).toBe("@剑 ");
        expect(editor.querySelector<HTMLElement>("[data-mention-reference-id]")?.dataset.mentionReferenceId).toBe("shot-cast:sword");
        expect(serializeEditableValue(editor)).toBe(saved);
        await act(async () => render(saved, "reloaded"));
        const reloaded = host.querySelector<HTMLElement>('[role="textbox"]')!;
        expect(reloaded.querySelector<HTMLElement>("[data-mention-reference-id]")?.dataset.mentionReferenceId).toBe("shot-cast:sword");
        expect(serializeEditableValue(reloaded)).toBe(saved);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

test("同名资产和共用别名跳过自然文本识别，保留可区分的显式候选", () => {
    const references = buildShotPromptReferences(shot({ castIdsJson: '["hero","other"]' }), [cast(), cast({ id: "other" })], mediaConfig(), "image");
    expect(references).toHaveLength(2);
    expect(new Set(references.map((item) => item.label)).size).toBe(2);
    expect(references.every((item) => !item.textAliases?.includes("林晚") && !item.textAliases?.includes("阿晚"))).toBe(true);
    const prompt = "林晚回头叫阿晚，两人同时应声。";
    const parts = splitMentionText(prompt, references);
    expect(parts.filter((part) => part.type === "mention")).toHaveLength(0);
    expect(plainText(parts)).toBe(prompt);
});

test("资产名称与其他主体别名冲突时，带冒号的对白也不自动绑定", () => {
    const references = buildShotPromptReferences(shot({ castIdsJson: '["hero","other"]' }), [cast({ name: "苏晚", aliasesJson: "[]" }), cast({ id: "other", name: "苏晴", aliasesJson: '["苏晚"]' })], mediaConfig(), "image");
    expect(references.every((item) => !item.textAliases?.includes("苏晚"))).toBe(true);
    const prompt = "苏晚：别过来。";
    const parts = splitMentionText(prompt, references);
    expect(parts.filter((part) => part.type === "mention")).toHaveLength(0);
    expect(plainText(parts)).toBe(prompt);
});

test("镜头当前造型优先于父角色，姓名引用指向已选造型", () => {
    const currentLook = cast({ id: "hero-banquet", parentId: "hero", lookName: "晚宴", imageResourceId: "banquet-image" });
    const unusedLook = cast({ id: "hero-journey", parentId: "hero", lookName: "远行", imageResourceId: "journey-image" });
    const references = buildShotPromptReferences(shot({ castIdsJson: '["hero"]', lookCastIdsJson: '["hero-banquet"]' }), [cast({ imageResourceId: "base-image" }), currentLook, unusedLook], mediaConfig(), "image");
    expect(references).toHaveLength(1);
    expect(references[0].label).toBe("林晚 · 晚宴");
    expect(references[0].storageKey).toBe("resource:banquet-image");
    expect(references[0].title).toContain("未附图，按文字设定");
    const parts = splitMentionText("林晚端起酒杯。", references);
    expect(parts.filter((part) => part.type === "mention").map((part) => part.reference.id)).toEqual(["shot-cast:hero-banquet"]);
    expect(plainText(parts)).toBe("林晚端起酒杯。");
});

test("参考图编号只遵循当前附件顺序，并保留资源名称与正文", () => {
    const config = mediaConfig({ referenceResourceIds: ["background", "hero-image"], referenceNames: { background: "雨夜街道" } });
    const references = buildShotPromptReferences(shot(), [cast({ imageResourceId: "hero-image" })], config, "image");
    const images = references.filter((item) => item.label.startsWith("参考图"));
    expect(images.map((item) => ({ token: item.mentionToken, storageKey: item.storageKey, title: item.title }))).toEqual([
        { token: "@[shot-image:background]", storageKey: "resource:background", title: "雨夜街道" },
        { token: "@[shot-image:hero-image]", storageKey: "resource:hero-image", title: "林晚" },
    ]);
    const prompt = "参考图1作为背景，参考图2人物从左侧走入，保留参考图10原文。";
    const parts = splitMentionText(prompt, references);
    expect(parts.filter((part) => part.type === "mention").map((part) => part.token)).toEqual(["参考图1", "参考图2"]);
    expect(plainText(parts)).toBe(prompt);
});

test("单镜已有稿中的资产名保留原文，同一个附图在括号中只显示一次资产引用", () => {
    const prompt = "【本镜参考图】\n林晚（参考图1）：推门。\n王府大厅 (@[shot-image:hall-view])：暖光。\n构图（参考图3）：独立上传。";
    const config = mediaConfig({ prompt, referenceResourceIds: ["hero-image", "hall-view", "upload"], referenceSubjects: { "hall-view": "hall" } });
    const references = buildShotPromptReferences(shot({ castIdsJson: '["hero"]', sceneCastId: "hall" }), [cast({ imageResourceId: "hero-image" }), cast({ id: "hall", kind: "scene", name: "王府大厅", imageResourceId: "hall-current" })], config, "video");
    const editor = document.createElement("div");
    renderEditableContent(editor, prompt, references);
    const chips = Array.from(editor.querySelectorAll<HTMLElement>("[data-mention-reference-id]"));
    expect(chips.map((chip) => [chip.dataset.mentionReferenceId, chip.querySelector(".canvas-resource-inline-label")?.textContent])).toEqual([
        ["shot-ref:hero-image", "林晚"],
        ["shot-ref:hall-view", "王府大厅"],
        ["shot-ref:upload", "参考图3"],
    ]);
    const precedingText = (chip: HTMLElement) => chip.previousSibling?.textContent?.replace(/\u200b/g, "") || chip.previousSibling?.previousSibling?.textContent;
    expect(precedingText(chips[0])).toEndWith("林晚（");
    expect(precedingText(chips[1])).toEndWith("王府大厅 (");
    expect(serializeEditableValue(editor)).toBe(prompt);

    const reordered = { ...config, prompt: "王府大厅（@[shot-image:hall-view]），林晚（参考图 3）。", referenceResourceIds: ["upload", "hall-view", "hero-image"] };
    const reorderedReferences = buildShotPromptReferences(shot(), [cast({ imageResourceId: "hero-image" }), cast({ id: "hall", kind: "scene", name: "王府大厅" })], reordered, "video");
    renderEditableContent(editor, reordered.prompt, reorderedReferences);
    expect(Array.from(editor.querySelectorAll<HTMLElement>("[data-mention-reference-id]"), (chip) => chip.dataset.mentionReferenceId)).toEqual(["shot-ref:hall-view", "shot-ref:hero-image"]);
    expect(serializeEditableValue(editor)).toBe(reordered.prompt);
});

test("同名角色或同一角色的不同附图各自保留可区分的单个引用", () => {
    const prompt = "林晚（参考图1）望向林晚（参考图2）；林晚（@[shot-image:hero-view]）的侧脸，背景（参考图4）。";
    const config = mediaConfig({
        prompt,
        referenceResourceIds: ["hero-image", "other-image", "hero-view", "background"],
        referenceSubjects: { "hero-image": "hero", "other-image": "other", "hero-view": "hero" },
    });
    const references = buildShotPromptReferences(shot({ castIdsJson: '["hero","other"]' }), [cast(), cast({ id: "other" })], config, "image");
    const editor = document.createElement("div");
    renderEditableContent(editor, prompt, references);
    const chips = Array.from(editor.querySelectorAll<HTMLElement>("[data-mention-reference-id]"));
    expect(chips.map((chip) => [chip.dataset.mentionReferenceId, chip.querySelector(".canvas-resource-inline-label")?.textContent])).toEqual([
        ["shot-ref:hero-image", "林晚 · 参考图1"],
        ["shot-ref:other-image", "林晚 · 参考图2"],
        ["shot-ref:hero-view", "林晚 · 参考图3"],
        ["shot-ref:background", "参考图4"],
    ]);
    expect(new Set(chips.slice(0, 3).map((chip) => chip.title)).size).toBe(3);
    expect(serializeEditableValue(editor)).toBe(prompt);
});

test("真实图片引用菜单插入稳定身份，删除前图和重新载入都不改绑", async () => {
    const currentShot = shot();
    let config = mediaConfig({ referenceResourceIds: ["background", "hero-image"], referenceNames: { background: "雨夜街道", "hero-image": "人物图片" } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const actions: { current: import("../../src/components/canvas/canvas-resource-mention-textarea").CanvasResourceMentionTextareaActions | null } = { current: null };
    let saved = "";
    const render = (value: string, key = "editing") =>
        root.render(
            <CanvasResourceMentionTextarea
                key={key}
                actionsRef={actions}
                value={value}
                references={buildShotPromptReferences(currentShot, [], { ...config, prompt: value }, "image")}
                onChange={(next) => {
                    saved = next;
                    render(next);
                }}
                aria-label="图片引用提示词"
            />,
        );
    try {
        await act(async () => render(""));
        await act(async () => {
            actions.current?.focus();
            actions.current?.insertTextAtSelection("@");
        });
        const menu = document.querySelector<HTMLElement>("[data-canvas-resource-mention-menu]")!;
        const candidate = Array.from(menu.querySelectorAll<HTMLButtonElement>(".canvas-resource-mention-item")).find((item) => item.textContent?.includes("参考图2"))!;
        expect(candidate).toBeDefined();
        await act(async () => candidate.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, cancelable: true })));
        expect(saved).toBe("@[shot-image:hero-image] ");
        config = { ...config, referenceResourceIds: ["hero-image"] };
        await act(async () => render(saved, "reloaded"));
        const editor = host.querySelector<HTMLElement>('[role="textbox"]')!;
        const chip = editor.querySelector<HTMLElement>("[data-mention-reference-id]")!;
        expect(chip.dataset.mentionReferenceId).toBe("shot-ref:hero-image");
        expect(chip.querySelector(".canvas-resource-inline-label")?.textContent).toBe("参考图1");
        expect(serializeEditableValue(editor)).toBe(saved);
        config = { ...config, referenceResourceIds: ["background"] };
        await act(async () => render(saved));
        const missing = host.querySelector<HTMLElement>('[data-mention-reference-id="shot-ref:hero-image"]')!;
        expect(missing.querySelector(".canvas-resource-inline-label")?.textContent).toBe("已移除图片");
        expect(missing.textContent).not.toContain("hero-image");
        expect(serializeEditableValue(host.querySelector<HTMLElement>('[role="textbox"]')!)).toBe(saved);
        await act(async () => {
            actions.current?.focus();
            actions.current?.insertTextAtSelection("@");
        });
        const available = document.querySelector<HTMLElement>("[data-canvas-resource-mention-menu]")!;
        expect(available).not.toBeNull();
        expect(available.textContent).not.toContain("已移除图片");
        expect(available.textContent).toContain("参考图1");
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

test.each(["history-image", "view-image", "cropped-image"])("%s 保留主体身份、附图状态和真实图片预览", (imageId) => {
    const config = mediaConfig({ referenceResourceIds: [imageId], referenceSubjects: { [imageId]: "hero" } });
    const references = buildShotPromptReferences(shot(), [cast({ imageResourceId: "current-image" })], config, "video");
    const subject = references.find((reference) => reference.id === "shot-cast:hero")!;
    expect(subject).toBeDefined();
    expect(subject.title).toContain("已附图");
    expect(subject.storageKey).toBe(`resource:${imageId}`);
    expect(references.find((reference) => reference.id === `shot-ref:${imageId}`)?.title).toBe("林晚");
    expect(splitMentionText("林晚回头。", references).find((part) => part.type === "mention")?.reference.id).toBe("shot-cast:hero");
});

test("映射到已选造型的历史图继续排除父角色", () => {
    const config = mediaConfig({ referenceResourceIds: ["look-history"], referenceSubjects: { "look-history": "hero-look" } });
    const references = buildShotPromptReferences(
        shot({ castIdsJson: '["hero"]', lookCastIdsJson: '["hero-look"]' }),
        [cast({ imageResourceId: "base-image" }), cast({ id: "hero-look", parentId: "hero", lookName: "晚宴", imageResourceId: "look-current" })],
        config,
        "image",
    );
    expect(references.filter((reference) => reference.id.startsWith("shot-cast:")).map((reference) => reference.id)).toEqual(["shot-cast:hero-look"]);
    expect(references.find((reference) => reference.id === "shot-cast:hero-look")?.storageKey).toBe("resource:look-history");
});

test("镜头提示词显示缺失图片警告，手动输入立即标记为手工草稿", async () => {
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { WorkflowShotPromptEditor } = await import("../../src/pages/projects/workflow-shot-prompt");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["drama-shot-reference-cast", "user", "project"], { cast: [] });
    const config = mediaConfig({ prompt: "@[shot-image:removed-image] 保持原构图", promptSourceHash: "automatic-hash" });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const writes: Partial<DramaShotMediaConfig>[] = [];
    try {
        await act(async () => {
            root.render(
                <QueryClientProvider client={queryClient}>
                    <WorkflowShotPromptEditor projectId="project" userId="user" shot={shot()} kind="image" config={config} disabled={false} onChange={(patch) => writes.push(patch)} />
                </QueryClientProvider>,
            );
        });
        expect(host.querySelector('[role="alert"]')?.textContent).toContain("图片已移除");
        expect(host.querySelector(".canvas-resource-inline-label")?.textContent).toBe("已移除图片");
        expect(writes).toHaveLength(0);
        const editor = host.querySelector<HTMLElement>('[role="textbox"]')!;
        await act(async () => {
            editor.focus();
            editor.append(document.createTextNode("，背景更暗"));
            setEditableSelection(editor, config.prompt.length + "，背景更暗".length);
            editor.dispatchEvent(new dom.InputEvent("input", { bubbles: true, inputType: "insertText", data: "，背景更暗" }));
        });
        expect(writes.at(-1)).toEqual({ prompt: `${config.prompt}，背景更暗`, promptSourceHash: "" });
    } finally {
        await act(async () => root.unmount());
        queryClient.clear();
        host.remove();
    }
});

test("图生视频仅以首帧尾帧表达附件，不把参考图列表混入帧语义", () => {
    const config = mediaConfig({
        operation: "image_to_video",
        firstFrameResourceId: "opening",
        lastFrameResourceId: "closing",
        referenceResourceIds: ["ignored-reference"],
        referenceNames: { opening: "开场画面", closing: "收束画面" },
    });
    const references = buildShotPromptReferences(shot(), [], config, "video");
    expect(references.map((item) => ({ token: item.mentionToken, storageKey: item.storageKey, title: item.title }))).toEqual([
        { token: "首帧", storageKey: "resource:opening", title: "首帧 · 开场画面" },
        { token: "尾帧", storageKey: "resource:closing", title: "尾帧 · 收束画面" },
    ]);
    expect(references.some((item) => item.storageKey === "resource:ignored-reference")).toBe(false);
    const lastOnly = buildShotPromptReferences(shot(), [], { ...config, firstFrameResourceId: "" }, "video");
    expect(lastOnly.map((item) => item.mentionToken)).toEqual(["尾帧"]);
    const sharedFrame = buildShotPromptReferences(shot(), [], { ...config, lastFrameResourceId: "opening" }, "video");
    expect(sharedFrame.map((item) => ({ id: item.id, token: item.mentionToken, storageKey: item.storageKey }))).toEqual([
        { id: "shot-frame:first", token: "首帧", storageKey: "resource:opening" },
        { id: "shot-frame:last", token: "尾帧", storageKey: "resource:opening" },
    ]);
});
