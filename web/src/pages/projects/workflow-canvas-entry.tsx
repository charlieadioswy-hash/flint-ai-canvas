import { useEffect, useRef, useState } from "react";
import { App, Button } from "antd";
import { AudioLines, Clapperboard, Grid2X2, LoaderCircle, Plus, Video, Zap } from "lucide-react";
import { useNavigate } from "react-router";
import { AgentChatComposer } from "@/components/canvas/canvas-cloud-agent-composer";
import { AppModal } from "@/components/ui/product/app-modal";
import { useAuthEntry } from "@/hooks/use-auth-entry";
import { agentAttachmentFileKey, checkAgentAttachmentFiles } from "@/lib/canvas/agent-composer-attachments";
import { AGENT_PROMPT_MAX_CHARS } from "@/lib/canvas/agent-outbox";
import { canvasThemes } from "@/lib/canvas-theme";
import { getActiveUserScope } from "@/lib/user-scope";
import { queueCanvasAgentEntry } from "@/services/canvas-agent-entry";
import { listAddedSkills, type Skill } from "@/services/api/skills";
import { hasRemoteUserDataSyncSession } from "@/services/user-data-sync";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { canvasDraftNavigationState, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import "@/components/canvas/canvas-cloud-agent.css";
import "./workflow-canvas-entry.css";

type Props = {
    disabled?: boolean;
    hidden?: boolean;
    onBeforeCreate?: () => boolean | Promise<boolean>;
    onBusyChange?: (busy: boolean) => void;
};
type ReferenceFile = { id: string; file: File; url: string };

const CAPABILITIES = [
    { name: "视频创作", icon: Video, cover: "space-opera", prompt: "我想创作一段视频，请先帮我梳理主题、镜头和时长，再使用当前可用的视频模型制作。" },
    { name: "音频创作", icon: AudioLines, cover: "real-life", prompt: "我想创作一段音频，请先确认配音、音效或音乐需求，并使用当前可用的音频工具制作。" },
    { name: "宫格图节点", icon: Grid2X2, cover: "cyberpunk-neon", prompt: "请帮我制作一张宫格分镜图，先确认故事主题与画面风格，再在画布中组织镜头。" },
    { name: "智能导演", icon: Clapperboard, cover: "future-tech", prompt: "请作为导演帮我把创意整理成拍摄方案，先确认故事、人物和风格，再分步制作分镜与视频。" },
];

export function WorkflowCanvasEntry(props: Props) {
    const userId = useUserStore((state) => state.user?.id || "");
    return <CanvasEntrySession key={`${getActiveUserScope()}:${userId}`} {...props} />;
}

function CanvasEntrySession({ disabled = false, hidden = false, onBeforeCreate, onBusyChange }: Props) {
    const navigate = useNavigate();
    const { openAuth } = useAuthEntry();
    const { message } = App.useApp();
    const theme = canvasThemes[useActiveTheme()];
    const hydrated = useCanvasStore((state) => state.hydrated);
    const [prompt, setPrompt] = useState("");
    const [files, setFiles] = useState<ReferenceFile[]>([]);
    const filesRef = useRef(files);
    filesRef.current = files;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [skillsOpen, setSkillsOpen] = useState(false);
    const [skills, setSkills] = useState<Skill[]>([]);
    const [skillsLoading, setSkillsLoading] = useState(false);
    const [skillsError, setSkillsError] = useState("");
    const [skillAttempt, setSkillAttempt] = useState(0);
    const [skillIds, setSkillIds] = useState<string[]>([]);
    const [search, setSearch] = useState("");
    const lock = useRef(false);
    const created = useRef<string | undefined>(undefined);
    const alive = useRef(true);
    const visible = useRef(!hidden);
    visible.current = !hidden;
    const busyListener = useRef(onBusyChange);
    busyListener.current = onBusyChange;
    const blocked = disabled || busy || hidden;

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            for (const item of filesRef.current) URL.revokeObjectURL(item.url);
            busyListener.current?.(false);
        };
    }, []);

    useEffect(() => {
        if (hidden) return;
        let active = true;
        setSkillsLoading(true);
        setSkillsError("");
        void listAddedSkills()
            .then((result) => {
                if (active) setSkills(result.skills);
            })
            .catch((cause) => {
                if (active) setSkillsError(cause instanceof Error ? cause.message : "技能读取失败");
            })
            .finally(() => {
                if (active) setSkillsLoading(false);
            });
        return () => {
            active = false;
        };
    }, [hidden, skillAttempt]);

    const addFiles = (input: FileList | File[] | null) => {
        if (blocked) return;
        const existing = filesRef.current;
        const check = checkAgentAttachmentFiles(Array.from(input || []), {
            existingCount: existing.length,
            existingKeys: new Set(existing.map((item) => agentAttachmentFileKey(item.file))),
            maxBytes: Math.max(1, useUserStore.getState().runtimeLimits.resourceUploadMB || 50) * 1024 * 1024,
        });
        if (check.problems.length) void message.warning(check.problems.join("；"));
        const added = check.accepted.map((file) => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) }));
        filesRef.current = [...existing, ...added];
        setFiles(filesRef.current);
    };

    const removeFile = (id: string) => {
        if (blocked) return;
        const item = filesRef.current.find((file) => file.id === id);
        if (item) URL.revokeObjectURL(item.url);
        filesRef.current = filesRef.current.filter((file) => file.id !== id);
        setFiles(filesRef.current);
        setPrompt((current) => current.split(`@[attachment:${id}]`).join(""));
    };

    const create = async (withDraft: boolean) => {
        if (lock.current || blocked) return;
        if (!useUserStore.getState().user) {
            openAuth({ preferDialog: true });
            return;
        }
        if (withDraft && !prompt.trim() && !files.length) return;
        const account = getActiveUserScope();
        const userId = useUserStore.getState().user?.id;
        const isCurrent = () => alive.current && visible.current && account === getActiveUserScope() && userId === useUserStore.getState().user?.id;
        lock.current = true;
        setBusy(true);
        busyListener.current?.(true);
        setError("");
        try {
            if (onBeforeCreate && !(await onBeforeCreate())) return;
            if (!isCurrent()) return;
            if (!hydrated) throw new Error("画布资料正在恢复，请稍后重试");
            if (!hasRemoteUserDataSyncSession()) throw new Error("登录资料尚未就绪，请稍后重试");
            if (!created.current) created.current = useCanvasStore.getState().createDraftProject("创作画布");
            const id = created.current;
            if (withDraft) queueCanvasAgentEntry(id, { text: prompt, skillIds, files: files.map(({ id, file }) => ({ id, file })) });
            navigate(`/canvas/${encodeURIComponent(id)}?agent=1`, { state: canvasDraftNavigationState(id) });
        } catch (cause) {
            if (isCurrent()) setError(cause instanceof Error ? cause.message : "画布创建失败，请重试");
        } finally {
            lock.current = false;
            if (alive.current) setBusy(false);
            busyListener.current?.(false);
        }
    };

    const toggleSkill = (id: string) => {
        if (blocked) return;
        const token = `@[skill:${id}]`;
        const selected = skillIds.includes(id);
        setSkillIds((current) => (selected ? current.filter((item) => item !== id) : [...current, id]));
        setPrompt((current) => (selected ? current.split(token).join("").trim() : current.includes(token) ? current : `${current.trim()} ${token} `.trimStart()));
    };
    const filteredSkills = skills.filter((skill) => `${skill.skillName} ${skill.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim()));

    return (
        <section className="drama-canvas-entry" aria-label="画布创作入口" hidden={hidden}>
            <div className="drama-canvas-entry-grid">
                <button type="button" className="drama-canvas-entry-new" disabled={blocked || !hydrated} onClick={() => void create(false)}>
                    <span>{busy ? <LoaderCircle className="size-5 animate-spin" aria-hidden /> : <Plus className="size-5" aria-hidden />}</span>
                    新建画布
                </button>
                <div
                    className="drama-canvas-entry-composer"
                    onDragOver={(event) => {
                        if (!event.dataTransfer.types.includes("Files")) return;
                        event.preventDefault();
                        event.stopPropagation();
                    }}
                    onDrop={(event) => {
                        if (!event.dataTransfer.files.length) return;
                        event.preventDefault();
                        event.stopPropagation();
                        addFiles(event.dataTransfer.files);
                    }}
                >
                    <AgentChatComposer
                        prompt={prompt}
                        theme={theme}
                        disabled={blocked}
                        sending={busy}
                        submitDisabled={!hydrated}
                        submitActionLabel="创建画布并继续创作"
                        placeholder="描述你的想法或上传参考，Agent 帮你一起创作"
                        onPromptChange={setPrompt}
                        onSubmit={() => void create(true)}
                        onAddFiles={addFiles}
                        onRemoveAttachment={removeFile}
                        attachments={files.map((item) => ({ id: item.id, name: item.file.name, url: item.url }))}
                        slashSkills={skills}
                        includeAssetLibrary={false}
                        charLimit={AGENT_PROMPT_MAX_CHARS}
                        left={
                            <button type="button" className="drama-canvas-entry-skills" disabled={blocked} aria-label="选择创作技能" onClick={() => setSkillsOpen(true)}>
                                <Zap className="size-4" aria-hidden />
                                技能{skillIds.length ? ` ${skillIds.length}` : ""}
                            </button>
                        }
                    />
                </div>
            </div>
            {error ? (
                <p className="drama-canvas-entry-error" role="alert">
                    {error}
                </p>
            ) : null}
            <div className="drama-canvas-entry-capabilities" aria-label="画布创作能力">
                {CAPABILITIES.map(({ name, icon: Icon, cover, prompt: suggestion }) => (
                    <button type="button" key={name} disabled={blocked} onClick={() => setPrompt((current) => (current.trim() ? `${current.trim()}\n\n${suggestion}` : suggestion))}>
                        <img src={`/short-drama-styles/${cover}.jpg`} alt="" />
                        <Icon className="size-3.5" aria-hidden />
                        <span>{name}</span>
                    </button>
                ))}
            </div>
            <AppModal title="选择创作技能" open={!hidden && skillsOpen} onCancel={() => setSkillsOpen(false)} footer={<Button onClick={() => setSkillsOpen(false)}>完成</Button>}>
                <div className="drama-canvas-entry-skill-picker">
                    <input type="search" aria-label="搜索已安装技能" placeholder="搜索已安装技能" value={search} onChange={(event) => setSearch(event.target.value)} />
                    {skillsLoading ? <p role="status">正在读取技能…</p> : null}
                    {skillsError ? (
                        <p role="alert">
                            {skillsError} <Button onClick={() => setSkillAttempt((value) => value + 1)}>重试</Button>
                        </p>
                    ) : null}
                    {!skillsLoading && !skillsError && !filteredSkills.length ? <p>暂无可用技能，可先在技能库安装。</p> : null}
                    {filteredSkills.map((skill) => (
                        <label key={skill.skillId}>
                            <input type="checkbox" checked={skillIds.includes(skill.skillId)} disabled={blocked || (!skillIds.includes(skill.skillId) && skillIds.length >= 16)} onChange={() => toggleSkill(skill.skillId)} />
                            <span>
                                <strong>{skill.skillName}</strong>
                                <small>{skill.description}</small>
                            </span>
                        </label>
                    ))}
                </div>
            </AppModal>
        </section>
    );
}
