import { describe, expect, test } from "bun:test";

import { activeDramaGuide, dramaGuideChange, dramaProjectPath, dramaProposalKey } from "../src/pages/projects/guide-state";
import type { DramaAgentProposal } from "../src/services/api/agent";

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
