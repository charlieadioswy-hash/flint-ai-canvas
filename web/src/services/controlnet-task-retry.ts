import { retryGenerationTask, waitForGenerationTask, type GenerationTask } from "./api/task-center";

export function taskHasStructureControl(task: Pick<GenerationTask, "inputJson"> | undefined) {
    if (!task?.inputJson) return false;
    try {
        const input = JSON.parse(task.inputJson) as { controlNet?: unknown; outputMask?: unknown };
        return (Array.isArray(input.controlNet) && input.controlNet.length > 0) || Boolean(input.outputMask && typeof input.outputMask === "object");
    } catch { return false; }
}

/** Requeue the saved task recipe; editor node references may have changed or been deleted. */
export async function retryStructureControlTask(
    task: GenerationTask,
    options: { signal?: AbortSignal; onTaskUpdate?: (task: GenerationTask) => void },
    dependencies = { retryTask: retryGenerationTask, waitTask: waitForGenerationTask },
) {
    if (!taskHasStructureControl(task)) throw new Error("任务缺少结构控制快照");
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const initialTask = task.status === "failed" || task.status === "cancelled" ? await dependencies.retryTask(task.id) : task;
    options.onTaskUpdate?.(initialTask);
    if (initialTask.status === "succeeded") return initialTask;
    return dependencies.waitTask(initialTask.id, { initialTask, ...options });
}
