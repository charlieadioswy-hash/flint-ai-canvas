import type { GenerationTask } from "@/services/api/task-center";

export type WorkbenchSubmissionState = "pending" | "submitting" | "created" | "failed" | "unknown";

type BatchReceipts = {
    id: string;
    states: WorkbenchSubmissionState[];
    receipts: Record<number, GenerationTask>;
};

/** 同一批次位置的原请求始终使用同一身份，响应丢失后继续提交也只核实原任务。 */
export function workbenchBatchOperationId(batchId: string, index: number) {
    return `${batchId}:${index}`;
}

/** 固定首次准备成功的 JSON 输入；网络重试不能因渠道配置或场景目录变化而改写同一请求。 */
export function prepareWorkbenchBatchSubmission<T>(cache: Map<number, Promise<T>>, index: number, prepare: () => Promise<T>): Promise<T> {
    const existing = cache.get(index);
    if (existing) return existing;
    const pending = prepare()
        .then((input) => structuredClone(input))
        .catch((error) => {
            if (cache.get(index) === pending) cache.delete(index);
            throw error;
        });
    cache.set(index, pending);
    return pending;
}

/** 轮询发现丢失回执的任务时，同时推进本机提交状态，避免继续提交把它算作未提交。 */
export function reconcileWorkbenchBatchReceipts<T extends BatchReceipts>(batch: T, tasks: readonly GenerationTask[]): T {
    let next = batch;
    for (const task of tasks) {
        const context = task.clientContext;
        const index = context?.batchIndex ?? 0;
        if (context?.batchId !== batch.id || !Number.isInteger(index) || index < 0 || index >= batch.states.length) continue;
        if (next.states[index] === "created" && next.receipts[index] === task) continue;
        next = { ...next, states: next.states.map((state, slot) => (slot === index ? "created" : state)), receipts: { ...next.receipts, [index]: task } };
    }
    return next;
}

export function unsubmittedWorkbenchBatchIndices(batch: BatchReceipts) {
    return batch.states.flatMap((state, index) => (!batch.receipts[index] && (state === "pending" || state === "failed" || state === "unknown") ? [index] : []));
}
