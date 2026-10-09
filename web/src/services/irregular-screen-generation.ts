import { nanoid } from "nanoid";
import type { SetStateAction } from "react";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { buildIrregularScreenTemplate, isIrregularScreenScene, type IrregularScreenTemplateInput } from "@/lib/canvas/irregular-screen-domain";
import { resolveCanvasControlNetInputs } from "@/lib/canvas/controlnet";
import { readNodeGenerationSpec } from "@/lib/canvas/generation-contract";
import { generationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { applyGenerationTaskResultToNodes, generationTaskOutputsApplied, shouldRecoverCanvasMediaAsset } from "@/lib/canvas/canvas-generation-task-sync";
import { commitCanvasGenerationResult } from "@/lib/canvas/canvas-generation-result";
import { getActiveUserScope } from "@/lib/user-scope";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import type { AiConfig } from "@/stores/use-config-store";
import { submitBackendGenerationTask } from "@/services/api/generation-task";
import { createGenerationTask, listGenerationTasks, waitForGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { ApiError } from "@/services/api/request";
import { resetGenerationTaskMetadata } from "@/lib/canvas/canvas-task-state";
import { ensureCanvasNodeAsset, consumeGenerationTaskNode, projectGenerationTaskResult } from "@/services/project-asset-sync";
import { applyCanvasGenerationTaskNodeEffect } from "@/services/canvas-generation-consumer";
import { attachNodeEffectKey } from "@/services/generation-task-materializer";
import { saveRemoteUserDataNow } from "@/services/user-data-sync";
import type { CanvasNodeData } from "@/types/canvas";

function assertScope(scope: string, signal?: AbortSignal) {
    if (signal?.aborted || scope !== getActiveUserScope()) throw new DOMException("Aborted", "AbortError");
}

export async function saveScreenCanvas(id: string, input: Omit<IrregularScreenTemplateInput, "existingProject">, signal?: AbortSignal) {
    const scope = getActiveUserScope();
    const existing = useCanvasStore.getState().openProject(id);
    if (!existing) throw new Error("画布不存在，请重新打开");
    assertScope(scope, signal);
    const template = buildIrregularScreenTemplate({ ...input, existingProject: existing });
    const sources = Object.values(template.creationScene.nodeIds).filter((nodeId) => nodeId !== template.generationNodeId);
    // 素材先完成服务端登记，再把引用写入画布；避免仅有 resource 的节点保存失败。
    for (const nodeId of sources) {
        const node = template.nodes.find((item) => item.id === nodeId)!;
        const asset = await ensureCanvasNodeAsset({ canvasId: id, node, source: "canvas-upload", signal });
        assertScope(scope, signal);
        node.metadata = { ...node.metadata, assetId: asset.assetId };
    }
    const current = useCanvasStore.getState().openProject(id);
    if (current !== existing && current && JSON.stringify(current.nodes) !== JSON.stringify(existing.nodes)) throw new Error("画布已在其他位置更新，请重新打开后继续");
    useCanvasStore.getState().updateProject(id, { nodes: template.nodes, connections: template.connections, creationScene: template.creationScene });
    await saveRemoteUserDataNow(id);
    assertScope(scope, signal);
    return useCanvasStore.getState().openProject(id)!;
}

export async function submitScreenGeneration(project: CanvasProject, config: AiConfig, signal?: AbortSignal) {
    const scope = getActiveUserScope();
    if (!isIrregularScreenScene(project.creationScene)) throw new Error("画布不是异形屏场景");
    const nodeId = project.creationScene.nodeIds.generation;
    const node = project.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("生成节点已移除，请在画布中恢复");
    if (node.metadata?.status === "loading") throw new Error("当前任务尚未完成，请等待结果");
    if (node.metadata?.taskStage === "submission_unconfirmed") throw new Error("上次提交状态尚未确认，请重新打开此场景读取原任务，勿重复提交");
    const spec = readNodeGenerationSpec(node);
    if (!spec?.prompt.trim()) throw new Error("请输入画面描述");
    const context = buildNodeGenerationContext(nodeId, project.nodes, project.connections, spec.prompt, useAssetStore.getState().assets, true);
    const expectedReferences = project.creationScene.nodeIds.contentReference ? 1 : 0;
    if (context.referenceImages.length !== expectedReferences) throw new Error("画布增加了其他内容参考输入，请在完整画布生成，或移除额外连线后使用快捷设置");
    const controls = resolveCanvasControlNetInputs(node, project.nodes);
    const operationId = nanoid();
    const oldResult = node.metadata?.assetId && node.metadata?.storageKey && node.metadata?.status === "success"
        ? { ...node, id: nanoid(), title: `${node.title} · 上次结果`, position: { x: node.position.x + node.width + 80, y: node.position.y }, metadata: { ...node.metadata } }
        : undefined;
    // 原节点的提交标记不属于新副本，保留会使普通持久化过滤掉上次结果。
    if (oldResult) delete oldResult.metadata.generationEffectKeys;
    const pending: CanvasNodeData = { ...node, metadata: { ...node.metadata, status: "loading", errorDetails: undefined, taskId: undefined, taskClientOperationId: operationId, taskStatus: "queued", taskStage: "submission_unconfirmed" } };
    useCanvasStore.getState().updateProject(project.id, { nodes: [...project.nodes.map((item) => item.id === nodeId ? pending : item), ...(oldResult ? [oldResult] : [])] });
    let dispatched = false;
    let accepted = false;
    try {
        await saveRemoteUserDataNow(project.id);
        assertScope(scope, signal);
        const task = await submitBackendGenerationTask({ projectId: project.id, mode: "image", prompt: context.prompt, config, referenceImages: context.referenceImages, ...controls, clientOperationId: operationId, signal, metadata: { nodeId, source: "irregular-screen", providerOptions: node.metadata?.providerOptions } }, {
            createId: nanoid, waitTask: waitForGenerationTask,
            createTask: (input) => { assertScope(scope, signal); dispatched = true; return createGenerationTask(input); },
        });
        accepted = true;
        assertScope(scope, signal);
        bindScreenTask(project.id, nodeId, task);
        await saveRemoteUserDataNow(project.id);
        return task;
    } catch (error) {
        // A local preparation error or an explicit rejection has no upstream task.
        // Ambiguous transport failures keep the operation identity for discovery.
        const rejected = error instanceof ApiError && [400, 401, 403, 404, 422, 429].includes(error.status || 0);
        if (!accepted && (!dispatched || rejected) && scope === getActiveUserScope()) {
            const current = useCanvasStore.getState().openProject(project.id);
            // 失败仅重置本次提交；上次成功结果仍作为独立副本保留，供查看和下载。
            if (current) useCanvasStore.getState().updateProject(project.id, { nodes: current.nodes.map((item) => item.id === nodeId && item.metadata?.taskClientOperationId === operationId ? { ...item, metadata: { ...resetGenerationTaskMetadata(item.metadata), status: "error", errorDetails: error instanceof Error ? error.message : "提交失败" } } : item) });
            try { await saveRemoteUserDataNow(project.id); } catch { /* Local retryable state remains pending cloud sync. */ }
        }
        throw error;
    }
}

export function bindScreenTask(projectId: string, nodeId: string, task: GenerationTask) {
    const project = useCanvasStore.getState().openProject(projectId);
    if (!project) return;
    useCanvasStore.getState().updateProject(projectId, { nodes: project.nodes.map((node) => node.id !== nodeId ? node : { ...node, metadata: { ...node.metadata, ...generationTaskMetadata(task), status: task.status === "failed" || task.status === "cancelled" ? "error" : "loading", errorDetails: task.error } }) });
}

export async function recoverScreenGeneration(projectId: string, signal: AbortSignal, onUpdate: (task: GenerationTask) => void) {
    const scope = getActiveUserScope();
    let project = useCanvasStore.getState().openProject(projectId);
    if (!project || !isIrregularScreenScene(project.creationScene)) return;
    const nodeId = project.creationScene.nodeIds.generation;
    const node = project.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    let taskId = node.metadata?.taskId;
    if (!taskId && node.metadata?.taskClientOperationId) {
        const tasks = await listGenerationTasks(100, { projectId }, undefined, signal);
        assertScope(scope, signal);
        const matching = tasks.find((task) => task.clientOperationId === node.metadata?.taskClientOperationId && task.clientContext?.nodeId === nodeId);
        if (!matching) throw new Error("上次提交尚未找到任务记录，请到任务中心核对，勿重复提交");
        taskId = matching.id;
    }
    if (!taskId) return;
    const task = await waitForGenerationTask(taskId, { signal, onTaskUpdate: (task) => { assertScope(scope, signal); bindScreenTask(projectId, nodeId, task); onUpdate(task); } }).catch(async (error: unknown) => {
        assertScope(scope, signal);
        await saveRemoteUserDataNow(projectId);
        throw error;
    });
    assertScope(scope, signal);
    if (task.status !== "succeeded") { await saveRemoteUserDataNow(projectId); throw new Error(task.error || "生成未完成"); }
    const nodesRef = { current: useCanvasStore.getState().openProject(projectId)!.nodes };
    const setNodes = (update: SetStateAction<CanvasNodeData[]>) => {
        assertScope(scope, signal);
        const current = useCanvasStore.getState().openProject(projectId)!;
        nodesRef.current = typeof update === "function" ? update(current.nodes) : update;
        useCanvasStore.getState().updateProject(projectId, { nodes: nodesRef.current });
    };
    try {
        const materialized = await consumeGenerationTaskNode(task, nodeId, 0, (effect) => applyCanvasGenerationTaskNodeEffect({ projectId, nodeId, ...effect, nodesRef, setNodes }), { signal });
        assertScope(scope, signal);
        project = useCanvasStore.getState().openProject(projectId)!;
        const live = project.nodes.find((item) => item.id === nodeId);
        if (live && !generationTaskOutputsApplied(live, materialized)) {
            const output = materialized.outputs?.find((item) => item.outputIndex === 0);
            if (!output) throw new Error("生成结果尚未保存，请重新读取任务");
            await applyCanvasGenerationTaskNodeEffect({ projectId, nodeId, task: materialized, output, effectKey: attachNodeEffectKey(taskId, nodeId, 0), signal, nodesRef, setNodes });
        }
    } catch (error) {
        assertScope(scope, signal);
        const storedTask = projectGenerationTaskResult(task);
        const current = useCanvasStore.getState().openProject(projectId);
        const before = current?.nodes.find((item) => item.id === nodeId);
        // HTTP 环境无法确认 attach effect；只回填已登记的不可变资源，不重建素材或执行合成。
        if (!before || before.metadata?.emotionEdit || !storedTask.outputs?.length || storedTask.outputs.some((output) => !output.providerArtifactRef?.startsWith("resource:"))) throw error;
        const applied = await applyGenerationTaskResultToNodes(current!.nodes, storedTask, nodeId).catch(() => { throw error; });
        assertScope(scope, signal);
        if (!applied.updated || !applied.node || [applied.node, ...(applied.additionalNodes || [])].some(shouldRecoverCanvasMediaAsset)) throw error;
        setNodes((nodes) => commitCanvasGenerationResult(nodes, before, applied.node!, task.id, applied.additionalNodes));
    }
    await saveRemoteUserDataNow(projectId);
}
