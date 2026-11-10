import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";
import type { DramaEpisodeDetail, DramaEpisodeRow, DramaSegment } from "@/services/api/drama";

const browser = new Window({ url: "http://localhost/projects/project/guide" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    SVGElement: browser.SVGElement,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

type TestButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & { icon?: ReactNode; loading?: boolean; size?: string; type?: string };
type TestSelectProps = { "aria-label"?: string; className?: string; value?: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void };
const empty = () => null;
mock.module("antd", () => ({
    Button: ({ children, icon, loading: _loading, size: _size, type: _type, ...props }: TestButtonProps) => (
        <button {...props}>
            {icon}
            {children}
        </button>
    ),
    Input: empty,
    InputNumber: empty,
    Select: ({ options, onChange, ...props }: TestSelectProps) => (
        <select {...props} onChange={(event) => onChange(event.target.value)}>
            {options.map((option) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </select>
    ),
}));
mock.module("@/components/cached-resource-image", () => ({ CachedResourceImage: empty }));
mock.module("@/components/ui/base/tooltip/ant-tooltip", () => ({ AntTooltip: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("@/pages/projects/asset-scheme", () => ({ AssetSchemePicker: empty }));
mock.module("@/components/ui/product/app-modal", () => ({ AppModal: empty }));
mock.module("@/pages/projects/drama-model-picker", () => ({ DramaModelPicker: empty, useDramaModelCatalog: empty }));
mock.module("@/pages/projects/step-settings", () => ({ DramaAssetImageModels: empty, DramaTextSteps: empty, VideoResolutionField: empty }));
mock.module("@/pages/projects/storyboard-rules", () => ({ EpisodeDurationInput: empty, StoryboardRules: empty }));
mock.module("@/pages/projects/style-picker", () => ({ DramaStylePicker: empty }));
mock.module("@/pages/projects/studio/segment-dialog", () => ({ ShotEditor: empty }));
mock.module("@/pages/projects/studio/use-studio", () => ({ dramaKeys: {} }));
const { GuideStory } = await import("@/pages/projects/guide-panels");
const { segmentState } = await import("@/pages/projects/studio/segment-parts");
type Props = ComponentProps<typeof GuideStory>;

afterAll(() => {
    browser.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function episode(id: string, number: number, stats: Partial<DramaEpisodeRow["stats"]> = {}): DramaEpisodeRow {
    return {
        id,
        number,
        title: `故事${number}`,
        synopsis: "",
        stage: "prompts",
        sourceFormat: "script",
        error: "",
        shotCount: 0,
        durationMs: 0,
        approved: false,
        mediaReleased: false,
        awaitingMedia: true,
        finalStale: false,
        stats: { segments: 0, promptReady: 0, promptSucceeded: 0, videoReady: 0, videoGenerated: 0, failed: 0, ...stats },
    };
}

function segment(id: string, index: number, patch: Partial<DramaSegment> = {}): DramaSegment {
    return {
        id,
        revision: 1,
        index,
        title: id,
        shotIds: [],
        durationMs: 5_000,
        videoPrompt: `${id}的提示词`,
        generated: `${id}的提示词`,
        custom: false,
        promptStatus: "ready",
        videoStatus: "",
        videoModel: { channelId: "", modelKey: "" },
        referenceMode: "auto",
        audioReferenceMode: "auto",
        request: { operation: "", seconds: 5, maxVideoSeconds: 10, aspectRatio: "16:9", generateAudio: false, firstFramePending: false, references: [], referenceCapacity: 0, modelMaxImages: 0, header: "" },
        ...patch,
    };
}

function detail(row: DramaEpisodeRow, segments: DramaSegment[]): DramaEpisodeDetail {
    return {
        episode: { ...row, projectId: "project", hook: "", cliffhanger: "", chapterIdsJson: "[]", subtitleSrt: "", revision: 1 },
        segments,
        shots: [],
        chapters: [],
        jobs: [],
    };
}

async function fixture(props: Pick<Props, "episodes" | "episodeId"> & Partial<Props>) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const calls = { reload: 0, retried: [] as string[], edited: [] as Array<[string, string]>, written: [] as Array<[string, string]> };
    let current: Props = {
        busy: false,
        loading: false,
        failed: false,
        onSelect: () => {},
        onReload: () => calls.reload++,
        onRescript: () => {},
        onRetryEpisode: (episodeId) => calls.retried.push(episodeId),
        onPatch: () => {},
        onEditPrompt: (item, episodeId) => calls.edited.push([item.id, episodeId]),
        onWritePrompt: (item, episodeId) => calls.written.push([item.id, episodeId]),
        ...props,
    };
    const render = async (patch: Partial<Props> = {}) => {
        current = { ...current, ...patch };
        await act(async () => root.render(<GuideStory {...current} />));
    };
    const dispose = async () => {
        await act(async () => root.unmount());
        host.remove();
    };
    try {
        await render();
        return { host, calls, render, dispose };
    } catch (cause) {
        await dispose();
        throw cause;
    }
}

function namedButton(host: Element, name: string) {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === name);
    expect(button, `未找到按钮：${name}`).toBeDefined();
    return button!;
}

async function selectStatus(host: HTMLElement, value: string) {
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="筛选段状态"]')!;
    await act(async () => {
        select.value = value;
        select.dispatchEvent(new browser.Event("change", { bubbles: true }));
    });
}

test("全部集保留已读取内容，失败集显示错误并可重试恢复", async () => {
    const first = episode("first", 1);
    const second = episode("second", 2);
    const loaded = detail(first, [segment("first-ready", 0)]);
    const stale = detail(second, [segment("old-second", 0)]);
    const ui = await fixture({ episodes: [first, second], episodeId: "all", details: [loaded, stale], failedEpisodeIds: [second.id] });
    try {
        expect(ui.host.textContent).toContain("first-ready");
        expect(ui.host.textContent).not.toContain("old-second");
        expect(ui.host.querySelector('[role="alert"]')!.textContent).toContain("本集内容暂时无法读取");
        expect(ui.host.querySelector('[role="alert"]')!.closest("section")!.textContent).toContain("第 2 集");
        expect(ui.host.textContent).not.toContain("正在读取剧本与分镜");
        await act(async () => namedButton(ui.host, "重新读取").click());
        expect(ui.calls.reload).toBe(1);
        await ui.render({ details: [loaded, detail(second, [segment("new-second", 0)])], failedEpisodeIds: [] });
        expect(ui.host.querySelector('[role="alert"]')).toBeNull();
        expect(ui.host.textContent).toContain("new-second");
    } finally {
        await ui.dispose();
    }
});

test("已有72段完成仍显示第9集剧本失败，全部集和单集均可定向重试", async () => {
    const finished = Array.from({ length: 8 }, (_, index) => episode(`episode-${index + 1}`, index + 1, { segments: 9, promptReady: 9, promptSucceeded: 9 }));
    const unfinished = { ...episode("episode-9", 9), stage: "script" as const, error: "分镜脚本解析失败：模型没有返回可解析的 JSON" };
    const failedDetail = detail(unfinished, []);
    const finishedDetails = finished.map((row) =>
        detail(
            row,
            Array.from({ length: 9 }, (_, index) => segment(`${row.id}-segment-${index}`, index)),
        ),
    );
    const ui = await fixture({ episodes: [...finished, unfinished], episodeId: "all", details: [...finishedDetails, failedDetail], loading: true });
    try {
        const progress = ui.host.querySelector(".drama-guide-story-progress")!;
        expect(progress.textContent).toContain("72/72 段已处理");
        expect(progress.textContent).toContain("8/9 集就绪");
        expect(progress.textContent).toContain("1 集剧本失败（第 9 集）");
        expect(progress.textContent).toContain("全部文字尚未完成");
        expect(progress.textContent).toContain("段进度仅统计已生成的剧情段");
        const failure = ui.host.querySelector(".drama-guide-story-episode-failure")!;
        expect(failure.textContent).toContain("第 9 集剧本与分镜生成失败");
        expect(failure.textContent).toContain(unfinished.error);
        expect(namedButton(failure, "重试本集剧本").disabled).toBe(false);
        await act(async () => namedButton(failure, "重试本集剧本").click());
        expect(ui.calls.retried).toEqual([unfinished.id]);
        expect(ui.calls.written).toEqual([]);

        await ui.render({ episodeId: unfinished.id, detail: failedDetail });
        expect(ui.host.querySelector('[aria-label="剧本与分镜进度"]')!.textContent).toContain("0/1 集就绪");
        expect(ui.host.textContent).toContain("1 集剧本失败（第 9 集）");
        expect(ui.host.querySelectorAll(".drama-guide-story-episode-failure")).toHaveLength(1);
        expect(ui.host.textContent).not.toContain("重新改编本集");
        await act(async () => namedButton(ui.host, "重试本集剧本").click());
        expect(ui.calls.retried).toEqual([unfinished.id, unfinished.id]);

        const recovered = { ...unfinished, stage: "prompts" as const, error: "", stats: { ...unfinished.stats, segments: 1, promptReady: 1, promptSucceeded: 1 } };
        await ui.render({ episodes: [...finished, recovered], detail: detail(recovered, [segment("recovered", 0)]), loading: false });
        expect(ui.host.querySelector(".drama-guide-story-episode-failure")).toBeNull();
        expect(ui.host.textContent).not.toContain("集剧本失败");
        expect(ui.host.textContent).toContain("1/1 集就绪");
    } finally {
        await ui.dispose();
    }
});

test("失败集保留已有段并可重试，只有本集排队运行或提交中禁用入口", async () => {
    const row = { ...episode("failed", 9), stage: "script" as const, error: "保存剧本结果失败" };
    const original = detail(row, [segment("saved-segment", 0)]);
    const ui = await fixture({ episodes: [row], episodeId: row.id, detail: original, loading: true });
    try {
        expect(ui.host.textContent).toContain("saved-segment");
        expect(namedButton(ui.host, "重试本集剧本").disabled).toBe(false);
        await act(async () => namedButton(ui.host, "重试本集剧本").click());
        expect(ui.calls.retried).toEqual([row.id]);
        const job = { id: "script", kind: "script" as const, status: "queued" as const, label: "改编本集", costMicrocredits: 0, attempt: 0, createdAt: "", updatedAt: "" };
        for (const status of ["queued", "running"] as const) {
            await ui.render({ detail: { ...original, scriptJob: { ...job, status } } });
            const retry = namedButton(ui.host, "本集剧本正在重试");
            expect(retry.disabled).toBe(true);
            await act(async () => retry.click());
            expect(ui.calls.retried).toEqual([row.id]);
            expect(ui.host.textContent).toContain("saved-segment");
        }
        await ui.render({ detail: original, busy: true });
        expect(namedButton(ui.host, "重试本集剧本").disabled).toBe(true);
    } finally {
        await ui.dispose();
    }
});

test("新内容不沿用历史剧本任务状态，当前错误仍可重试且清除错误后不再误报失败", async () => {
    const row = { ...episode("replaced", 9), stage: "review" as const };
    const current = detail(row, [segment("imported-storyboard", 0)]);
    const job = { id: "historical-script", kind: "script" as const, status: "failed" as const, label: "旧版改编", error: "旧版剧本解析失败", costMicrocredits: 0, attempt: 0, createdAt: "", updatedAt: "" };
    const ui = await fixture({ episodes: [row], episodeId: row.id, detail: { ...current, scriptJob: job } });
    try {
        for (const status of ["failed", "queued", "running"] as const) {
            const replaced = { ...current, scriptJob: { ...job, status } };
            await ui.render({ detail: replaced });
            expect(ui.host.textContent).toContain("剧本与分镜：1/1 集就绪");
            expect(ui.host.querySelector('[role="alert"]')).toBeNull();
            expect(ui.host.textContent).not.toContain("重试本集剧本");
            expect(namedButton(ui.host, "重新改编本集").disabled).toBe(false);
            expect(ui.host.textContent).toContain("imported-storyboard");

            if (status !== "failed") {
                await ui.render({ detail: { ...replaced, episode: { ...replaced.episode, error: "当前内容处理失败" } } });
                expect(namedButton(ui.host, "重试本集剧本").disabled).toBe(false);
            }
        }
        const restarting = { ...current, episode: { ...current.episode, stage: "script" as const }, scriptJob: job };
        await ui.render({ detail: restarting });
        expect(ui.host.textContent).toContain("1 集剧本尚未就绪");
        expect(ui.host.querySelector('[role="alert"]')).toBeNull();
        expect(ui.host.textContent).not.toContain("重试本集剧本");
    } finally {
        await ui.dispose();
    }
});

test("分批读取时用未加载集的独立成功统计，补齐详情不改变混合进度", async () => {
    const first = episode("first", 1, { segments: 2, promptReady: 1, promptSucceeded: 1, failed: 1 });
    const second = episode("second", 2, { segments: 9, promptReady: 6, promptSucceeded: 3, failed: 4 });
    const firstDetail = detail(first, [segment("ready-first", 0), segment("failed-first", 1, { promptStatus: "failed" })]);
    const secondDetail = detail(second, [
        segment("ready-second", 0),
        segment("custom-second", 1, { promptStatus: "stale", custom: true }),
        segment("video-ready", 2, { videoStatus: "ready" }),
        segment("prompt-failed", 3, { promptStatus: "failed" }),
        segment("video-failed", 4, { videoStatus: "failed" }),
        segment("both-failed", 5, { promptStatus: "failed", videoStatus: "failed", custom: true }),
        segment("custom-video-failed", 6, { promptStatus: "stale", custom: true, videoStatus: "failed" }),
        segment("running", 7, { promptStatus: "running" }),
        segment("stale", 8, { promptStatus: "stale" }),
    ]);
    const ui = await fixture({ episodes: [first, second], episodeId: "all", details: [firstDetail], loading: true });
    const checkProgress = () => {
        const progress = ui.host.querySelector(".drama-guide-story-progress")!;
        expect(progress.getAttribute("aria-label")).toBe("段提示词进度：已完成 4 段，失败 5 段，共 11 段");
        expect(progress.textContent).toContain("9/11 段已处理");
        expect(progress.textContent).toContain("2 段待处理");
        expect(progress.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("82");
        expect(parseFloat(progress.querySelector<HTMLElement>(".is-success[style]")!.style.width)).toBeCloseTo((4 / 11) * 100);
        expect(parseFloat(progress.querySelector<HTMLElement>(".is-failed[style]")!.style.width)).toBeCloseTo((5 / 11) * 100);
    };
    try {
        checkProgress();
        await ui.render({ details: [firstDetail, secondDetail], loading: false });
        checkProgress();
    } finally {
        await ui.dispose();
    }
});

test("全部集编辑和重新撰写携带真实集ID而非同名段下标", async () => {
    const first = episode("first", 1);
    const second = episode("second", 2);
    const ui = await fixture({ episodes: [first, second], episodeId: "all", details: [detail(first, [segment("same-index-first", 0)]), detail(second, [segment("same-index-second", 0)])] });
    try {
        const cards = ui.host.querySelectorAll(".drama-guide-segment");
        await act(async () => {
            namedButton(cards[1], "编辑").click();
            namedButton(cards[1], "重新撰写").click();
        });
        expect(ui.calls.edited).toEqual([["same-index-second", "second"]]);
        expect(ui.calls.written).toEqual([["same-index-second", "second"]]);
        expect(ui.host.textContent).not.toContain("重新改编本集");
        expect(ui.host.querySelector('select[aria-label="审阅集数"]')!.textContent).toContain("全部集（2 集）");
    } finally {
        await ui.dispose();
    }
});

test("不同失败段可连续重新撰写，仅排队或运行中的当前段禁止重复提交", async () => {
    const first = episode("first", 1);
    const second = episode("second", 2);
    const failedFirst = segment("failed-first", 0, { promptStatus: "failed" });
    const failedNext = segment("failed-next", 1, { promptStatus: "failed" });
    const failedOtherEpisode = segment("failed-other-episode", 0, { promptStatus: "failed" });
    const ui = await fixture({ episodes: [first, second], episodeId: "all", details: [detail(first, [failedFirst, failedNext]), detail(second, [failedOtherEpisode])] });
    const rewriteButtons = () => [...ui.host.querySelectorAll(".drama-guide-segment")].map((card) => namedButton(card, "重新撰写"));
    try {
        expect(rewriteButtons().map((button) => button.disabled)).toEqual([false, false, false]);
        await act(async () => rewriteButtons()[0].click());
        await ui.render({ details: [detail(first, [{ ...failedFirst, promptStatus: "queued" }, failedNext]), detail(second, [failedOtherEpisode])], loading: true });
        expect(rewriteButtons().map((button) => button.disabled)).toEqual([true, false, false]);
        await act(async () => {
            rewriteButtons()[0].click();
            rewriteButtons()[1].click();
        });
        expect(ui.calls.written).toEqual([
            ["failed-first", "first"],
            ["failed-next", "first"],
        ]);
        await ui.render({
            details: [
                detail(first, [
                    { ...failedFirst, promptStatus: "running" },
                    { ...failedNext, promptStatus: "queued" },
                ]),
                detail(second, [failedOtherEpisode]),
            ],
        });
        expect(rewriteButtons().map((button) => button.disabled)).toEqual([true, true, false]);
        await act(async () => {
            rewriteButtons()[0].click();
            rewriteButtons()[1].click();
            rewriteButtons()[2].click();
        });
        expect(ui.calls.written).toEqual([
            ["failed-first", "first"],
            ["failed-next", "first"],
            ["failed-other-episode", "second"],
        ]);
        expect(ui.calls.edited).toEqual([]);
    } finally {
        await ui.dispose();
    }
});

test("提示词已完成可在生成视频前筛出，切换集数重置筛选", async () => {
    const first = episode("first", 1);
    const second = episode("second", 2);
    const firstDetail = detail(first, [
        segment("ready", 0),
        segment("failed", 1, { promptStatus: "failed" }),
        segment("running", 2, { promptStatus: "running" }),
        segment("idle", 3, { promptStatus: "none" }),
        segment("stale", 4, { promptStatus: "stale" }),
    ]);
    const customRunning = segment("custom-running", 1, { custom: true, promptStatus: "running" });
    const customQueued = segment("custom-queued", 2, {
        custom: true,
        promptStatus: "queued",
        promptJob: { id: "queued-job", kind: "segment_prompt", status: "queued", label: "撰写段提示词", costMicrocredits: 0, attempt: 0, createdAt: "", updatedAt: "", wait: "等待账号额度：排队中" },
    });
    expect(segmentState(firstDetail.segments[0]).tone).toBe("idle");
    expect(segmentState(firstDetail.segments[0], "prompt").tone).toBe("ready");
    expect(segmentState(customRunning).tone).toBe("busy");
    expect(segmentState(customRunning, "prompt").tone).toBe("ready");
    expect(segmentState(customQueued).tone).toBe("blocked");
    expect(segmentState(customQueued, "prompt").tone).toBe("ready");
    const ui = await fixture({ episodes: [first, second], episodeId: "all", details: [firstDetail, detail(second, [segment("custom", 0, { custom: true, promptStatus: "stale" }), customRunning, customQueued])] });
    try {
        await selectStatus(ui.host, "ready");
        const cards = ui.host.querySelectorAll(".drama-guide-segment");
        expect(cards).toHaveLength(4);
        expect(cards[0].querySelector(".drama-sg-status.is-ready")!.textContent).toContain("提示词");
        expect(cards[1].textContent).toContain("custom");
        expect(cards[2].textContent).toContain("custom-running");
        expect(cards[3].textContent).toContain("custom-queued");
        for (const card of cards) expect(card.querySelector(".drama-sg-status.is-ready")!.textContent).toContain("提示词");
        expect(ui.host.querySelector(".drama-guide-story-progress")!.textContent).toContain("4 段已完成");
        await ui.render({ episodeId: first.id, detail: firstDetail });
        expect(ui.host.querySelector<HTMLSelectElement>('select[aria-label="筛选段状态"]')!.value).toBe("all");
        expect(ui.host.querySelectorAll(".drama-guide-segment")).toHaveLength(5);
    } finally {
        await ui.dispose();
    }
});
