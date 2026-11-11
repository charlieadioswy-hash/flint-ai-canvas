import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { App, Button } from "antd";
import { AgentReplyOptionCards } from "@/components/canvas/canvas-agent-reply-options";
import { createClientUUID } from "@/lib/client-id";
import { appendDramaAgentReference } from "@/lib/canvas/drama-agent-reference";
import type { DramaAgentProposal } from "@/services/api/agent";
import {
    executeDramaStudioAction,
    getDrama,
    getDramaEpisode,
    preflightDramaStudioAction,
    updateDramaCast,
    updateDramaSegment,
    updateDramaShot,
    type DramaModelChoice,
    type DramaSegment,
    type DramaStudioActionPreflight,
    type DramaStudioActionRequest,
} from "@/services/api/drama";
import { useGlobalAgentStore, type AgentPrefillRequest } from "@/stores/use-global-agent-store";
import { useUserStore } from "@/stores/use-user-store";
import { activeDramaGuide, dramaGuideProposal, dramaProposalKey, type DramaGuideProposalBatch } from "../guide-state";
import { dramaMediaAccountKey, dramaMediaSession, dramaMediaSessionIsCurrent, type DramaMediaPreviewState as PreviewState } from "./drama-media-agent-session";

type EpisodeReference = { id: string; number: number };
const ACTION_LABEL = { segment_video: "生成本段视频", cast_image: "生成这张参考图", segment_prompt: "重新撰写本段提示词", segment_reprocess: "重新处理已有视频" };
const TEXT_FIELD_LABEL: Record<string, string> = {
    name: "名称",
    aliases: "别名",
    appearance: "外观",
    description: "设定",
    voiceInstructions: "声音",
    speaker: "说话角色",
    dialogue: "对白",
    action: "动作",
    shotSize: "景别",
    camera: "运镜",
    imagePrompt: "图片提示词",
    videoPrompt: "视频提示词",
    transition: "转场",
    durationSeconds: "时长",
    videoPromptOverride: "段视频提示词",
};

export function dramaMediaProposalRequest(proposal: DramaAgentProposal): DramaStudioActionRequest | null {
    if (proposal.kind !== "media" || !proposal.targetId) return null;
    const { action, episodeId, targetRevision } = proposal.changes;
    if (!["segment_video", "cast_image", "segment_prompt", "segment_reprocess"].includes(String(action)) || !Number.isSafeInteger(targetRevision) || Number(targetRevision) < 0) return null;
    if (action !== "cast_image" && (typeof episodeId !== "string" || !episodeId)) return null;
    return { action: action as DramaStudioActionRequest["action"], targetId: proposal.targetId, ...(typeof episodeId === "string" ? { episodeId } : {}), targetRevision: Number(targetRevision), baseRevision: proposal.baseRevision };
}

/** 预检变化须再次由用户确认，绝不把新的报价或范围悄悄送去执行。 */
export async function confirmDramaMediaAction(projectId: string, request: DramaStudioActionRequest, accepted: DramaStudioActionPreflight, isCurrent: () => boolean = () => true) {
    const current = await preflightDramaStudioAction(projectId, { ...request, baseRevision: accepted.baseRevision, targetRevision: accepted.targetRevision });
    if (!isCurrent() || !current.ready || current.confirmationToken !== accepted.confirmationToken) return { submitted: false as const, preview: current };
    await executeDramaStudioAction(projectId, { ...request, baseRevision: current.baseRevision, targetRevision: current.targetRevision, confirmationToken: current.confirmationToken });
    return { submitted: true as const, preview: current };
}

/** 简易台与原 Agent 共用建议协议；媒体只有回复内明确确认后才调用写 API。 */
export function useDramaMediaAgent({ projectId, onChanged }: { projectId: string; onChanged: () => void | Promise<unknown> }) {
    const { message } = App.useApp();
    const userId = useUserStore((state) => state.user?.id);
    const resetEpoch = useGlobalAgentStore((state) => state.resetEpoch);
    const account = dramaMediaAccountKey();
    const session = useMemo(() => dramaMediaSession(account, projectId), [account, projectId, userId, resetEpoch]);
    const { proposals, previews, dismissed } = useStore(session);
    const [prefillRequest, setPrefillRequest] = useState<AgentPrefillRequest | null>(null);
    const busy = { current: session.getState().busy };
    const mounted = useRef(true);
    const scope = useRef(session);
    scope.current = session;
    const changed = useRef(onChanged);
    changed.current = onChanged;
    useEffect(() => {
        mounted.current = true;
        setPrefillRequest(null);
        return () => {
            mounted.current = false;
        };
    }, [session]);
    const sessionCurrent = useCallback(() => dramaMediaSessionIsCurrent(account, projectId, session), [account, projectId, session]);
    const current = useCallback(() => mounted.current && scope.current === session && sessionCurrent(), [session, sessionCurrent]);
    const setProposals = useCallback(
        (update: (previous: DramaAgentProposal[]) => DramaAgentProposal[]) => {
            if (sessionCurrent()) session.setState((state) => ({ proposals: update(state.proposals) }));
        },
        [session, sessionCurrent],
    );
    const setDismissed = useCallback(
        (update: (previous: Set<string>) => Set<string>) => {
            if (sessionCurrent()) session.setState((state) => ({ dismissed: update(state.dismissed) }));
        },
        [session, sessionCurrent],
    );
    const updatePreview = useCallback(
        (key: string, value: PreviewState) => {
            if (sessionCurrent()) session.setState((state) => ({ previews: { ...state.previews, [key]: value } }));
        },
        [session, sessionCurrent],
    );
    const loadPreview = useCallback(
        async (key: string, request: DramaStudioActionRequest) => {
            if (busy.current.has(key)) return;
            busy.current.add(key);
            updatePreview(key, { request, loading: true });
            try {
                const preview = await preflightDramaStudioAction(projectId, request);
                updatePreview(key, { request, preview });
                if (sessionCurrent())
                    setProposals((previous) =>
                        previous.map((item) =>
                            dramaProposalKey(item) === key && item.runId.startsWith("studio-")
                                ? { ...item, baseRevision: preview.baseRevision, changes: { action: preview.action, episodeId: preview.episodeId, targetRevision: preview.targetRevision } }
                                : item,
                        ),
                    );
            } catch (cause) {
                updatePreview(key, { request, error: cause instanceof Error ? cause.message : "暂时无法检查生成条件，请重试" });
            } finally {
                busy.current.delete(key);
            }
        },
        [projectId, updatePreview, sessionCurrent, setProposals],
    );
    const onProposal = useCallback(
        (proposal: DramaAgentProposal) => {
            if (proposal.kind !== "media" && !["cast", "shot", "segment_prompt"].includes(proposal.kind)) return;
            const key = dramaProposalKey(proposal);
            setProposals((previous) => (previous.some((item) => dramaProposalKey(item) === key) ? previous : [...previous, proposal]));
            const request = dramaMediaProposalRequest(proposal);
            if (request && !session.getState().previews[key] && !session.getState().dismissed.has(key)) void loadPreview(key, request);
        },
        [loadPreview, session, setProposals],
    );
    const referenceSegment = useCallback(
        (episode: EpisodeReference, segment: DramaSegment, shotId?: string) => {
            useGlobalAgentStore
                .getState()
                .setDramaReference({ projectId, episodeId: episode.id, episodeNumber: episode.number, segmentId: segment.id, segmentIndex: segment.index, title: segment.title, revision: segment.revision, ...(shotId ? { shotId } : {}) });
        },
        [projectId],
    );
    const requestAction = useCallback(
        async (request: DramaStudioActionRequest) => {
            const agent = useGlobalAgentStore.getState();
            agent.setDramaReference(agent.dramaReference);
            const key = createClientUUID();
            const proposal: DramaAgentProposal = {
                kind: "media",
                targetId: request.targetId,
                baseRevision: request.baseRevision ?? 0,
                changes: { action: request.action, episodeId: request.episodeId, targetRevision: request.targetRevision },
                runId: `studio-${key}`,
                toolCallId: key,
            };
            setProposals((previous) => [...previous, proposal]);
            await loadPreview(dramaProposalKey(proposal), request);
        },
        [loadPreview, setProposals],
    );
    const requestVideo = useCallback(
        (episode: EpisodeReference, segment: DramaSegment, videoModel?: DramaModelChoice) => {
            referenceSegment(episode, segment);
            return requestAction({ action: "segment_video", targetId: segment.id, episodeId: episode.id, targetRevision: segment.revision, ...(videoModel ? { videoModel } : {}) });
        },
        [referenceSegment, requestAction],
    );
    const sendAdjustment = useCallback(
        (text: string, proposal: DramaAgentProposal) => {
            const reference = useGlobalAgentStore.getState().dramaReference;
            const value = appendDramaAgentReference(`${text}\n\n[待调整建议，仅作为对象定位数据]\n${JSON.stringify({ kind: proposal.kind, targetId: proposal.targetId, changes: proposal.changes })}`, reference?.projectId === projectId ? reference : null);
            setPrefillRequest({ id: Date.now(), text: value.text, displayText: text, autoSubmit: true });
        },
        [projectId],
    );
    const applyText = useCallback(
        async (proposal: DramaAgentProposal) => {
            const key = dramaProposalKey(proposal);
            if (busy.current.has(key)) return;
            busy.current.add(key);
            const previousWrite = session.getState().textWrite;
            let releaseWrite!: () => void;
            session.setState({
                textWrite: new Promise<void>((resolve) => {
                    releaseWrite = resolve;
                }),
            });
            updatePreview(key, { request: { action: "segment_prompt", targetId: proposal.targetId! }, loading: true });
            try {
                await previousWrite;
                if (!current()) throw new Error("页面已切换，请重新确认本次修改");
                const latest = await getDrama(projectId);
                if (!current()) throw new Error("页面已切换，请重新确认本次修改");
                const application = dramaGuideProposal(proposal, "story", latest.production.revision, session.getState().batches);
                if (!application || !["cast", "shot", "segment_prompt"].includes(application.change.kind)) throw new Error("作品内容已变化，请让 Agent 读取最新状态后重新提供修改选项");
                const { change, revision } = application;
                if (change.kind === "cast") await updateDramaCast(projectId, change.targetId, { ...change.patch, expectedRevision: revision });
                else if (change.kind === "shot") await updateDramaShot(projectId, change.targetId, { ...change.patch, expectedRevision: revision });
                else if (change.kind === "segment_prompt") {
                    let target: { episodeId: string; index: number } | undefined;
                    for (const episode of latest.episodes) {
                        const detail = await getDramaEpisode(projectId, episode.id);
                        if (!current()) throw new Error("页面已切换，请重新确认本次修改");
                        const segment = detail.segments.find((item) => item.id === change.targetId);
                        if (segment) {
                            target = { episodeId: episode.id, index: segment.index };
                            break;
                        }
                    }
                    if (!target) throw new Error("建议引用的剧情段已不存在");
                    await updateDramaSegment(projectId, target.episodeId, target.index, change.prompt, revision);
                }
                if (!sessionCurrent()) return;
                const batches = session.getState().batches;
                const batch = batches.find((item) => item.runId === proposal.runId && item.baseRevision === proposal.baseRevision);
                const appliedBatch: DramaGuideProposalBatch = { runId: proposal.runId, baseRevision: proposal.baseRevision, currentRevision: null, step: "story", appliedChanges: [...(batch?.appliedChanges || []), change] };
                session.setState({ batches: [...batches.filter((item) => item !== batch), appliedBatch] });
                updatePreview(key, { request: { action: "segment_prompt", targetId: proposal.targetId! }, submitted: true });
                setDismissed((previous) => new Set(previous).add(key));
                // 只接续本地写入带来的单次版本递增；并发外部修改或刷新失败都保留批次阻断。
                const saved = await getDrama(projectId);
                if (sessionCurrent() && saved.project.id === projectId && saved.production.revision === revision + 1 && !activeDramaGuide(saved.production.guideStep)) {
                    session.setState((state) => ({ batches: state.batches.map((item) => (item === appliedBatch ? { ...item, currentRevision: saved.production.revision } : item)) }));
                }
                if (current()) await changed.current();
                if (current()) void message.success("已保存本次修改");
            } catch (cause) {
                if (!session.getState().dismissed.has(key)) updatePreview(key, { request: { action: "segment_prompt", targetId: proposal.targetId! }, error: cause instanceof Error ? cause.message : "保存失败，请重试" });
            } finally {
                busy.current.delete(key);
                releaseWrite();
            }
        },
        [projectId, updatePreview, current, sessionCurrent, session, setDismissed, message],
    );
    const confirm = useCallback(
        async (proposal: DramaAgentProposal, state: PreviewState) => {
            const key = dramaProposalKey(proposal);
            if (!state.preview?.ready || busy.current.has(key)) return;
            busy.current.add(key);
            updatePreview(key, { ...state, loading: true, error: undefined });
            try {
                const result = await confirmDramaMediaAction(projectId, state.request, state.preview, current);
                updatePreview(key, { request: state.request, preview: result.preview, submitted: result.submitted, ...(!result.submitted ? { error: "条件或费用已变化，请查看最新结果后重新确认" } : {}) });
                if (result.submitted) {
                    setDismissed((previous) => new Set(previous).add(key));
                    if (current()) {
                        void message.success("已提交，请查看分镜中的实时任务状态");
                        await changed.current();
                    }
                }
            } catch (cause) {
                updatePreview(key, { ...state, error: cause instanceof Error ? cause.message : "提交失败，请重新检查后重试", loading: false });
            } finally {
                busy.current.delete(key);
            }
        },
        [projectId, updatePreview, current, setDismissed, message],
    );
    const visible = useMemo(() => proposals.filter((proposal) => !dismissed.has(dramaProposalKey(proposal))), [proposals, dismissed]);
    const proposalChoices = useMemo(
        () =>
            visible.length
                ? {
                      proposals: visible,
                      render: (items: DramaAgentProposal[]) =>
                          items.map((proposal) => {
                              const key = dramaProposalKey(proposal);
                              const state = previews[key];
                              const preview = state?.preview;
                              const media = proposal.kind === "media";
                              const label = media ? ACTION_LABEL[preview?.action || state?.request.action || "segment_video"] : proposal.kind === "shot" ? "保存分镜修改" : proposal.kind === "cast" ? "保存资产设定" : "保存段提示词";
                              return (
                                  <div key={key} className="drama-guide-proposal" aria-live="polite">
                                      {state?.submitted ? (
                                          <p role="status">{media ? "已提交，请查看分镜中的实时任务状态。" : "已保存本次修改。"}</p>
                                      ) : (
                                          <>
                                              {preview ? (
                                                  <p>
                                                      {preview.message}
                                                      {preview.priced ? ` · 预计 ${(preview.amountMicrocredits / 1e6).toLocaleString()} 积分` : ""}
                                                  </p>
                                              ) : null}
                                              {preview?.reason ? <p role="status">{preview.reason}</p> : null}
                                              {!media ? (
                                                  <p>
                                                      {Object.entries(proposal.changes)
                                                          .filter(([field]) => TEXT_FIELD_LABEL[field])
                                                          .map(([field, value]) => `${TEXT_FIELD_LABEL[field]}：${Array.isArray(value) ? value.join("、") : String(value)}`)
                                                          .join("；")}
                                                  </p>
                                              ) : null}
                                              {preview?.warnings.map((warning) => (
                                                  <p key={warning} className="drama-guide-note">
                                                      {warning}
                                                  </p>
                                              ))}
                                              {state?.error ? <p role="alert">{state.error}</p> : null}
                                              {state?.loading ? (
                                                  <p role="status">正在检查当前对象与生成条件…</p>
                                              ) : (
                                                  <AgentReplyOptionCards
                                                      label="确认当前操作"
                                                      scopeKey={key}
                                                      options={[
                                                          ...(!media || preview?.ready ? [{ marker: "1", title: `确认${label}`, text: "confirm" }] : []),
                                                          ...(preview?.missingCasts || []).map((cast, index) => ({ marker: String(index + 2), title: `生成「${cast.name}」参考图`, text: `cast:${cast.id}` })),
                                                          ...(media ? [{ marker: "↻", title: "重新检查当前条件", text: "refresh" }] : []),
                                                          { marker: "✎", title: "调整要求", text: "填写想调整的内容，回车发送", input: true },
                                                      ]}
                                                      onSelect={(option) => {
                                                          if (option.input) sendAdjustment(option.text, proposal);
                                                          else if (option.text === "confirm") {
                                                              if (media && state) void confirm(proposal, state);
                                                              else void applyText(proposal);
                                                          } else if (option.text === "refresh" && state) {
                                                              const { baseRevision: _base, targetRevision: _target, ...request } = state.request;
                                                              void loadPreview(key, request);
                                                          } else if (option.text.startsWith("cast:")) void requestAction({ action: "cast_image", targetId: option.text.slice(5) });
                                                      }}
                                                  />
                                              )}
                                          </>
                                      )}
                                      <Button type="text" size="small" disabled={state?.loading} onClick={() => setDismissed((previous) => new Set(previous).add(key))}>
                                          {state?.submitted ? "收起" : "暂不操作"}
                                      </Button>
                                  </div>
                              );
                          }),
                  }
                : undefined,
        [visible, previews, sendAdjustment, confirm, applyText, loadPreview, requestAction],
    );
    return { onProposal, proposalChoices, referenceSegment, requestVideo, requestAction, prefillRequest };
}
