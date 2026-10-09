import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { useEffectiveConfig, modelOptionName } from "@/stores/use-config-store";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { requestCreditCost } from "@/lib/model-pricing";
import { readNodeGenerationSpec } from "@/lib/canvas/generation-contract";
import { isIrregularScreenScene, resolveIrregularScreenOutputSize } from "@/lib/canvas/irregular-screen-domain";
import { screenPickerConfig, screenDefaultSettings, screenModelDefaults, screenModelError, screenControlParameters, screenProviderOptions } from "@/lib/canvas/irregular-screen-model";
import { validateControlNetBindings } from "@/lib/canvas/controlnet";
import { loadCanvasProjectForEditing } from "@/services/user-data-sync";
import { getImageBlob, resolveImageUrl } from "@/services/image-storage";
import { readScreenImage, deriveScreenOutputMask, persistScreenImage, screenImageFromNode, type ScreenImage } from "@/services/irregular-screen-media";
import { saveScreenCanvas, submitScreenGeneration, recoverScreenGeneration } from "@/services/irregular-screen-generation";
import { createScreenCreationSession, type ScreenCreationSession } from "./screen-creation-session";
import type { ScreenCreationWorkspaceProps, ScreenCreationResult, ScreenMaskMode } from "./screen-creation-types";

export function screenTaskNeedsRecovery(project?: CanvasProject | null) {
    if (!project || !isIrregularScreenScene(project.creationScene)) return false;
    const metadata = project.nodes.find((node) => node.id === project.creationScene!.nodeIds.generation)?.metadata;
    if (!metadata || metadata.status === "success" || metadata.taskStatus === "failed" || metadata.taskStatus === "cancelled") return false;
    return Boolean(metadata.taskId || metadata.taskClientOperationId);
}

export function useScreenCreation(): ScreenCreationWorkspaceProps {
    const navigate = useNavigate();
    const { canvasId } = useParams();
    const userId = useUserStore((state) => state.user?.id);
    const baseConfig = useEffectiveConfig();
    const config = useMemo(() => screenPickerConfig(baseConfig), [baseConfig]);
    const availableModels = config.models;
    const projects = useCanvasStore((state) => state.projects);
    const draftId = useRef(canvasId);
    const project = projects.find((item) => item.id === (canvasId || draftId.current));
    const [model, setModelValue] = useState("");
    const [size, setSizeValue] = useState("");
    const [quality, setQuality] = useState("auto");
    const [prompt, setPrompt] = useState("");
    const [advanced, setAdvancedValue] = useState(() => screenDefaultSettings(baseConfig, ""));
    const [mask, setMask] = useState<ScreenImage | null>(null);
    const [reference, setReference] = useState<ScreenImage | null>(null);
    const [outputMask, setOutputMask] = useState<ScreenImage | null>(null);
    const [maskMode, setMaskModeValue] = useState<ScreenMaskMode>("auto");
    const [results, setResults] = useState<ScreenCreationResult[]>([]);
    const [selectedResultId, setSelectedResultId] = useState("");
    const [busy, setBusy] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [loading, setLoading] = useState(Boolean(canvasId));
    const [loadFailed, setLoadFailed] = useState(false);
    const [error, setError] = useState("");
    const [statusText, setStatusText] = useState("");
    const [storageNotice, setStorageNotice] = useState("");
    const [newVersion, setNewVersion] = useState(0);
    const lock = useRef<symbol | null>(null);
    const uploadEpoch = useRef(0);
    const lifetime = useRef<ScreenCreationSession | null>(null);
    const profile = model ? modelCapabilityConfigFor(baseConfig, model).image : undefined;

    useLayoutEffect(() => {
        const session = createScreenCreationSession();
        lifetime.current = session;
        return () => { session.dispose(); uploadEpoch.current++; };
    }, [canvasId, userId, newVersion]);

    useEffect(() => {
        const session = lifetime.current!;
        draftId.current = canvasId;
        lock.current = null;
        uploadEpoch.current++;
        const initialModel = canvasId ? "" : availableModels[0] || "";
        setError(""); setStorageNotice(""); setStatusText(""); setResults([]); setSelectedResultId("");
        setBusy(false); setUploading(false); setLoadFailed(false);
        setPrompt(""); setMask(null); setReference(null); setOutputMask(null); setMaskModeValue("auto");
        setSizeValue(""); setQuality("auto"); setModelValue(initialModel); setAdvancedValue(screenDefaultSettings(baseConfig, initialModel));
        if (!canvasId) { setLoading(false); return; }
        setLoading(true);
        void (async () => {
            const loaded = await loadCanvasProjectForEditing(canvasId);
            session.assertActive();
            if (!isIrregularScreenScene(loaded.creationScene)) throw new Error("这个画布没有异形屏设置，请从新建场景开始");
            const ids = loaded.creationScene.nodeIds;
            const node = loaded.nodes.find((item) => item.id === ids.generation);
            const control = loaded.nodes.find((item) => item.id === ids.controlImage);
            const output = loaded.nodes.find((item) => item.id === ids.outputMask);
            const content = loaded.nodes.find((item) => item.id === ids.contentReference);
            if (!node || !control || !output || (ids.contentReference && !content)) throw new Error("场景节点已被移除，请打开完整画布恢复节点或新建场景");
            const spec = readNodeGenerationSpec(node);
            if (!spec || spec.modelSelection?.kind !== "channel") throw new Error("场景模型设置不完整，请在画布中检查");
            const selected = `${spec.modelSelection.channelId}::${spec.modelSelection.modelKey}`;
            const images = await Promise.all([screenImageFromNode(control), screenImageFromNode(output), content ? screenImageFromNode(content) : null]);
            session.assertActive();
            const params = spec.options.controlNet?.[0]?.parameters;
            const defaults = screenDefaultSettings(baseConfig, selected);
            const provider = node.metadata?.providerOptions?.[screenModelDefaults(baseConfig, selected).protocol] || {};
            const next = { ...defaults };
            for (const key of ["steps", "sampler", "cfgScale", "seed", "denoisingStrength"] as const) if (typeof provider[key] === "number") next[key] = provider[key] as number;
            if (typeof provider.negativePrompt === "string") next.negativePrompt = provider.negativePrompt;
            if (params) Object.assign(next, { controlModel: params.model, strength: params.strength, start: params.start, end: params.end, resolution: params.canny?.resolution ?? 1024, lowThreshold: params.canny?.lowThreshold ?? 100, highThreshold: params.canny?.highThreshold ?? 200 });
            setModelValue(selected); setAdvancedValue(next); setPrompt(spec.prompt); setSizeValue(spec.options.size || ""); setQuality(spec.options.quality || "auto");
            setMask(images[0]); setOutputMask(images[1]); setReference(images[2]); setMaskModeValue(loaded.creationScene.maskMode || "auto");
            setStorageNotice("已读取保存的画布设置");
        })().catch((failure) => { if (session.isActive()) { setLoadFailed(true); setError(errorText(failure)); } })
            .finally(() => { if (session.isActive()) setLoading(false); });
        // Model catalog refresh must not overwrite edits in the currently open form.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvasId, userId, newVersion]);

    useEffect(() => {
        if (!loading && !canvasId && !model && availableModels[0]) { setModelValue(availableModels[0]); setAdvancedValue(screenDefaultSettings(baseConfig, availableModels[0])); }
    }, [canvasId, model, availableModels, baseConfig, loading, newVersion]);

    const recover = useCallback(async (id: string, session: ScreenCreationSession, signal: AbortSignal) => {
        await recoverScreenGeneration(id, signal, (task) => {
            session.assertActive();
            if (signal.aborted) return;
            setStatusText(task.status === "succeeded" ? "正在保存生成结果…" : `${task.stage || "生成中"}${typeof task.progress === "number" ? ` · ${task.progress}%` : ""}`);
        });
        session.assertActive();
        if (signal.aborted) return;
        const completed = useCanvasStore.getState().openProject(id);
        const resultId = completed && isIrregularScreenScene(completed.creationScene) ? completed.creationScene.nodeIds.generation : undefined;
        const result = completed?.nodes.find((node) => node.id === resultId);
        if (!result || result.metadata?.status !== "success" || !result.metadata.storageKey || !result.metadata.assetId) throw new Error("结果尚未保存，请重新读取任务或打开完整画布检查");
        setSelectedResultId(result.id);
        setStatusText("生成完成"); setStorageNotice("结果与画布已保存"); setError("");
    }, []);

    useEffect(() => {
        if (!canvasId || loading || loadFailed || lock.current || !screenTaskNeedsRecovery(useCanvasStore.getState().openProject(canvasId))) return;
        const session = lifetime.current!;
        const controller = new AbortController();
        const abort = () => controller.abort();
        session.signal.addEventListener("abort", abort, { once: true });
        const token = Symbol("recover");
        lock.current = token; setBusy(true); setStatusText("正在读取已提交的任务…");
        void recover(canvasId, session, controller.signal)
            .catch((failure) => { if (session.isActive() && !controller.signal.aborted) { setError(errorText(failure)); setStatusText(""); } })
            .finally(() => { if (lock.current === token) { lock.current = null; if (session.isActive() && !controller.signal.aborted) setBusy(false); } });
        return () => {
            controller.abort(); session.signal.removeEventListener("abort", abort);
            if (lock.current === token) { lock.current = null; if (session.isActive()) setBusy(false); }
        };
    }, [canvasId, loading, loadFailed, newVersion, userId, recover]);

    useEffect(() => {
        const session = lifetime.current!;
        let current = true;
        if (loading || loadFailed || project?.id !== (canvasId || draftId.current)) return;
        const generationId = project && isIrregularScreenScene(project.creationScene) ? project.creationScene.nodeIds.generation : undefined;
        const candidates = (project?.nodes.filter((node) => node.metadata?.taskId && node.metadata?.storageKey && node.metadata?.assetId && node.metadata?.status === "success") || [])
            .sort((left, right) => left.id === generationId ? -1 : right.id === generationId ? 1 : (right.metadata?.taskCompletedAt || "").localeCompare(left.metadata?.taskCompletedAt || ""));
        void Promise.all(candidates.map(async (node) => ({ id: node.id, storageKey: node.metadata!.storageKey, url: await resolveImageUrl(node.metadata!.storageKey), width: node.metadata?.naturalWidth, height: node.metadata?.naturalHeight, createdAt: node.metadata?.taskCompletedAt })))
            .then((value) => { if (current && session.isActive()) { setResults(value); setSelectedResultId((id) => value.some((item) => item.id === id) ? id : value[0]?.id || ""); } })
            .catch((failure) => { if (current && session.isActive()) setError(errorText(failure)); });
        return () => { current = false; };
    }, [project?.nodes, canvasId, userId, newVersion, loading, loadFailed]);

    const chooseSize = (image: ScreenImage, nextModel = model) => {
        const nextProfile = modelCapabilityConfigFor(baseConfig, nextModel).image;
        if (!nextProfile) throw new Error("请先选择可用模型");
        const selected = resolveIrregularScreenOutputSize(image, nextProfile);
        setSizeValue(selected.size);
        if (selected.scaled) setStorageNotice(`原图 ${image.width}×${image.height}，输出 ${selected.width}×${selected.height}${selected.aspectRatioAdjusted ? "（像素比例取整）" : ""}`);
    };
    const setModel = (value: string) => { setModelValue(value); setAdvancedValue(screenDefaultSettings(baseConfig, value)); setError(""); if (mask) try { chooseSize(mask, value); } catch (failure) { setSizeValue(""); setError(errorText(failure)); } };
    const upload = async (file: File, role: "mask" | "reference") => {
        const session = lifetime.current;
        if (!session?.isActive()) return;
        const token = ++uploadEpoch.current;
        setUploading(true); setError("");
        try {
            const pixels = await readScreenImage(file); session.assertActive();
            if (token !== uploadEpoch.current) return;
            const image: ScreenImage = { storageKey: "", blob: file, url: session.ownUrl(URL.createObjectURL(file)), width: pixels.width, height: pixels.height, mimeType: file.type, bytes: file.size, name: file.name, uploadKey: nanoid() };
            if (role === "reference") setReference(image);
            else {
                const derived = await deriveScreenOutputMask(image, maskMode);
                session.ownUrl(derived.image.url);
                if (token !== uploadEpoch.current) { session.releaseUrl(derived.image.url); return; }
                setMask(image); setOutputMask({ ...derived.image, uploadKey: nanoid() }); setStorageNotice(derived.warnings.join("；"));
                if (model) chooseSize(image);
            }
        } catch (failure) { if (session.isActive() && token === uploadEpoch.current) setError(errorText(failure)); }
        finally { if (session.isActive() && token === uploadEpoch.current) setUploading(false); }
    };
    const changeMaskMode = async (value: ScreenMaskMode) => {
        const session = lifetime.current;
        if (!session?.isActive()) return;
        setMaskModeValue(value); if (!mask) return;
        const token = ++uploadEpoch.current;
        setUploading(true); setOutputMask(null); setError("");
        try {
            const derived = await deriveScreenOutputMask(mask, value); session.ownUrl(derived.image.url);
            if (token !== uploadEpoch.current) { session.releaseUrl(derived.image.url); return; }
            setOutputMask({ ...derived.image, uploadKey: nanoid() }); setStorageNotice(derived.warnings.join("；"));
        } catch (failure) { if (session.isActive() && token === uploadEpoch.current) setError(errorText(failure)); }
        finally { if (session.isActive() && token === uploadEpoch.current) setUploading(false); }
    };

    let disabledReason = screenModelError(baseConfig, model, Boolean(reference));
    if (!disabledReason && !mask) disabledReason = "请上传屏幕蒙版";
    if (!disabledReason && !outputMask) disabledReason = "请先确认有效屏幕区域";
    if (!disabledReason && !prompt.trim()) disabledReason = "请输入画面描述";
    if (!disabledReason && !size) disabledReason = "当前模型没有与蒙版匹配的输出尺寸";
    if (!disabledReason && profile?.controlNet?.models?.length && !profile.controlNet.models.includes(advanced.controlModel)) disabledReason = "所选控制模型与当前图片模型不兼容";
    try { validateControlNetBindings([{ id: "screen", imageBindingId: "screen", parameters: screenControlParameters(advanced) }]); } catch (failure) { disabledReason ||= errorText(failure); }
    const needsRecovery = screenTaskNeedsRecovery(project);

    const persist = async (session: ScreenCreationSession) => {
        session.assertActive();
        if (disabledReason) throw new Error(disabledReason);
        const signal = session.signal;
        setStatusText("正在保存输入素材…");
        const original = await persistScreenImage(mask!, mask!.uploadKey || nanoid(), signal); session.assertActive(); setMask(original);
        const region = await persistScreenImage(outputMask!, outputMask!.uploadKey || nanoid(), signal); session.assertActive(); setOutputMask(region);
        const content = reference ? await persistScreenImage(reference, reference.uploadKey || nanoid(), signal) : undefined; session.assertActive(); if (content) setReference(content);
        const id = draftId.current || useCanvasStore.getState().createProject(`异形屏 · ${prompt.trim().slice(0, 24)}`);
        draftId.current = id;
        const channel = screenModelDefaults(baseConfig, model).channel;
        const saved = await saveScreenCanvas(id, { controlImage: original, outputMask: region, contentReference: content, prompt, modelSelection: { kind: "channel", channelId: channel.id, modelKey: modelOptionName(model) }, controlParameters: screenControlParameters(advanced), size, quality, maskMode, providerOptions: screenProviderOptions(baseConfig, model, advanced, Boolean(content)) }, signal);
        session.assertActive(); setStorageNotice("设置已保存到画布"); return saved;
    };
    const generate = async () => {
        const session = lifetime.current;
        if (!session?.isActive() || lock.current || busy || uploading || loading) return;
        const token = Symbol("generate");
        lock.current = token; setBusy(true); setError("");
        try {
            const existingId = canvasId || draftId.current;
            if (existingId && screenTaskNeedsRecovery(useCanvasStore.getState().openProject(existingId))) {
                setStatusText("正在读取已提交的任务…");
                await recover(existingId, session, session.signal);
                session.assertActive();
                if (!canvasId) navigate(`/screen-creation/${existingId}`, { replace: true });
                return;
            }
            const saved = await persist(session);
            session.assertActive(); setStatusText("正在提交生成任务…");
            await submitScreenGeneration(saved, { ...baseConfig, model, imageModel: model, size, quality, count: "1", transparentBackground: "false" }, session.signal);
            session.assertActive();
            if (canvasId !== saved.id) navigate(`/screen-creation/${saved.id}`, { replace: true });
            else await recover(saved.id, session, session.signal);
        } catch (failure) { if (session.isActive()) { setError(errorText(failure)); setStatusText(""); } }
        finally { if (lock.current === token) { lock.current = null; if (session.isActive()) setBusy(false); } }
    };
    const openCanvas = async () => {
        const session = lifetime.current;
        if (!session?.isActive()) return;
        const existingId = canvasId || draftId.current;
        if (existingId && (loadFailed || disabledReason || screenTaskNeedsRecovery(useCanvasStore.getState().openProject(existingId)))) {
            navigate(`/canvas/${existingId}`);
            return;
        }
        if (lock.current || busy || loading || uploading) return;
        const token = Symbol("open-canvas");
        lock.current = token; setBusy(true); setError("");
        try { const saved = await persist(session); session.assertActive(); navigate(`/canvas/${saved.id}`); }
        catch (failure) { if (session.isActive()) { setError(errorText(failure)); setStatusText(""); } }
        finally { if (lock.current === token) { lock.current = null; if (session.isActive()) setBusy(false); } }
    };
    const { channel } = screenModelDefaults(baseConfig, model);
    const credit = requestCreditCost({ channelMode: baseConfig.channelMode, modelCosts: channel.modelCosts, model: modelOptionName(model), count: 1, capability: "image", config: { ...baseConfig, model, size, quality }, requirements: { capability: "image", controlNetUnits: 1, imageSize: size, input: { imageCount: reference ? 1 : 0, characterCount: 0, videoCount: 0, audioCount: 0, textCount: 0 } } });

    return {
        config, model, setModel, profile, size, quality, setSize: (value, nextQuality) => { setSizeValue(value); if (nextQuality) setQuality(nextQuality); },
        mask: mask ? { ...mask, name: mask.name || "屏幕蒙版" } : null, reference: reference ? { ...reference, name: reference.name || "内容参考图" } : null,
        uploadMask: (file) => upload(file, "mask"), uploadReference: (file) => upload(file, "reference"),
        clearMask: () => { uploadEpoch.current++; setMask(null); setOutputMask(null); setUploading(false); }, clearReference: () => { uploadEpoch.current++; setReference(null); setUploading(false); },
        maskMode, setMaskMode: (value) => { void changeMaskMode(value); }, prompt, setPrompt, advanced, setAdvanced: (patch) => setAdvancedValue((value) => ({ ...value, ...patch })),
        effectiveMaskUrl: outputMask?.url, effectiveMaskStorageKey: outputMask?.storageKey, results, selectedResultId, setSelectedResultId, busy, uploading, loading, error, statusText, storageNotice,
        canGenerate: (needsRecovery || !disabledReason) && !busy && !uploading && !loading && !loadFailed, disabledReason: needsRecovery ? undefined : disabledReason, generate, generateLabel: needsRecovery ? "继续读取结果" : "生成画面",
        quoteLabel: needsRecovery ? "继续读取原任务，不会重新提交" : credit === null ? "费用以后台模型配置为准" : `本次消耗 ${credit.toLocaleString("zh-CN", { maximumFractionDigits: 6 })} 积分`,
        canvasId: canvasId || draftId.current, sceneName: project?.title, recentScenes: projects.filter((item) => isIrregularScreenScene(item.creationScene)).map((item) => ({ id: item.id, name: item.title, updatedAt: item.updatedAt })),
        newScene: () => { lifetime.current?.dispose(); if (!canvasId) setNewVersion((value) => value + 1); else navigate("/screen-creation"); },
        openScene: (id) => { lifetime.current?.dispose(); if (id === canvasId) setNewVersion((value) => value + 1); else navigate(`/screen-creation/${id}`); },
        openCanvas: () => { void openCanvas(); },
        downloadResult: async (id) => {
            const session = lifetime.current;
            if (!session?.isActive()) return;
            try {
                const node = project?.nodes.find((item) => item.id === id);
                if (!node?.metadata?.storageKey) throw new Error("结果尚未保存");
                const blob = await getImageBlob(node.metadata.storageKey);
                session.assertActive();
                if (!blob) throw new Error("下载失败，请重新读取结果");
                saveAs(blob, "异形屏画面.png");
            } catch (failure) { if (session.isActive()) setError(errorText(failure)); }
        },
    };
}

function errorText(error: unknown) { return error instanceof Error ? error.message : "操作失败，请稍后重试"; }
