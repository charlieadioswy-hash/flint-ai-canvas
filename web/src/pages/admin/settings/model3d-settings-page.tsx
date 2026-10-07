import { App, Button, Form, Input, InputNumber, Skeleton } from "antd";
import { Archive, Box, CirclePause, KeyRound, Plus, RefreshCw, RotateCcw, Save, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router";

import { activateModel3DProvider, archiveModel3DProvider, disableModel3D, getModel3DAdminState, saveModel3DProvider, type Model3DAdminState, type Model3DProviderView } from "@/services/api/model3d";
import { AdminPageFrame } from "../components/admin-shell";
import { AdminStatTile, AdminStatusBadge, SettingsSectionCard } from "../components/admin-ui";
import { Callout, Checkbox, Select, Switch } from "../ui/controls";
import {
    isModel3DAdminState,
    model3DProviderDraft,
    model3DProviderDraftChanged,
    model3DProviderInput,
    model3DProviderResponseMatches,
    model3DProviderStatus,
    TRIPO_API_BASE_URLS,
    validateModel3DBaseUrl,
    validateModel3DProviderDraft,
    type Model3DProviderDraft,
} from "./model3d-settings-form";
import "./model3d-settings-page.css";

const modeLabels: Record<string, string> = { text: "文本生成", image: "单图生成", multiview: "多视图生成" };

export default function Model3DSettingsPage() {
    const { message, modal } = App.useApp();
    const [state, setState] = useState<Model3DAdminState | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [busyAction, setBusyAction] = useState("");
    const [dirty, setDirty] = useState(false);
    const [error, setError] = useState("");
    const [needsRefresh, setNeedsRefresh] = useState(false);
    const [form] = Form.useForm<Model3DProviderDraft>();
    const selection = useRef<string | null>(null);
    const loadVersion = useRef(0);
    const loadController = useRef<AbortController | null>(null);
    const writeInFlight = useRef(false);
    const navigationConfirm = useRef(false);
    const selected = state?.providers.find((provider) => provider.id === selectedId) || null;
    const values = Form.useWatch([], { form, preserve: true }) as Partial<Model3DProviderDraft> | undefined;
    const providerType = state?.providerTypes.find((type) => type.type === (values?.type || selected?.type));
    const busy = loading || Boolean(busyAction);
    const locked = busy || needsRefresh;

    const select = useCallback(
        (next: Model3DAdminState, provider: Model3DProviderView | null) => {
            selection.current = provider?.id || null;
            setSelectedId(provider?.id || null);
            form.resetFields();
            form.setFieldsValue(model3DProviderDraft(provider, next));
            setDirty(false);
        },
        [form],
    );

    const load = useCallback(
        async (initial = false) => {
            const version = ++loadVersion.current;
            loadController.current?.abort();
            const controller = new AbortController();
            loadController.current = controller;
            if (initial) setLoading(true);
            else setBusyAction("refresh");
            try {
                const next = await getModel3DAdminState(controller.signal);
                if (version !== loadVersion.current) return;
                if (!isModel3DAdminState(next)) throw new Error("服务端返回的 3D 配置格式无效，请核对接口版本");
                const provider = next.providers.find((row) => row.id === selection.current && !row.archived) || next.providers.find((row) => row.id === next.activeProviderId && !row.archived) || next.providers.find((row) => !row.archived) || null;
                setState(next);
                select(next, provider);
                setNeedsRefresh(false);
                setError("");
            } catch (cause) {
                if (version !== loadVersion.current) return;
                setError(errorText(cause, "读取 3D 生成配置失败"));
                setNeedsRefresh(true);
            } finally {
                if (version === loadVersion.current) {
                    setLoading(false);
                    setBusyAction("");
                }
            }
        },
        [select],
    );

    useEffect(() => {
        void load(true);
        return () => {
            loadVersion.current += 1;
            loadController.current?.abort();
        };
    }, [load]);

    const blocker = useBlocker(dirty && !busyAction);
    useEffect(() => {
        const handle = (event: BeforeUnloadEvent) => {
            if (dirty) event.preventDefault();
        };
        window.addEventListener("beforeunload", handle);
        return () => window.removeEventListener("beforeunload", handle);
    }, [dirty]);
    useEffect(() => {
        if (blocker.state !== "blocked" || navigationConfirm.current) return;
        navigationConfirm.current = true;
        modal.confirm({
            title: "放弃 3D 配置草稿？",
            content: "尚未保存的配置和输入凭据会丢失。",
            okText: "放弃并离开",
            cancelText: "继续编辑",
            okButtonProps: { danger: true },
            onOk: () => {
                navigationConfirm.current = false;
                blocker.proceed();
            },
            onCancel: () => {
                navigationConfirm.current = false;
                blocker.reset();
            },
        });
    }, [blocker, modal]);

    const discardThen = (action: () => void | Promise<void>) => {
        if (!dirty) {
            void action();
            return;
        }
        modal.confirm({ title: "放弃当前配置草稿？", content: "尚未保存的修改和输入凭据会被清除。", okText: "放弃修改", cancelText: "继续编辑", okButtonProps: { danger: true }, onOk: action });
    };

    const write = async (action: string, operation: () => Promise<void>) => {
        if (locked || writeInFlight.current) return;
        writeInFlight.current = true;
        setBusyAction(action);
        setError("");
        try {
            await operation();
        } catch (cause) {
            const detail = errorText(cause, "3D 配置操作失败");
            setError(`${detail}。请刷新配置核对后继续操作。`);
            setNeedsRefresh(true);
            message.error(detail);
        } finally {
            writeInFlight.current = false;
            setBusyAction("");
        }
    };

    const save = async () => {
        if (!state || locked) return;
        let draft: Model3DProviderDraft;
        try {
            draft = await form.validateFields();
        } catch {
            return;
        }
        const invalid = validateModel3DProviderDraft(draft, selected, state);
        if (invalid) {
            message.error(invalid);
            return;
        }
        const input = model3DProviderInput(draft);
        await write("save", async () => {
            const provider = await saveModel3DProvider(input, selected?.id);
            if (!model3DProviderResponseMatches(provider, input, selected)) throw new Error("服务端返回的配置与本次保存内容不一致");
            const next = { ...state, providers: [...state.providers.filter((row) => row.id !== provider.id), provider] };
            setState(next);
            select(next, provider);
            message.success("新版本已保存，设为生效后用于后续生成");
        });
    };

    const activate = async () => {
        if (!state || !selected || dirty) return;
        await write("activate", async () => {
            const next = await activateModel3DProvider(selected.id, selected.configId, state.policyRevision);
            if (!isModel3DAdminState(next) || next.activeProviderId !== selected.id || next.activeConfigId !== selected.configId || next.policyRevision <= state.policyRevision) throw new Error("服务端尚未确认生效切换");
            setState(next);
            select(next, next.providers.find((row) => row.id === selected.id) || null);
            message.success("3D 生成配置已生效");
        });
    };

    const disable = async () => {
        if (!state || dirty) return;
        await write("disable", async () => {
            const next = await disableModel3D(state.policyRevision);
            if (!isModel3DAdminState(next) || next.activeProviderId || next.activeConfigId || next.policyRevision <= state.policyRevision) throw new Error("服务端尚未确认停用");
            setState(next);
            message.success("已停止接收新的 3D 任务，在途任务继续使用原配置");
        });
    };

    const archive = async () => {
        if (!state || !selected || dirty || selected.id === state.activeProviderId) return;
        await write("archive", async () => {
            const next = await archiveModel3DProvider(selected.id);
            if (!isModel3DAdminState(next) || !next.providers.find((row) => row.id === selected.id)?.archived) throw new Error("服务端尚未确认归档");
            setState(next);
            select(next, next.providers.find((row) => row.id === next.activeProviderId && !row.archived) || next.providers.find((row) => !row.archived) || null);
            message.success("服务商配置已归档，历史模型保留");
        });
    };

    if (loading && !state)
        return (
            <AdminPageFrame title="3D 模型生成" scroll>
                <Skeleton active paragraph={{ rows: 8 }} />
            </AdminPageFrame>
        );
    if (!state)
        return (
            <AdminPageFrame title="3D 模型生成" scroll>
                <Callout
                    tone="error"
                    title="无法读取配置"
                    action={
                        <Button loading={busy} onClick={() => void load()}>
                            重新读取
                        </Button>
                    }
                >
                    {error}
                </Callout>
            </AdminPageFrame>
        );
    const active = state.providers.find((provider) => provider.id === state.activeProviderId);
    const visible = state.providers.filter((provider) => !provider.archived);
    const canActivate = selected?.enabled && !selected.archived && (selected.id !== state.activeProviderId || selected.configId !== state.activeConfigId);

    return (
        <AdminPageFrame title="3D 模型生成" description="管理生成服务商、开放能力与生效配置；节点按需创建模型" scroll>
            <div className="admin-settings-stack admin-model3d-settings">
                <div className="admin-model3d-toolbar">
                    <div className="admin-model3d-actions">
                        <AdminStatusBadge label={active ? "生成已启用" : "生成未启用"} tone={active ? "success" : "neutral"} />
                        <span className="admin-model3d-muted">仅在用户点击生成时创建任务</span>
                    </div>
                    <div className="admin-model3d-actions">
                        {active ? (
                            <Button danger icon={<CirclePause className="size-4" />} disabled={locked || dirty} loading={busyAction === "disable"} onClick={() => void disable()}>
                                停用新任务
                            </Button>
                        ) : null}
                        <Button icon={<RefreshCw className="size-4" />} disabled={busy} loading={busyAction === "refresh"} onClick={() => discardThen(() => load())}>
                            刷新状态
                        </Button>
                    </div>
                </div>
                {error ? (
                    <Callout tone="error" title="请刷新后核对配置">
                        {error} 当前保留上次成功读取的状态。
                    </Callout>
                ) : null}
                <div className="admin-model3d-stats">
                    <AdminStatTile label="生效服务商" value={active?.name || "未启用"} />
                    <AdminStatTile label="生效配置" value={active ? (active.configId === state.activeConfigId ? `v${active.version}` : "旧版本生效") : "—"} />
                </div>
                <SettingsSectionCard icon={<Box className="size-4" />} title="生成服务商" description="可保存多套配置，同一时刻仅一个版本生效。">
                    <div className="admin-model3d-providers">
                        {visible.map((provider) => (
                            <button key={provider.id} type="button" className="admin-model3d-provider" aria-pressed={selectedId === provider.id} disabled={busy} onClick={() => discardThen(() => select(state, provider))}>
                                <div className="admin-model3d-provider-summary">
                                    <strong>{provider.name}</strong>
                                    <span className="admin-model3d-muted">{provider.baseUrl}</span>
                                </div>
                                <span className="admin-model3d-muted">
                                    {state.providerTypes.find((item) => item.type === provider.type)?.label || provider.type} · v{provider.version}
                                </span>
                                <AdminStatusBadge {...model3DProviderStatus(provider, state)} />
                            </button>
                        ))}
                        {!visible.length ? <p className="admin-model3d-muted">尚未配置服务商。新增配置并保存，再设为生效。</p> : null}
                        <div>
                            <Button icon={<Plus className="size-4" />} disabled={locked || !state.providerTypes.length} onClick={() => discardThen(() => select(state, null))}>
                                新增服务商配置
                            </Button>
                        </div>
                    </div>
                </SettingsSectionCard>
                <Form
                    form={form}
                    layout="vertical"
                    requiredMark={false}
                    disabled={locked}
                    onValuesChange={(changed: Partial<Model3DProviderDraft>, draft: Model3DProviderDraft) => {
                        let next = draft;
                        if (changed.type !== undefined) {
                            const type = state.providerTypes.find((item) => item.type === changed.type);
                            next = { ...draft, allowedModels: type?.modelVersions.map((item) => item.id) || [], defaultModel: type?.modelVersions[0]?.id || "", allowedModes: type?.modes || [] };
                            form.setFieldsValue(next);
                        }
                        setDirty(model3DProviderDraftChanged(next, selected, state));
                    }}
                >
                    <div className="admin-model3d-settings">
                        <div className="admin-model3d-actions">
                            <strong>{selected ? `编辑 ${selected.name}` : "新增服务商配置"}</strong>
                            <AdminStatusBadge {...(selected ? model3DProviderStatus(selected, state) : { label: "未保存" })} />
                            {dirty ? <span className="admin-model3d-muted">有未保存修改</span> : null}
                        </div>
                        {selected?.id === state.activeProviderId && selected.configId !== state.activeConfigId ? <Callout tone="warning">当前编辑的是新版本，生成任务仍使用原生效配置。设为生效后才会切换。</Callout> : null}
                        <SettingsSectionCard icon={<KeyRound className="size-4" />} title="连接配置" description="API 地址随配置版本保存；API Key 加密保存在后端，不会发送到画布或分享链接。">
                            <div className="admin-model3d-fields">
                                <Form.Item name="name" label="配置名称" rules={[{ required: true, whitespace: true, message: "请填写配置名称" }]}>
                                    <Input placeholder="例如：Tripo3D 主账号" maxLength={120} autoComplete="off" />
                                </Form.Item>
                                <Form.Item name="type" label="服务商" rules={[{ required: true, message: "请选择服务商" }]}>
                                    <Select ariaLabel="3D 生成服务商" disabled={locked || Boolean(selected)} options={state.providerTypes.map((type) => ({ value: type.type, label: type.label }))} />
                                </Form.Item>
                                <Form.Item name="apiKey" label={selected?.apiKeyConfigured ? "API Key（已配置）" : "API Key"} extra={selected?.apiKeyConfigured ? "留空保留已有密钥；填写后保存为新配置版本。" : "填写服务商 API Key，保存后不回显。"}>
                                    <Input.Password autoComplete="new-password" placeholder={selected?.apiKeyConfigured ? "留空保留原凭据" : "输入 API Key"} />
                                </Form.Item>
                                <Form.Item name="enabled" label="允许设为生效" valuePropName="checked" extra={selected?.id === state.activeProviderId ? "停用当前服务请使用上方“停用新任务”。" : undefined}>
                                    <Switch disabled={locked || selected?.id === state.activeProviderId} aria-label="允许此配置设为生效" />
                                </Form.Item>
                            </div>
                            <Form.Item
                                name="baseUrl"
                                label="API 地址"
                                rules={[
                                    { required: true, whitespace: true, message: "请填写 API 地址" },
                                    {
                                        validator: (_, value: string) => {
                                            const invalid = validateModel3DBaseUrl(value || "");
                                            return invalid ? Promise.reject(new Error(invalid)) : Promise.resolve();
                                        },
                                    },
                                ]}
                                extra={
                                    <div className="admin-model3d-actions">
                                        <span>快捷填写：</span>
                                        {[
                                            { label: "国内地址", value: TRIPO_API_BASE_URLS.domestic },
                                            { label: "国外地址", value: TRIPO_API_BASE_URLS.international },
                                        ].map((address) => (
                                            <Button
                                                key={address.value}
                                                size="small"
                                                disabled={locked}
                                                onClick={() => {
                                                    form.setFieldValue("baseUrl", address.value);
                                                    setDirty(model3DProviderDraftChanged(form.getFieldsValue(), selected, state));
                                                    void form.validateFields(["baseUrl"]).catch(() => undefined);
                                                }}
                                            >
                                                {address.label}
                                            </Button>
                                        ))}
                                        <span>修改后保存新版本，再设为生效。</span>
                                    </div>
                                }
                            >
                                <Input placeholder={TRIPO_API_BASE_URLS.international} autoComplete="off" spellCheck={false} />
                            </Form.Item>
                        </SettingsSectionCard>
                        <SettingsSectionCard icon={<Box className="size-4" />} title="开放能力" description="用户可以在节点中选择开放的模型与模式，并调整生成参数。">
                            <Form.Item name="allowedModels" label="开放模型" rules={[{ required: true, type: "array", min: 1, message: "至少开放一个模型" }]}>
                                <Choices disabled={locked} label="开放模型版本" options={providerType?.modelVersions.map((model) => ({ value: model.id, label: model.label })) || []} />
                            </Form.Item>
                            <div className="admin-model3d-fields">
                                <Form.Item name="defaultModel" label="默认模型" rules={[{ required: true, message: "请选择默认模型" }]}>
                                    <Select ariaLabel="默认 3D 模型" options={providerType?.modelVersions.filter((model) => values?.allowedModels?.includes(model.id)).map((model) => ({ value: model.id, label: model.label })) || []} />
                                </Form.Item>
                            </div>
                            <Form.Item name="allowedModes" label="开放模式" rules={[{ required: true, type: "array", min: 1, message: "至少开放一种生成模式" }]}>
                                <Choices disabled={locked} label="开放生成模式" options={providerType?.modes.map((mode) => ({ value: mode, label: modeLabels[mode] || mode })) || []} />
                            </Form.Item>
                        </SettingsSectionCard>
                        <SettingsSectionCard icon={<SlidersHorizontal className="size-4" />} title="调用控制" description="每次主动生成会使用服务商额度，轮询和恢复下载不会重新生成。">
                            <div className="admin-model3d-fields">
                                <Form.Item name="timeoutSeconds" label="上游请求超时（秒）" extra="10–120 秒，单次网络请求超时；不代表生成任务等待时长。" rules={[{ required: true, type: "integer", min: 10, max: 120, message: "请输入 10–120 的整数" }]}>
                                    <InputNumber min={10} max={120} precision={0} />
                                </Form.Item>
                                <Form.Item name="maxTasksPerDay" label="每日任务上限（次）" extra="按 UTC 日限制全平台新任务数；切换配置不重置计数。" rules={[{ required: true, type: "integer", min: 1, max: 100000, message: "请输入 1–100000 的整数" }]}>
                                    <InputNumber min={1} max={100000} precision={0} />
                                </Form.Item>
                            </div>
                        </SettingsSectionCard>
                    </div>
                </Form>
                <div className="admin-model3d-toolbar">
                    <span className="admin-model3d-muted">保存与设为生效均不调用生成接口，也不验证远程密钥有效性。</span>
                    <div className="admin-model3d-actions">
                        {selected && selected.id !== state.activeProviderId ? (
                            <Button
                                danger
                                icon={<Archive className="size-4" />}
                                disabled={locked || dirty}
                                loading={busyAction === "archive"}
                                onClick={() => modal.confirm({ title: `归档 ${selected.name}？`, content: "后续不可再激活此配置，历史模型与任务保留。", okText: "归档", cancelText: "取消", okButtonProps: { danger: true }, onOk: archive })}
                            >
                                归档
                            </Button>
                        ) : null}
                        {dirty ? (
                            <Button icon={<RotateCcw className="size-4" />} disabled={busy} onClick={() => select(state, selected)}>
                                撤销调整
                            </Button>
                        ) : null}
                        <Button icon={<Box className="size-4" />} disabled={!canActivate || dirty || locked} loading={busyAction === "activate"} onClick={() => void activate()}>
                            设为生效
                        </Button>
                        <Button type="primary" icon={<Save className="size-4" />} disabled={locked || (!dirty && Boolean(selected))} loading={busyAction === "save"} onClick={() => void save()}>
                            保存新版本
                        </Button>
                    </div>
                </div>
            </div>
        </AdminPageFrame>
    );
}

function Choices({ value = [], onChange, options, label, disabled }: { value?: string[]; onChange?: (value: string[]) => void; options: Array<{ value: string; label: string }>; label: string; disabled: boolean }) {
    return (
        <div className="admin-model3d-choices" role="group" aria-label={label}>
            {options.map((option) => (
                <Checkbox key={option.value} disabled={disabled} checked={value.includes(option.value)} onChange={(event) => onChange?.(event.target.checked ? [...value, option.value] : value.filter((item) => item !== option.value))}>
                    {option.label}
                </Checkbox>
            ))}
        </div>
    );
}

function errorText(cause: unknown, fallback: string) {
    return cause instanceof Error ? cause.message : fallback;
}
