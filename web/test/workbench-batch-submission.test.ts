import { describe, expect, test } from "bun:test";

import { prepareWorkbenchBatchSubmission, reconcileWorkbenchBatchReceipts, unsubmittedWorkbenchBatchIndices, workbenchBatchOperationId, type WorkbenchSubmissionState } from "../src/pages/workbench/workbench-batch-submission";
import type { GenerationTask } from "../src/services/api/task-center";

describe("工作台批量提交回执恢复", () => {
    test("丢失 POST 回执后，轮询确认的任务不会再次进入剩余提交", () => {
        const batch = { id: "batch-lost-receipt", states: ["unknown", "pending", "pending"] as WorkbenchSubmissionState[], receipts: {} as Record<number, GenerationTask> };
        const committed = { id: "task-already-charged", status: "running", clientContext: { batchId: batch.id, batchCount: 3 } } as GenerationTask;

        const recovered = reconcileWorkbenchBatchReceipts(batch, [committed]);

        expect(recovered.states).toEqual(["created", "pending", "pending"]);
        expect(recovered.receipts[0]).toBe(committed);
        expect(unsubmittedWorkbenchBatchIndices(recovered)).toEqual([1, 2]);
    });

    test("未知结果未被轮询查到时，继续提交仍携带原来的计费幂等身份", () => {
        const batch = { id: "batch-response-timeout", states: ["unknown", "pending"] as WorkbenchSubmissionState[], receipts: {} };
        const originalKeys = batch.states.map((_, index) => workbenchBatchOperationId(batch.id, index));
        const replayKeys = unsubmittedWorkbenchBatchIndices(batch).map((index) => workbenchBatchOperationId(batch.id, index));

        expect(replayKeys).toEqual(originalKeys);
        expect(new Set(replayKeys).size).toBe(2);
        expect(replayKeys.every((key) => /^[\x20-\x7e]{1,128}$/.test(key))).toBe(true);
    });

    test("忽略其他批次和越界回执，已有回执不依赖过期状态再次提交", () => {
        const committed = { id: "task-1", clientContext: { batchId: "batch-a", batchIndex: 1 } } as GenerationTask;
        const batch = { id: "batch-a", states: ["failed", "unknown"] as WorkbenchSubmissionState[], receipts: { 1: committed } };
        const unrelated = [
            { id: "other-batch", clientContext: { batchId: "batch-b" } },
            { id: "out-of-range", clientContext: { batchId: batch.id, batchIndex: 2 } },
        ] as GenerationTask[];

        expect(reconcileWorkbenchBatchReceipts(batch, unrelated)).toBe(batch);
        expect(unsubmittedWorkbenchBatchIndices(batch)).toEqual([0]);
    });

    for (const route of ["workbench", "tasks"] as const) {
        test(`${route} 提交回执丢失后重用首次准备的完整输入`, async () => {
            const source = { route, input: { clientOperationId: "batch-a:0", metadata: { toolName: "原场景", config: { model: "model-a" } } } };
            const cache = new Map<number, Promise<typeof source>>();
            let preparations = 0;
            const prepare = async () => {
                preparations += 1;
                return source;
            };
            const first = await prepareWorkbenchBatchSubmission(cache, 0, prepare);
            const sentBody = JSON.stringify(first);
            // POST 可能已提交成功，但浏览器没有收到回执；期间场景和渠道配置已刷新。
            source.input.metadata.toolName = "新场景";
            source.input.metadata.config.model = "model-b";
            const retry = await prepareWorkbenchBatchSubmission(cache, 0, prepare);

            expect(preparations).toBe(1);
            expect(JSON.stringify(retry)).toBe(sentBody);
            expect(retry.input.clientOperationId).toBe("batch-a:0");
        });
    }

    test("准备输入失败还未发出请求时，允许重新准备", async () => {
        const cache = new Map<number, Promise<string>>();
        await expect(
            prepareWorkbenchBatchSubmission(cache, 0, async () => {
                throw new Error("准备失败");
            }),
        ).rejects.toThrow("准备失败");
        expect(await prepareWorkbenchBatchSubmission(cache, 0, async () => "prepared")).toBe("prepared");
    });
});
