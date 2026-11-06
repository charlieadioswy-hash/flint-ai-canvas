import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Input, Select } from "antd";
import { Check, ImagePlus, Pencil, RotateCcw, UsersRound } from "lucide-react";

import { dramaChoiceKey } from "@/lib/drama/model-choice";
import { DRAMA_STYLES } from "@/lib/drama/drama-styles";
import { getDramaChapter, listDramaChapters, type DramaCast, type DramaEpisodeDetail, type DramaEpisodeRow, type DramaSegment, type DramaSettings, type DramaShot, type DramaShotPatch, type DramaSummary } from "@/services/api/drama";

import { AssetSchemePicker } from "./asset-scheme";
import { DramaModelPicker, useDramaModelCatalog } from "./drama-model-picker";
import { CAST_KIND_LABEL, mediaBusy, MediaThumb } from "./drama-shared";
import { DramaAssetImageModels, DramaTextSteps, VideoResolutionField } from "./step-settings";
import { EpisodeDurationInput, StoryboardRules } from "./storyboard-rules";
import { DramaStylePicker } from "./style-picker";
import { secondsLabel, SegmentStatus } from "./studio/segment-parts";
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
    const patch = (change: Partial<DramaSettings>) => {
        if (editable && !busy) onChange({ ...settings, ...change, mediaMode: "manual" });
    };
    const style = DRAMA_STYLES.find((item) => item.prompt === settings.stylePrompt);
    const imageChoice = dramaChoiceKey(settings.models.characterImage) ? settings.models.characterImage : settings.models.image;
    const imageOption = catalog.data?.options.image.find((item) => dramaChoiceKey(item.choice) === dramaChoiceKey(imageChoice));
    const videoOption = catalog.data?.options.video.find((item) => dramaChoiceKey(item.choice) === dramaChoiceKey(settings.models.video));
    return (
        <div className="drama-guide-stack">
            <section className="drama-guide-card">
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
                <fieldset disabled={!editable || busy} inert={!editable || busy} className="drama-guide-fields">
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
                        <span>视觉风格 · {settings.styleName || "自定义"}</span>
                        <p className="drama-guide-style-description">{settings.stylePrompt || "请与 Agent 确认视觉风格"}</p>
                        <details>
                            <summary>选择其他风格</summary>
                            <DramaStylePicker
                                value={style?.id || ""}
                                onChange={(id) => {
                                    const selected = DRAMA_STYLES.find((item) => item.id === id);
                                    if (selected) patch({ styleName: selected.name, stylePrompt: selected.prompt });
                                }}
                            />
                        </details>
                    </div>
                    <div className="drama-guide-field is-full">
                        <span>视频分辨率</span>
                        <VideoResolutionField option={videoOption} value={settings.videoResolution} onChange={(videoResolution) => patch({ videoResolution })} />
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
                                skills={{ bible: settings.bibleSkill, script: settings.scriptSkill, prompt: settings.promptSkill }}
                                onSkillChange={(step, value) => patch({ [step === "bible" ? "bibleSkill" : step === "script" ? "scriptSkill" : "promptSkill"]: value })}
                            />
                            <StoryboardRules value={settings.storyboard} onChange={(storyboard) => patch({ storyboard })} episodeSeconds={settings.episodeSeconds} maxVideoSeconds={videoOption?.maxVideoSeconds} videoModelLabel={videoOption?.label} />
                            <AssetSchemePicker value={settings.assets} onChange={(assets) => patch({ assets })} imageModel={imageOption} layout="compact" />
                            <DramaAssetImageModels models={settings.models} onModelsChange={(change) => patch({ models: { ...settings.models, ...change } })} assets={settings.assets} onAssetsChange={(assets) => patch({ assets })} />
                        </div>
                    </details>
                </fieldset>
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
    return (
        <div className="drama-guide-stack">
            <div className="drama-guide-section-head">
                <div>
                    <h2>确认角色、场景与道具</h2>
                    <p>先检查文字设定。参考图按需生成，没有图片也可以继续。</p>
                </div>
                <span className="drama-chip">{cast.length} 项资产</span>
            </div>
            {!cast.length ? (
                <div className="drama-guide-empty" role="status">
                    <UsersRound className="size-7" />
                    <h3>{loading ? "正在提取资产文字设定" : "尚未生成资产文字"}</h3>
                    <p>生成后会停在这里，等你确认再改编剧本与分镜。</p>
                </div>
            ) : (
                <div className="drama-guide-cast-grid">
                    {cast.map((item) => (
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
                            <footer>
                                <span className="drama-guide-note">
                                    {item.imageStatus === "failed"
                                        ? "参考图生成失败，可重试"
                                        : item.imageStatus === "stale"
                                          ? "设定已调整，参考图已过期"
                                          : mediaBusy(item.imageStatus)
                                            ? "参考图正在生成"
                                            : item.imageResourceId
                                              ? "已有参考图"
                                              : "尚未生成参考图"}
                                </span>
                                <Button size="small" icon={<ImagePlus className="size-3.5" />} disabled={busy || mediaBusy(item.imageStatus)} loading={mediaBusy(item.imageStatus)} onClick={() => onGenerate(item)}>
                                    {item.imageResourceId ? "重新生成图片" : "生成参考图"}
                                </Button>
                            </footer>
                        </article>
                    ))}
                </div>
            )}
        </div>
    );
}

export function GuideStory({
    episodes,
    episodeId,
    detail,
    busy,
    loading,
    failed,
    onSelect,
    onReload,
    onRescript,
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
    onRescript: () => void;
    onPatch: (shot: DramaShot, patch: DramaShotPatch) => void;
    onEditPrompt: (segment: DramaSegment) => void;
    onWritePrompt: (segment: DramaSegment) => void;
}) {
    return (
        <div className="drama-guide-stack">
            <div className="drama-guide-section-head">
                <div>
                    <h2>审阅剧本、镜头与段提示词</h2>
                    <p>逐集检查内容，可以直接修改文字，或请 Agent 提出调整建议。</p>
                </div>
                {episodeId ? (
                    <Button icon={<RotateCcw className="size-3.5" />} disabled={busy || loading} onClick={onRescript}>
                        重新改编本集
                    </Button>
                ) : null}
            </div>
            {episodes.length ? <Select className="w-full" aria-label="审阅集数" value={episodeId || undefined} options={episodes.map((episode) => ({ value: episode.id, label: `第 ${episode.number} 集 · ${episode.title}` }))} onChange={onSelect} /> : null}
            {failed ? (
                <div className="drama-guide-empty" role="alert">
                    <h3>本集内容暂时无法读取</h3>
                    <Button onClick={onReload}>重新读取</Button>
                </div>
            ) : !detail?.shots.length ? (
                <div className="drama-guide-empty" role="status">
                    <h3>{detail?.episode.error ? "本集剧本改编失败" : loading ? "正在改编剧本与分镜" : "本集尚无镜头"}</h3>
                    <p>{detail?.episode.error || "内容会分步显示，全部文字任务结束后再确认进入制作台。"}</p>
                </div>
            ) : (
                <>
                    {detail.episode.synopsis ? (
                        <section className="drama-guide-card">
                            <h3>本集梗概</h3>
                            <p>{detail.episode.synopsis}</p>
                        </section>
                    ) : null}
                    {detail.segments.map((segment, index) => (
                        <details key={segment.id} open={index === 0} className="drama-guide-card drama-guide-segment">
                            <summary>
                                <span>
                                    第 {segment.index + 1} 段 · {segment.title}
                                </span>
                                <span className="drama-guide-segment-meta">
                                    {secondsLabel(segment.durationMs)}
                                    <SegmentStatus segment={segment} />
                                </span>
                            </summary>
                            <div className="drama-guide-segment-body">
                                <div className="drama-guide-section-head">
                                    <h3>段视频提示词</h3>
                                    <div className="drama-guide-inline-actions">
                                        <Button size="small" disabled={busy} onClick={() => onEditPrompt(segment)} icon={<Pencil className="size-3.5" />}>
                                            编辑
                                        </Button>
                                        <Button size="small" disabled={busy || segment.promptStatus === "queued" || segment.promptStatus === "running"} onClick={() => onWritePrompt(segment)} icon={<RotateCcw className="size-3.5" />}>
                                            重新撰写
                                        </Button>
                                    </div>
                                </div>
                                <p className="drama-guide-prompt">{segment.videoPrompt || segment.promptError || "段提示词尚未就绪"}</p>
                                {detail.shots
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
