import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Input } from "antd";
import { Sparkles } from "lucide-react";

import { ModelPicker } from "@/components/model-picker";
import { AppModal } from "@/components/ui/product/app-modal";
import { STYLE_DRAFT_IDEA_LIMIT } from "@/lib/canvas/style-profile-drafting";
import type { StyleProfileSnapshot } from "@/lib/canvas/style-profile";
import { canCancelGenerationTask } from "@/lib/generation-task-display";
import { getActiveUserScope } from "@/lib/user-scope";
import { cancelGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { generateStyleProfileDraft } from "@/services/style-profile-drafting";
import { configuredModelMatchesCapability, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type DraftRequest = {
    controller: AbortController;
    scope: string;
    task?: GenerationTask;
    cancellationSent?: boolean;
};

export function StyleProfileDraftModal({ profile, onClose, onFill }: { profile: StyleProfileSnapshot; onClose: () => void; onFill: (profile: StyleProfileSnapshot) => void }) {
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const userId = useUserStore((state) => state.user?.id);
    const isReady = useConfigStore((state) => state.isAiConfigReady);
    const [model, setModel] = useState(config.textModel);
    const [idea, setIdea] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const requestRef = useRef<DraftRequest | null>(null);
    const generationConfig = { ...config, model, textModel: model, taskWorkflowProvider: "model" as const };
    const modelReady = configuredModelMatchesCapability(config, model, "text") && isReady(generationConfig, model);

    const cancelTask = useCallback(
        (request: DraftRequest) => {
            if (request.scope !== getActiveUserScope() || request.cancellationSent || !request.task || !canCancelGenerationTask(request.task)) return;
            request.cancellationSent = true;
            void cancelGenerationTask(request.task.id).catch(() => {
                if (request.scope === getActiveUserScope()) message.warning("未能取消填写任务，可在任务中心查看状态");
            });
        },
        [message],
    );

    useEffect(() => {
        setBusy(false);
        setError("");
        setIdea("");
        return () => {
            const request = requestRef.current;
            requestRef.current = null;
            if (!request) return;
            request.controller.abort();
            cancelTask(request);
        };
    }, [cancelTask, profile, userId]);

    const requestClose = () => {
        const request = requestRef.current;
        if (request) {
            request.controller.abort();
            cancelTask(request);
        }
        onClose();
    };

    const generate = async () => {
        if (requestRef.current || !idea.trim() || !modelReady || !userId) return;
        const request: DraftRequest = { controller: new AbortController(), scope: getActiveUserScope() };
        requestRef.current = request;
        setBusy(true);
        setError("");
        try {
            const result = await generateStyleProfileDraft({
                idea,
                profile,
                config: generationConfig,
                signal: request.controller.signal,
                onTaskUpdate: (task) => {
                    request.task = task;
                    // 创建回执可能晚于关闭弹窗，拿到 ID 后仍需取消同一任务。
                    if (request.controller.signal.aborted) cancelTask(request);
                },
            });
            if (request.controller.signal.aborted || requestRef.current !== request || request.scope !== getActiveUserScope()) return;
            onFill(result);
            onClose();
        } catch (cause) {
            if (!request.controller.signal.aborted && requestRef.current === request && request.scope === getActiveUserScope()) setError(cause instanceof Error ? cause.message : "风格填写失败，请重试");
        } finally {
            if (requestRef.current === request) {
                requestRef.current = null;
                if (!request.controller.signal.aborted && request.scope === getActiveUserScope()) setBusy(false);
            }
        }
    };

    return (
        <AppModal open title="AI 帮我填写" onCancel={requestClose} footer={null} width={600}>
            <div className="space-y-4">
                <p className="text-xs leading-5 text-foreground/55">描述你想要的画面风格，AI 会补齐名称、简介、标签、Prompt、负面约束、辅助标注和执行策略。填入后可继续修改，再手动保存。</p>
                <Input.TextArea
                    autoFocus
                    aria-label="风格描述"
                    value={idea}
                    onChange={(event) => setIdea(event.target.value)}
                    placeholder="例如：东方志怪题材，工笔线条和暗彩水墨，青绿与赭红配色，人物克制写实，古建筑有年代感，画面神秘但不恐怖。"
                    autoSize={{ minRows: 5, maxRows: 9 }}
                    maxLength={STYLE_DRAFT_IDEA_LIMIT}
                    showCount
                    disabled={busy}
                />
                <div className="space-y-2">
                    <p className="text-xs font-medium text-foreground/62">文本模型</p>
                    {busy ? <p className="text-xs text-foreground/55">正在生成风格配置…</p> : <ModelPicker config={config} capability="text" value={model} onChange={setModel} placeholder="选择用于填写风格的文本模型" showOptionPrices fullWidth />}
                    {!busy && !modelReady ? <p className="text-xs text-foreground/55">请先选择可用的文本模型。</p> : null}
                </div>
                <p className="text-xs leading-5 text-foreground/45">已选择的封面和执行资产会保留。需要的图片、LoRA 或模板可在填写后自行选择。</p>
                {error ? (
                    <p role="alert" className="text-xs leading-5 text-destructive">
                        {error}
                    </p>
                ) : null}
                <div className="flex justify-end gap-2 border-t border-border pt-4">
                    <Button onClick={requestClose}>{busy ? "停止填写" : "取消"}</Button>
                    <Button type="primary" icon={<Sparkles className="size-3.5" />} loading={busy} disabled={!idea.trim() || !modelReady || !userId} onClick={() => void generate()}>
                        生成并填入
                    </Button>
                </div>
            </div>
        </AppModal>
    );
}
