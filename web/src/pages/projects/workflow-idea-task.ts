import { dramaChoiceToModel } from "@/lib/drama/model-choice";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { createClientUUID } from "@/lib/client-id";
import { prepareBackendGenerationTask, parseBackendGenerationResult } from "@/services/api/generation-task";
import type { CreateTaskInput, GenerationTask } from "@/services/api/task-center";
import type { DramaModelChoice } from "@/services/api/drama";
import { resolveModelChannel, type AiConfig } from "@/stores/use-config-store";

export type IdeaSourceFormat = "novel" | "script";
export type IdeaSubmission = { request: CreateTaskInput; idea: string; format: IdeaSourceFormat; choice: DramaModelChoice };
export type IdeaWorkspace = {
    version: 1;
    idea: string;
    format: IdeaSourceFormat;
    choice?: DramaModelChoice;
    taskId?: string;
    result: string;
    resultTaskId?: string;
    resultEdited: boolean;
    pending?: IdeaSubmission;
    pendingRetry?: { taskId: string; attempts: number; updatedAt: string };
};

const STORAGE_KEY = "drama-workflow-idea";
const NODE_PREFIX = "drama-idea:";
const writes = new Map<string, Promise<unknown>>();
export const emptyIdeaWorkspace = (): IdeaWorkspace => ({ version: 1, idea: "", format: "script", result: "", resultEdited: false });

function record(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validChoice(value: unknown): value is DramaModelChoice {
    return record(value) && ((typeof value.logicalModelId === "string" && Boolean(value.logicalModelId)) || (typeof value.channelId === "string" && Boolean(value.channelId) && typeof value.modelKey === "string" && Boolean(value.modelKey)));
}

function safePayload(value: unknown): boolean {
    if (Array.isArray(value)) return value.every(safePayload);
    if (!record(value)) return true;
    return Object.entries(value).every(([key, item]) => !/^(apiKey|secretKey|headers|authorization|cookie)$/i.test(key) && safePayload(item));
}

function validSubmission(value: unknown): value is IdeaSubmission {
    if (!record(value) || typeof value.idea !== "string" || !value.idea.trim() || value.idea.length > 4000 || !["novel", "script"].includes(String(value.format)) || !validChoice(value.choice)) return false;
    const request = value.request;
    if (
        !record(request) ||
        request.projectId ||
        request.type !== "canvas_text" ||
        request.operation !== "text" ||
        typeof request.prompt !== "string" ||
        !request.prompt.trim() ||
        typeof request.clientOperationId !== "string" ||
        !request.clientOperationId ||
        !safePayload(request)
    )
        return false;
    const input = request.input;
    if (!record(input) || input.mode !== "text" || input.prompt !== request.prompt || !record(input.metadata)) return false;
    const source = input.metadata.dramaIdea;
    return (
        input.metadata.source === "drama_idea" &&
        input.metadata.clientOperationId === request.clientOperationId &&
        input.metadata.nodeId === `${NODE_PREFIX}${request.clientOperationId}` &&
        record(source) &&
        source.idea === value.idea &&
        source.format === value.format &&
        JSON.stringify(source.choice) === JSON.stringify(value.choice)
    );
}

export async function prepareIdeaSubmission(config: AiConfig, choice: DramaModelChoice, idea: string, format: IdeaSourceFormat): Promise<IdeaSubmission> {
    const input = idea.trim();
    if (!input) throw new Error("请先填写创作想法");
    if (input.length > 4000) throw new Error("创作想法请控制在 4000 字以内");
    const model = dramaChoiceToModel(config, "text", choice);
    if (!model || resolveModelChannel(config, model).scope !== "system") throw new Error("请选择可用的平台文本模型");
    const instruction = format === "script" ? "扩写为可拍摄的短剧剧本，包含人物设定、场景、动作和对白；按“第1集”标题组织正文。" : "扩写为完整连贯、可供短剧改编的故事正文，按“第1章”标题组织内容。";
    const prompt = `请根据用户创意${instruction}\n保留用户明确给出的人物定义与情节要求。只输出完整正文，不输出建议列表、选择题、前言或生成说明。不要将创作建议冒充正文，也不要声称内容来自已上传文件。\n\n用户创意：\n${input}`;
    const id = createClientUUID();
    const request = await prepareBackendGenerationTask({
        mode: "text",
        prompt,
        config: { ...config, model, taskWorkflowProvider: "model", systemPrompt: "" },
        streamText: true,
        clientOperationId: id,
        metadata: { source: "drama_idea", nodeId: `${NODE_PREFIX}${id}`, dramaIdea: { idea: input, format, choice } },
    });
    request.clientOperationId = id;
    const providerConfig = request.input?.config;
    if (providerConfig && typeof providerConfig === "object") {
        const safeConfig = { ...(providerConfig as Record<string, unknown>) };
        delete safeConfig.apiKey;
        delete safeConfig.secretKey;
        delete safeConfig.headers;
        request.input = { ...request.input, config: safeConfig };
    }
    const submittedChoice = request.logicalModelId ? { ...choice, logicalModelId: request.logicalModelId } : choice;
    request.input = { ...request.input, metadata: { ...(request.input?.metadata as Record<string, unknown>), dramaIdea: { idea: input, format, choice: submittedChoice } } };
    const submission = { request: JSON.parse(JSON.stringify(request)) as CreateTaskInput, idea: input, format, choice: submittedChoice };
    if (!validSubmission(submission)) throw new Error("扩写请求包含无效配置，请重新选择平台模型");
    return submission;
}

export function ideaTaskSource(task: GenerationTask): { idea: string; format: IdeaSourceFormat; choice: DramaModelChoice } | undefined {
    if (task.projectId || task.type !== "canvas_text" || !task.inputJson) return;
    try {
        const input = JSON.parse(task.inputJson);
        const source = input?.metadata?.dramaIdea;
        if (input?.metadata?.source !== "drama_idea" || !ideaTaskOperationId(task) || typeof source?.idea !== "string" || !["novel", "script"].includes(source.format) || !validChoice(source.choice)) return;
        return source;
    } catch {
        return;
    }
}

export function ideaTaskOperationId(task: GenerationTask): string | undefined {
    try {
        const input = JSON.parse(task.inputJson || "");
        const id = input?.metadata?.clientOperationId;
        return typeof id === "string" && id && input.metadata.nodeId === `${NODE_PREFIX}${id}` ? id : undefined;
    } catch {
        return undefined;
    }
}

/** 列表只返回摘要；nodeId 仅筛选候选，读取详情后仍须验证 source 和提交身份。 */
export function ideaTaskCandidate(task: GenerationTask): boolean {
    return !task.projectId && task.type === "canvas_text" && Boolean(task.clientContext?.nodeId?.startsWith(NODE_PREFIX));
}

export function ideaTaskText(task: GenerationTask): string {
    if (task.status !== "succeeded") return task.textDraft || "";
    const text = parseBackendGenerationResult(task).text;
    if (!text?.trim()) throw new Error("模型未返回正文，请检查任务结果后重试");
    return text;
}

export async function readIdeaWorkspace(owner: string): Promise<IdeaWorkspace> {
    if (!owner) throw new Error("请先登录");
    await writes.get(owner)?.catch(() => undefined);
    const raw = await localForageStorageForScope(owner).getItem(STORAGE_KEY);
    if (!raw) return emptyIdeaWorkspace();
    let saved: unknown;
    try {
        saved = JSON.parse(raw);
    } catch {
        throw new Error("本机创意草稿无法读取，请从任务历史恢复；原缓存未被覆盖");
    }
    if (
        !record(saved) ||
        saved?.version !== 1 ||
        typeof saved.idea !== "string" ||
        typeof saved.result !== "string" ||
        typeof saved.resultEdited !== "boolean" ||
        typeof saved.format !== "string" ||
        !["novel", "script"].includes(saved.format) ||
        (saved.choice !== undefined && !validChoice(saved.choice)) ||
        (saved.taskId !== undefined && typeof saved.taskId !== "string") ||
        (saved.resultTaskId !== undefined && typeof saved.resultTaskId !== "string") ||
        (saved.pending !== undefined && !validSubmission(saved.pending)) ||
        (saved.pendingRetry !== undefined &&
            (!record(saved.pendingRetry) || typeof saved.pendingRetry.taskId !== "string" || saved.pendingRetry.taskId !== saved.taskId || typeof saved.pendingRetry.attempts !== "number" || typeof saved.pendingRetry.updatedAt !== "string"))
    )
        throw new Error("本机创意草稿无法读取，任务中心中的任务仍可恢复");
    return saved as IdeaWorkspace;
}

export function writeIdeaWorkspace(owner: string, state: IdeaWorkspace): Promise<void> {
    if (!owner) return Promise.reject(new Error("请先登录"));
    const raw = JSON.stringify(state);
    const write = (writes.get(owner) || Promise.resolve()).catch(() => undefined).then(() => localForageStorageForScope(owner).setItem(STORAGE_KEY, raw));
    writes.set(owner, write);
    return write as Promise<void>;
}
