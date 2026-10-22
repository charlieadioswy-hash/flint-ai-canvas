import { useState } from "react";
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
                    <section className="model3d-composer" aria-label="独立 3D 创作参数">
                        <Model3DInputs draft={draft} capabilities={capabilities} count={count} disabled={disabled} onChange={workflow.setDraft} onCountChange={workflow.setCount} onUpload={workflow.uploadImage} onIdeas={() => setIdeasOpen(true)} />
                        <footer className="model3d-submit">
                            {!capabilities?.available && !loading ? <p className="model3d-error">3D 生成服务尚未启用，请联系管理员。</p> : null}
                            {inputError ? <p className="model3d-hint">{inputError}</p> : null}
                            <Button type="primary" block size="large" loading={submitting || uploading} disabled={disabled || !capabilities?.available || Boolean(inputError)} onClick={() => setConfirmation({ draft: structuredClone(draft), count })}>
                                确认并生成 {count} 个版本
                            </Button>
                            <p className="model3d-hint">任务在后台运行，产物自动保存到资产库。</p>
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
                            onSelect={workflow.selectTask}
                            onRefresh={() => void workflow.refresh()}
                            onRecover={(id) => void workflow.recover(id)}
                            onReuse={(task) => workflow.reuseTask(task.id)}
                            onLoadMore={() => void workflow.loadMore()}
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
                okText={confirmation ? `开始生成 ${confirmation.count} 个版本` : "开始生成"}
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
                    void workflow.generate(snapshot.draft, snapshot.count);
                }}
            >
                {confirmed ? (
                    <div className="model3d-confirmation">
                        <p className="model3d-hint">请确认输入、形态与面数，每个候选都会独立执行一次生成。</p>
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
                                <dt>目标面数</dt>
                                <dd>{confirmed.parameters.faceLimit?.toLocaleString()}</dd>
                            </div>
                            <div>
                                <dt>候选数量</dt>
                                <dd>{confirmation?.count} 个独立任务</dd>
                            </div>
                        </dl>
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
