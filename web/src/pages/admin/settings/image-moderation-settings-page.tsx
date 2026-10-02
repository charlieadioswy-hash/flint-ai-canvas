import { App, Button, Form, Input, InputNumber, Skeleton } from "antd";
import { Archive, Check, CirclePause, KeyRound, Plus, RefreshCw, RotateCcw, Save, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router";

import { cn } from "@/lib/utils";
import {
    activateModerationProvider,
    archiveModerationProvider,
    disableImageModeration,
    getModerationAdminState,
    saveModerationProvider,
    validateModerationProvider,
    type ModerationAdminState,
    type ModerationProviderView,
} from "@/services/api/image-moderation";
import { AdminPageFrame } from "../components/admin-shell";
import { AdminStatTile, AdminStatusBadge, configuredSecretText, SettingsSectionCard } from "../components/admin-ui";
import { Callout, Checkbox, Select, Switch } from "../ui/controls";
import {
    isModerationAdminState,
    moderationProviderDraft,
    moderationProviderDraftChanged,
    moderationProviderInput,
    moderationProviderResponseMatches,
    moderationProviderStatus,
    validateModerationProviderDraft,
    type ImageModerationProviderDraft,
} from "./image-moderation-settings-form";
import "./image-moderation-settings-page.css";

export default function ImageModerationSettingsPage() {
    const { message, modal } = App.useApp();
    const [state, setState] = useState<ModerationAdminState | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [busyAction, setBusyAction] = useState("");
    const [dirty, setDirty] = useState(false);
    const [error, setError] = useState("");
    const [needsRefresh, setNeedsRefresh] = useState(false);
    const [validationMessage, setValidationMessage] = useState<{ valid: boolean; message: string } | null>(null);
    const [form] = Form.useForm<ImageModerationProviderDraft>();
    const selectedIdRef = useRef<string | null>(null);
    const loadVersionRef = useRef(0);
    const loadControllerRef = useRef<AbortController | null>(null);
    const navigationConfirmRef = useRef(false);
    const selectedProvider = state?.providers.find((provider) => provider.id === selectedId) || null;
    const watchedValues = Form.useWatch([], form) as ImageModerationProviderDraft | undefined;
    const providerType = state?.providerTypes.find((item) => item.type === (watchedValues?.type || selectedProvider?.type));
    const busy = loading || Boolean(busyAction);
    const writeLocked = busy || needsRefresh;

    const applySelection = useCallback((nextState: ModerationAdminState, provider: ModerationProviderView | null) => {
        selectedIdRef.current = provider?.id || null;
        setSelectedId(provider?.id || null);
        form.resetFields();
        form.setFieldsValue(moderationProviderDraft(provider, nextState));
        setDirty(false);
        setValidationMessage(null);
    }, [form]);

    const load = useCallback(async (initial = false) => {
        const version = ++loadVersionRef.current;
        loadControllerRef.current?.abort();
        const controller = new AbortController();
        loadControllerRef.current = controller;
        if (initial) setLoading(true);
        else setBusyAction("refresh");
        try {
            const result = await getModerationAdminState(controller.signal);
            if (version !== loadVersionRef.current) return;
            if (!isModerationAdminState(result)) throw new Error("服务端返回的检测配置格式无效，请核对接口版本");
            const provider = result.providers.find((item) => item.id === selectedIdRef.current && !item.archived)
                || result.providers.find((item) => item.id === result.activeProviderId && !item.archived)
                || result.providers.find((item) => !item.archived) || null;
            setState(result);
            applySelection(result, provider);
            setNeedsRefresh(false);
            setError("");
        } catch (cause) {
            if (version !== loadVersionRef.current) return;
            setError(errorText(cause, "读取图片合规检测配置失败"));
            setNeedsRefresh(true);
        } finally {
            if (version === loadVersionRef.current) {
                setLoading(false);
                setBusyAction("");
            }
        }
    }, [applySelection]);

    useEffect(() => {
        void load(true);
        return () => { loadVersionRef.current += 1; loadControllerRef.current?.abort(); };
    }, [load]);

    const blocker = useBlocker(dirty && !busyAction);
    useEffect(() => {
        const handleBeforeUnload = (event: BeforeUnloadEvent) => {
            if (dirty) event.preventDefault();
        };
        window.addEventListener("beforeunload", handleBeforeUnload);
        return () => window.removeEventListener("beforeunload", handleBeforeUnload);
    }, [dirty]);

    useEffect(() => {
        if (blocker.state !== "blocked" || navigationConfirmRef.current) return;
        navigationConfirmRef.current = true;
        modal.confirm({
            title: "放弃检测配置草稿？",
            content: "尚未保存的配置和输入凭据会丢失。",
            okText: "放弃并离开",
            cancelText: "继续编辑",
            okButtonProps: { danger: true },
            onOk: () => { navigationConfirmRef.current = false; blocker.proceed(); },
            onCancel: () => { navigationConfirmRef.current = false; blocker.reset(); },
        });
    }, [blocker, modal]);

    const discardThen = (action: () => void | Promise<void>) => {
        if (!dirty) { void action(); return; }
        modal.confirm({
            title: "放弃当前配置草稿？",
            content: "尚未保存的修改和输入凭据会被清除。",
            okText: "放弃修改",
            cancelText: "继续编辑",
            okButtonProps: { danger: true },
            onOk: action,
        });
    };

    const runWrite = async (action: string, operation: () => Promise<void>) => {
        if (writeLocked) return;
        setBusyAction(action);
        setError("");
        try {
            await operation();
        } catch (cause) {
            const detail = errorText(cause, "检测配置操作失败");
            setError(`${detail}。未自动重试，请刷新配置核对后继续操作。`);
            setNeedsRefresh(true);
            message.error(detail);
        } finally {
            setBusyAction("");
        }
    };

    const save = async () => {
        if (!state || writeLocked) return;
        let values: ImageModerationProviderDraft;
        try { values = await form.validateFields(); } catch { return; }
        const validationError = validateModerationProviderDraft(values, selectedProvider, state);
        if (validationError) { message.error(validationError); return; }
        const input = moderationProviderInput(values);
        await runWrite("save", async () => {
            const result = await saveModerationProvider(input, selectedProvider?.id);
            if (!moderationProviderResponseMatches(result, input, selectedProvider)) throw new Error("服务端返回的检测配置与本次保存内容不一致");
            const nextState = { ...state, providers: [...state.providers.filter((provider) => provider.id !== result.id), result] };
            setState(nextState);
            applySelection(nextState, result);
            message.success("新配置版本已保存，请单独设为生效");
        });
    };

    const activate = async (provider: ModerationProviderView) => {
        if (!state || dirty || writeLocked) return;
        await runWrite("activate", async () => {
            const result = await activateModerationProvider(provider.id, provider.configId, state.policyRevision);
            if (!isModerationAdminState(result) || result.activeProviderId !== provider.id || result.activeConfigId !== provider.configId || result.policyRevision <= state.policyRevision) throw new Error("服务端尚未确认本次生效切换");
            setState(result);
            applySelection(result, result.providers.find((item) => item.id === provider.id) || null);
            message.success("检测配置已设为生效，仅影响后续手动检测");
        });
    };

    const disable = async () => {
        if (!state || writeLocked) return;
        await runWrite("disable", async () => {
            const result = await disableImageModeration(state.policyRevision);
            if (!isModerationAdminState(result) || result.activeProviderId || result.activeConfigId || result.policyRevision <= state.policyRevision) throw new Error("服务端尚未确认停用检测");
            setState(result);
            message.success("已停用新的图片检测，在途检测沿用原配置");
        });
    };

    const archive = async (provider: ModerationProviderView) => {
        if (!state || writeLocked || provider.id === state.activeProviderId) return;
        await runWrite("archive", async () => {
            const result = await archiveModerationProvider(provider.id);
            if (!isModerationAdminState(result) || !result.providers.find((item) => item.id === provider.id)?.archived) throw new Error("服务端尚未确认 Provider 归档");
            setState(result);
            applySelection(result, result.providers.find((item) => item.id === result.activeProviderId && !item.archived) || result.providers.find((item) => !item.archived) || null);
            message.success("Provider 已归档，历史报告保留");
        });
    };

    const validate = async () => {
        if (!selectedProvider || dirty || writeLocked) return;
        setBusyAction("validate");
        setValidationMessage(null);
        try {
            const result = await validateModerationProvider(selectedProvider.id, selectedProvider.configId);
            setValidationMessage(result);
        } catch (cause) {
            setValidationMessage({ valid: false, message: errorText(cause, "配置校验失败") });
        } finally { setBusyAction(""); }
    };

    if (loading && !state) {
        return <AdminPageFrame title="图片合规检测" description="统一管理检测平台、检测项目和生效版本" scroll><div className="admin-moderation-settings" role="status" aria-label="正在读取检测配置"><Skeleton active paragraph={{ rows: 8 }} /></div></AdminPageFrame>;
    }
    if (!state) {
        return <AdminPageFrame title="图片合规检测" description="统一管理检测平台、检测项目和生效版本" scroll><Callout tone="error" title="无法读取检测配置" action={<Button loading={busyAction === "refresh"} onClick={() => void load()}>重新读取</Button>}>{error}</Callout></AdminPageFrame>;
    }

    const activeProvider = state.providers.find((provider) => provider.id === state.activeProviderId);
    const currentStatus = selectedProvider ? moderationProviderStatus(selectedProvider, state) : { label: "新建配置", tone: "neutral" as const };
    const pendingVersion = Boolean(activeProvider && activeProvider.configId !== state.activeConfigId);
    const selectableProviders = state.providers.filter((provider) => !provider.archived);
    const canActivate = selectedProvider && selectedProvider.enabled && !selectedProvider.archived
        && (selectedProvider.id !== state.activeProviderId || selectedProvider.configId !== state.activeConfigId);

    return (
        <AdminPageFrame title="图片合规检测" description="统一管理检测平台、检测项目和生效版本；用户仅查看汇总报告" scroll>
            <div className="admin-settings-stack admin-moderation-settings">
                <div className="admin-moderation-command-bar">
                    <div className="admin-moderation-command-state">
                        <AdminStatusBadge label={state.activeProviderId ? "检测已启用" : "检测已停用"} tone={state.activeProviderId ? "success" : "neutral"} />
                        <span>仅在用户手动点击时执行 · 保存与生效分别操作</span>
                    </div>
                    <div className="admin-moderation-command-actions">
                        {state.activeProviderId ? <Button danger icon={<CirclePause className="size-4" />} disabled={writeLocked || dirty} loading={busyAction === "disable"} onClick={() => void disable()}>停用检测</Button> : null}
                        <Button icon={<RefreshCw className="size-4" />} loading={busyAction === "refresh"} disabled={busy} onClick={() => discardThen(() => load())}>刷新状态</Button>
                    </div>
                </div>
                {error ? <Callout tone="error" title={needsRefresh ? "请刷新后核对配置" : undefined}>{error}{state && busyAction !== "refresh" ? " 当前保留上次成功读取的状态。" : null}</Callout> : null}
                <div className="admin-moderation-workbench">
                    <aside className="admin-moderation-summary" aria-label="当前生效配置摘要">
                        <AdminStatTile label="生效 Provider" value={activeProvider?.name || "未启用"} />
                        <AdminStatTile label="配置版本" value={pendingVersion ? "旧版本生效" : activeProvider ? `v${activeProvider.version}` : "—"} />
                        <AdminStatTile label="可用 Provider" value={selectableProviders.length} />
                        <AdminStatTile label="策略修订" value={state.policyRevision} />
                    </aside>
                    <div className="admin-moderation-main">
                        <SettingsSectionCard className="admin-moderation-section" icon={<ShieldCheck className="size-4" />} title="检测平台" description="可保存多个 Provider，同一时刻只使用一个配置版本。" status={<AdminStatusBadge label={`${selectableProviders.length} 个可管理`} />}>
                            <div className="admin-moderation-provider-list">
                                {selectableProviders.map((provider) => {
                                    const status = moderationProviderStatus(provider, state);
                                    return <button key={provider.id} type="button" className={cn("admin-moderation-provider", selectedId === provider.id && "is-selected")} aria-pressed={selectedId === provider.id} disabled={busy} onClick={() => discardThen(() => applySelection(state, provider))}>
                                        <span className="admin-moderation-provider-name">{provider.name}</span>
                                        <span className="admin-moderation-provider-detail">{state.providerTypes.find((item) => item.type === provider.type)?.label || provider.type} · v{provider.version}</span>
                                        <AdminStatusBadge label={status.label} tone={status.tone} />
                                    </button>;
                                })}
                                {!selectableProviders.length ? <p className="admin-moderation-empty">尚未配置检测平台。新增 Provider 并保存，再明确设为生效。</p> : null}
                                <Button icon={<Plus className="size-4" />} disabled={busy || needsRefresh || !state.providerTypes.length} onClick={() => discardThen(() => applySelection(state, null))}>新增 Provider</Button>
                                {state.providers.some((provider) => provider.archived) ? <span className="admin-moderation-muted">已归档 {state.providers.filter((provider) => provider.archived).length} 个 Provider</span> : null}
                            </div>
                        </SettingsSectionCard>
                        <Form form={form} layout="vertical" requiredMark={false} disabled={writeLocked} onValuesChange={(changed: Partial<ImageModerationProviderDraft>, values: ImageModerationProviderDraft) => {
                            let nextValues = values;
                            if (changed.type !== undefined) {
                                const nextType = state.providerTypes.find((item) => item.type === values.type);
                                nextValues = { ...values, region: nextType?.regions[0]?.value || "", services: nextType?.services[0] ? [nextType.services[0].code] : [] };
                                form.setFieldsValue(nextValues);
                            }
                            setDirty(moderationProviderDraftChanged(nextValues, selectedProvider, state));
                            setValidationMessage(null);
                        }}>
                            <div className="admin-moderation-editor-heading">
                                <strong>{selectedProvider ? `编辑 ${selectedProvider.name}` : "新增 Provider"}</strong>
                                <AdminStatusBadge label={currentStatus.label} tone={currentStatus.tone} />
                            </div>
                            {selectedProvider?.id === state.activeProviderId && selectedProvider.configId !== state.activeConfigId ? <Callout tone="warning">新版本 v{selectedProvider.version} 尚未应用，后续检测仍使用原生效版本。点击“设为生效”才切换。</Callout> : null}
                            <SettingsSectionCard className="admin-moderation-section" icon={<KeyRound className="size-4" />} title="连接配置" description="凭据加密保存在服务端；页面不回显已保存的 AccessKey。">
                                <div className="admin-moderation-form-grid">
                                    <Form.Item name="name" label="Provider 名称" rules={[{ required: true, whitespace: true, message: "请填写 Provider 名称" }]}><Input autoComplete="off" placeholder="例如：阿里云内容检测" /></Form.Item>
                                    <Form.Item name="type" label="检测平台" extra={selectedProvider ? "已有 Provider 的平台类型固定，更换平台请新建。" : undefined} rules={[{ required: true, message: "请选择检测平台" }]}><Select ariaLabel="检测平台" disabled={writeLocked || Boolean(selectedProvider)} options={state.providerTypes.map((item) => ({ value: item.type, label: item.label }))} /></Form.Item>
                                    <Form.Item name="region" label="服务地域" rules={[{ required: true, message: "请选择服务地域" }]}><Select ariaLabel="服务地域" options={providerType?.regions.map((item) => ({ value: item.value, label: item.label })) || []} /></Form.Item>
                                    <div className="admin-moderation-enable-field"><div><span>允许设为生效</span>{selectedProvider?.id === state.activeProviderId ? <p className="admin-moderation-muted">当前生效 Provider 如需禁用，请先停用检测或切换平台。</p> : null}</div><Form.Item name="enabled" valuePropName="checked" noStyle><Switch disabled={writeLocked || selectedProvider?.id === state.activeProviderId} aria-label="允许此 Provider 设为生效" /></Form.Item></div>
                                    <Form.Item name="accessKeyId" label={selectedProvider?.accessKeyIdConfigured ? `AccessKey ID（${configuredSecretText}）` : "AccessKey ID"}><Input.Password autoComplete="new-password" placeholder={selectedProvider?.accessKeyIdConfigured ? "留空保留原凭据" : "输入 AccessKey ID"} /></Form.Item>
                                    <Form.Item name="accessKeySecret" label={selectedProvider?.accessKeySecretConfigured ? `AccessKey Secret（${configuredSecretText}）` : "AccessKey Secret"} extra="更换凭据时请同时填写两项。"><Input.Password autoComplete="new-password" placeholder={selectedProvider?.accessKeySecretConfigured ? "留空保留原凭据" : "输入 AccessKey Secret"} /></Form.Item>
                                </div>
                            </SettingsSectionCard>
                            <SettingsSectionCard className="admin-moderation-section" icon={<ShieldCheck className="size-4" />} title="检测项目" description="一次手动检测执行全部勾选项目，后端合并为一份报告。">
                                <Form.Item name="services" className="admin-moderation-service-field" rules={[{ required: true, type: "array", min: 1, message: "请至少选择一个检测项目" }]}>
                                    <ModerationServiceChoices options={providerType?.services || []} />
                                </Form.Item>
                                <p className="admin-moderation-muted">画布不展示平台名称和检测配置。多个项目分别占用调用次数；部分失败时报告会明确标注未完成。</p>
                            </SettingsSectionCard>
                            <SettingsSectionCard className="admin-moderation-section" icon={<SlidersHorizontal className="size-4" />} title="调用控制" description="设定调用上限和复检间隔，避免重复或过量调用。">
                                <div className="admin-moderation-form-grid admin-moderation-limit-grid">
                                    <Form.Item name="timeoutSeconds" label="单项检测超时" extra="5–120 秒" rules={[{ required: true, type: "integer", min: 5, max: 120, message: "请填写 5–120 的整数" }]}><InputNumber min={5} max={120} precision={0} addonAfter="秒" /></Form.Item>
                                    <Form.Item name="maxCallsPerDay" label="每日调用上限" extra="平台全局按 UTC 日计数；多个项目分别计数，切换 Provider 不重置" rules={[{ required: true, type: "integer", min: 1, max: 100000, message: "请填写 1–100000 的整数" }]}><InputNumber min={1} max={100000} precision={0} addonAfter="次" /></Form.Item>
                                    <Form.Item name="minIntervalSeconds" label="新检测最小间隔" extra="按用户限制新批次；在途重复点击复用任务，完成后复检重新计数" rules={[{ required: true, type: "integer", min: 1, max: 3600, message: "请填写 1–3600 的整数" }]}><InputNumber min={1} max={3600} precision={0} addonAfter="秒" /></Form.Item>
                                </div>
                            </SettingsSectionCard>
                        </Form>
                        <div className="admin-moderation-editor-actions">
                            <span className="admin-moderation-muted">保存、配置校验与生效切换均不调用检测接口。</span>
                            <div className="admin-moderation-command-actions">
                                {selectedProvider && selectedProvider.id !== state.activeProviderId ? <Button danger icon={<Archive className="size-4" />} disabled={writeLocked || dirty} loading={busyAction === "archive"} onClick={() => modal.confirm({ title: `归档 ${selectedProvider.name}？`, content: "归档后不再用于新的检测配置，历史报告保留。", okText: "归档 Provider", cancelText: "取消", okButtonProps: { danger: true }, onOk: () => archive(selectedProvider) })}>归档</Button> : null}
                                {dirty ? <Button icon={<RotateCcw className="size-4" />} disabled={busy} onClick={() => applySelection(state, selectedProvider)}>撤销调整</Button> : null}
                                <Button icon={<Check className="size-4" />} disabled={!selectedProvider || dirty || writeLocked} loading={busyAction === "validate"} onClick={() => void validate()}>配置校验</Button>
                                <Button icon={<ShieldCheck className="size-4" />} disabled={!canActivate || dirty || writeLocked} loading={busyAction === "activate"} onClick={() => selectedProvider && void activate(selectedProvider)}>设为生效</Button>
                                <Button type="primary" icon={<Save className="size-4" />} disabled={writeLocked || (!dirty && Boolean(selectedProvider))} loading={busyAction === "save"} onClick={() => void save()}>保存新版本</Button>
                            </div>
                        </div>
                        {validationMessage ? <Callout tone={validationMessage.valid ? "success" : "warning"} title={validationMessage.valid ? "配置校验通过" : "配置需要调整"}>{validationMessage.message} 本次仅校验配置，不调用检测接口，也不验证远程凭据有效性。</Callout> : null}
                    </div>
                </div>
            </div>
        </AdminPageFrame>
    );
}

function ModerationServiceChoices({ value = [], onChange, options, disabled }: { value?: string[]; onChange?: (value: string[]) => void; options: Array<{ code: string; label: string }>; disabled?: boolean }) {
    return <div className="admin-moderation-service-choices" role="group" aria-label="本次批次包含的检测项目">{options.map((option) => <Checkbox key={option.code} disabled={disabled} checked={value.includes(option.code)} onChange={(event) => onChange?.(event.target.checked ? [...value, option.code] : value.filter((item) => item !== option.code))}>{option.label}</Checkbox>)}</div>;
}

function errorText(cause: unknown, fallback: string): string {
    return cause instanceof Error ? cause.message : fallback;
}
