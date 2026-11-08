import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { App, Button, Input } from "antd";
import { ArrowLeft, ArrowRight, Check, CheckCheck, ChevronRight, MessageSquare, RefreshCw, Sparkles, X } from "lucide-react";
import { Link, Navigate, useNavigate, useParams } from "react-router";

import { WorkspacePage } from "@/components/layout/workspace-page";
import { WorkspaceErrorState, WorkspaceLoadingState } from "@/components/layout/workspace-state";
import { AppModal } from "@/components/ui/product/app-modal";
import { analyzeNovel, EPISODE_SOURCE_CHARS, sourceChars } from "@/lib/drama/novel-parse";
import { dramaChoiceKey, dramaVideoResolutionIssue } from "@/lib/drama/model-choice";
import type { DramaAgentProposal } from "@/services/api/agent";
import {
    confirmDramaGuide,
    createDramaCast,
    deleteDramaCast,
    getDramaEpisode,
    regenerateDramaCast,
    rescriptDramaEpisode,
    retryFailedDrama,
    saveDramaGuideSource,
    updateDramaCast,
    updateDramaSegment,
    updateDramaSettings,
    updateDramaShot,
    writeDramaSegmentPrompts,
    type DramaCast,
    type DramaCastPatch,
    type DramaGuideStep,
    type DramaSegment,
    type DramaSettings,
    type DramaSourceFormat,
    type DramaSummary,
} from "@/services/api/drama";
import { useGlobalAgentStore, type AgentPrefillRequest } from "@/stores/use-global-agent-store";

import { GuideAssets, GuideConfiguration, GuideStory, GuideTextField } from "./guide-panels";
import { useDramaModelCatalog } from "./drama-model-picker";
import { dramaGuideChange, dramaGuideChangesConflict, dramaGuideProposal, dramaProposalKey, rebaseDramaGuideSettingsDraft, type DramaGuideChange, type DramaGuideProposalBatch } from "./guide-state";
import { GuideSetupChoices, GuideStageChoices, type GuideStageChoice } from "./guide-setup-choices";
import { CAST_KIND_LABEL, SourceFormatPicker } from "./drama-shared";
import { dramaKeys, useDramaCast, useDramaEpisode, useDramaSummary } from "./studio/use-studio";
import "./drama.css";
import "./guide.css";

const STEPS = [
    { key: "configuring", title: "创作方案", action: "确认配置，开始提取资产", hint: "确认视频配置、风格、语言与故事正文" },
    { key: "assets", title: "角色与场景", action: "确认资产，开始改编剧本与分镜", hint: "检查资产文字；参考图可在制作台再生成" },
    { key: "story", title: "剧本与分镜", action: "确认并进入制作台", hint: "全部文字任务结束后进入现有短剧制作流程" },
    { key: "completed", title: "进入制作台", action: "进入制作台", hint: "引导已完成，后续图片与视频在制作台继续" },
] as const;
type VisibleStep = Exclude<DramaGuideStep, "completed">;
type Operation = { work: () => Promise<unknown>; after?: (summary: DramaSummary | undefined) => void; requireFreshSummary?: boolean };
type SettingsDraft = { value: DramaSettings; baseline: DramaSettings; revision: number };
type CastDraft = { cast: DramaCast; patch: DramaCastPatch; revision: number };
type ProposalApplication = { proposal: DramaAgentProposal; change: DramaGuideChange; revision: number; step: DramaGuideStep };

export default function DramaGuidePage() {
    const { projectId = "" } = useParams();
    const navigate = useNavigate();
    const { message, modal } = App.useApp();
    const queryClient = useQueryClient();
    const summaryQuery = useDramaSummary(projectId);
    const catalog = useDramaModelCatalog();
    const summary = summaryQuery.data;
    const summaryRef = useRef(summary);
    summaryRef.current = summary;
    const step = summary?.production.guideStep || "configuring";
    const revision = summary?.production.revision || 0;
    const stepIndex = STEPS.findIndex((item) => item.key === step);
    const [viewStep, setViewStep] = useState<VisibleStep>("configuring");
    const [host, setHost] = useState<HTMLDivElement | null>(null);
    const [chatActionsHost, setChatActionsHost] = useState<HTMLDivElement | null>(null);
    const [mobilePane, setMobilePane] = useState<"chat" | "results">("chat");
    const [appliedNotice, setAppliedNotice] = useState("");
    const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(null);
    const [castDraft, setCastDraft] = useState<CastDraft | null>(null);
    const [sourceDraft, setSourceDraft] = useState<{ text: string; sourceFormat: DramaSourceFormat; revision: number } | null>(null);
    const [promptDraft, setPromptDraft] = useState<{ segment: DramaSegment; episodeId: string; text: string; revision: number } | null>(null);
    const [selectedEpisodeId, setSelectedEpisodeId] = useState("");
    const [proposals, setProposals] = useState<DramaAgentProposal[]>([]);
    const [proposalBatches, setProposalBatches] = useState<DramaGuideProposalBatch[]>([]);
    const proposalBatchesRef = useRef(proposalBatches);
    proposalBatchesRef.current = proposalBatches;
    const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
    const [pendingConversationId, setPendingConversationId] = useState<string | null>(null);
    const [prefillRequest, setPrefillRequest] = useState<{ projectId: string; request: AgentPrefillRequest } | null>(null);
    const confirmStageRef = useRef<() => void>(() => undefined);
    const prefillSequence = useRef(1);
    const sendGuideMessage = (text: string, displayText: string, requireIdle = false) => {
        if (summaryRef.current?.project.id !== projectId) return;
        prefillSequence.current = Math.max(Date.now(), prefillSequence.current + 1);
        setPrefillRequest({ projectId, request: { id: prefillSequence.current, text, displayText, autoSubmit: true, ...(requireIdle ? { requireIdle: true } : {}) } });
        setMobilePane("chat");
    };
    const creativeBrief = summary?.production.creativeBrief || "";
    const chapterCount = summary?.production.chapterCount || 0;
    const startupRequest = useMemo<AgentPrefillRequest | null>(() => {
        if (summary?.project.id !== projectId || summary.production.guideStep !== "configuring" || summaryQuery.isError) return null;
        return {
            id: 1,
            text: `请开始这个短剧的创作引导，先读取当前阶段、现有正文和配置。${creativeBrief ? `我的创作想法是：\n${creativeBrief}\n` : ""}请根据故事内容逐项引导我选择风格、视频画幅与清晰度、语言和时长，一轮只选择一项，用 drama_propose_changes 给出同一项的 2–4 个可直接保存的选项，不要一次给整套配置，也不要让我先回复选项再去应用建议。每项说明放顶层 explanation，正文只简短引导，不重复列举选项或提示去下方卡片。界面会提供自定义输入。${chapterCount ? "请直接读取已保存的正文，不需要我重复粘贴。" : creativeBrief ? "请先基于我的创作想法起草可改编的故事正文，用故事正文建议提交供我确认。" : "请先询问我的创作想法或需要改编的正文。"}点选后界面会直接保存并反馈结果，再读取最新配置继续下一项，已明确的选择不重复问。阶段推进时，请在 Agent 回复中提供“确认”与“继续调整”选项，由我直接选择，不使用右侧或下方独立确认按钮。每个阶段都等待我确认，不自动生成图片或视频。`,
            autoSubmit: true,
            displayText: chapterCount ? "请根据已保存的正文推荐创作方案" : creativeBrief ? "请根据我的创作想法起草正文，并推荐创作方案" : "请引导我开始创作短剧",
        };
    }, [projectId, summary?.project.id, summary?.production.guideStep, summaryQuery.isError, creativeBrief, chapterCount]);
    const busyRef = useRef(false);
    const jobsActive = Boolean((summary?.jobCounts.queued || 0) + (summary?.jobCounts.running || 0));
    const castQuery = useDramaCast(projectId, jobsActive, summary?.production.revision);
    const episodes = summary?.episodes || [];
    const episodeId = episodes.some((item) => item.id === selectedEpisodeId) ? selectedEpisodeId : episodes[0]?.id || "";
    const episodeQuery = useDramaEpisode(projectId, step === "story" || step === "completed" || viewStep === "story" ? episodeId : "", jobsActive);
    const detail = episodeQuery.data?.episode.id === episodeId ? episodeQuery.data : undefined;
    const operation = useMutation({
        mutationFn: ({ work }: Operation) => work(),
        onSuccess: async (_data, input) => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: dramaKeys.summary(projectId), exact: true }, { throwOnError: input.requireFreshSummary, cancelRefetch: Boolean(input.requireFreshSummary) }),
                queryClient.invalidateQueries({ queryKey: dramaKeys.cast(projectId) }),
                queryClient.invalidateQueries({ queryKey: ["drama", projectId, "episode"] }),
                queryClient.invalidateQueries({ queryKey: dramaKeys.chapters(projectId) }),
                queryClient.invalidateQueries({ queryKey: ["drama", projectId, "chapter"] }),
                queryClient.invalidateQueries({ queryKey: ["dramas"] }),
            ]);
            const state = queryClient.getQueryState<DramaSummary>(dramaKeys.summary(projectId));
            input.after?.(state?.status === "success" && !state.isInvalidated && state.fetchStatus === "idle" ? state.data : undefined);
        },
        onError: (error) => {
            message.error(error instanceof Error ? error.message : "操作失败，请重试");
            void summaryQuery.refetch({ cancelRefetch: false });
        },
        onSettled: () => {
            busyRef.current = false;
        },
    });
    const perform = (work: Operation["work"], after?: Operation["after"], requireFreshSummary = false) => {
        if (busyRef.current) {
            message.info("正在保存上一项调整，请稍候");
            return;
        }
        busyRef.current = true;
        operation.mutate({ work, after, requireFreshSummary });
    };
    const boundConversation = useCallback((id: string) => setPendingConversationId(id), []);
    const receiveProposal = useCallback((proposal: DramaAgentProposal) => setProposals((previous) => (previous.some((item) => dramaProposalKey(item) === dramaProposalKey(proposal)) ? previous : [...previous, proposal])), []);
    useEffect(() => {
        setViewStep(step === "completed" ? "story" : step);
        setSettingsDraft(null);
        setAppliedNotice("");
        setProposals([]);
        setDismissed(new Set());
        setPrefillRequest((previous) => (previous?.request.requireIdle ? null : previous));
    }, [step, projectId]);
    useEffect(() => {
        if (proposalBatchesRef.current.some((batch) => batch.currentRevision !== null && (batch.step !== step || batch.currentRevision !== revision))) {
            const blocked = proposalBatchesRef.current.map((batch) => (batch.step !== step || batch.currentRevision !== revision ? { ...batch, currentRevision: null } : batch));
            proposalBatchesRef.current = blocked;
            setProposalBatches(blocked);
        }
    }, [step, revision, projectId]);
    useEffect(() => {
        setProposals([]);
        proposalBatchesRef.current = [];
        setProposalBatches([]);
        setDismissed(new Set());
        setSelectedEpisodeId("");
        setCastDraft(null);
        setSourceDraft(null);
        setPromptDraft(null);
        setPendingConversationId(null);
        setPrefillRequest(null);
    }, [projectId]);
    useEffect(() => {
        if (!pendingConversationId || !summary || operation.isPending || busyRef.current) return;
        setPendingConversationId(null);
        if (summary.production.guideConversationId === pendingConversationId) return;
        perform(() => updateDramaSettings(projectId, { guideConversationId: pendingConversationId, expectedRevision: summary.production.revision }));
    }, [pendingConversationId, summary, operation.isPending]);

    const assertRevision = (expected: number) => {
        if (summaryRef.current?.project.id !== projectId || summaryRef.current.production.revision !== expected) throw new Error("内容已经更新，请重新载入最新内容后调整");
    };
    const currentProposal = (proposal: DramaAgentProposal) => {
        const current = summaryRef.current;
        return current?.project.id === projectId && current.production.guideStep && !summaryQuery.isError ? dramaGuideProposal(proposal, current.production.guideStep, current.production.revision, proposalBatchesRef.current, castQuery.cast) : null;
    };
    const recordProposalWrite = (application: ProposalApplication) => {
        if (summaryRef.current?.project.id !== projectId) return;
        const { proposal, change, step } = application;
        const previous = proposalBatchesRef.current;
        const batch = previous.find((item) => item.runId === proposal.runId && item.baseRevision === proposal.baseRevision);
        const next = [...previous.filter((item) => item !== batch), { runId: proposal.runId, baseRevision: proposal.baseRevision, currentRevision: null, step, appliedChanges: [...(batch?.appliedChanges || []), change] }];
        // 写入成功但刷新尚未确认时也保留阻断记录，旧缓存不能重新启用这个批次。
        proposalBatchesRef.current = next;
        setProposalBatches(next);
    };
    const finishProposalWrite = (application: ProposalApplication, latest: DramaSummary | undefined) => {
        if (summaryRef.current?.project.id !== projectId || latest?.project.id !== projectId || latest.production.revision !== application.revision + 1 || latest.production.guideStep !== application.step) return;
        const next = proposalBatchesRef.current.map((batch) => (batch.runId === application.proposal.runId && batch.baseRevision === application.proposal.baseRevision ? { ...batch, currentRevision: latest.production.revision } : batch));
        proposalBatchesRef.current = next;
        setProposalBatches(next);
    };
    const locateEpisodeTarget = async (targetId: string, kind: "shot" | "segment_prompt") => {
        for (const row of summaryRef.current?.episodes || []) {
            const current = await queryClient.fetchQuery({ queryKey: dramaKeys.episode(projectId, row.id), queryFn: ({ signal }) => getDramaEpisode(projectId, row.id, signal) });
            if (kind === "shot" ? current.shots.some((shot) => shot.id === targetId) : current.segments.some((segment) => segment.id === targetId)) return current;
        }
        throw new Error("建议对应的内容已不存在，请让 Agent 重新读取并提出建议");
    };
    const setupProposalIssue = useCallback(
        (proposal: DramaAgentProposal) => {
            if (proposal.kind !== "setup") return "";
            const settings = summaryRef.current?.production.settings;
            const option = catalog.data?.options.video.find((item) => dramaChoiceKey(item.choice) === dramaChoiceKey(settings?.models.video));
            const resolution = typeof proposal.changes.videoResolution === "string" ? proposal.changes.videoResolution : settings?.videoResolution;
            return dramaVideoResolutionIssue(option, resolution);
        },
        [catalog.data],
    );
    const saveProposal = (proposal: DramaAgentProposal) => {
        let application: ProposalApplication | undefined;
        let savedDraft: SettingsDraft | null = null;
        perform(
            async () => {
                const current = summaryRef.current;
                if (!current?.production.guideStep) throw new Error("当前作品不在引导中");
                const accepted = currentProposal(proposal);
                if (!accepted) throw new Error("建议已过期或不适用于当前步骤，请让 Agent 根据最新内容重新建议");
                const { change, revision: expectedRevision } = accepted;
                if (change.kind === "setup") {
                    if (settingsDraft && settingsDraft.revision !== expectedRevision) throw new Error("配置已变化，请先重新载入当前调整，再选择方案");
                    const issue = setupProposalIssue(proposal);
                    if (issue) throw new Error(`当前视频模型${issue}，请重新推荐可用选项`);
                    savedDraft = settingsDraft;
                    await updateDramaSettings(projectId, { settings: { ...current.production.settings, ...change.patch, mediaMode: "manual" }, expectedRevision });
                } else if (change.kind === "source") {
                    await saveDramaGuideSource(projectId, { chapters: change.chapters, sourceFormat: change.sourceFormat, expectedRevision });
                } else if (change.kind === "cast_create") {
                    await createDramaCast(projectId, { ...change.input, expectedRevision });
                } else if (change.kind === "cast_delete") {
                    if (!castQuery.cast.some((item) => item.id === change.targetId)) throw new Error("建议对应的资产已不存在，请重新读取");
                    await deleteDramaCast(projectId, change.targetId, expectedRevision);
                } else if (change.kind === "cast") {
                    if (!castQuery.cast.some((item) => item.id === change.targetId)) throw new Error("建议对应的资产已不存在，请重新读取");
                    await updateDramaCast(projectId, change.targetId, { ...change.patch, expectedRevision });
                } else {
                    const target = await locateEpisodeTarget(change.targetId, change.kind);
                    assertRevision(expectedRevision);
                    if (currentProposal(proposal)?.revision !== expectedRevision) throw new Error("建议已过期，请根据最新内容重新建议");
                    if (change.kind === "shot") await updateDramaShot(projectId, change.targetId, { ...change.patch, expectedRevision });
                    else {
                        const segment = target.segments.find((item) => item.id === change.targetId)!;
                        await updateDramaSegment(projectId, target.episode.id, segment.index, change.prompt, expectedRevision);
                    }
                    await queryClient.invalidateQueries({ queryKey: dramaKeys.episode(projectId, target.episode.id) });
                }
                application = { proposal, change, revision: expectedRevision, step: current.production.guideStep };
                recordProposalWrite(application);
            },
            (latest) => {
                if (summaryRef.current?.project.id !== projectId) return;
                if (application) finishProposalWrite(application, latest);
                const verified = Boolean(application && latest?.production.revision === application.revision + 1 && latest.production.guideStep === application.step && latest.project.id === projectId);
                if (application?.change.kind === "setup" && verified && latest) {
                    const value = savedDraft ? rebaseDramaGuideSettingsDraft(savedDraft.baseline, savedDraft.value, latest.production.settings, application.change.patch) : null;
                    setSettingsDraft(value ? { value, baseline: latest.production.settings, revision: latest.production.revision } : null);
                    sendGuideMessage(
                        `用户已在对话中点选并成功保存配置。当前制作版本：${latest.production.revision}；本次选择：${JSON.stringify(application.change.patch)}。请先用 drama_get_context 读取最新状态，再继续下一项尚未确认的配置选择；每轮只提供一个决策的可保存选项，不重复询问已确认项，不自动确认阶段或生成图片视频。`,
                        `已选择：${setupChoiceDescription(proposal)}`,
                        true,
                    );
                }
                setDismissed((previous) => {
                    const next = new Set(previous).add(dramaProposalKey(proposal));
                    if (application?.change.kind === "setup") {
                        for (const candidate of proposals) {
                            const change = dramaGuideChange(candidate, application.step, candidate.baseRevision);
                            if (candidate.runId === proposal.runId && candidate.baseRevision === proposal.baseRevision && change?.kind === "setup" && dramaGuideChangesConflict(application.change, change)) next.add(dramaProposalKey(candidate));
                        }
                    }
                    return next;
                });
                if (proposal.kind === "cast_delete") setCastDraft((previous) => (previous?.cast.id === proposal.targetId ? null : previous));
                setAppliedNotice("已保存本次选择，可继续确认下一步。");
                message.success("已保存本次选择");
            },
            true,
        );
    };
    const applyProposal = (proposal: DramaAgentProposal) => {
        if (proposal.kind !== "cast_delete") {
            saveProposal(proposal);
            return;
        }
        const target = castQuery.cast.find((item) => item.id === proposal.targetId);
        if (!target) {
            message.error("建议对应的资产已不存在，请重新读取");
            return;
        }
        modal.confirm({
            title: `确认删除「${target.name}」？`,
            content: "确认后将删除此资产条目，已有图片和生成历史会保留；存在分镜、造型或画布等引用，或正在生成时无法删除。",
            okText: "确认删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: () => saveProposal(proposal),
        });
    };

    const busy = operation.isPending;
    const dirty = Boolean(settingsDraft);
    const stale = Boolean(settingsDraft && settingsDraft.revision !== revision);
    const askAgent = () => {
        if (!startupRequest) return;
        sendGuideMessage(startupRequest.text, startupRequest.displayText || "请重新推荐创作选项");
    };
    const currentStep = STEPS[stepIndex] || STEPS[0];
    const visibleProposals = useMemo(() => proposals.filter((proposal) => !dismissed.has(dramaProposalKey(proposal))), [proposals, dismissed]);
    const validProposal = useCallback(
        (proposal: DramaAgentProposal) => !summaryQuery.isError && Boolean(dramaGuideProposal(proposal, step, revision, proposalBatches, castQuery.cast)),
        [summaryQuery.isError, step, revision, proposalBatches, castQuery.cast],
    );
    const refreshChoices = (proposal: DramaAgentProposal) =>
        sendGuideMessage(`请先用 drama_get_context 读取当前真实配置与版本，重新提供${setupChoiceFields(proposal)}的 2–4 个可直接保存选项。不要让我回答‘是否点了/是否看到卡片’，不要重复已确认的配置，不自动推进阶段。`, "请重新提供当前可选项");
    const customChoice = (text: string, proposal: DramaAgentProposal) => {
        if (busy || !text.trim()) return;
        sendGuideMessage(
            `我想为当前讨论的配置填写其他内容。当前讨论项：${setupChoiceFields(proposal)}。我的输入是：\n${text.trim()}\n请先用 drama_get_context 读取最新状态，再只针对这一项提供符合我输入的可保存选项；不替我编造其他设置，不声称已保存，不让我再去右侧应用。`,
            text.trim(),
        );
    };
    const setupActions = useRef({ applyProposal, customChoice, refreshChoices });
    setupActions.current = { applyProposal, customChoice, refreshChoices };
    const setupChoices = useMemo(
        () => ({
            proposals: visibleProposals.filter((proposal) => proposal.kind === "setup"),
            render: (items: DramaAgentProposal[]) => (
                <GuideSetupChoices
                    proposals={items}
                    busy={busy || stale || summaryQuery.isError}
                    isValid={validProposal}
                    issue={setupProposalIssue}
                    onChoose={(proposal) => setupActions.current.applyProposal(proposal)}
                    onCustom={(text, proposal) => setupActions.current.customChoice(text, proposal)}
                    onRefresh={(proposal) => setupActions.current.refreshChoices(proposal)}
                />
            ),
        }),
        [visibleProposals, busy, stale, validProposal, setupProposalIssue],
    );
    const proposalChoices = useMemo(
        () => ({
            proposals: visibleProposals.filter((proposal) => proposal.kind !== "setup"),
            render: (items: DramaAgentProposal[]) =>
                items.map((proposal) => (
                    <ProposalReview
                        key={dramaProposalKey(proposal)}
                        proposal={proposal}
                        target={castQuery.cast.find((item) => item.id === proposal.targetId)}
                        valid={!summaryQuery.isError && Boolean(dramaGuideProposal(proposal, step, revision, proposalBatches, castQuery.cast)) && (proposal.kind !== "cast_delete" || castQuery.cast.some((item) => item.id === proposal.targetId))}
                        busy={busy}
                        onApply={() => applyProposal(proposal)}
                        onDismiss={() => setDismissed((previous) => new Set(previous).add(dramaProposalKey(proposal)))}
                    />
                )),
        }),
        [applyProposal, busy, castQuery.cast, proposalBatches, revision, step, summaryQuery.isError, visibleProposals],
    );
    const stageChoices = useMemo(() => {
        if (!summary?.guide?.canConfirm || step === "completed") return undefined;
        const choices: GuideStageChoice[] =
            step === "configuring"
                ? [
                      { key: "confirm", title: "确认配置，开始提取资产", detail: "使用当前视频配置、风格、语言和正文进入资产提取。" },
                      { key: "adjust", title: "继续调整", detail: "让 Agent 根据你的要求继续调整配置或故事正文。" },
                  ]
                : step === "assets"
                  ? [
                        { key: "confirm", title: "确认资产，开始改编剧本与分镜", detail: "使用当前角色、场景和道具文字进入下一阶段。" },
                        { key: "adjust", title: "继续调整", detail: "让 Agent 继续补充或修改角色与场景设定。" },
                    ]
                  : [
                        { key: "confirm", title: "确认剧本与分镜，进入制作台", detail: "文字产物已完成，进入现有短剧制作流程。" },
                        { key: "adjust", title: "继续调整", detail: "让 Agent 根据你的要求继续修改剧本与分镜，暂不进入制作台。" },
                    ];
        const title = step === "configuring" ? "下一步：提取资产" : step === "assets" ? "下一步：开始改编" : "下一步：剧本与分镜";
        return {
            content: (
                <GuideStageChoices
                    title={title}
                    choices={choices}
                    busy={busy || stale || summaryQuery.isError}
                    onChoose={(choice) => {
                        if (choice.key === "confirm") {
                            confirmStageRef.current();
                            return;
                        }
                        const prompt =
                            step === "configuring"
                                ? "我想继续调整创作配置，请先读取最新短剧状态，再根据我的要求修改配置或故事正文；暂不提取资产。"
                                : step === "assets"
                                  ? "我想继续调整角色与场景，请先读取最新短剧状态，再根据我的要求修改资产文字；暂不开始改编剧本与分镜。"
                                  : "我想继续调整剧本与分镜，请先读取最新短剧状态，再根据我的要求修改文字内容；暂不进入制作台。";
                        sendGuideMessage(prompt, choice.title, true);
                    }}
                />
            ),
        };
    }, [busy, stale, step, summary?.guide?.canConfirm, summaryQuery.isError]);
    useEffect(() => {
        if (!host || summary?.project.id !== projectId || !summary.production.guideStep) {
            if (useGlobalAgentStore.getState().drama?.projectId === projectId) useGlobalAgentStore.getState().setDrama(null);
            return;
        }
        useGlobalAgentStore.getState().setDrama({
            projectId,
            guideConversationId: summary.production.guideConversationId,
            host,
            onConversationBound: boundConversation,
            onProposal: receiveProposal,
            onActionsHost: setChatActionsHost,
            setupChoices,
            proposalChoices,
            stageChoices,
            startupRequest,
            prefillRequest: prefillRequest?.projectId === projectId ? prefillRequest.request : null,
        });
    }, [host, projectId, summary?.production.guideStep, summary?.production.guideConversationId, boundConversation, receiveProposal, startupRequest, prefillRequest, setupChoices, proposalChoices, stageChoices]);
    useEffect(
        () => () => {
            if (useGlobalAgentStore.getState().drama?.projectId === projectId) useGlobalAgentStore.getState().setDrama(null);
        },
        [projectId],
    );

    if (summaryQuery.isLoading)
        return (
            <WorkspacePage>
                <WorkspaceLoadingState label="正在恢复创作引导" />
            </WorkspacePage>
        );
    if (!summary)
        return (
            <WorkspacePage>
                <WorkspaceErrorState title="作品暂时无法读取" description="请检查网络，或返回作品列表确认访问权限。" onRetry={() => void summaryQuery.refetch()} />
            </WorkspacePage>
        );
    if (!summary.production.guideStep) return <Navigate to={`/projects/${projectId}`} replace />;
    const settings = settingsDraft?.value || summary.production.settings;
    const confirm = () => {
        if (step === "completed") {
            navigate(`/projects/${projectId}`);
            return;
        }
        if (stale) {
            message.warning("配置已经更新，请重新载入后确认");
            return;
        }
        perform(
            () => {
                assertRevision(settingsDraft?.revision ?? revision);
                if (summaryRef.current?.production.guideStep !== step) throw new Error("引导步骤已经更新，请查看当前内容后再确认");
                return confirmDramaGuide(projectId, { expectedStep: step, expectedRevision: settingsDraft?.revision ?? revision, ...(step === "configuring" ? { settings: { ...settings, mediaMode: "manual" } } : {}) });
            },
            () => {
                setSettingsDraft(null);
                if (step === "story") navigate(`/projects/${projectId}`, { replace: true });
            },
        );
    };
    confirmStageRef.current = confirm;
    const saveSettings = () => {
        const draft = settingsDraft;
        if (!draft) return;
        perform(
            async () => {
                assertRevision(draft.revision);
                await updateDramaSettings(projectId, { settings: { ...draft.value, mediaMode: "manual" }, expectedRevision: draft.revision });
            },
            () => {
                if (summaryRef.current?.project.id !== projectId) return;
                setSettingsDraft(null);
                message.success("配置已保存");
            },
        );
    };
    const configurationProps = {
        summary,
        busy,
        onChange: (value: DramaSettings) => setSettingsDraft((previous) => (previous ? { ...previous, value } : { value, baseline: summary.production.settings, revision })),
        onSave: saveSettings,
        onDiscard: () => setSettingsDraft(null),
        onEditSource: () => setSourceDraft({ text: "", sourceFormat: "novel" as const, revision }),
        onAskAgent: askAgent,
    };
    return (
        <WorkspacePage fluid scroll={false}>
            <div className="drama-root drama-guide">
                <header className="drama-guide-header">
                    <div className="drama-guide-title">
                        <Link to="/projects">
                            <Button type="text" icon={<ArrowLeft className="size-4" />} aria-label="返回短剧列表" />
                        </Link>
                        <div>
                            <span className="drama-eyebrow">短剧创作引导</span>
                            <h1>{summary.project.name}</h1>
                        </div>
                    </div>
                    <div className="drama-guide-header-end">
                        <span className="drama-guide-note">进度自动保存，可随时回来继续</span>
                        <Button
                            type="text"
                            icon={<RefreshCw className="size-4" />}
                            aria-label="刷新引导内容"
                            loading={summaryQuery.isFetching}
                            onClick={() => {
                                void summaryQuery.refetch();
                                void castQuery.refetch();
                                if (episodeId) void episodeQuery.refetch();
                            }}
                        />
                    </div>
                </header>
                <nav className="drama-guide-progress" aria-label="创作引导步骤">
                    {STEPS.map((item, index) => (
                        <button
                            key={item.key}
                            type="button"
                            disabled={index > stepIndex || item.key === "completed"}
                            aria-current={step === item.key ? "step" : undefined}
                            aria-pressed={viewStep === item.key || (step === "completed" && item.key === "completed")}
                            onClick={() => {
                                if (item.key !== "completed") setViewStep(item.key);
                                setMobilePane("results");
                            }}
                        >
                            <span className="drama-guide-step-number">{index < stepIndex ? <Check className="size-3.5" /> : index + 1}</span>
                            <span>{item.title}</span>
                            {index < STEPS.length - 1 ? <ChevronRight className="size-3.5" /> : null}
                        </button>
                    ))}
                </nav>
                <div className="drama-guide-mobile-switch">
                    <button type="button" aria-pressed={mobilePane === "chat"} onClick={() => setMobilePane("chat")}>
                        <MessageSquare className="size-4" />与 Agent 讨论
                    </button>
                    <button type="button" aria-pressed={mobilePane === "results"} onClick={() => setMobilePane("results")}>
                        <Sparkles className="size-4" />
                        审阅创作产物
                    </button>
                </div>
                <div className={`drama-guide-layout is-${mobilePane}`}>
                    <aside className="drama-guide-chat" aria-label="短剧创作 Agent">
                        <div className="drama-guide-agent-host" ref={setHost} />
                    </aside>
                    <section className="drama-guide-results thin-scrollbar" aria-label="创作产物">
                        {summaryQuery.isError ? (
                            <p className="drama-guide-notice" role="alert">
                                最新进度读取失败，当前展示上次保存的内容。请刷新后继续。
                            </p>
                        ) : null}
                        {summary.production.pauseReason ? (
                            <div className="drama-guide-notice" role="alert">
                                <strong>{summary.production.pauseReason}</strong>
                                <Button size="small" disabled={busy} onClick={() => perform(() => retryFailedDrama(projectId))}>
                                    重试失败任务
                                </Button>
                            </div>
                        ) : null}
                        {step === "completed" ? (
                            <div className="drama-guide-complete">
                                <CheckCheck className="size-6" />
                                <div>
                                    <h2>创作准备已完成</h2>
                                    <p>文字产物已保存，进入制作台后可继续生成图片与视频。</p>
                                </div>
                                <Button onClick={confirm}>进入制作台</Button>
                            </div>
                        ) : null}
                        {viewStep === "configuring" ? (
                            <GuideConfiguration {...configurationProps} settings={settings} editable={step === "configuring"} dirty={dirty} stale={stale} />
                        ) : viewStep === "assets" ? (
                            castQuery.isError ? (
                                <WorkspaceErrorState description="资产暂时无法读取。" onRetry={() => void castQuery.refetch()} />
                            ) : (
                                <GuideAssets
                                    cast={castQuery.cast}
                                    busy={busy || step === "completed"}
                                    loading={jobsActive || castQuery.isLoading}
                                    onEdit={(cast) => setCastDraft({ cast, patch: { name: cast.name, description: cast.description, appearance: cast.appearance, voiceInstructions: cast.voiceInstructions }, revision })}
                                    onGenerate={(cast) => perform(() => regenerateDramaCast(projectId, cast.id, false))}
                                />
                            )
                        ) : (
                            <div className="drama-guide-stack">
                                <details className="drama-guide-card">
                                    <summary>审阅全部资产文字（{castQuery.cast.length} 项，包含本阶段新增角色、场景与道具）</summary>
                                    <p className="drama-guide-note">剧本改编可能补充新设定。最终确认前，请一并检查；没有参考图也可以完成引导。</p>
                                    {castQuery.isError ? (
                                        <WorkspaceErrorState description="资产暂时无法读取。" onRetry={() => void castQuery.refetch()} />
                                    ) : (
                                        <GuideAssets
                                            cast={castQuery.cast}
                                            busy={busy || step === "completed"}
                                            loading={jobsActive || castQuery.isLoading}
                                            onEdit={(cast) => setCastDraft({ cast, patch: { name: cast.name, description: cast.description, appearance: cast.appearance, voiceInstructions: cast.voiceInstructions }, revision })}
                                            onGenerate={(cast) => perform(() => regenerateDramaCast(projectId, cast.id, false))}
                                        />
                                    )}
                                </details>
                                <GuideStory
                                    episodes={episodes}
                                    episodeId={episodeId}
                                    detail={detail}
                                    busy={busy || step === "completed"}
                                    loading={jobsActive || episodeQuery.isLoading}
                                    failed={episodeQuery.isError}
                                    onSelect={setSelectedEpisodeId}
                                    onReload={() => void episodeQuery.refetch()}
                                    onRescript={() =>
                                        modal.confirm({
                                            title: "重新改编本集？",
                                            content: "将按现有正文与资产重新生成本集剧本、镜头及段提示词，会替换本集已有文字调整。",
                                            okText: "重新改编",
                                            cancelText: "保留当前",
                                            onOk: () => perform(() => rescriptDramaEpisode(projectId, episodeId)),
                                        })
                                    }
                                    onPatch={(shot, patch) => perform(() => updateDramaShot(projectId, shot.id, { ...patch, expectedRevision: revision }))}
                                    onEditPrompt={(segment) => setPromptDraft({ segment, episodeId, text: segment.videoPrompt, revision })}
                                    onWritePrompt={(segment) => perform(() => writeDramaSegmentPrompts(projectId, episodeId, [segment.index]))}
                                />
                            </div>
                        )}
                    </section>
                </div>
                {chatActionsHost
                    ? createPortal(
                          <section className="drama-guide-chat-actions" aria-label="短剧对话中的选项与确认">
                              {appliedNotice ? (
                                  <p className="drama-guide-notice" role="status">
                                      {appliedNotice}
                                  </p>
                              ) : null}
                              {stageChoices ? null : (
                                  <footer className="drama-guide-footer">
                                      <div>
                                          <strong>{currentStep.title}</strong>
                                          <p role="status">{summary.guide?.blockingReason || currentStep.hint}</p>
                                      </div>
                                      <Button
                                          type="primary"
                                          icon={step === "completed" ? <ArrowRight className="size-4" /> : <Check className="size-4" />}
                                          loading={busy}
                                          disabled={busy || stale || summaryQuery.isError || (step !== "completed" && !summary.guide?.canConfirm)}
                                          onClick={confirm}
                                      >
                                          {currentStep.action}
                                      </Button>
                                  </footer>
                              )}
                          </section>,
                          chatActionsHost,
                      )
                    : null}
                <AppModal
                    rootClassName="drama-root"
                    title={castDraft ? `编辑${CAST_KIND_LABEL[castDraft.cast.kind]} · ${castDraft.cast.name}` : "编辑资产"}
                    open={Boolean(castDraft)}
                    onCancel={() => setCastDraft(null)}
                    okText="保存设定"
                    cancelText="取消"
                    confirmLoading={busy}
                    okButtonProps={{ disabled: busy || castDraft?.revision !== revision }}
                    onOk={() => {
                        if (!castDraft) return;
                        perform(
                            async () => {
                                assertRevision(castDraft.revision);
                                await updateDramaCast(projectId, castDraft.cast.id, { ...castDraft.patch, expectedRevision: castDraft.revision });
                            },
                            () => setCastDraft(null),
                        );
                    }}
                >
                    {castDraft ? (
                        <div className="drama-guide-stack">
                            {castDraft.revision !== revision ? <p role="alert">内容已经更新，请关闭后重新打开最新设定。</p> : null}
                            <label className="drama-guide-field">
                                <span>名称</span>
                                <Input value={castDraft.patch.name} aria-label="资产名称" onChange={(event) => setCastDraft({ ...castDraft, patch: { ...castDraft.patch, name: event.target.value } })} />
                            </label>
                            {(
                                [
                                    { key: "description", label: "描述" },
                                    { key: "appearance", label: castDraft.cast.kind === "scene" ? "环境设定" : "外观设定" },
                                    ...(castDraft.cast.kind === "character" ? [{ key: "voiceInstructions", label: "声线设定" }] : []),
                                ] as Array<{ key: "description" | "appearance" | "voiceInstructions"; label: string }>
                            ).map(({ key, label }) => (
                                <GuideTextField key={key} label={label} value={castDraft.patch[key] || ""} onChange={(value) => setCastDraft({ ...castDraft, patch: { ...castDraft.patch, [key]: value } })} />
                            ))}
                        </div>
                    ) : null}
                </AppModal>
                <AppModal
                    rootClassName="drama-root"
                    title="补充或替换故事正文"
                    open={Boolean(sourceDraft)}
                    width={760}
                    onCancel={() => setSourceDraft(null)}
                    okText="保存正文"
                    cancelText="取消"
                    confirmLoading={busy}
                    okButtonProps={{ disabled: busy || !sourceDraft?.text.trim() || sourceDraft.revision !== revision }}
                    onOk={() => {
                        if (!sourceDraft) return;
                        perform(
                            async () => {
                                assertRevision(sourceDraft.revision);
                                const chapters = analyzeNovel(sourceDraft.text, { perEpisode: true }).chapters.map(({ title, text }) => ({ title, text }));
                                if (!chapters.length) throw new Error("请输入可改编的正文");
                                if (chapters.some((chapter) => sourceChars(chapter.text) > EPISODE_SOURCE_CHARS)) throw new Error("单章正文超过 1.2 万字，请用章节标题拆分后保存");
                                await saveDramaGuideSource(projectId, { chapters, sourceFormat: sourceDraft.sourceFormat, expectedRevision: sourceDraft.revision });
                            },
                            () => setSourceDraft(null),
                        );
                    }}
                >
                    {sourceDraft ? (
                        <div className="drama-guide-stack">
                            <p className="drama-guide-note">保存会替换当前全部正文（含预留章节）。确认配置前可继续调整；一句创作想法请先让 Agent 扩展为正文。</p>
                            {sourceDraft.revision !== revision ? <p role="alert">内容已经更新，请关闭后重新打开。</p> : null}
                            <SourceFormatPicker row value={sourceDraft.sourceFormat} onChange={(sourceFormat) => setSourceDraft({ ...sourceDraft, sourceFormat })} disabled={busy} />
                            <GuideTextField label="故事正文" value={sourceDraft.text} rows={10} onChange={(text) => setSourceDraft({ ...sourceDraft, text })} />
                        </div>
                    ) : null}
                </AppModal>
                <AppModal
                    rootClassName="drama-root"
                    title="编辑段视频提示词"
                    open={Boolean(promptDraft)}
                    width={760}
                    onCancel={() => setPromptDraft(null)}
                    okText="保存提示词"
                    cancelText="取消"
                    confirmLoading={busy}
                    okButtonProps={{ disabled: busy || promptDraft?.revision !== revision }}
                    onOk={() => {
                        if (!promptDraft) return;
                        perform(
                            async () => {
                                assertRevision(promptDraft.revision);
                                await updateDramaSegment(projectId, promptDraft.episodeId, promptDraft.segment.index, promptDraft.text, promptDraft.revision);
                            },
                            () => setPromptDraft(null),
                        );
                    }}
                >
                    {promptDraft ? (
                        <div className="drama-guide-stack">
                            {promptDraft.revision !== revision ? <p role="alert">内容已经更新，请关闭后重新打开最新提示词。</p> : null}
                            <GuideTextField label="段视频提示词" value={promptDraft.text} rows={10} onChange={(text) => setPromptDraft({ ...promptDraft, text })} />
                        </div>
                    ) : null}
                </AppModal>
            </div>
        </WorkspacePage>
    );
}

const CHANGE_LABEL: Record<string, string> = {
    aspectRatio: "画幅",
    styleName: "风格名称",
    stylePrompt: "视觉风格",
    language: "语言",
    episodeSeconds: "单集时长（秒）",
    videoResolution: "视频分辨率",
    name: "名称",
    kind: "资产类型",
    reason: "删除原因",
    aliases: "别名",
    description: "描述",
    appearance: "外观设定",
    voiceInstructions: "声线设定",
    speaker: "说话人",
    dialogue: "台词",
    action: "动作",
    shotSize: "景别",
    camera: "运镜",
    imagePrompt: "起幅画面",
    videoPrompt: "视频提示词",
    videoPromptOverride: "段视频提示词",
    durationSeconds: "镜头时长（秒）",
    transition: "转场",
};

function setupChoiceFields(proposal: DramaAgentProposal) {
    return (
        Object.keys(proposal.changes)
            .filter((key) => CHANGE_LABEL[key])
            .map((key) => CHANGE_LABEL[key])
            .join("、") || "创作配置"
    );
}

function setupChoiceDescription(proposal: DramaAgentProposal) {
    const values = proposal.changes;
    return (
        [values.styleName || values.stylePrompt, values.aspectRatio, values.videoResolution, values.language, typeof values.episodeSeconds === "number" ? `${values.episodeSeconds} 秒` : ""]
            .filter((value) => typeof value === "string" && value.trim())
            .join(" · ") || "创作配置"
    );
}
function ProposalReview({ proposal, target, valid, busy, onApply, onDismiss }: { proposal: DramaAgentProposal; target?: DramaCast; valid: boolean; busy: boolean; onApply: () => void; onDismiss: () => void }) {
    const title = { setup: "创作配置建议", source: "故事正文草稿", cast: "资产设定调整", cast_create: "新增资产", cast_delete: "删除资产", shot: "镜头文字调整", segment_prompt: "段提示词调整" }[proposal.kind];
    const deleting = proposal.kind === "cast_delete";
    const chooseLabel =
        deleting
            ? "删除此资产"
            : proposal.kind === "cast_create"
              ? "新增此资产"
              : proposal.kind === "source"
                ? "采用这份正文"
                : proposal.kind === "cast"
                  ? "保存资产设定"
                  : proposal.kind === "shot"
                    ? "保存分镜修改"
                    : "保存段提示词";
    return (
        <article className="drama-guide-card drama-guide-proposal">
            <div className="drama-guide-section-head">
                <h3>{title}</h3>
                <Button type="text" size="small" aria-label={`忽略${title}`} icon={<X className="size-3.5" />} onClick={onDismiss} />
            </div>
            {target && (proposal.kind === "cast" || deleting) ? <p>{`${CAST_KIND_LABEL[target.kind]} · ${target.name}`}</p> : null}
            {proposal.kind === "source" && Array.isArray(proposal.changes.chapters) ? (
                proposal.changes.chapters.flatMap((chapter: unknown, index: number) => {
                    if (!chapter || typeof chapter !== "object") return [];
                    const item = chapter as Record<string, unknown>;
                    return (
                        <details key={index}>
                            <summary>{typeof item.title === "string" ? item.title : `第 ${index + 1} 章`}</summary>
                            <p>{typeof item.text === "string" ? item.text : "正文内容不完整，请重新建议"}</p>
                        </details>
                    );
                })
            ) : (
                <dl>
                    {Object.entries(proposal.changes)
                        .filter(([key]) => CHANGE_LABEL[key])
                        .map(([key, value]) => (
                            <div key={key}>
                                <dt>{CHANGE_LABEL[key]}</dt>
                                <dd>{key === "kind" && ["character", "prop", "scene"].includes(String(value)) ? CAST_KIND_LABEL[value as DramaCast["kind"]] : Array.isArray(value) ? value.join("、") : String(value)}</dd>
                            </div>
                        ))}
                </dl>
            )}
            <div className="drama-guide-inline-actions">
                <span className="drama-guide-note">
                    {!valid ? "此建议已过期或目标已不存在，请根据最新内容重新建议" : deleting ? "确认后删除；已有引用或正在生成时无法删除" : proposal.kind === "cast_create" ? "仅保存文字设定，参考图可稍后手动生成" : "选择后直接保存到作品"}
                </span>
                <Button className="drama-guide-proposal-choose" danger={deleting} disabled={!valid || busy} onClick={onApply}>
                    {chooseLabel}
                </Button>
            </div>
        </article>
    );
}
