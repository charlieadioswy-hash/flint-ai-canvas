import { describe, expect, test } from "bun:test";

import {
    activeDramaGuide,
    dramaGuideChange,
    dramaGuideChangesConflict,
    dramaGuideProposal,
    dramaGuideSetupChange,
    dramaProjectPath,
    dramaProposalKey,
    rebaseDramaGuideSettingsDraft,
    type DramaGuideChange,
    type DramaGuideProposalBatch,
} from "../src/pages/projects/guide-state";
import type { DramaAgentProposal } from "../src/services/api/agent";
import type { DramaSettings } from "../src/services/api/drama";

const proposal = (patch: Partial<DramaAgentProposal> = {}): DramaAgentProposal => ({ kind: "setup", baseRevision: 8, changes: { language: "粤语" }, runId: "run-1", toolCallId: "call-1", ...patch });

describe("guided drama route recovery", () => {
    test("only an explicit active guide opens the guide route", () => {
        expect(activeDramaGuide(undefined)).toBe(false);
        expect(dramaProjectPath("manual-project")).toBe("/projects/manual-project");
        expect(dramaProjectPath("auto-project", "")).toBe("/projects/auto-project");
        for (const step of ["configuring", "assets", "story"] as const) expect(dramaProjectPath("guided", step)).toBe("/projects/guided/guide");
    });

    test("completed guides return to the existing studio", () => {
        expect(activeDramaGuide("completed")).toBe(false);
        expect(dramaProjectPath("guided", "completed")).toBe("/projects/guided");
    });
});

describe("same-run drama proposal continuation", () => {
    const setup = (patch: Partial<DramaSettings>): DramaGuideChange => ({ kind: "setup", patch });
    const source: DramaGuideChange = { kind: "source", chapters: [{ title: "第一章", text: "正文" }] };
    const cast = (targetId: string, name?: string): DramaGuideChange => ({ kind: "cast", targetId, assetKind: "character", patch: name ? { name } : { appearance: "红衣" } });
    const create = (name: string, kind: "character" | "scene" = "character"): DramaGuideChange => ({ kind: "cast_create", input: { kind, name } });

    test("only the exact same run, original revision and verified step can continue", () => {
        const batches: DramaGuideProposalBatch[] = [{ runId: "run-1", baseRevision: 8, currentRevision: 9, step: "configuring", appliedChanges: [source] }];
        expect(dramaGuideProposal(proposal(), "configuring", 9, batches)?.revision).toBe(9);
        expect(proposal().baseRevision).toBe(8);
        expect(dramaGuideProposal(proposal({ runId: "other" }), "configuring", 9, batches)).toBeNull();
        expect(dramaGuideProposal(proposal({ baseRevision: 7 }), "configuring", 9, batches)).toBeNull();
        expect(dramaGuideProposal(proposal(), "configuring", 10, batches)).toBeNull();
        expect(dramaGuideProposal(proposal(), "assets", 9, batches)).toBeNull();
        expect(dramaGuideProposal(proposal(), "configuring", 8, [{ ...batches[0], currentRevision: null }])).toBeNull();
    });

    test("source and independent setup fields continue, related style and frame fields conflict", () => {
        expect(dramaGuideChangesConflict(source, setup({ language: "粤语" }))).toBe(false);
        expect(dramaGuideChangesConflict(setup({ language: "粤语" }), source)).toBe(false);
        expect(dramaGuideChangesConflict(source, source)).toBe(true);
        expect(dramaGuideChangesConflict(setup({ language: "粤语" }), setup({ episodeSeconds: 120 }))).toBe(false);
        expect(dramaGuideChangesConflict(setup({ styleName: "电影" }), setup({ stylePrompt: "冷色" }))).toBe(true);
        expect(dramaGuideChangesConflict(setup({ aspectRatio: "9:16" }), setup({ videoResolution: "1080p" }))).toBe(true);
    });

    test("asset, shot and segment conflict ranges remain conservative", () => {
        expect(dramaGuideChangesConflict(cast("a"), cast("b"))).toBe(false);
        expect(dramaGuideChangesConflict(cast("a"), { kind: "cast_delete", targetId: "a", reason: "重复" })).toBe(true);
        expect(dramaGuideChangesConflict(create(" Ａ 青 "), create("a 青"))).toBe(true);
        expect(dramaGuideChangesConflict(create("小青"), create("小青", "scene"))).toBe(false);
        expect(dramaGuideChangesConflict(create("小青"), cast("a", " 小青 "))).toBe(true);
        expect(dramaGuideChangesConflict(cast("a", "小青"), create("小青"))).toBe(true);
        expect(dramaGuideChangesConflict(cast("a", "小青"), cast("b", " 小青 "))).toBe(true);
        const shot: DramaGuideChange = { kind: "shot", targetId: "a", patch: { dialogue: "你好" } };
        const segment: DramaGuideChange = { kind: "segment_prompt", targetId: "a", prompt: "提示词" };
        expect(dramaGuideChangesConflict(shot, { ...shot, targetId: "b" })).toBe(false);
        expect(dramaGuideChangesConflict(shot, shot)).toBe(true);
        expect(dramaGuideChangesConflict(segment, { ...segment, targetId: "b" })).toBe(false);
        expect(dramaGuideChangesConflict(segment, segment)).toBe(true);
        expect(dramaGuideChangesConflict(shot, segment)).toBe(true);
        expect(dramaGuideChangesConflict(cast("a"), shot)).toBe(true);
        expect(dramaGuideChangesConflict(cast("a"), segment)).toBe(true);
    });

    test("adjusted setup uses final whitelisted differences and excludes advanced edits", () => {
        const before = { language: "中文", videoResolution: "720p", models: {}, mediaMode: "manual" } as DramaSettings;
        expect(dramaGuideSetupChange(before, { ...before, language: "粤语" })).toEqual(setup({ language: "粤语" }));
        expect(dramaGuideSetupChange(before, before)).toEqual(setup({}));
        expect(dramaGuideSetupChange(before, { ...before, models: { video: { modelKey: "other" } } })).toBeNull();
    });
});

describe("rebasing manual drama settings after a direct choice", () => {
    const baseline = {
        aspectRatio: "9:16",
        videoResolution: "720p",
        styleName: "写实",
        stylePrompt: "自然光",
        language: "中文普通话",
        episodeSeconds: 90,
        mediaMode: "manual",
        models: { video: { modelKey: "original-video" } },
        assets: { characterPrompt: "原有角色描述" },
        concurrency: 2,
    } as DramaSettings;

    test("keeps unrelated manual and nested edits while accepting the saved choice and fresh server fields", () => {
        const draft = { ...baseline, aspectRatio: "16:9", assets: { ...baseline.assets, characterPrompt: "手动角色描述" }, models: { video: { modelKey: "manual-video" } } };
        const saved = { ...baseline, language: "粤语", concurrency: 4 };
        expect(rebaseDramaGuideSettingsDraft(baseline, draft, saved, { language: "粤语" })).toEqual({ ...saved, aspectRatio: "16:9", assets: draft.assets, models: draft.models });
        expect(saved.assets.characterPrompt).toBe("原有角色描述");
        expect(draft.language).toBe("中文普通话");
    });

    test("choosing either style field replaces both style drafts but preserves an unrelated language draft", () => {
        const draft = { ...baseline, styleName: "手动风格", stylePrompt: "手动光影", language: "英语" };
        const saved = { ...baseline, styleName: "电影风格" };
        expect(rebaseDramaGuideSettingsDraft(baseline, draft, saved, { styleName: "电影风格" })).toEqual({ ...saved, language: "英语" });
        const savedPrompt = { ...baseline, stylePrompt: "水墨线条" };
        expect(rebaseDramaGuideSettingsDraft(baseline, draft, savedPrompt, { stylePrompt: "水墨线条" })).toEqual({ ...savedPrompt, language: "英语" });
    });

    test("choosing either frame field replaces both ratio and resolution drafts", () => {
        const draft = { ...baseline, aspectRatio: "16:9", videoResolution: "1080p", episodeSeconds: 120 };
        for (const chosen of [{ videoResolution: "480p" }, { aspectRatio: "1:1" }]) {
            const saved = { ...baseline, ...chosen };
            expect(rebaseDramaGuideSettingsDraft(baseline, draft, saved, chosen)).toEqual({ ...saved, episodeSeconds: 120 });
        }
    });

    test("clears drafts when no remaining differences exist, including selected fields already matching the server", () => {
        const chosen = { language: "粤语" };
        const saved = { ...baseline, ...chosen };
        expect(rebaseDramaGuideSettingsDraft(baseline, baseline, saved, chosen)).toBeNull();
        expect(rebaseDramaGuideSettingsDraft(baseline, { ...baseline, ...chosen }, saved, chosen)).toBeNull();
        expect(rebaseDramaGuideSettingsDraft(baseline, { ...baseline, episodeSeconds: 120 }, { ...saved, episodeSeconds: 120 }, chosen)).toBeNull();
    });
});

describe("drama Agent suggestions", () => {
    test("replayed tool calls have a stable identity", () => {
        expect(dramaProposalKey(proposal())).toBe(dramaProposalKey(proposal({ changes: { language: "英语" } })));
        expect(dramaProposalKey(proposal({ toolCallId: "call-2" }))).not.toBe(dramaProposalKey(proposal()));
    });

    test("stale suggestions cannot overwrite newer edits", () => {
        expect(dramaGuideChange(proposal(), "configuring", 9)).toBeNull();
        expect(dramaGuideChange(proposal({ kind: "cast", targetId: "cast-1", changes: { appearance: "红衣" } }), "assets", 9)).toBeNull();
    });

    test("setup suggestions cannot enable media or advance a stage", () => {
        const result = dramaGuideChange(proposal({ changes: { language: "粤语", mediaMode: "auto", guideStep: "completed", models: { text: {} } } }), "configuring", 8);
        expect(result).toEqual({ kind: "setup", patch: { language: "粤语" } });
        expect(dramaGuideChange(proposal(), "assets", 8)).toBeNull();
        expect(dramaGuideChange(proposal(), "completed", 8)).toBeNull();
    });

    test("source suggestions require actual chapter text and the configuration stage", () => {
        const input = proposal({ kind: "source", changes: { chapters: [{ title: "第一章", text: "完整故事正文" }], sourceFormat: "script" } });
        expect(dramaGuideChange(input, "configuring", 8)).toEqual({ kind: "source", chapters: [{ title: "第一章", text: "完整故事正文" }], sourceFormat: "script" });
        expect(dramaGuideChange(input, "story", 8)).toBeNull();
        expect(dramaGuideChange(proposal({ kind: "source", changes: { chapters: [{ title: "第一章", text: " " }] } }), "configuring", 8)).toBeNull();
        expect(dramaGuideChange(proposal({ kind: "source", changes: { chapters: [null] } }), "configuring", 8)).toBeNull();
    });

    test("cast suggestions allow textual aliases but exclude media writes", () => {
        const input = proposal({ kind: "cast", targetId: "cast-1", changes: { aliases: ["阿青"], imageResourceId: "image-1", locked: true } });
        expect(dramaGuideChange(input, "story", 8)).toEqual({ kind: "cast", targetId: "cast-1", patch: { aliases: ["阿青"] } });
        expect(dramaGuideChange({ ...input, changes: { aliases: [1] } }, "assets", 8)).toBeNull();
        expect(dramaGuideChange({ ...input, targetId: undefined }, "assets", 8)).toBeNull();
    });

    test("new asset suggestions accept existing asset kinds and only save textual settings", () => {
        for (const kind of ["character", "prop", "scene"]) {
            const input = proposal({ kind: "cast_create", changes: { kind, name: " 新资产 ", aliases: ["别名"], appearance: "文字外观", description: "文字描述", voiceInstructions: "温和", imageResourceId: "image-1", generate: true, locked: true } });
            expect(dramaGuideChange(input, "assets", 8)).toEqual({ kind: "cast_create", input: { kind, name: "新资产", aliases: ["别名"], appearance: "文字外观", description: "文字描述", voiceInstructions: "温和" } });
            expect(dramaGuideChange(input, "story", 8)?.kind).toBe("cast_create");
            expect(dramaGuideChange(input, "configuring", 8)).toBeNull();
            expect(dramaGuideChange(input, "completed", 8)).toBeNull();
            expect(dramaGuideChange(input, "assets", 9)).toBeNull();
        }
    });

    test("new assets require a supported kind, a name and valid textual aliases", () => {
        const input = proposal({ kind: "cast_create", changes: { kind: "character", name: "小青" } });
        for (const changes of [{ name: "小青" }, { kind: "environment", name: "山林" }, { kind: "character", name: " " }, { kind: "character", name: "小青", aliases: [1] }]) expect(dramaGuideChange({ ...input, changes }, "assets", 8)).toBeNull();
    });

    test("deletion suggestions require a target, a reason, the current revision and an editable asset step", () => {
        const input = proposal({ kind: "cast_delete", targetId: "cast-1", changes: { reason: " 与其他角色重复 ", deleteMedia: true } });
        expect(dramaGuideChange(input, "assets", 8)).toEqual({ kind: "cast_delete", targetId: "cast-1", reason: "与其他角色重复" });
        expect(dramaGuideChange(input, "story", 8)?.kind).toBe("cast_delete");
        expect(dramaGuideChange(input, "configuring", 8)).toBeNull();
        expect(dramaGuideChange(input, "completed", 8)).toBeNull();
        expect(dramaGuideChange(input, "assets", 9)).toBeNull();
        expect(dramaGuideChange({ ...input, targetId: undefined }, "assets", 8)).toBeNull();
        expect(dramaGuideChange({ ...input, targetId: " " }, "assets", 8)).toBeNull();
        expect(dramaGuideChange({ ...input, changes: {} }, "assets", 8)).toBeNull();
        expect(dramaGuideChange({ ...input, changes: { reason: " " } }, "assets", 8)).toBeNull();
    });

    test("shot edits stay textual and require the story stage", () => {
        const input = proposal({ kind: "shot", targetId: "shot-1", changes: { dialogue: "你好", durationSeconds: 3, videoStatus: "ready", imageResourceId: "image-1" } });
        expect(dramaGuideChange(input, "story", 8)).toEqual({ kind: "shot", targetId: "shot-1", patch: { dialogue: "你好", durationSeconds: 3 } });
        expect(dramaGuideChange(input, "assets", 8)).toBeNull();
    });

    test("segment prompt suggestions cannot trigger video generation", () => {
        const input = proposal({ kind: "segment_prompt", targetId: "segment-1", changes: { videoPromptOverride: "新的段提示词", generate: true } });
        expect(dramaGuideChange(input, "story", 8)).toEqual({ kind: "segment_prompt", targetId: "segment-1", prompt: "新的段提示词" });
        expect(dramaGuideChange({ ...input, changes: { videoPromptOverride: 1 } }, "story", 8)).toBeNull();
    });
});
