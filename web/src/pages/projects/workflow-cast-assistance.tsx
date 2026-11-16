import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Select } from "antd";
import { ImagePlus, Mic, Sparkles } from "lucide-react";

import { AssetLibraryPickerModal } from "@/components/assets/asset-library-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { AppModal } from "@/components/ui/product/app-modal";
import { createClientUUID } from "@/lib/client-id";
import { audioVoiceOptionsForConfig } from "@/lib/audio-generation";
import { formatDramaCredits } from "@/lib/drama/drama-format";
import { dramaChoiceToModel, modelToDramaChoice } from "@/lib/drama/model-choice";
import type { DramaCast, DramaSummary } from "@/services/api/drama";
import {
    adoptDramaCastAssistance,
    executeDramaCastAssistance,
    getDramaCastAssistance,
    preflightDramaCastAssistance,
    type DramaCastAssistancePreflight,
    type DramaCastAssistancePurpose,
    type DramaCastAssistanceRequest,
} from "@/services/api/drama-cast-assistance";
import { ApiError } from "@/services/api/request";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

import { DramaModelPicker } from "./drama-model-picker";
import { MediaThumb } from "./drama-shared";
import { CastVoicePreview } from "./studio/cast-voice";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { clearCastAssistancePending, readCastAssistancePending, writeCastAssistancePending } from "./workflow-cast-assistance-state";
import "./workflow-cast-assistance.css";

const TITLE: Record<DramaCastAssistancePurpose, string> = { voice_sample: "生成音色试听", fill_description: "AI 补写外观", image_prompt: "图片反推提示词" };
const STATUS: Record<string, string> = { queued: "排队中", running: "生成中", succeeded: "已完成", failed: "生成失败", cancelled: "已取消" };
type Props = { summary: DramaSummary; cast: DramaCast; onChanged: () => void; disabled?: boolean; children?: ReactNode };
type Quote = { view: DramaCastAssistancePreflight; request: DramaCastAssistanceRequest };

export function WorkflowCastAssistance(props: Props) {
    const [purpose, setPurpose] = useState<DramaCastAssistancePurpose>();
    const userId = useUserStore((state) => state.user?.id || "");
    return (
        <section className="drama-cast-assistance" aria-label="资产 AI 辅助">
            <div className="drama-cast-assistance-actions">
                <Button size="small" icon={<Sparkles className="size-3.5" />} disabled={props.disabled} onClick={() => setPurpose("fill_description")}>
                    AI 补写外观
                </Button>
                <Button size="small" icon={<ImagePlus className="size-3.5" />} disabled={props.disabled} onClick={() => setPurpose("image_prompt")}>
                    图片反推提示词
                </Button>
                {props.cast.kind === "character" && !props.cast.parentId ? (
                    <Button size="small" icon={<Mic className="size-3.5" />} disabled={props.disabled} onClick={() => setPurpose("voice_sample")}>
                        生成音色试听
                    </Button>
                ) : null}
                {props.children}
            </div>
            {purpose ? <AssistanceSession key={`${userId}:${props.summary.project.id}:${props.cast.id}:${purpose}`} {...props} purpose={purpose} userId={userId} onClose={() => setPurpose(undefined)} /> : null}
        </section>
    );
}

function AssistanceSession({ summary, cast, onChanged, purpose, userId, onClose }: Props & { purpose: DramaCastAssistancePurpose; userId: string; onClose: () => void }) {
    const projectId = summary.project.id;
    const castRevision = cast.revision ?? -1;
    const operation = useDramaOperationScope(projectId);
    const config = useEffectiveConfig();
    const client = useQueryClient();
    const queryKey = ["drama-cast-assistance", userId, projectId, cast.id, purpose];
    const query = useQuery({ queryKey, queryFn: ({ signal }) => getDramaCastAssistance(projectId, cast.id, signal), refetchInterval: (value) => (value.state.data?.some((item) => ["queued", "running"].includes(item.status)) ? 3000 : false) });
    const [draft, setDraft] = useState<DramaCastAssistanceRequest>(() => ({
        purpose,
        expectedRevision: summary.production.revision,
        castRevision,
        model: purpose === "voice_sample" ? modelToDramaChoice(config, config.audioModel || "") || {} : summary.production.settings.models.text,
        instruction: "",
        sampleText: purpose === "voice_sample" ? `你好，我是${cast.name}。` : "",
        voiceKey: "",
        sourceResourceId: purpose === "image_prompt" ? cast.imageResourceId || "" : "",
    }));
    const [quote, setQuote] = useState<Quote>();
    const [pending, setPending] = useState<DramaCastAssistanceRequest>();
    const [pendingLoaded, setPendingLoaded] = useState(false);
    const [pendingError, setPendingError] = useState("");
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [pickerOpen, setPickerOpen] = useState(false);
    const [texts, setTexts] = useState<Record<string, string>>({});
    const locked = useRef(false);
    const results = (query.data || []).filter((item) => item.purpose === purpose);
    const active = results.some((item) => ["queued", "running"].includes(item.status));
    const disabled = Boolean(busy || pending || !pendingLoaded || active || castRevision < 0);
    const selectedAudioModel = dramaChoiceToModel(config, "audio", draft.model);
    const voices = audioVoiceOptionsForConfig({ ...config, model: selectedAudioModel });

    const loadPending = async () => {
        const ticket = operation.capture();
        setPendingLoaded(false);
        setPendingError("");
        try {
            const saved = await readCastAssistancePending(userId, projectId, cast.id, purpose);
            if (!operation.isCurrent(ticket)) return;
            setPending(saved);
            if (saved) setDraft(saved);
            setPendingLoaded(true);
        } catch (reason) {
            if (operation.isCurrent(ticket)) setPendingError(reason instanceof Error ? reason.message : "读取待确认提交失败");
        }
    };
    useEffect(() => {
        void loadPending();
        // Each session is keyed by account, project, asset and purpose.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => {
        setQuote(undefined);
    }, [cast.revision, summary.production.revision]);

    const patch = (value: Partial<DramaCastAssistanceRequest>) => {
        if (disabled) return;
        setDraft((previous) => ({ ...previous, ...value }));
        setQuote(undefined);
        setError("");
        setNotice("");
    };
    const run = async (name: string, action: (ticket: ReturnType<typeof operation.capture>) => Promise<void>) => {
        if (locked.current) return;
        locked.current = true;
        const ticket = operation.capture();
        setBusy(name);
        setError("");
        try {
            await action(ticket);
        } catch (reason) {
            if (operation.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : "操作失败");
        } finally {
            locked.current = false;
            if (operation.isCurrent(ticket)) setBusy("");
        }
    };
    const check = () =>
        run("preflight", async (ticket) => {
            if (castRevision < 0) throw new Error("资产版本未载入，请关闭后刷新资产");
            const request = { ...draft, expectedRevision: summary.production.revision, castRevision, confirmationToken: undefined, clientOperationId: undefined };
            const view = await preflightDramaCastAssistance(projectId, cast.id, request);
            if (operation.isCurrent(ticket)) setQuote({ view, request: { ...request, confirmationToken: view.confirmationToken, clientOperationId: `cast-assist:${createClientUUID()}` } });
        });
    const execute = () =>
        run("execute", async (ticket) => {
            const request = pending || (quote?.view.ready && quote.view.priced ? quote.request : undefined);
            if (!request) return;
            await writeCastAssistancePending(userId, projectId, cast.id, request);
            if (!operation.isCurrent(ticket)) return;
            setPending(request);
            try {
                const task = await executeDramaCastAssistance(projectId, cast.id, request);
                await clearCastAssistancePending(userId, projectId, cast.id, purpose);
                if (!operation.isCurrent(ticket)) return;
                setPending(undefined);
                setQuote(undefined);
                setNotice(`任务已提交 · ${STATUS[task.status] || task.stage || "等待更新"}`);
                await query.refetch();
            } catch (reason) {
                const rejected = reason instanceof ApiError && [reason.status, reason.code].some((value) => value !== undefined && value >= 400 && value < 500 && value !== 408 && value !== 429);
                if (rejected) {
                    await clearCastAssistancePending(userId, projectId, cast.id, purpose);
                    if (operation.isCurrent(ticket)) {
                        setPending(undefined);
                        setQuote(undefined);
                    }
                }
                throw reason;
            }
        });

    return (
        <AppModal open title={`${cast.lookName || cast.name} · ${TITLE[purpose]}`} onCancel={onClose} footer={null} centered width="min(720px, calc(100vw - 32px))" rootClassName="drama-root" closable={!busy} maskClosable={!busy} keyboard={!busy}>
            <div className="drama-cast-assistance-dialog">
                <p className="text-sm text-muted-foreground">{purpose === "voice_sample" ? "使用所选模型音色合成试听，试听后可绑定为角色声音样本。" : "生成可编辑草稿，审阅后手动采用。原始说明始终保留。"}</p>
                {castRevision < 0 ? <p role="alert">资产版本未载入，请关闭后刷新资产。</p> : null}
                <fieldset disabled={disabled} inert={disabled} className="drama-cast-assistance-form">
                    <label>
                        <span>模型</span>
                        {purpose === "voice_sample" ? (
                            <ModelPicker
                                config={config}
                                capability="audio"
                                value={selectedAudioModel}
                                fullWidth
                                modelDisabledReason={(model) => (modelToDramaChoice(config, model) ? "" : "请选择可在服务端执行的平台模型")}
                                onChange={(model) => {
                                    const choice = modelToDramaChoice(config, model);
                                    if (choice) patch({ model: choice, voiceKey: "" });
                                }}
                            />
                        ) : (
                            <DramaModelPicker capability="text" value={draft.model} onChange={(model) => patch({ model })} />
                        )}
                    </label>
                    {purpose === "voice_sample" ? (
                        <>
                            <label>
                                <span>音色</span>
                                <Select aria-label="试听音色" value={draft.voiceKey || undefined} placeholder="选择模型音色" options={voices} onChange={(voiceKey) => patch({ voiceKey })} />
                            </label>
                            <label>
                                <span>试听文本</span>
                                <Input.TextArea aria-label="试听文本" value={draft.sampleText} rows={3} maxLength={1000} onChange={(event) => patch({ sampleText: event.target.value })} />
                            </label>
                        </>
                    ) : null}
                    {purpose === "image_prompt" ? (
                        <div className="drama-cast-assistance-source">
                            {draft.sourceResourceId ? <MediaThumb resourceId={draft.sourceResourceId} alt="反推来源图片" /> : <span>尚未选择反推图片</span>}
                            <Button icon={<ImagePlus className="size-4" />} onClick={() => setPickerOpen(true)}>
                                从资产库选择图片
                            </Button>
                        </div>
                    ) : null}
                    <label>
                        <span>{purpose === "voice_sample" ? "语气与演绎要求（可选）" : "补充要求（可选）"}</span>
                        <Input.TextArea aria-label="辅助生成要求" value={draft.instruction} rows={3} maxLength={4000} onChange={(event) => patch({ instruction: event.target.value })} />
                    </label>
                </fieldset>
                {pendingError ? (
                    <p role="alert">
                        {pendingError} <Button onClick={() => void loadPending()}>重新读取提交记录</Button>
                    </p>
                ) : null}
                {query.isError ? (
                    <p role="alert">
                        读取任务历史失败 <Button onClick={() => void query.refetch()}>重新载入</Button>
                    </p>
                ) : null}
                {error ? <p role="alert">{error}</p> : null}
                {notice ? <p role="status">{notice}</p> : null}
                {pending ? <p role="status">提交结果待确认，使用原提交标识查询，避免重复计费。</p> : null}
                {quote ? <p role="status">{quote.view.ready ? `${quote.view.estimated ? "预计" : "本次"} ${formatDramaCredits(quote.view.amountMicrocredits)} 积分，确认后生成。` : quote.view.reason || "当前无法生成"}</p> : null}
                <div className="drama-cast-assistance-actions">
                    <Button loading={busy === "preflight"} disabled={disabled || query.isPending || query.isError} onClick={() => void check()}>
                        {results.some((item) => item.status === "failed") ? "重新预检并报价" : "预检并报价"}
                    </Button>
                    {pending || quote?.view.ready ? (
                        <Button type="primary" loading={busy === "execute"} disabled={Boolean(busy || (!pending && (!quote?.view.priced || active)))} onClick={() => void execute()}>
                            {pending ? "确认提交结果" : "确认生成"}
                        </Button>
                    ) : null}
                </div>
                <section className="drama-cast-assistance-results" aria-label="辅助任务历史">
                    <h3>任务与历史结果</h3>
                    {query.isPending ? <p role="status">正在读取任务…</p> : null}
                    {!query.isPending && !query.isError && !results.length ? <p className="text-sm text-muted-foreground">还没有该类任务，生成结果不会自动覆盖当前设定。</p> : null}
                    {results.map((result) => {
                        const stale = result.sourceRevision !== castRevision;
                        const text = texts[result.id] ?? result.text ?? "";
                        const ready = result.status === "succeeded" && !result.error && !stale && Boolean(purpose === "voice_sample" ? result.resourceId : text.trim());
                        return (
                            <article key={result.id}>
                                <div className="drama-cast-assistance-result-head">
                                    <strong>版本 {result.version}</strong>
                                    <span>
                                        {STATUS[result.status] || result.status}
                                        {["queued", "running"].includes(result.status) ? ` · ${Math.max(0, Math.min(100, result.progress))}%` : ""}
                                    </span>
                                </div>
                                {stale ? <p>资产已有修改，此结果仅保留在历史中。</p> : null}
                                {result.error ? <p role="alert">{result.error}</p> : null}
                                {result.resourceId ? <CastVoicePreview key={result.resourceId} resourceId={result.resourceId} name={cast.name} /> : null}
                                {result.text ? (
                                    <Input.TextArea
                                        aria-label={`版本 ${result.version} 草稿`}
                                        value={text}
                                        rows={5}
                                        maxLength={purpose === "image_prompt" ? 12000 : 1000}
                                        disabled={Boolean(busy || stale || pending)}
                                        onChange={(event) => setTexts((previous) => ({ ...previous, [result.id]: event.target.value }))}
                                    />
                                ) : null}
                                <Button
                                    disabled={!ready || Boolean(busy || pending)}
                                    loading={busy === result.id}
                                    onClick={() =>
                                        void run(result.id, async (ticket) => {
                                            await adoptDramaCastAssistance(projectId, cast.id, { expectedRevision: summary.production.revision, castRevision, takeId: result.id, ...(purpose === "voice_sample" ? {} : { text }) });
                                            if (!operation.isCurrent(ticket)) return;
                                            setNotice(purpose === "voice_sample" ? "已绑定角色声音样本" : "已采用审阅后的草稿，原始说明已保留");
                                            void client.invalidateQueries({ queryKey: ["voice-profiles"] });
                                            onChanged();
                                            await query.refetch();
                                        })
                                    }
                                >
                                    {purpose === "voice_sample" ? "采用为角色声音" : purpose === "image_prompt" ? "采用为生图提示词" : "采用为外观描述"}
                                </Button>
                            </article>
                        );
                    })}
                </section>
                <AssetLibraryPickerModal
                    open={pickerOpen && !disabled}
                    title="选择反推来源图片"
                    items={[]}
                    categoryLabels={{}}
                    mediaKinds={["image"]}
                    remoteLibrary
                    remoteKind="image"
                    acceptRemoteItems
                    multiple={false}
                    remoteItemDisabledReason={(asset) => (asset.kind === "image" && resourceIdFromStorageKey(asset.data.storageKey) ? undefined : "请选择已保存的图片")}
                    onClose={() => setPickerOpen(false)}
                    onConfirm={(_ids, items) => {
                        if (disabled) return;
                        const asset = items?.[0]?.asset;
                        const id = asset?.kind === "image" ? resourceIdFromStorageKey(asset.data.storageKey) : "";
                        if (!id) return;
                        patch({ sourceResourceId: id });
                        setPickerOpen(false);
                    }}
                />
            </div>
        </AppModal>
    );
}
