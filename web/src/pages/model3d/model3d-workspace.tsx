import { useRef, useState } from "react";
import { Button } from "antd";
import { ArrowUpRight, Box, RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { PageHeader, WorkspacePage } from "@/components/layout/workspace-page";
import { AppModal } from "@/components/ui/product/app-modal";
import { model3DInputError, MODEL3D_MODE_LABELS, type Model3DDraft } from "@/lib/canvas/model3d";
import type { useModel3DWorkflow } from "./use-model3d-workflow";
import { Model3DInputs } from "./model3d-inputs";
import { Model3DResults } from "./model3d-results";
import { Model3DPromptIdeas } from "./model3d-prompt-ideas";
import "./model3d.css";

export type Model3DWorkspaceProps = ReturnType<typeof useModel3DWorkflow>;

export function Model3DWorkspace(workflow: Model3DWorkspaceProps) {
    const [ideasOpen, setIdeasOpen] = useState(false);
    const [confirmation, setConfirmation] = useState<{ draft: Model3DDraft; count: number } | null>(null);
    const [editingVersion, setEditingVersion] = useState("");
    const composer = useRef<HTMLElement>(null);
    const { capabilities, draft, count, loading, submitting, uploading } = workflow;
    const disabled = loading || submitting || uploading;
    const inputError = model3DInputError(draft, [], [], capabilities) || (!draft.parameters.faceLimit ? "请设置目标面数。" : "");
    const selectedTask = workflow.tasks.find((task) => task.id === workflow.selectedTaskId) || workflow.tasks[0];
    const confirmed = confirmation?.draft;
    const confirmationError = confirmed ? model3DInputError(confirmed, [], [], capabilities) : "";
    return (
        <WorkspacePage className="model3d-page">
            <div className="model3d-page-inner">
                <PageHeader
                    title="3D 创作"
                    description="从文字或图片生成模型，保存每个候选版本，随时预览与导出。"
                    meta={
                        <span className="model3d-title-badge">
                            <Box className="size-3.5" />
                            独立工作台
                        </span>
                    }
                    actions={
                        <Link to="/assets" className="model3d-assets-link">
                            查看资产库
                            <ArrowUpRight className="size-4" />
                        </Link>
                    }
                />
                <div className="model3d-layout">
                    <section ref={composer} tabIndex={-1} className="model3d-composer" aria-label="独立 3D 创作参数">
                        {editingVersion ? (
                            <div className="model3d-editing-note" role="status">
                                <strong>已载入版本输入 · {editingVersion}</strong>
                                <p className="model3d-hint">{draft.mode === "text" ? "修改提示词和参数" : "替换参考图片或修改参数"}后，确认生成新版本。原版本及其模型文件会保留。</p>
                            </div>
                        ) : null}
                        <Model3DInputs draft={draft} capabilities={capabilities} count={count} disabled={disabled} onChange={workflow.setDraft} onCountChange={workflow.setCount} onUpload={workflow.uploadImage} onIdeas={() => setIdeasOpen(true)} />
                        <footer className="model3d-submit">
                            {!capabilities?.available && !loading ? <p className="model3d-error">3D 生成服务尚未启用，请联系管理员。</p> : null}
                            {inputError ? <p className="model3d-hint">{inputError}</p> : null}
                            <Button type="primary" block size="large" loading={submitting || uploading} disabled={disabled || !capabilities?.available || Boolean(inputError)} onClick={() => setConfirmation({ draft: structuredClone(draft), count })}>
                                确认并生成 {count} 个新版本
                            </Button>
                            <p className="model3d-hint">每次生成独立保存为新版本，产物自动进入资产库。可继续修改输入再生成。</p>
                            <Button type="text" size="small" icon={<RefreshCw className="size-3" />} disabled={loading} onClick={() => void workflow.refresh()}>
                                更新服务配置与任务
                            </Button>
                        </footer>
                    </section>
                    <div className="model3d-output-column">
                        {workflow.error ? (
                            <div role="alert" className="model3d-notice">
                                <span>{workflow.error}</span>
                                <Button size="small" onClick={() => void workflow.refresh()}>
                                    重新同步
                                </Button>
                            </div>
                        ) : null}
                        <Model3DResults
                            tasks={workflow.tasks}
                            selectedTask={selectedTask}
                            loading={loading || workflow.loadingMore}
                            refreshing={workflow.refreshing}
                            hasMore={workflow.hasMore}
                            editingDisabled={disabled}
                            onSelect={(id) => void workflow.selectTask(id)}
                            onRefresh={() => void workflow.refresh()}
                            onRecover={(id) => void workflow.recover(id)}
                            onReuse={(task) => {
                                if (disabled) return;
                                void workflow.selectTask(task.id);
                                workflow.reuseTask(task.id);
                                setEditingVersion(new Date(task.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
                                composer.current?.scrollIntoView?.({ block: "start" });
                                composer.current?.focus({ preventScroll: true });
                            }}
                            onLoadMore={() => void workflow.loadMore()}
                            processingOperations={capabilities?.available ? capabilities.processingOperations : []}
                            onProcess={(processing) => void workflow.processModel(processing)}
                            onSource={(id) => void workflow.selectTask(id)}
                            onFindSegmentation={workflow.findSegmentation}
                        />
                    </div>
                </div>
            </div>
            {ideasOpen ? (
                <Model3DPromptIdeas
                    prompt={draft.prompt}
                    onClose={() => setIdeasOpen(false)}
                    onApply={(prompt) => {
                        workflow.setDraft((current) => ({ ...current, prompt, mode: "text" }));
                        setIdeasOpen(false);
                    }}
                />
            ) : null}
            <AppModal
                open={Boolean(confirmation)}
                title="确认这次 3D 创作"
                okText={confirmation ? `开始生成 ${confirmation.count} 个新版本` : "开始生成"}
                cancelText="返回修改"
                confirmLoading={submitting}
                okButtonProps={{ disabled: Boolean(confirmationError) || disabled || !capabilities?.available }}
                onCancel={() => {
                    if (!submitting) setConfirmation(null);
                }}
                onOk={() => {
                    if (!confirmation || disabled || confirmationError) return;
                    const snapshot = confirmation;
                    setConfirmation(null);
                    setEditingVersion("");
                    void workflow.generate(snapshot.draft, snapshot.count);
                }}
            >
                {confirmed ? (
                    <div className="model3d-confirmation">
                        <p className="model3d-hint">每个候选都会独立执行一次生成，并保存为新版本。已有版本及其模型文件不会被覆盖。</p>
                        <dl>
                            <div>
                                <dt>输入方式</dt>
                                <dd>{MODEL3D_MODE_LABELS[confirmed.mode]}</dd>
                            </div>
                            <div>
                                <dt>生成模型</dt>
                                <dd>{capabilities?.modelVersions.find((model) => model.id === confirmed.parameters.model)?.label || confirmed.parameters.model}</dd>
                            </div>
                            <div>
                                <dt>模型形态</dt>
                                <dd>
                                    {confirmed.parameters.texture ? "带纹理" : "白模"} · {confirmed.parameters.quad ? "四边面" : "三角面"}
                                </dd>
                            </div>
                            <div>
                                <dt>贴图质量</dt>
                                <dd>
                                    {!confirmed.parameters.texture
                                        ? "白模（不生成贴图）"
                                        : confirmed.parameters.textureQuality === "extreme"
                                          ? "8K 贴图"
                                          : confirmed.parameters.textureQuality === "detailed"
                                            ? "高清贴图"
                                            : confirmed.parameters.textureQuality === "fast"
                                              ? "快速贴图"
                                              : "标准贴图"}
                                </dd>
                            </div>
                            <div>
                                <dt>目标面数</dt>
                                <dd>{confirmed.parameters.faceLimit?.toLocaleString()}</dd>
                            </div>
                            <div>
                                <dt>候选数量</dt>
                                <dd>{confirmation?.count} 个独立任务</dd>
                            </div>
                        </dl>
                        {confirmed.parameters.texture && confirmed.parameters.textureQuality === "extreme" ? <p className="model3d-hint">8K 指贴图分辨率，会增加生成耗时、文件大小和预览显存占用；生成费用以服务商实际计费为准。</p> : null}
                        <p className="model3d-confirmation-prompt">{confirmed.mode === "text" ? confirmed.prompt : confirmed.mode === "image" ? confirmed.image?.title || "已上传参考图" : "已指定多视角参考图"}</p>
                        {confirmationError ? (
                            <p role="alert" className="model3d-error">
                                {confirmationError}
                            </p>
                        ) : null}
                    </div>
                ) : null}
            </AppModal>
        </WorkspacePage>
    );
}
