import { describe, expect, test } from "bun:test";

import { createGenerationTaskSubscriptionService, type GenerationTask } from "../src/services/api/task-center";
import { pendingCreationTaskIds, pendingCreationTaskKey } from "../src/services/creation-conversation-store";
import { attachCreationTaskContexts, materializeCreationTaskResults, reconcileCreationTaskMessages } from "../src/pages/create/creation-conversations";
import type { CreationConversation, CreationMessage } from "../src/pages/create/creation-types";

type CreationRuntime = Parameters<typeof reconcileCreationTaskMessages>[0];
const runtime = {} as CreationRuntime;
const createdAt = "2026-10-01T00:00:00.000Z";
const completedAt = "2026-10-01T00:01:00.000Z";

function history(overrides: Partial<CreationMessage> = {}): CreationConversation[] {
    return [
        {
            id: "conversation-1",
            title: "创作",
            updatedAt: createdAt,
            messages: [
                {
                    id: "message-1",
                    role: "assistant",
                    mode: "image",
                    status: "error",
                    content: "生成失败",
                    error: "当前浏览器不支持跨页面生成副作用互斥",
                    generationErrorCode: "provider_error",
                    createdAt,
                    taskIds: ["task-1"],
                    ...overrides,
                },
            ],
        },
    ];
}

function task(overrides: Partial<GenerationTask> = {}): GenerationTask {
    return { id: "task-1", type: "canvas_image", status: "succeeded", prompt: "fixture", attempts: 1, createdAt, updatedAt: completedAt, ...overrides };
}

describe("creation media task recovery", () => {
    test("refresh reads the original succeeded task and restores its registered result", async () => {
        const conversations = history();
        const queried: string[] = [];
        let waits = 0;
        let materialized = 0;
        const subscription = createGenerationTaskSubscriptionService({
            async queryTask(id) {
                queried.push(id);
                return task();
            },
            async waitTask() {
                waits += 1;
                throw new Error("terminal tasks must not wait again");
            },
        });
        const observed = await new Promise<GenerationTask>((resolve) => subscription.subscribe(pendingCreationTaskIds(conversations), resolve));
        const recoveryRuntime = {
            async runGenerationConsumer(_signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<GenerationTask>) {
                return operation(new AbortController().signal);
            },
            async materializeGenerationTaskAssets(existing: GenerationTask) {
                materialized += 1;
                return { ...existing, outputs: [{ outputIndex: 0, mediaType: "image", materializedAssetId: "asset-1" }] };
            },
            generationTaskMaterializedUrls: () => [],
            generationTaskMaterializedStorageKeys: () => ["resource:asset-1"],
        } as unknown as CreationRuntime;
        const contextual = attachCreationTaskContexts([observed], conversations);
        const results = await materializeCreationTaskResults(recoveryRuntime, contextual);
        const recovered = reconcileCreationTaskMessages(recoveryRuntime, conversations, results);

        expect(queried).toEqual(["task-1"]);
        expect(waits).toBe(0);
        expect(materialized).toBe(1);
        expect(recovered[0].messages[0]).toMatchObject({ status: "done", content: "图片已生成", resultStorageKeys: ["resource:asset-1"], taskIds: ["task-1"] });
        expect(recovered[0].messages[0].error).toBeUndefined();
        expect(recovered[0].messages[0].generationErrorCode).toBeUndefined();
        expect(recovered[0].updatedAt).toBe(completedAt);
        expect(pendingCreationTaskIds(recovered)).toEqual([]);
        expect(reconcileCreationTaskMessages(recoveryRuntime, recovered, results)).toBe(recovered);
    });

    test("errors without task IDs and errors with existing partial results are not queried", () => {
        for (const overrides of [
            { taskIds: undefined },
            { taskIds: [] },
            { taskIds: ["", " "] },
            { resultUrls: ["blob:existing"], taskIds: ["task-1", "task-2"] },
            { resultStorageKeys: ["resource:existing"], taskIds: ["task-1", "task-2"] },
            { status: "cancelled" },
            { status: "done" },
            { mode: "text" },
            { mode: undefined },
            { role: "user" },
        ] satisfies Partial<CreationMessage>[]) {
            const conversations = history(overrides);
            expect(pendingCreationTaskIds(conversations)).toEqual([]);
            expect(pendingCreationTaskKey(conversations)).toBe("");
        }
        expect(pendingCreationTaskIds(history({ taskIds: ["", "task-1", "task-1"] }))).toEqual(["task-1"]);
    });

    test("genuine provider failure remains stable and never enters task waiting", async () => {
        const conversations = history({ error: "供应商拒绝了生成请求" });
        let queries = 0;
        let waits = 0;
        const subscription = createGenerationTaskSubscriptionService({
            async queryTask() {
                queries += 1;
                return task({ status: "failed", error: "供应商拒绝了生成请求" });
            },
            async waitTask() {
                waits += 1;
                throw new Error("failed task must not be polled");
            },
        });
        const observed = await new Promise<GenerationTask>((resolve) => subscription.subscribe(pendingCreationTaskIds(conversations), resolve));
        expect(reconcileCreationTaskMessages(runtime, conversations, [observed])).toBe(conversations);
        subscription.subscribe(pendingCreationTaskIds(conversations), () => {});
        await Promise.resolve();
        expect(queries).toBe(1);
        expect(waits).toBe(0);
    });

    test("running tasks and unreadable successful results leave the local error intact", () => {
        const conversations = history();
        for (const observed of [task({ status: "queued" }), task({ status: "running" }), task(), { ...task(), creationError: "素材暂时不可读取" }]) {
            expect(reconcileCreationTaskMessages(runtime, conversations, [observed])).toBe(conversations);
        }
    });

    test("late recovery preserves cancelled, completed, result-bearing and unbound messages", () => {
        const ready = { ...task({ clientContext: { conversationId: "conversation-1", messageId: "message-1" } }), creationResultStorageKeys: ["resource:asset-1"] };
        for (const overrides of [
            { status: "cancelled", content: "已停止" },
            { status: "done", content: "用户编辑的说明" },
            { resultStorageKeys: ["resource:existing"], taskIds: ["task-1", "task-2"] },
            { resultUrls: ["blob:existing"], taskIds: ["task-1", "task-2"] },
            { taskIds: undefined },
        ] satisfies Partial<CreationMessage>[]) {
            const conversations = history(overrides);
            expect(reconcileCreationTaskMessages(runtime, conversations, [ready])).toBe(conversations);
        }
    });

    test("batch recovery waits for all original task results and keeps a partial-success summary", () => {
        const conversations = history({ taskIds: ["task-1", "task-2"] });
        const succeeded = { ...task({ clientContext: { batchIndex: 0, batchCount: 2 } }), creationResultStorageKeys: ["resource:asset-1"] };
        const failed = task({ id: "task-2", status: "failed", clientContext: { batchIndex: 1, batchCount: 2 } });
        expect(reconcileCreationTaskMessages(runtime, conversations, [succeeded])).toBe(conversations);
        const recovered = reconcileCreationTaskMessages(runtime, conversations, [failed, succeeded]);
        expect(recovered[0].messages[0]).toMatchObject({ status: "done", content: "1 张图片已生成，1 张失败", resultStorageKeys: ["resource:asset-1"] });
    });

    test("pending media and text observations keep their existing recovery eligibility", () => {
        expect(pendingCreationTaskIds(history({ status: "pending", resultStorageKeys: ["resource:partial"] }))).toEqual(["task-1"]);
        expect(pendingCreationTaskIds(history({ mode: "text", status: "streaming" }))).toEqual(["task-1"]);
        const recovered = reconcileCreationTaskMessages(runtime, history({ mode: "video", status: "pending" }), [{ ...task({ type: "canvas_video" }), creationResultStorageKeys: ["resource:video-1"] }]);
        expect(recovered[0].messages[0]).toMatchObject({ status: "done", content: "视频已生成" });
    });
});
