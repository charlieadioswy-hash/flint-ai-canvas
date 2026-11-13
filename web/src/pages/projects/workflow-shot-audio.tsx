import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Select } from "antd";

import { ModelPicker } from "@/components/model-picker";
import { audioVoiceOptionsForConfig } from "@/lib/audio-generation";
import { audioFileExtension } from "@/lib/character-voice-formats";
import { createClientUUID } from "@/lib/client-id";
import { formatDramaCredits } from "@/lib/drama/drama-format";
import { dramaChoiceToModel, modelToDramaChoice } from "@/lib/drama/model-choice";
import type { DramaShot } from "@/services/api/drama";
import {
    adoptDramaShotMedia,
    executeDramaShotMedia,
    getDramaShotMedia,
    preflightDramaShotMedia,
    saveDramaShotMedia,
    type DramaShotMedia,
    type DramaShotMediaAction,
    type DramaShotMediaConfig,
    type DramaShotMediaPreflight,
} from "@/services/api/drama-shot-media";
import { ApiError } from "@/services/api/request";
import { getResource } from "@/services/api/resources";
import { selectableModelsByCapability, useEffectiveConfig } from "@/stores/use-config-store";

import { downloadResource, useResourceMediaUrl } from "./drama-shared";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { clearShotAudioPending, readShotAudioPending, writeShotAudioPending } from "./workflow-shot-audio-state";

type Props = { projectId: string; shot: DramaShot; userId: string; onChanged?: () => void; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void };
type Quote = { preview: DramaShotMediaPreflight; action: DramaShotMediaAction };
const STATUS: Record<string, string> = { idle: "待生成", ready: "已采用", queued: "排队中", running: "生成中", succeeded: "已完成", failed: "生成失败", cancelled: "已取消", awaiting_adoption: "待试听与采用", stale: "镜头已有变更" };

function ShotAudioPreview({ resourceId }: { resourceId: string }) {
    const url = useResourceMediaUrl(resourceId, "playback");
    const audio = useRef<HTMLAudioElement>(null);
    useEffect(() => {
        const element = audio.current;
        return () => {
            element?.pause();
            element?.removeAttribute("src");
            element?.load();
        };
    }, [resourceId, url]);
    return url ? <audio ref={audio} controls preload="metadata" src={url} aria-label="试听镜头音频" /> : <p role="status">正在读取镜头音频…</p>;
}

export function WorkflowShotAudioEditor({ projectId, shot, userId, onChanged, onDirtyChange, onBusyChange }: Props) {
    const operation = useDramaOperationScope(projectId);
    const client = useQueryClient();
    const config = useEffectiveConfig();
    const queryKey = ["drama-shot-media", userId, projectId, shot.id, "audio"];
    const query = useQuery({ queryKey, queryFn: ({ signal }) => getDramaShotMedia(projectId, shot.id, "audio", signal), refetchInterval: (value) => (["queued", "running"].includes(value.state.data?.status || "") ? 3000 : false) });
    const [draft, setDraft] = useState<DramaShotMediaConfig>();
    const [baseline, setBaseline] = useState<{ revision: number; config: string }>();
    const [quote, setQuote] = useState<Quote>();
    const [pending, setPending] = useState<DramaShotMediaAction>();
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const locked = useRef(false);
    const current = query.data;
    const active = ["queued", "running"].includes(current?.status || "");
    const dirty = Boolean(draft && baseline && JSON.stringify(draft) !== baseline.config);
    const stale = Boolean(current && baseline && current.revision !== baseline.revision);
    const disabled = Boolean(busy || pending || !loaded || active);
    const selectedModel = draft ? dramaChoiceToModel(config, "audio", draft.model) : "";
    const available = selectableModelsByCapability(config, "audio").some((model) => Boolean(modelToDramaChoice(config, model)));
    const voices = selectedModel ? audioVoiceOptionsForConfig({ ...config, model: selectedModel }) : [];
    const playable = Boolean(selectedModel && draft?.audioVoice && draft?.prompt.trim());
    useEffect(() => {
        onDirtyChange(dirty);
    }, [dirty, onDirtyChange]);
    useEffect(() => {
        onBusyChange(Boolean(busy || pending));
    }, [busy, pending, onBusyChange]);
    useEffect(() => {
        if (current && !draft) {
            setDraft(current.config);
            setBaseline({ revision: current.revision, config: JSON.stringify(current.config) });
        }
    }, [current, draft]);
    const load = async () => {
        const ticket = operation.capture();
        setLoadError("");
        try {
            const value = await readShotAudioPending(userId, projectId, shot.id);
            if (operation.isCurrent(ticket)) {
                setPending(value);
                setLoaded(true);
            }
        } catch (reason) {
            if (operation.isCurrent(ticket)) setLoadError(reason instanceof Error ? reason.message : "读取音频提交记录失败");
        }
    };
    useEffect(() => {
        void load();
    }, []);
    const accept = (value: DramaShotMedia) => {
        client.setQueryData(queryKey, value);
        setDraft(value.config);
        setBaseline({ revision: value.revision, config: JSON.stringify(value.config) });
    };
    const patch = (value: Partial<DramaShotMediaConfig>) => {
        if (disabled) return;
        setDraft((previous) => (previous ? { ...previous, ...value } : previous));
        setQuote(undefined);
        setNotice("");
    };
    const run = async (name: string, action: (ticket: ReturnType<typeof operation.capture>) => Promise<void>) => {
        if (locked.current) return;
        locked.current = true;
        setBusy(name);
        setError("");
        const ticket = operation.capture();
        try {
            await action(ticket);
        } catch (reason) {
            if (operation.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : "镜头音频操作失败");
        } finally {
            locked.current = false;
            if (operation.isCurrent(ticket)) setBusy("");
        }
    };
    const save = async (ticket: ReturnType<typeof operation.capture>) => {
        if (!draft || !baseline || stale) throw new Error("音频配置已有更新，请关闭并确认放弃草稿后重新载入");
        const value = await saveDramaShotMedia(projectId, shot.id, "audio", { expectedRevision: baseline.revision, config: draft });
        if (operation.isCurrent(ticket)) accept(value);
        return value;
    };
    const execute = () =>
        run("execute", async (ticket) => {
            const action = pending || (quote?.preview.ready && quote.preview.priced ? quote.action : undefined);
            if (!action) return;
            await writeShotAudioPending(userId, projectId, shot.id, action);
            if (!operation.isCurrent(ticket)) return;
            setPending(action);
            try {
                await executeDramaShotMedia(projectId, shot.id, "audio", action);
                await clearShotAudioPending(userId, projectId, shot.id);
                if (!operation.isCurrent(ticket)) return;
                setPending(undefined);
                setQuote(undefined);
                setNotice("镜头音频已提交，完成后请试听并手动采用");
                const value = await getDramaShotMedia(projectId, shot.id, "audio");
                if (operation.isCurrent(ticket)) {
                    accept(value);
                    onChanged?.();
                }
            } catch (reason) {
                const rejected = reason instanceof ApiError && [reason.status, reason.code].some((status) => status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429);
                if (rejected) {
                    await clearShotAudioPending(userId, projectId, shot.id);
                    if (operation.isCurrent(ticket)) {
                        setPending(undefined);
                        setQuote(undefined);
                    }
                }
                throw reason;
            }
        });
    if (query.isError && !current)
        return (
            <p role="alert">
                镜头音频读取失败 <Button onClick={() => void query.refetch()}>重新载入</Button>
            </p>
        );
    if (!draft || !baseline) return <p role="status">正在读取镜头音频…</p>;
    return (
        <div className="drama-shot-media-columns">
            <section className="drama-shot-media-config" aria-label="独立镜头音频配置">
                <p>音频作为独立文件保存，可试听、采用和下载。不会自动混入成片或剪映时间线；资产包会包含已采用的音频。</p>
                {!available ? <p role="status">当前没有可用的平台语音模型，请先在后台配置音频模型。</p> : null}
                <fieldset className="drama-shot-media-model" disabled={disabled} inert={disabled}>
                    <label>
                        <span>语音模型</span>
                        <ModelPicker
                            config={config}
                            capability="audio"
                            value={selectedModel}
                            fullWidth
                            modelDisabledReason={(model) => (modelToDramaChoice(config, model) ? "" : "请选择可在服务端执行的平台语音模型")}
                            onChange={(model) => {
                                const choice = modelToDramaChoice(config, model);
                                if (choice) patch({ model: choice, audioVoice: "" });
                            }}
                        />
                    </label>
                    <label>
                        <span>音色</span>
                        <Select aria-label="镜头音频音色" value={draft.audioVoice || undefined} options={voices} placeholder="先选择模型，再选择音色" disabled={!selectedModel} onChange={(audioVoice) => patch({ audioVoice })} />
                    </label>
                    <label>
                        <span>朗读文本</span>
                        <Input.TextArea aria-label="镜头朗读文本" value={draft.prompt} rows={5} maxLength={1000} onChange={(event) => patch({ prompt: event.target.value })} />
                    </label>
                    <label>
                        <span>语气与演绎要求（可选）</span>
                        <Input.TextArea aria-label="镜头音频演绎要求" value={draft.audioInstructions || ""} rows={3} maxLength={4000} onChange={(event) => patch({ audioInstructions: event.target.value })} />
                    </label>
                </fieldset>
                {loadError ? (
                    <p role="alert">
                        {loadError} <Button onClick={() => void load()}>重新读取提交记录</Button>
                    </p>
                ) : null}
                {error ? <p role="alert">{error}</p> : null}
                {notice ? <p role="status">{notice}</p> : null}
                {stale ? <p role="status">音频已有新版本，当前草稿保留，请重新载入后再操作。</p> : null}
                <div className="drama-shot-media-actions">
                    <Button
                        disabled={disabled || stale || !playable || (!dirty && Boolean(current?.id))}
                        onClick={() =>
                            void run("save", async (ticket) => {
                                await save(ticket);
                                if (operation.isCurrent(ticket)) setNotice("镜头音频配置已保存");
                            })
                        }
                    >
                        保存音频配置
                    </Button>
                    <Button
                        disabled={disabled || stale || !playable || !available}
                        onClick={() =>
                            void run("check", async (ticket) => {
                                if (!current || !baseline) return;
                                const value = dirty || !current.id ? await save(ticket) : current;
                                if (!operation.isCurrent(ticket)) return;
                                const preview = await preflightDramaShotMedia(projectId, shot.id, "audio", { expectedRevision: value.revision });
                                if (operation.isCurrent(ticket))
                                    setQuote({ preview, action: { expectedRevision: preview.revision, baseRevision: preview.baseRevision, confirmationToken: preview.confirmationToken, clientOperationId: `shot-audio:${createClientUUID()}` } });
                            })
                        }
                    >
                        预检生成音频
                    </Button>
                    <Button
                        disabled={Boolean(busy || pending)}
                        onClick={() =>
                            void run("reload", async (ticket) => {
                                if (dirty) throw new Error("请先保存配置，或关闭后放弃草稿再载入");
                                const value = await getDramaShotMedia(projectId, shot.id, "audio");
                                if (operation.isCurrent(ticket)) {
                                    accept(value);
                                    setQuote(undefined);
                                }
                            })
                        }
                    >
                        重新载入音频
                    </Button>
                </div>
                {quote || pending ? (
                    <div role="status">
                        {pending ? "提交结果待确认，将复用原提交标识。" : quote?.preview.reason || `${quote?.preview.estimated ? "预估" : "本次"} ${formatDramaCredits(quote?.preview.amountMicrocredits || 0)} 积分`}
                        {pending || quote?.preview.ready ? (
                            <Button type="primary" disabled={Boolean(busy) || (!pending && (!quote?.preview.priced || stale))} onClick={() => void execute()}>
                                {pending ? "核对音频提交结果" : "确认生成镜头音频"}
                            </Button>
                        ) : null}
                    </div>
                ) : null}
            </section>
            <aside className="drama-shot-media-output" aria-label="镜头音频结果与版本">
                <strong>当前采用 · {STATUS[current?.status || "idle"] || current?.status}</strong>
                {current?.resourceId ? (
                    <>
                        <ShotAudioPreview key={current.resourceId} resourceId={current.resourceId} />
                        <Button
                            onClick={() =>
                                void run("download", async (ticket) => {
                                    const resource = await getResource(current.resourceId!);
                                    if (operation.isCurrent(ticket)) await downloadResource(resource.id, `镜头${shot.position + 1}-音频.${audioFileExtension(resource.mimeType)}`);
                                })
                            }
                        >
                            下载独立音频
                        </Button>
                    </>
                ) : (
                    <p>尚未采用镜头音频</p>
                )}
                {current?.error ? <p role="alert">{current.error}</p> : null}
                <strong>试听与历史版本</strong>
                {current?.takes.map((take) => (
                    <div className="drama-shot-media-take" key={take.id}>
                        <span>
                            版本 {take.version} · {take.current ? "当前采用" : STATUS[take.status] || take.status}
                        </span>
                        {take.resourceId ? <ShotAudioPreview key={take.resourceId} resourceId={take.resourceId} /> : null}
                        {take.error ? <p role="alert">{take.error}</p> : null}
                        {!take.current && take.resourceId ? (
                            <Button
                                disabled={Boolean(busy || pending || dirty || stale)}
                                onClick={() =>
                                    void run("adopt", async (ticket) => {
                                        if (!current) return;
                                        const value = await adoptDramaShotMedia(projectId, shot.id, "audio", { expectedRevision: current.revision, takeId: take.id });
                                        if (operation.isCurrent(ticket)) {
                                            accept(value);
                                            setQuote(undefined);
                                            setNotice("已采用此镜头音频，仍作为独立文件保存");
                                            onChanged?.();
                                        }
                                    })
                                }
                            >
                                采用此音频版本
                            </Button>
                        ) : null}
                    </div>
                ))}
                {!current?.takes.length ? <p>提交后会记录真实音频任务与版本。</p> : null}
            </aside>
        </div>
    );
}
