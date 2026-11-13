import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Input, Progress } from "antd";
import { Link } from "react-router";

import { dramaChoiceToModel } from "@/lib/drama/model-choice";
import { getActiveUserScope } from "@/lib/user-scope";
import { modelQuoteDescription, systemModelQuoteRequest } from "@/lib/model-pricing";
import { quoteModel, type LogicalModelQuote, type ModelQuoteRequest } from "@/services/api/logical-models";
import { cancelGenerationTask, createGenerationTask, listGenerationTasks, queryGenerationTask, retryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import type { DramaSourceFormat } from "@/services/api/drama";
import { ApiError } from "@/services/api/request";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

import { DramaModelPicker, useDramaModelCatalog } from "./drama-model-picker";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { emptyIdeaWorkspace, ideaTaskCandidate, ideaTaskOperationId, ideaTaskSource, ideaTaskText, prepareIdeaSubmission, readIdeaWorkspace, writeIdeaWorkspace, type IdeaSourceFormat, type IdeaSubmission, type IdeaWorkspace } from "./workflow-idea-task";
import "./workflow-idea.css";

export type WorkflowIdeaProps = { onAdopt: (text: string, sourceFormat: DramaSourceFormat) => void; disabled?: boolean; onDirtyChange?: (dirty: boolean, busy: boolean) => void };
type QuoteDraft = { quote: LogicalModelQuote; quoteRequest: ModelQuoteRequest; submission?: IdeaSubmission; retryTaskId?: string; ticket: ReturnType<ReturnType<typeof useDramaOperationScope>["capture"]> };
const quoteFingerprint = (quote: LogicalModelQuote) => JSON.stringify([quote.logicalModelId, quote.billingMode, quote.quantity, quote.amountMicrocredits, quote.estimated]);
const active = (task?: GenerationTask) => task?.status === "queued" || task?.status === "running";
const taskLabels = { queued: "排队中", running: "生成中", succeeded: "已完成", failed: "失败", cancelled: "已取消" };

export function WorkflowIdea(props: WorkflowIdeaProps) {
    const owner = useUserStore((state) => state.user?.id || "");
    return <IdeaSession key={JSON.stringify([owner, getActiveUserScope()])} {...props} owner={owner} />;
}

function IdeaSession({ onAdopt, disabled = false, onDirtyChange, owner }: WorkflowIdeaProps & { owner: string }) {
    const { message } = App.useApp();
    const operation = useDramaOperationScope("");
    const renderTicket = operation.capture();
    const ownerIsActive = Boolean(owner && getActiveUserScope() === owner);
    const queryClient = useQueryClient();
    const config = useEffectiveConfig();
    const catalog = useDramaModelCatalog();
    const [workspace, setWorkspace] = useState<IdeaWorkspace>(emptyIdeaWorkspace);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState("");
    const [quoting, setQuoting] = useState(false);
    const [checking, setChecking] = useState(false);
    const [restoreAttempt, setRestoreAttempt] = useState(0);
    const [confirmation, setConfirmation] = useState<QuoteDraft>();
    const [historyChoice, setHistoryChoice] = useState<GenerationTask>();
    const lock = useRef(false);
    const canEdit = useRef(false);
    const current = useRef({ workspace, onAdopt, onDirtyChange, disabled });
    current.current = { workspace, onAdopt, onDirtyChange, disabled };

    useEffect(() => {
        let cancelled = false;
        const ticket = operation.capture();
        if (!ownerIsActive) return;
        void readIdeaWorkspace(owner)
            .then((saved) => {
                if (!cancelled && operation.isCurrent(ticket)) {
                    setWorkspace(saved);
                    setReady(true);
                    setError("");
                }
            })
            .catch((cause) => {
                if (!cancelled && operation.isCurrent(ticket)) {
                    setError(cause instanceof Error ? cause.message : "本机草稿读取失败");
                    setReady(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [owner, ownerIsActive, restoreAttempt]);

    useEffect(() => () => current.current.onDirtyChange?.(false, false), []);

    useEffect(() => {
        if (!ready || !ownerIsActive || !operation.isCurrent(renderTicket)) return;
        const ticket = operation.capture();
        void writeIdeaWorkspace(owner, workspace).catch(() => {
            if (operation.isCurrent(ticket)) setError("本机草稿保存失败，请保留当前页面；任务仍保存在任务中心。");
        });
    }, [workspace, ready, owner]);

    const task = useQuery({
        queryKey: ["drama-idea-task", owner, workspace.taskId],
        enabled: ready && ownerIsActive && Boolean(workspace.taskId),
        retry: false,
        queryFn: async ({ signal }) => {
            const ticket = operation.capture();
            if (!operation.isCurrent(ticket)) throw new Error("页面或登录状态已变化");
            const result = await queryGenerationTask(workspace.taskId!, { signal });
            if (!operation.isCurrent(ticket)) throw new Error("页面或登录状态已变化");
            if (result.id !== workspace.taskId || !ideaTaskSource(result)) throw new Error("这个任务不是当前短剧创意扩写任务，请从任务中心核对");
            return result;
        },
        refetchInterval: (query) => (active(query.state.data) ? 2000 : false),
    });
    const history = useQuery({
        queryKey: ["drama-idea-history", owner],
        enabled: ownerIsActive,
        retry: false,
        queryFn: async ({ signal }) => {
            const ticket = operation.capture();
            if (!operation.isCurrent(ticket)) throw new Error("页面或登录状态已变化");
            const items = await listGenerationTasks(100, undefined, undefined, signal);
            if (!operation.isCurrent(ticket)) throw new Error("页面或登录状态已变化");
            const candidates = items.filter(ideaTaskCandidate).slice(0, 20);
            const details = await Promise.all(
                candidates.map(async (item) => {
                    if (!operation.isCurrent(ticket)) throw new Error("页面或登录状态已变化");
                    const detail = await queryGenerationTask(item.id, { signal });
                    if (!operation.isCurrent(ticket) || detail.id !== item.id) throw new Error("任务身份或登录状态已变化");
                    return detail;
                }),
            );
            return details.filter((item) => Boolean(ideaTaskSource(item)));
        },
    });

    useEffect(() => {
        if (!task.data || !ownerIsActive || !operation.isCurrent(renderTicket)) return;
        const pendingRetry = workspace.pendingRetry;
        if (pendingRetry?.taskId === task.data.id && (task.data.attempts > pendingRetry.attempts || active(task.data))) {
            setWorkspace((previous) => (previous.pendingRetry === pendingRetry ? { ...previous, pendingRetry: undefined } : previous));
        }
        try {
            if (task.data.status !== "succeeded") return;
            const text = ideaTaskText(task.data);
            const source = ideaTaskSource(task.data)!;
            setWorkspace((previous) =>
                previous.taskId !== task.data.id || (previous.resultTaskId === task.data.id && previous.resultEdited) || (previous.resultTaskId === task.data.id && previous.result === text)
                    ? previous
                    : { ...previous, format: source.format, result: text, resultTaskId: task.data.id, resultEdited: false },
            );
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "正文结果读取失败");
        }
    }, [task.data, workspace.pendingRetry]);

    const acceptTask = (result: GenerationTask, source?: IdeaSubmission) => {
        const receipt = ideaTaskSource(result);
        if (!receipt || (source && (ideaTaskOperationId(result) !== source.request.clientOperationId || receipt.idea !== source.idea || receipt.format !== source.format))) throw new Error("任务回执与本次创意扩写不匹配，请从任务中心核对");
        setWorkspace((previous) => ({
            ...previous,
            ...(source ? { idea: source.idea, format: source.format, choice: source.choice } : {}),
            taskId: result.id,
            pending: undefined,
            pendingRetry: undefined,
            resultTaskId: previous.resultTaskId === result.id && previous.resultEdited ? previous.resultTaskId : undefined,
            result: previous.resultTaskId === result.id && previous.resultEdited ? previous.result : "",
            resultEdited: previous.resultTaskId === result.id && previous.resultEdited,
        }));
        queryClient.setQueryData(["drama-idea-task", owner, result.id], result);
        void queryClient.invalidateQueries({ queryKey: ["drama-idea-history", owner] });
    };

    const submit = useMutation({
        mutationFn: async (draft: QuoteDraft) => {
            if (!operation.isCurrent(draft.ticket) || current.current.disabled) throw new Error("页面或登录状态已变化，请重新确认");
            const checkedQuote = await quoteModel(draft.quoteRequest);
            if (!operation.isCurrent(draft.ticket) || current.current.disabled) throw new Error("页面或登录状态已变化，请重新确认");
            if (quoteFingerprint(checkedQuote.quote) !== quoteFingerprint(draft.quote)) throw new Error("模型报价已变化，请重新查看费用并确认");
            if (draft.retryTaskId) {
                const latestTask = await queryGenerationTask(draft.retryTaskId);
                if (!operation.isCurrent(draft.ticket) || current.current.disabled) throw new Error("页面或登录状态已变化");
                if (!ideaTaskSource(latestTask) || !["failed", "cancelled"].includes(latestTask.status)) throw new Error("任务状态已变化，请刷新后再操作");
                const next = { ...current.current.workspace, pendingRetry: { taskId: latestTask.id, attempts: latestTask.attempts, updatedAt: latestTask.updatedAt } };
                await writeIdeaWorkspace(owner, next);
                if (!operation.isCurrent(draft.ticket) || current.current.disabled) throw new Error("页面或登录状态已变化");
                setWorkspace(next);
                const result = await retryGenerationTask(draft.retryTaskId);
                if (result.id !== draft.retryTaskId) throw new Error("重试回执与原任务不一致，请从任务中心核对");
                return { task: result };
            }
            if (!draft.submission) throw new Error("缺少已确认的扩写请求");
            const next = { ...current.current.workspace, pending: draft.submission };
            await writeIdeaWorkspace(owner, next);
            if (!operation.isCurrent(draft.ticket) || current.current.disabled) throw new Error("页面或登录状态已变化");
            setWorkspace(next);
            return { task: await createGenerationTask(draft.submission.request), source: draft.submission };
        },
        onSuccess: (result, draft) => {
            if (!operation.isCurrent(draft.ticket)) return;
            acceptTask(result.task, result.source);
            setConfirmation(undefined);
            setError("");
            message.success("扩写任务已排队，完成后可编辑并采用");
        },
        onError: (cause, draft) => {
            if (!operation.isCurrent(draft.ticket)) return;
            setConfirmation(undefined);
            setError(cause instanceof Error ? cause.message : "提交失败，请核对任务状态");
            if (cause instanceof ApiError && cause.status !== undefined && cause.status >= 400 && cause.status < 500 && ![408, 409, 425].includes(cause.status)) {
                setWorkspace((previous) => ({ ...previous, pending: undefined, pendingRetry: undefined }));
            }
            if (draft.retryTaskId) void task.refetch();
        },
        onSettled: () => {
            lock.current = false;
        },
    });

    const cancel = useMutation({
        mutationFn: async (input: { id: string; ticket: QuoteDraft["ticket"] }) => {
            if (!operation.isCurrent(input.ticket) || current.current.disabled) throw new Error("页面或登录状态已变化");
            const result = await cancelGenerationTask(input.id);
            if (result.id !== input.id || !ideaTaskSource(result)) throw new Error("取消回执与原任务不一致，请刷新核对");
            return result;
        },
        onSuccess: (result, input) => {
            if (!operation.isCurrent(input.ticket)) return;
            queryClient.setQueryData(["drama-idea-task", owner, result.id], result);
            void history.refetch();
        },
        onError: (cause, input) => {
            if (operation.isCurrent(input.ticket)) setError(cause instanceof Error ? cause.message : "取消失败，请刷新核对任务");
        },
    });

    const busy = quoting || checking || submit.isPending || cancel.isPending;
    const frozen = disabled || busy || active(task.data) || !ready;
    const choice = workspace.choice || catalog.data?.defaults.text;
    canEdit.current = !frozen && !workspace.pending && !workspace.pendingRetry && !confirmation && !historyChoice;
    const result = task.data && active(task.data) ? task.data.textDraft || "" : workspace.result;
    useEffect(() => {
        current.current.onDirtyChange?.(Boolean(workspace.idea.trim() || workspace.resultEdited || workspace.pending || workspace.pendingRetry), busy || active(task.data));
    }, [workspace.idea, workspace.resultEdited, workspace.pending, workspace.pendingRetry, busy, task.data?.status]);

    const prepareQuote = async (replay = false, retry = false) => {
        if (lock.current || frozen || workspace.pendingRetry || (workspace.pending && !replay) || !owner || confirmation) return;
        lock.current = true;
        setQuoting(true);
        setError("");
        const ticket = operation.capture();
        try {
            const source = retry && task.data ? ideaTaskSource(task.data) : undefined;
            const selected = source?.choice || (replay ? workspace.pending?.choice : choice);
            if (!selected) throw new Error("请选择文本模型");
            const model = dramaChoiceToModel(config, "text", selected);
            const catalogQuote = systemModelQuoteRequest({ ...config, model }, model, "text");
            if (!catalogQuote) throw new Error("当前模型无法报价，请刷新模型目录后重试");
            const submission = retry ? undefined : replay ? workspace.pending : await prepareIdeaSubmission(config, selected, workspace.idea, workspace.format);
            if (!retry && !submission) throw new Error("没有待恢复的原始提交");
            let quoteRequest = catalogQuote;
            if (submission) {
                const request = submission.request;
                const provider = request.input?.config as Record<string, unknown> | undefined;
                if (request.logicalModelId) quoteRequest = { logicalModelID: request.logicalModelId, intent: catalogQuote.intent };
                else if (typeof provider?.channelId === "string" && typeof provider.model === "string") quoteRequest = { channelId: provider.channelId, modelKey: provider.model, intent: catalogQuote.intent };
                else throw new Error("原提交缺少可核对的模型身份，请从任务历史核对");
            }
            const quote = await quoteModel(quoteRequest);
            if (operation.isCurrent(ticket) && !current.current.disabled)
                setConfirmation({ quote: quote.quote, quoteRequest: JSON.parse(JSON.stringify(quoteRequest)) as ModelQuoteRequest, submission, retryTaskId: retry ? task.data?.id : undefined, ticket });
        } catch (cause) {
            if (operation.isCurrent(ticket)) setError(cause instanceof Error ? cause.message : "报价失败");
        } finally {
            lock.current = false;
            if (operation.isCurrent(ticket)) setQuoting(false);
        }
    };

    const recover = async () => {
        if (!workspace.pending || busy || lock.current || disabled) return;
        lock.current = true;
        setChecking(true);
        const ticket = operation.capture();
        try {
            const tasks = await history.refetch();
            if (!operation.isCurrent(ticket)) return;
            if (tasks.error) throw tasks.error;
            const found = tasks.data?.find((item) => ideaTaskOperationId(item) === workspace.pending!.request.clientOperationId);
            if (found) acceptTask(found, workspace.pending);
            else setError("最近任务中尚未找到回执。可继续原提交核对，系统会复用相同提交标识，避免重复建单。");
        } catch (cause) {
            if (operation.isCurrent(ticket)) setError(cause instanceof Error ? cause.message : "暂时无法核对任务");
        } finally {
            lock.current = false;
            if (operation.isCurrent(ticket)) setChecking(false);
        }
    };

    const restoreTask = (selectedTask: GenerationTask) => {
        if (busy || disabled || workspace.pending || workspace.pendingRetry || confirmation) return;
        const source = ideaTaskSource(selectedTask);
        const ticket = operation.capture();
        if (!source || !operation.isCurrent(ticket)) return;
        setWorkspace({ ...emptyIdeaWorkspace(), idea: source.idea, format: source.format, choice: source.choice, taskId: selectedTask.id });
        setReady(true);
        setError("");
        setHistoryChoice(undefined);
    };

    return (
        <section className="drama-workflow-idea" aria-label="创意扩写正文">
            <header>
                <h2>从一句想法开始</h2>
                <p>生成一份可编辑的 AI 正文草稿。只有点击采用，才会填入导入正文。</p>
            </header>
            <Input.TextArea
                aria-label="创作想法"
                value={workspace.idea}
                maxLength={4000}
                autoSize={{ minRows: 3, maxRows: 6 }}
                disabled={frozen || Boolean(workspace.pending || workspace.pendingRetry || confirmation)}
                onChange={(event) => {
                    const value = event.target.value;
                    setWorkspace((previous) => ({ ...previous, idea: value }));
                }}
                placeholder="例如：整个小区突然穿越到森林，兄弟俩依靠每日结算系统重建家园。"
            />
            <div className="drama-workflow-idea-controls">
                <label>
                    输出形式
                    <select
                        aria-label="扩写正文类型"
                        value={workspace.format}
                        disabled={frozen || Boolean(workspace.pending || workspace.pendingRetry || confirmation)}
                        onChange={(event) => {
                            const value = event.target.value as IdeaSourceFormat;
                            setWorkspace((previous) => ({ ...previous, format: value }));
                        }}
                    >
                        <option value="script">剧本</option>
                        <option value="novel">故事正文</option>
                    </select>
                </label>
                <div className="drama-workflow-idea-model">
                    {frozen || workspace.pending || workspace.pendingRetry || confirmation ? (
                        <span>{choice?.label || "当前文本模型"}</span>
                    ) : (
                        <DramaModelPicker
                            key={workspace.taskId || "new"}
                            capability="text"
                            value={choice}
                            onChange={(value) => {
                                const ticket = operation.capture();
                                if (operation.isCurrent(ticket) && current.current.workspace.taskId === workspace.taskId && canEdit.current && !lock.current) setWorkspace((previous) => ({ ...previous, choice: value }));
                            }}
                        />
                    )}
                </div>
                <Button type="primary" disabled={frozen || !workspace.idea.trim() || !choice || Boolean(workspace.pending || workspace.pendingRetry || confirmation)} loading={quoting} onClick={() => void prepareQuote()}>
                    扩写正文
                </Button>
                <Link to="/tasks">任务历史</Link>
            </div>
            {confirmation ? (
                <div className="drama-workflow-idea-confirm" role="region" aria-label="确认扩写费用">
                    <p>{modelQuoteDescription(confirmation.quote)}</p>
                    <Button disabled={submit.isPending} onClick={() => setConfirmation(undefined)}>
                        取消
                    </Button>
                    <Button
                        type="primary"
                        loading={submit.isPending}
                        disabled={disabled || submit.isPending}
                        onClick={() => {
                            if (!lock.current) {
                                lock.current = true;
                                submit.mutate(confirmation);
                            }
                        }}
                    >
                        确认并{confirmation.retryTaskId ? "重试" : "生成"}
                    </Button>
                </div>
            ) : null}
            {workspace.pending && !submit.isPending ? (
                <div role="status">
                    <p>提交回执尚未确认，已保留原始请求。核对期间不会自动重新生成。</p>
                    <Button disabled={busy || disabled} onClick={() => void recover()}>
                        核对提交
                    </Button>
                    <Button disabled={busy || disabled} onClick={() => void prepareQuote(true)}>
                        继续原提交
                    </Button>
                </div>
            ) : null}
            {workspace.pendingRetry && !submit.isPending ? (
                <div role="status">
                    <p>重试回执尚未确认，请先刷新核对。状态确认前不会再次提交重试。</p>
                    <Button disabled={busy || disabled} onClick={() => void task.refetch()}>
                        核对重试状态
                    </Button>
                </div>
            ) : null}
            {task.data ? (
                <div className="drama-workflow-idea-progress" role="status">
                    <span>扩写任务：{taskLabels[task.data.status]}</span>
                    {active(task.data) ? <Progress percent={Math.max(0, Math.min(100, task.data.progress || 0))} status="active" /> : null}
                    {task.data.error ? <p>{task.data.error}</p> : null}
                    {active(task.data) ? (
                        <Button disabled={disabled || busy} loading={cancel.isPending} onClick={() => cancel.mutate({ id: task.data.id, ticket: operation.capture() })}>
                            取消任务
                        </Button>
                    ) : null}
                    {["failed", "cancelled"].includes(task.data.status) ? (
                        <Button disabled={frozen || Boolean(workspace.pendingRetry || workspace.pending || confirmation)} onClick={() => void prepareQuote(false, true)}>
                            重试扩写
                        </Button>
                    ) : null}
                </div>
            ) : null}
            {result || task.data?.status === "succeeded" ? (
                <div className="drama-workflow-idea-result">
                    <label>
                        AI 扩写草稿 · 尚未采用
                        <Input.TextArea
                            aria-label="扩写正文草稿"
                            value={result}
                            readOnly={task.data?.status !== "succeeded" || workspace.resultTaskId !== task.data?.id}
                            disabled={disabled || busy}
                            autoSize={{ minRows: 6, maxRows: 16 }}
                            onChange={(event) => {
                                const value = event.target.value;
                                setWorkspace((previous) => (previous.taskId === task.data?.id && previous.resultTaskId === task.data?.id ? { ...previous, result: value, resultEdited: true } : previous));
                            }}
                        />
                    </label>
                    <Button
                        type="primary"
                        disabled={disabled || busy || Boolean(task.error || workspace.pending || workspace.pendingRetry || confirmation) || task.data?.status !== "succeeded" || workspace.resultTaskId !== task.data?.id || !workspace.result.trim()}
                        onClick={() => {
                            const ticket = operation.capture();
                            const source = task.data && ideaTaskSource(task.data);
                            if (operation.isCurrent(ticket) && !current.current.disabled && !lock.current && task.data?.status === "succeeded" && !task.error && source && workspace.resultTaskId === task.data.id && workspace.result.trim())
                                current.current.onAdopt(workspace.result, source.format);
                        }}
                    >
                        采用为正文
                    </Button>
                </div>
            ) : null}
            {error || task.error || history.error ? (
                <p role="alert">
                    {error || (task.error instanceof Error ? task.error.message : history.error instanceof Error ? history.error.message : "任务读取失败")}
                    <Button
                        size="small"
                        onClick={() => {
                            if (workspace.taskId) void task.refetch();
                            void history.refetch();
                            if (!ready) setRestoreAttempt((previous) => previous + 1);
                        }}
                    >
                        刷新任务
                    </Button>
                </p>
            ) : null}
            {history.data?.length ? (
                <label>
                    最近扩写任务（从最近 100 条任务中读取，最多 20 项）
                    <select
                        aria-label="恢复扩写任务"
                        value={workspace.taskId || ""}
                        disabled={busy || disabled || active(task.data) || Boolean(workspace.pending || workspace.pendingRetry || confirmation)}
                        onChange={(event) => {
                            const selectedTask = history.data?.find((item) => item.id === event.target.value);
                            if (!selectedTask || selectedTask.id === workspace.taskId) return;
                            const currentSource = task.data && ideaTaskSource(task.data);
                            const changedIdea = workspace.idea.trim() && (!currentSource || workspace.idea !== currentSource.idea || workspace.format !== currentSource.format);
                            if (workspace.resultEdited || changedIdea) setHistoryChoice(selectedTask);
                            else restoreTask(selectedTask);
                        }}
                    >
                        <option value="">选择任务</option>
                        {history.data.map((item) => (
                            <option key={item.id} value={item.id}>
                                {taskLabels[item.status]} · {ideaTaskSource(item)?.idea.slice(0, 30)}
                            </option>
                        ))}
                    </select>
                </label>
            ) : null}
            {historyChoice ? (
                <div className="drama-workflow-idea-confirm" role="region" aria-label="确认切换扩写草稿">
                    <p>切换任务会替换当前创意，并放弃正文的手动修改。</p>
                    <Button onClick={() => setHistoryChoice(undefined)}>保留当前草稿</Button>
                    <Button disabled={busy || disabled} onClick={() => restoreTask(historyChoice)}>
                        放弃修改并切换
                    </Button>
                </div>
            ) : null}
            {catalog.isError ? (
                <p role="alert">
                    文本模型目录读取失败。<Button onClick={() => void catalog.refetch()}>重新读取模型</Button>
                </p>
            ) : null}
        </section>
    );
}
