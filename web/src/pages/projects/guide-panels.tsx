import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Input, Select } from "antd";
import { Check, ImagePlus, ImageIcon, Pencil, RotateCcw, Shirt, UsersRound } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import { dramaChoiceKey } from "@/lib/drama/model-choice";
import { DRAMA_STYLES, styleCoverBackground } from "@/lib/drama/drama-styles";
import { getDramaChapter, listDramaChapters, type DramaCast, type DramaEpisodeDetail, type DramaEpisodeRow, type DramaSegment, type DramaSettings, type DramaShot, type DramaShotPatch, type DramaSummary } from "@/services/api/drama";

import { AssetSchemePicker } from "./asset-scheme";
import { DramaModelPicker, useDramaModelCatalog } from "./drama-model-picker";
import { CAST_KIND_LABEL, mediaBusy, MediaThumb } from "./drama-shared";
import { DramaAssetImageModels, DramaTextSteps, VideoResolutionField } from "./step-settings";
import { EpisodeDurationInput, StoryboardRules } from "./storyboard-rules";
import { DramaStylePicker } from "./style-picker";
import { secondsLabel, segmentState, SegmentStatus, type SegmentTone } from "./studio/segment-parts";
import { ShotEditor } from "./studio/segment-dialog";
import { dramaKeys } from "./studio/use-studio";

export function GuideConfiguration({
    summary,
    settings,
    editable,
    busy,
    dirty,
    stale,
    onChange,
    onSave,
    onDiscard,
    onEditSource,
    onAskAgent,
}: {
    summary: DramaSummary;
    settings: DramaSettings;
    editable: boolean;
    busy: boolean;
    dirty: boolean;
    stale: boolean;
    onChange: (settings: DramaSettings) => void;
    onSave: () => void;
    onDiscard: () => void;
    onEditSource: () => void;
    onAskAgent: () => void;
}) {
    const catalog = useDramaModelCatalog();
    const [stylePickerOpen, setStylePickerOpen] = useState(false);
    const patch = (change: Partial<DramaSettings>) => {
        if (editable && !busy) onChange({ ...settings, ...change, mediaMode: "manual" });
    };
    const style = DRAMA_STYLES.find((item) => item.prompt === settings.stylePrompt);
    const imageChoice = dramaChoiceKey(settings.models.characterImage) ? settings.models.characterImage : settings.models.image;
    const imageOption = catalog.data?.options.image.find((item) => dramaChoiceKey(item.choice) === dramaChoiceKey(imageChoice));
    const videoOption = catalog.data?.options.video.find((item) => dramaChoiceKey(item.choice) === dramaChoiceKey(settings.models.video));
    return (
        <div className="drama-guide-stack">
            <section className="drama-guide-card drama-guide-config-card">
                <div className="drama-guide-section-head">
                    <div>
                        <h2>先把创作方向聊清楚</h2>
                        <p>首次进入时 Agent 会自动梳理正文与创作方案，你可以在对话中选择或调整，确认后开始制作。</p>
                    </div>
                    {editable ? (
                        <Button disabled={busy} onClick={onAskAgent}>
                            {summary.production.chapterCount ? "重新推荐方案" : "重新起草正文与方案"}
                        </Button>
                    ) : (
                        <span className="drama-chip">先做文字</span>
                    )}
                </div>
                {summary.production.creativeBrief ? (
                    <div className="drama-guide-brief">
                        <strong>你的创作想法</strong>
                        <p>{summary.production.creativeBrief}</p>
                    </div>
                ) : null}
                <fieldset disabled={!editable || busy} inert={!editable || busy} className="drama-guide-configuration">
                    <div className="drama-guide-current-style" aria-label="当前视觉风格">
                        <span className="drama-guide-config-label">视觉风格</span>
                        <div className="drama-guide-style-cover" style={style ? { background: styleCoverBackground(style) } : undefined} role="img" aria-label={style?.cover ? `${style.name}风格样图` : "当前风格暂无样图"}>
                            {!style?.cover ? (
                                <>
                                    <ImageIcon className="size-7" aria-hidden="true" />
                                    <span>{style ? "风格主色示意" : "暂无风格样图"}</span>
                                </>
                            ) : null}
                        </div>
                        <div className="drama-guide-style-copy">
                            <h3>{settings.styleName || style?.name || "自定义风格"}</h3>
                            <p className="drama-guide-style-description">{style?.description || settings.stylePrompt || "请与 Agent 确认视觉风格"}</p>
                            {settings.stylePrompt ? (
                                <details className="drama-guide-style-prompt">
                                    <summary>查看完整风格说明</summary>
                                    <p className="drama-guide-prompt">{settings.stylePrompt}</p>
                                </details>
                            ) : null}
                        </div>
                        <Button disabled={!editable || busy} onClick={() => setStylePickerOpen(true)}>
                            选择其他风格
                        </Button>
                    </div>
                    <div className="drama-guide-fields drama-guide-config-controls" aria-label="视频配置">
                        <label className="drama-guide-field">
                            <span>视频画幅</span>
                            <div className="drama-tabs" role="radiogroup" aria-label="视频画幅">
                                {["9:16", "16:9", "1:1"].map((value) => (
                                    <button type="button" key={value} className="drama-tab" role="radio" aria-checked={settings.aspectRatio === value} onClick={() => patch({ aspectRatio: value })}>
                                        {value === "9:16" ? "竖屏" : value === "16:9" ? "横屏" : "方形"} {value}
                                    </button>
                                ))}
                            </div>
                        </label>
                        <label className="drama-guide-field">
                            <span>单集时长</span>
                            <EpisodeDurationInput value={settings.episodeSeconds} onChange={(episodeSeconds) => patch({ episodeSeconds })} />
                        </label>
                        <label className="drama-guide-field">
                            <span>对白语言</span>
                            <Select
                                disabled={!editable || busy}
                                value={settings.language}
                                aria-label="对白语言"
                                options={[...new Set(["中文普通话", "粤语", "英语", "日语", settings.language])].map((value) => ({ value, label: value }))}
                                onChange={(language) => patch({ language })}
                            />
                        </label>
                        <label className="drama-guide-field">
                            <span>分集方式</span>
                            <Select
                                disabled={!editable || busy}
                                aria-label="分集方式"
                                value={settings.episodeMode || "chapter"}
                                options={[
                                    { value: "chapter", label: "按章节分集" },
                                    { value: "auto", label: "模型自动规划分集" },
                                ]}
                                onChange={(episodeMode) => patch({ episodeMode })}
                            />
                        </label>
                        <div className="drama-guide-field is-full">
                            <span>视频分辨率</span>
                            <VideoResolutionField option={videoOption} value={settings.videoResolution} onChange={(videoResolution) => patch({ videoResolution })} />
                        </div>
                    </div>
                    <details className="drama-guide-advanced is-full">
                        <summary>更多制作设置</summary>
                        <div className="drama-guide-stack">
                            <div className="drama-guide-fields">
                                {(["text", "image", "video"] as const).map((capability) => (
                                    <label className="drama-guide-field" key={capability}>
                                        <span>{capability === "text" ? "文本模型" : capability === "image" ? "图片模型" : "视频模型"}</span>
                                        <DramaModelPicker
                                            capability={capability}
                                            value={settings.models[capability]}
                                            aspectRatio={settings.aspectRatio}
                                            videoResolution={settings.videoResolution}
                                            onChange={(choice) => patch({ models: { ...settings.models, [capability]: choice } })}
                                        />
                                    </label>
                                ))}
                                <label className="drama-guide-field">
                                    <span>视频衔接</span>
                                    <Select
                                        disabled={!editable || busy}
                                        aria-label="视频衔接"
                                        value={settings.videoContinuity || "tail_frame"}
                                        options={[
                                            { value: "tail_frame", label: "尾帧续接" },
                                            { value: "parallel", label: "各段独立生成" },
                                        ]}
                                        onChange={(videoContinuity) => patch({ videoContinuity })}
                                    />
                                </label>
                            </div>
                            <DramaTextSteps
                                models={settings.models}
                                onModelsChange={(change) => patch({ models: { ...settings.models, ...change } })}
                                textThinking={settings.textThinking || {}}
                                onThinkingChange={(step, level) => patch({ textThinking: { ...settings.textThinking, [step]: level === "auto" ? undefined : level } })}
                                skills={{ bible: settings.bibleSkill, script: settings.scriptSkill, prompt: settings.promptSkill }}
                                onSkillChange={(step, value) => patch({ [step === "bible" ? "bibleSkill" : step === "script" ? "scriptSkill" : "promptSkill"]: value })}
                            />
                            <StoryboardRules value={settings.storyboard} onChange={(storyboard) => patch({ storyboard })} episodeSeconds={settings.episodeSeconds} maxVideoSeconds={videoOption?.maxVideoSeconds} videoModelLabel={videoOption?.label} />
                            <AssetSchemePicker value={settings.assets} onChange={(assets) => patch({ assets })} imageModel={imageOption} layout="compact" />
                            <DramaAssetImageModels models={settings.models} onModelsChange={(change) => patch({ models: { ...settings.models, ...change } })} assets={settings.assets} onAssetsChange={(assets) => patch({ assets })} />
                        </div>
                    </details>
                </fieldset>
                <AppModal open={stylePickerOpen && editable && !busy} title="选择视觉风格" onCancel={() => setStylePickerOpen(false)} footer={null} width="min(960px, calc(100vw - 32px))" rootClassName="drama-root">
                    <DramaStylePicker
                        value={style?.id || ""}
                        onChange={(id) => {
                            const selected = DRAMA_STYLES.find((item) => item.id === id);
                            if (selected) {
                                patch({ styleName: selected.name, stylePrompt: selected.prompt });
                                setStylePickerOpen(false);
                            }
                        }}
                    />
                </AppModal>
                {editable && dirty ? (
                    <div className="drama-guide-inline-actions">
                        {stale ? <span role="alert">配置已有更新，请重新载入后调整。</span> : <span>有尚未保存的调整</span>}
                        <Button onClick={onDiscard} disabled={busy}>
                            重新载入
                        </Button>
                        <Button onClick={onSave} disabled={busy || stale} loading={busy}>
                            保存调整
                        </Button>
                    </div>
                ) : null}
            </section>
            <section className="drama-guide-card">
                <div className="drama-guide-section-head">
                    <div>
                        <h2>故事正文</h2>
                        <p>
                            {summary.production.chapterCount
                                ? `已加入 ${summary.production.chapterCount} 章，共 ${summary.production.wordCount.toLocaleString()} 字${summary.production.reservedChapterCount ? `，另有 ${summary.production.reservedChapterCount} 章预留正文` : ""}。`
                                : "创作想法还需要扩展为可改编的正文。可以请 Agent 起草，也可以自行补充。"}
                        </p>
                    </div>
                    {editable ? (
                        <Button icon={<Pencil className="size-3.5" />} onClick={onEditSource} disabled={busy}>
                            {summary.production.chapterCount ? "替换正文" : "补充正文"}
                        </Button>
                    ) : (
                        <Check className="size-4" />
                    )}
                </div>
                {summary.production.chapterCount ? <GuideSourcePreview projectId={summary.project.id} /> : null}
                <p className="drama-guide-note">正文确认后将沿用现有资产提取、剧本改编和分镜流程。参考图可逐张手动生成，也可以进入制作台后再做。</p>
            </section>
        </div>
    );
}

function GuideSourcePreview({ projectId }: { projectId: string }) {
    const [open, setOpen] = useState(false);
    const [selected, setSelected] = useState("");
    const chapters = useQuery({ queryKey: dramaKeys.chapters(projectId), queryFn: ({ signal }) => listDramaChapters(projectId, signal), enabled: open });
    const id = chapters.data?.chapters.some((chapter) => chapter.id === selected) ? selected : chapters.data?.chapters[0]?.id || "";
    const source = useQuery({ queryKey: ["drama", projectId, "chapter", id], queryFn: ({ signal }) => getDramaChapter(projectId, id, signal), enabled: open && Boolean(id) });
    return (
        <details className="drama-guide-source-preview" onToggle={(event) => setOpen(event.currentTarget.open)}>
            <summary>查看已保存的正文</summary>
            {open ? (
                <div className="drama-guide-stack">
                    <Select
                        aria-label="查看正文章节"
                        value={id || undefined}
                        loading={chapters.isLoading}
                        options={chapters.data?.chapters.map((chapter) => ({ value: chapter.id, label: `${chapter.title}${chapter.reserved ? "（预留）" : ""}` }))}
                        onChange={setSelected}
                    />
                    {chapters.isError || source.isError ? (
                        <p role="alert">
                            正文暂时无法读取。
                            <Button
                                size="small"
                                onClick={() => {
                                    void chapters.refetch();
                                    if (id) void source.refetch();
                                }}
                            >
                                重试
                            </Button>
                        </p>
                    ) : (
                        <p className="drama-guide-prompt">{source.isLoading ? "正在读取正文…" : source.data?.chapter.sourceText || "暂无正文"}</p>
                    )}
                </div>
            ) : null}
        </details>
    );
}

export function GuideAssets({ cast, busy, loading, onEdit, onGenerate }: { cast: DramaCast[]; busy: boolean; loading: boolean; onEdit: (cast: DramaCast) => void; onGenerate: (cast: DramaCast) => void }) {
    const assets = cast.filter((item) => !item.parentId);
    const looks = cast.filter((item) => item.parentId);
    return (
        <div className="drama-guide-stack">
            <div className="drama-guide-section-head">
                <div>
                    <h2>确认角色、场景与道具</h2>
                    <p>先检查文字设定。参考图按需生成，没有图片也可以继续。</p>
                </div>
                <span className="drama-chip">
                    {assets.length} 项资产{looks.length ? ` · ${looks.length} 套造型` : ""}
                </span>
            </div>
            {!assets.length ? (
                <div className="drama-guide-empty" role="status">
                    <UsersRound className="size-7" />
                    <h3>{loading ? "正在提取资产文字设定" : "尚未生成资产文字"}</h3>
                    <p>生成后会停在这里，等你确认再改编剧本与分镜。</p>
                </div>
            ) : (
                <div className="drama-guide-cast-grid">
                    {assets.map((item) => (
                        <article className="drama-guide-card drama-guide-cast" key={item.id}>
                            <header>
                                <div className="drama-guide-asset-thumb">{item.imageResourceId ? <MediaThumb resourceId={item.imageResourceId} alt={item.name} /> : <UsersRound className="size-5" />}</div>
                                <div>
                                    <span className="drama-eyebrow">
                                        {CAST_KIND_LABEL[item.kind]}
                                        {item.role ? ` · ${item.role}` : ""}
                                    </span>
                                    <h3>{item.name}</h3>
                                </div>
                                <Button type="text" icon={<Pencil className="size-4" />} aria-label={`编辑${item.name}`} disabled={busy} onClick={() => onEdit(item)} />
                            </header>
                            <p>{item.description || "尚无描述"}</p>
                            {item.appearance ? (
                                <div className="drama-guide-cast-detail">
                                    <strong>{item.kind === "scene" ? "环境" : "外观"}</strong>
                                    <p>{item.appearance}</p>
                                </div>
                            ) : null}
                            {item.voiceInstructions ? (
                                <div className="drama-guide-cast-detail">
                                    <strong>声线</strong>
                                    <p>{item.voiceInstructions}</p>
                                </div>
                            ) : null}
                            <GuideAssetImageActions cast={item} busy={busy} onGenerate={onGenerate} />
                            {item.kind === "character" ? <GuideAssetLooks character={item} looks={looks.filter((look) => look.parentId === item.id)} busy={busy} onGenerate={onGenerate} /> : null}
                        </article>
                    ))}
                </div>
            )}
        </div>
    );
}

function GuideAssetImageActions({ cast, busy, onGenerate }: { cast: DramaCast; busy: boolean; onGenerate: (cast: DramaCast) => void }) {
    const label = cast.imageResourceId ? "重新生成图片" : "生成参考图";
    const name = cast.parentId ? `${cast.name} · ${cast.lookName || "未命名造型"}` : cast.name;
    return (
        <footer>
            <span className="drama-guide-note" role="status">
                {cast.imageStatus === "failed" ? "参考图生成失败，可重试" : cast.imageStatus === "stale" ? "设定已调整，参考图已过期" : mediaBusy(cast.imageStatus) ? "参考图正在生成" : cast.imageResourceId ? "已有参考图" : "尚未生成参考图"}
            </span>
            <Button size="small" icon={<ImagePlus className="size-3.5" />} aria-label={`${name}：${label}`} disabled={busy || mediaBusy(cast.imageStatus)} loading={mediaBusy(cast.imageStatus)} onClick={() => onGenerate(cast)}>
                {label}
            </Button>
        </footer>
    );
}

function GuideAssetLooks({ character, looks, busy, onGenerate }: { character: DramaCast; looks: DramaCast[]; busy: boolean; onGenerate: (cast: DramaCast) => void }) {
    if (!looks.length) return null;
    return (
        <details className="drama-guide-cast-looks">
            <summary>其他造型（{looks.length}）</summary>
            <div className="drama-guide-stack">
                {looks.map((look) => (
                    <article className="drama-guide-look" key={look.id} aria-label={`${character.name} · ${look.lookName || "未命名造型"}`}>
                        <div className="drama-guide-look-head">
                            <div className="drama-guide-asset-thumb">{look.imageResourceId ? <MediaThumb resourceId={look.imageResourceId} alt={`${character.name} · ${look.lookName || "未命名造型"}`} /> : <Shirt className="size-5" />}</div>
                            <div>
                                <h4>{look.lookName || "未命名造型"}</h4>
                                <small>
                                    {look.lookFromChapter && look.lookToChapter
                                        ? `第 ${look.lookFromChapter}–${look.lookToChapter} 章`
                                        : look.lookFromChapter
                                          ? `第 ${look.lookFromChapter} 章起`
                                          : look.lookToChapter
                                            ? `第 ${look.lookToChapter} 章前`
                                            : "不限章节"}
                                </small>
                            </div>
                        </div>
                        <p>{look.appearance || "尚无外观设定"}</p>
                        <GuideAssetImageActions cast={look} busy={busy} onGenerate={onGenerate} />
                    </article>
                ))}
            </div>
        </details>
    );
}

export function GuideStory({
    episodes,
    episodeId,
    detail,
    details = [],
    failedEpisodeIds,
    busy,
    loading,
    failed,
    onSelect,
    onReload,
    onRescript,
    onRetryEpisode,
    onPatch,
    onEditPrompt,
    onWritePrompt,
}: {
    episodes: DramaEpisodeRow[];
    episodeId: string;
    detail?: DramaEpisodeDetail;
    busy: boolean;
    loading: boolean;
    failed: boolean;
    onSelect: (id: string) => void;
    onReload: () => void;
    details?: DramaEpisodeDetail[];
    failedEpisodeIds?: string[];
    onRescript?: () => void;
    onRetryEpisode?: (episodeId: string) => void;
    onPatch: (shot: DramaShot, patch: DramaShotPatch) => void;
    onEditPrompt: (segment: DramaSegment, episodeId: string) => void;
    onWritePrompt: (segment: DramaSegment, episodeId: string) => void;
}) {
    const allEpisodes = episodeId === "all";
    const [segmentFilter, setSegmentFilter] = useState<"all" | SegmentTone>("all");
    useEffect(() => setSegmentFilter("all"), [episodeId]);
    const failedEpisodeIdSet = useMemo(() => new Set(failedEpisodeIds), [failedEpisodeIds]);
    const visibleDetails = useMemo(() => (allEpisodes ? details.filter((current) => !failedEpisodeIdSet.has(current.episode.id)) : detail ? [detail] : []), [allEpisodes, detail, details, failedEpisodeIdSet]);
    const selectedEpisodes = allEpisodes ? episodes : episodes.filter((episode) => episode.id === episodeId);
    const episodeProgress = selectedEpisodes.reduce(
        (result, episode) => {
            const current = visibleDetails.find((item) => item.episode.id === episode.id);
            const row = current?.episode || episode;
            if (row.error) result.failed.push(episode.number);
            else if (failedEpisodeIdSet.has(episode.id)) result.unavailable += 1;
            else if (row.stage === "queued" || row.stage === "script" || (current?.segments.length ?? episode.stats?.segments ?? 0) === 0) result.pending += 1;
            return result;
        },
        { failed: [] as number[], pending: 0, unavailable: 0 },
    );
    const episodesIncomplete = episodeProgress.failed.length + episodeProgress.pending + episodeProgress.unavailable;
    const progress = useMemo(() => {
        const detailProgress = new Map(
            visibleDetails.map((current) => [
                current.episode.id,
                current.segments.reduce(
                    (result, segment) => {
                        const failed = segmentState(segment, "prompt").tone === "failed";
                        result.total += 1;
                        if (failed) result.failed += 1;
                        else if (segment.custom || segment.promptStatus === "ready") result.completed += 1;
                        return result;
                    },
                    { total: 0, completed: 0, failed: 0 },
                ),
            ]),
        );
        const selectedEpisodes = allEpisodes ? episodes : episodes.filter((episode) => episode.id === episodeId);
        return selectedEpisodes.reduce(
            (result, episode) => {
                const current = detailProgress.get(episode.id);
                result.total += current?.total ?? episode.stats?.segments ?? 0;
                const failed = current?.failed ?? episode.stats?.failed ?? 0;
                result.completed += current?.completed ?? episode.stats?.promptSucceeded ?? 0;
                result.failed += failed;
                return result;
            },
            { total: 0, completed: 0, failed: 0 },
        );
    }, [allEpisodes, detail, details, episodeId, episodes, visibleDetails]);
    const progressPercent = progress.total ? Math.min(100, Math.round(((progress.completed + progress.failed) / progress.total) * 100)) : 0;
    const successPercent = progress.total ? (progress.completed / progress.total) * 100 : 0;
    const failurePercent = progress.total ? (progress.failed / progress.total) * 100 : 0;
    const statusOptions: Array<{ value: "all" | SegmentTone; label: string }> = [
        { value: "all", label: "全部状态" },
        { value: "idle", label: "待处理" },
        { value: "busy", label: "处理中" },
        { value: "ready", label: "已完成" },
        { value: "failed", label: "失败" },
        { value: "stale", label: "已过期" },
        { value: "blocked", label: "等待中" },
    ];
    const filteredSegments = (current: DramaEpisodeDetail) => current.segments.filter((segment) => segmentFilter === "all" || segmentState(segment, "prompt").tone === segmentFilter);
    const detailLoading = loading;
    const unavailableEpisodes = allEpisodes ? episodes.filter((episode) => failedEpisodeIdSet.has(episode.id)) : [];
    return (
        <div className="drama-guide-stack">
            <div className="drama-guide-section-head">
                <div>
                    <h2>审阅剧本、镜头与段提示词</h2>
                    <p>逐集检查内容，可以直接修改文字，或请 Agent 提出调整建议。</p>
                    <div className="drama-guide-story-progress" aria-label={`段提示词进度：已完成 ${progress.completed} 段，失败 ${progress.failed} 段，共 ${progress.total} 段`}>
                        <div className="drama-guide-story-progress-head">
                            <strong>已生成段的提示词进度</strong>
                            <span>
                                {progress.completed + progress.failed}/{progress.total || 0} 段已处理
                            </span>
                        </div>
                        <div className="drama-guide-story-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}>
                            <span className="is-success" style={{ width: `${successPercent}%` }} />
                            <span className="is-failed" style={{ width: `${failurePercent}%` }} />
                        </div>
                        <div className="drama-guide-story-progress-meta">
                            <span className="is-success">{progress.completed} 段已完成</span>
                            <span className="is-failed">{progress.failed} 段失败</span>
                            <span>{Math.max(0, progress.total - progress.completed - progress.failed)} 段待处理</span>
                        </div>
                        {selectedEpisodes.length ? (
                            <div className="drama-guide-story-progress-meta" role="status" aria-label="剧本与分镜进度">
                                <span>
                                    剧本与分镜：{selectedEpisodes.length - episodesIncomplete}/{selectedEpisodes.length} 集就绪
                                </span>
                                {episodeProgress.failed.length ? (
                                    <span className="is-failed">
                                        {episodeProgress.failed.length} 集剧本失败（第 {episodeProgress.failed.join("、")} 集）
                                    </span>
                                ) : null}
                                {episodeProgress.pending ? <span>{episodeProgress.pending} 集剧本尚未就绪</span> : null}
                                {episodeProgress.unavailable ? <span>{episodeProgress.unavailable} 集读取失败</span> : null}
                                {episodesIncomplete ? <span>全部文字尚未完成，段进度仅统计已生成的剧情段。</span> : null}
                            </div>
                        ) : null}
                    </div>
                </div>
                {episodeId && episodeId !== "all" && onRescript && !detail?.episode.error ? (
                    <Button icon={<RotateCcw className="size-3.5" />} disabled={busy || loading} onClick={onRescript}>
                        重新改编本集
                    </Button>
                ) : null}
            </div>
            {episodes.length ? (
                <div className="drama-guide-story-filters">
                    <Select
                        className="drama-guide-story-episode-select"
                        aria-label="审阅集数"
                        value={episodeId || undefined}
                        options={[{ value: "all", label: `全部集（${episodes.length} 集）` }, ...episodes.map((episode) => ({ value: episode.id, label: `第 ${episode.number} 集 · ${episode.title}` }))]}
                        onChange={onSelect}
                    />
                    <Select className="drama-guide-story-status-select" aria-label="筛选段状态" value={segmentFilter} options={statusOptions} onChange={setSegmentFilter} />
                </div>
            ) : null}
            {failed ? (
                <div className="drama-guide-empty" role="alert">
                    <h3>本集内容暂时无法读取</h3>
                    <Button onClick={onReload}>重新读取</Button>
                </div>
            ) : detailLoading && !visibleDetails.length ? (
                <div className="drama-guide-empty" role="status">
                    <h3>正在读取剧本与分镜</h3>
                    <p>内容会分步显示，全部文字任务结束后再确认进入制作台。</p>
                </div>
            ) : (
                <>
                    {visibleDetails.map((current) => {
                        const segments = filteredSegments(current);
                        const scriptError = current.episode.error;
                        const scriptBusy = current.episode.stage === "script" && (current.scriptJob?.status === "queued" || current.scriptJob?.status === "running");
                        return (
                            <section key={current.episode.id} className="drama-guide-story-episode">
                                {allEpisodes ? (
                                    <h3 className="drama-guide-story-episode-title">
                                        第 {current.episode.number} 集 · {current.episode.title}
                                    </h3>
                                ) : null}
                                {scriptError ? (
                                    <div className="drama-guide-notice drama-guide-story-episode-failure" role="alert">
                                        <strong>第 {current.episode.number} 集剧本与分镜生成失败</strong>
                                        <p>{scriptError}</p>
                                        {onRetryEpisode ? (
                                            <Button disabled={busy || scriptBusy} icon={<RotateCcw className="size-3.5" />} onClick={() => onRetryEpisode(current.episode.id)}>
                                                {scriptBusy ? "本集剧本正在重试" : "重试本集剧本"}
                                            </Button>
                                        ) : null}
                                    </div>
                                ) : null}
                                {current.episode.synopsis ? (
                                    <section className="drama-guide-card">
                                        <h3>本集梗概</h3>
                                        <p>{current.episode.synopsis}</p>
                                    </section>
                                ) : null}
                                {segments.map((segment, index) => (
                                    <details key={segment.id} open={index === 0} className="drama-guide-card drama-guide-segment">
                                        <summary>
                                            <span>
                                                第 {segment.index + 1} 段 · {segment.title}
                                            </span>
                                            <span className="drama-guide-segment-meta">
                                                {secondsLabel(segment.durationMs)}
                                                <SegmentStatus segment={segment} phase="prompt" />
                                            </span>
                                        </summary>
                                        <div className="drama-guide-segment-body">
                                            <div className="drama-guide-section-head">
                                                <h3>段视频提示词</h3>
                                                <div className="drama-guide-inline-actions">
                                                    <Button size="small" disabled={busy} onClick={() => onEditPrompt(segment, current.episode.id)} icon={<Pencil className="size-3.5" />}>
                                                        编辑
                                                    </Button>
                                                    <Button
                                                        size="small"
                                                        disabled={busy || segment.promptStatus === "queued" || segment.promptStatus === "running"}
                                                        onClick={() => onWritePrompt(segment, current.episode.id)}
                                                        icon={<RotateCcw className="size-3.5" />}
                                                    >
                                                        重新撰写
                                                    </Button>
                                                </div>
                                            </div>
                                            <p className="drama-guide-prompt">{segment.videoPrompt || segment.promptError || "段提示词尚未就绪"}</p>
                                            {current.shots
                                                .filter((shot) => shot.segmentIndex === segment.index)
                                                .map((shot) => (
                                                    <details key={shot.id} className="drama-guide-shot">
                                                        <summary>
                                                            <strong>
                                                                镜头 {shot.position + 1} · {shot.scene || "场景待定"}
                                                            </strong>
                                                            <span>
                                                                {shot.shotSize} · {secondsLabel(shot.durationMs)}
                                                                <Pencil className="size-3" />
                                                            </span>
                                                        </summary>
                                                        {shot.dialogue ? (
                                                            <p className="drama-guide-dialogue">
                                                                {shot.speaker ? `${shot.speaker}：` : ""}
                                                                {shot.dialogue}
                                                            </p>
                                                        ) : null}
                                                        <fieldset disabled={busy} inert={busy}>
                                                            <ShotEditor shot={shot} onPatch={(patch) => onPatch(shot, patch)} />
                                                        </fieldset>
                                                    </details>
                                                ))}
                                        </div>
                                    </details>
                                ))}
                                {!segments.length && !detailLoading && !scriptError ? (
                                    <p className="drama-guide-empty" role="status">
                                        {current.episode.error || (segmentFilter === "all" ? "本集尚无镜头" : "没有符合当前状态的段")}
                                    </p>
                                ) : null}
                            </section>
                        );
                    })}
                    {unavailableEpisodes.map((episode) => (
                        <section key={episode.id} className="drama-guide-story-episode">
                            <h3 className="drama-guide-story-episode-title">
                                第 {episode.number} 集 · {episode.title}
                            </h3>
                            <div className="drama-guide-empty" role="alert">
                                <h3>本集内容暂时无法读取</h3>
                                <p>请重新读取全部集后继续。</p>
                                <Button onClick={onReload}>重新读取</Button>
                            </div>
                        </section>
                    ))}
                </>
            )}
        </div>
    );
}

export function GuideTextField({ label, value, onChange, rows = 3 }: { label: string; value: string; onChange: (value: string) => void; rows?: number }) {
    return (
        <label className="drama-guide-field">
            <span>{label}</span>
            <Input.TextArea value={value} autoSize={{ minRows: rows, maxRows: 10 }} onChange={(event) => onChange(event.target.value)} aria-label={label} />
        </label>
    );
}
