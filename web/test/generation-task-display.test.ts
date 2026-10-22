import { describe, expect, test } from "bun:test";
import { canCancelGenerationTask, generationTaskShowsProgress, generationTaskStageLabel, generationTaskStatusLabel, mediaDeliverySummary } from "@/lib/generation-task-display";
import { resetGenerationTaskMetadata } from "@/lib/canvas/canvas-task-state";

describe("作品保存阶段", () => {
    test("3D 保存、失败和恢复阶段不展示遗留的完成百分比", () => {
        for (const [status, stage] of [
            ["running", "保存 3D 模型文件"],
            ["failed", "3D 生成失败"],
            ["queued", "恢复原 3D 任务"],
            ["running", "3D 模型生成中"],
        ] as const) {
            expect(generationTaskShowsProgress({ status, stage, progress: 100 })).toBe(false);
        }
        expect(generationTaskShowsProgress({ status: "running", stage: "3D 模型生成中", providerProgress: 37 })).toBe(true);
        expect(generationTaskShowsProgress({ status: "succeeded", stage: "3D 模型已保存", progress: 100 })).toBe(false);
    });
    test("分别表达生成、下载、上传和登记，不把保存失败当成生成失败", () => {
        expect(mediaDeliverySummary("failed", "download")).toBe("生成成功 · 下载失败");
        expect(mediaDeliverySummary("failed", "upload")).toBe("生成成功 · 下载成功 · 上传 OSS失败");
        expect(mediaDeliverySummary("failed", "register")).toBe("生成成功 · 文件保存成功 · 登记素材失败");
        expect(mediaDeliverySummary("failed", "checkpoint")).not.toContain("下载成功");
        expect(mediaDeliverySummary("succeeded", "completed")).toContain("素材登记成功");
    });
    test("恢复中不显示虚假生成进度", () => {
        expect(generationTaskStatusLabel({ status: "running", mediaStage: "upload" })).toBe("作品已生成，正在保存");
        expect(generationTaskShowsProgress({ status: "running", mediaStage: "upload" })).toBe(false);
        expect(generationTaskStatusLabel({ status: "failed", mediaStage: "download" })).toBe("作品保存未完成");
    });
    test("重新生成清除旧恢复信息", () => {
        const metadata = resetGenerationTaskMetadata({ taskId: "old", taskMediaStage: "upload", taskCanRecoverMedia: true, taskProviderProgress: 37 });
        expect(metadata.taskId).toBeUndefined();
        expect(metadata.taskMediaStage).toBeUndefined();
        expect(metadata.taskCanRecoverMedia).toBeUndefined();
        expect(metadata.taskProviderProgress).toBeUndefined();
    });
});

describe("生成任务取消边界", () => {
    test("排队和本地准备阶段仍允许取消", () => {
        expect(canCancelGenerationTask({ status: "queued", stage: "等待队列调度" })).toBe(true);
        expect(canCancelGenerationTask({ status: "running", stage: "后端接管任务" })).toBe(true);
    });

    test("进入上游提交阶段后立即隐藏取消入口", () => {
        for (const stage of ["调用生成模型", "正在连接上游", "上游生成中", "后台仍在生成", "等待上游任务同步", "generating", "submitting", "submitted", "submission_unknown"]) {
            expect(canCancelGenerationTask({ status: "running", stage })).toBe(false);
        }
    });

    test("已有上游请求或取消协调状态时不可取消", () => {
        expect(canCancelGenerationTask({ status: "running", stage: "后端接管任务", providerRequestId: "provider-1" })).toBe(false);
        expect(canCancelGenerationTask({ status: "running", stage: "后端接管任务", providerCancelStatus: "requested" })).toBe(false);
    });

    test("作品已生成进入保存阶段或上游返回未知阶段时也不暴露取消入口", () => {
        expect(canCancelGenerationTask({ status: "running", stage: "作品已生成，正在保存", mediaStage: "upload" })).toBe(false);
        expect(canCancelGenerationTask({ status: "running", stage: "provider_processing" })).toBe(false);
        expect(canCancelGenerationTask({ status: "running", stage: "" })).toBe(false);
        expect(canCancelGenerationTask({ status: "queued", stage: "" })).toBe(true);
    });
});

describe("生成任务用户可见阶段", () => {
    test("只显示供应商返回的有效百分比，包括真实零值", () => {
        for (const providerProgress of [0, 1, 37, 99]) {
            expect(generationTaskShowsProgress({ status: "running", stage: "上游生成中", progress: 35, providerProgress })).toBe(true);
        }
        for (const providerProgress of [undefined, -1, 100, 101, NaN, Infinity]) {
            expect(generationTaskShowsProgress({ status: "running", stage: "上游生成中", progress: 35, providerProgress })).toBe(false);
        }
        for (const status of ["failed", "cancelled", "succeeded"] as const) {
            expect(generationTaskShowsProgress({ status, stage: "上游生成中", providerProgress: 37 })).toBe(false);
            expect(generationTaskStageLabel({ status, stage: "上游生成中" })).toBe(generationTaskStatusLabel({ status }));
        }
        expect(generationTaskShowsProgress({ status: "running", mediaStage: "upload", providerProgress: 99 })).toBe(false);
        expect(generationTaskShowsProgress({ status: "running", stage: "submission_unknown", providerProgress: 0 })).toBe(false);
        expect(generationTaskStageLabel({ status: "queued", stage: "等待队列调度" })).toBe("排队中");
    });
    test("不向用户暴露参考素材准备和上游连接等技术阶段", () => {
        expect(generationTaskStageLabel({ status: "running", stage: "正在准备参考素材" })).toBe("作品创作中");
        expect(generationTaskStageLabel({ status: "running", stage: "正在连接上游" })).toBe("作品创作中");
    });
});
