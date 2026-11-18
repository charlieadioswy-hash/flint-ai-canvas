import { describe, expect, test } from "bun:test";

import type { DramaGuideStep, DramaSummary } from "../src/services/api/drama";
import { allowedWorkflowSteps, defaultWorkflowStep, episodeWorkflowEntryStep, EPISODE_WORKFLOW_STEPS, isWorkflowStepAllowed, resolveWorkflowStep, WORKFLOW_STEPS } from "../src/pages/projects/workflow-state";

function summary(guideStep: DramaGuideStep | "", chapterCount = 1): DramaSummary {
    return {
        production: { guideStep, chapterCount },
        guide: guideStep ? { step: guideStep, canConfirm: false } : undefined,
    } as DramaSummary;
}

describe("短剧简易工作台步骤", () => {
    test("六步名称与计划一致", () => {
        expect(WORKFLOW_STEPS.map((step) => step.title)).toEqual(["上传剧本", "剧本格式", "风格设置", "角色场景", "漫剧分镜", "视频预览"]);
        expect(EPISODE_WORKFLOW_STEPS.map((step) => step.title)).toEqual(["分集剧本", "风格设置", "角色场景", "漫剧分镜", "视频预览"]);
    });

    test("配置中只能浏览正文与风格，不能跳到资产或分镜", () => {
        const current = summary("configuring");
        expect(allowedWorkflowSteps(current)).toEqual(["source", "review", "style"]);
        expect(isWorkflowStepAllowed(current, "assets")).toBe(false);
        expect(resolveWorkflowStep(current, "story")).toBe("review");
    });

    test("没有正文的配置草稿默认回到导入", () => {
        expect(defaultWorkflowStep(summary("configuring", 0))).toBe("source");
        expect(resolveWorkflowStep(summary("configuring", 0), "review")).toBe("review");
    });

    test("资产阶段可回看前步，但不能进入分镜或预览", () => {
        const current = summary("assets");
        expect(defaultWorkflowStep(current)).toBe("assets");
        expect(isWorkflowStepAllowed(current, "style")).toBe(true);
        expect(resolveWorkflowStep(current, "preview")).toBe("assets");
    });

    test("资产阶段已有分镜的当前集可直接查看，不能借用其他集解锁", () => {
        const current = summary("assets");
        current.episodes = [
            { id: "empty", number: 1, shotCount: 0, stats: { segments: 0 } },
            { id: "shots", number: 2, shotCount: 3, stats: { segments: 0 } },
            { id: "segments", number: 3, shotCount: 0, stats: { segments: 1 } },
        ] as DramaSummary["episodes"];
        expect(resolveWorkflowStep(current, "story")).toBe("assets");
        expect(resolveWorkflowStep(current, "story", "empty")).toBe("assets");
        expect(resolveWorkflowStep(current, "story", "missing")).toBe("assets");
        for (const episodeId of ["shots", "segments"]) {
            expect(isWorkflowStepAllowed(current, "story", { episodeId })).toBe(true);
            expect(resolveWorkflowStep(current, "story", episodeId)).toBe("story");
            expect(resolveWorkflowStep(current, "preview", episodeId)).toBe("assets");
        }
    });

    test("分镜阶段可回看，也能恢复用户已选择的预览页", () => {
        const current = summary("story");
        expect(allowedWorkflowSteps(current)).toEqual(["source", "review", "style", "assets", "story"]);
        expect(resolveWorkflowStep(current, "preview")).toBe("preview");
        expect(resolveWorkflowStep(current, "source")).toBe("source");
    });

    test("已完成和旧传统项目停在分镜，预览只能手动进入", () => {
        for (const current of [summary("completed"), summary("")]) {
            expect(defaultWorkflowStep(current)).toBe("story");
            expect(isWorkflowStepAllowed(current, "preview")).toBe(false);
            expect(isWorkflowStepAllowed(current, "preview", { manualPreview: true })).toBe(true);
            expect(resolveWorkflowStep(current, "preview")).toBe("preview");
            expect(resolveWorkflowStep(current, "assets")).toBe("assets");
        }
    });

    test("未知地址步骤回到当前阶段默认步骤", () => {
        expect(resolveWorkflowStep(summary("assets"), "not-a-step")).toBe("assets");
    });

    test("分集按本集主体和分镜结果决定入口", () => {
        const stats = { segments: 0, promptReady: 0, promptSucceeded: 0, videoReady: 0, videoGenerated: 0, failed: 0 };
        const fresh = { id: "fresh", assetsReady: false, storyboardReady: false, shotCount: 0, stats };
        const extracted = { ...fresh, id: "extracted", assetsReady: true };
        const boarded = { ...extracted, id: "boarded", storyboardReady: true, shotCount: 2, stats: { ...stats, segments: 1 } };
        expect(episodeWorkflowEntryStep(fresh)).toBe("assets");
        expect(episodeWorkflowEntryStep(extracted)).toBe("review");
        expect(episodeWorkflowEntryStep(boarded)).toBe("story");

        const current = summary("completed");
        current.episodes = [fresh, extracted, boarded] as DramaSummary["episodes"];
        expect(resolveWorkflowStep(current, undefined, fresh.id)).toBe("assets");
        expect(resolveWorkflowStep(current, "story", fresh.id)).toBe("assets");
        expect(resolveWorkflowStep(current, "preview", fresh.id)).toBe("assets");
        expect(resolveWorkflowStep(current, "review", fresh.id)).toBe("review");
        expect(resolveWorkflowStep(current, "story", extracted.id)).toBe("story");
        expect(resolveWorkflowStep(current, "preview", extracted.id)).toBe("review");
        expect(resolveWorkflowStep(current, "preview", boarded.id)).toBe("preview");
        expect(resolveWorkflowStep(summary("configuring"), "assets", fresh.id)).toBe("review");
    });
});
