import { ImagePlus, Shirt, UsersRound, VenetianMask, X } from "lucide-react";

import { IconButton } from "@/components/ui/base/buttons";
import { Tooltip } from "@/components/ui/base/tooltip/tooltip";
import type { DramaCast } from "@/services/api/drama";
import { CAST_KIND_LABEL, mediaBusy, MediaThumb } from "./drama-shared";
import { QuotedMediaButton, useDramaMediaContext } from "./studio/drama-media-action-context";
import { dramaCastImageAction } from "./studio/drama-media-action-request";

export function GuideAssets({
    cast,
    busy,
    loading,
    onEdit,
    onGenerate,
    onDelete,
    onSaveToLibrary,
    selectedIds,
    onSelect,
    sharedLookIds,
    compact = false,
}: {
    cast: DramaCast[];
    busy: boolean;
    loading: boolean;
    onEdit: (cast: DramaCast) => void;
    onGenerate: (cast: DramaCast) => void;
    onDelete?: (cast: DramaCast) => void;
    onSaveToLibrary?: (cast: DramaCast) => void;
    selectedIds?: Set<string>;
    onSelect?: (cast: DramaCast, checked: boolean) => void;
    sharedLookIds?: Set<string>;
    compact?: boolean;
}) {
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
                        <article
                            className={`drama-guide-card drama-guide-cast has-edit${compact ? " is-compact" : ""}`}
                            key={item.id}
                            data-selected={selectedIds?.has(item.id) || undefined}
                            onClick={(event) => {
                                if (busy || !(event.target instanceof Element)) return;
                                const control = event.target.closest("button, input, a, select, textarea, details, .drama-guide-asset-toolbar");
                                if (control && event.currentTarget.contains(control)) return;
                                onEdit(item);
                            }}
                        >
                            {compact ? (
                                <div className="drama-guide-asset-toolbar" role="group" aria-label={`${item.name}的快捷操作`}>
                                    {onSelect ? (
                                        <input
                                            className="drama-workflow-asset-checkbox"
                                            type="checkbox"
                                            aria-label={`选择${item.name}`}
                                            checked={selectedIds?.has(item.id) || false}
                                            disabled={busy}
                                            onChange={(event) => onSelect(item, event.target.checked)}
                                        />
                                    ) : null}
                                    <div className="drama-guide-asset-shortcuts">
                                        {onDelete ? (
                                            <Tooltip title="删除" placement="top" delay={200}>
                                                <IconButton size="xs" icon={X} aria-label={`删除${item.name}`} disabled={busy || mediaBusy(item.imageStatus)} onClick={() => onDelete(item)} />
                                            </Tooltip>
                                        ) : null}
                                        <GuideAssetGenerateButton cast={item} compact busy={busy} onGenerate={onGenerate} />
                                        {item.kind === "character" && onSaveToLibrary ? (
                                            <Tooltip title="加入角色库" placement="top" delay={200}>
                                                <IconButton size="xs" icon={VenetianMask} aria-label={`将${item.name}加入角色库`} disabled={busy || mediaBusy(item.imageStatus)} onClick={() => onSaveToLibrary(item)} />
                                            </Tooltip>
                                        ) : null}
                                    </div>
                                </div>
                            ) : onSelect ? (
                                <input className="drama-workflow-asset-checkbox" type="checkbox" aria-label={`选择${item.name}`} checked={selectedIds?.has(item.id) || false} disabled={busy} onChange={(event) => onSelect(item, event.target.checked)} />
                            ) : null}
                            <header>
                                <div className="drama-guide-asset-thumb">{item.imageResourceId ? <MediaThumb resourceId={item.imageResourceId} alt={item.name} /> : <UsersRound className="size-5" />}</div>
                                <div>
                                    {!compact || item.role ? <span className="drama-eyebrow">{compact ? item.role : `${CAST_KIND_LABEL[item.kind]}${item.role ? ` · ${item.role}` : ""}`}</span> : null}
                                    <h3 title={item.name}>
                                        <button type="button" className="drama-guide-asset-edit-trigger" aria-label={`编辑${item.name}`} disabled={busy} onClick={() => onEdit(item)}>
                                            {item.name}
                                        </button>
                                    </h3>
                                </div>
                            </header>
                            <div className={`drama-guide-cast-body${compact ? "" : " thin-scrollbar"}`} role="region" aria-label={`${item.name}的资产设定`} tabIndex={compact ? undefined : 0}>
                                <p title={compact ? item.description : undefined}>{item.description || "尚无描述"}</p>
                                {!compact && item.appearance ? (
                                    <div className="drama-guide-cast-detail">
                                        <strong>{item.kind === "scene" ? "环境" : "外观"}</strong>
                                        <p>{item.appearance}</p>
                                    </div>
                                ) : null}
                                {!compact && item.voiceInstructions ? (
                                    <div className="drama-guide-cast-detail">
                                        <strong>声线</strong>
                                        <p>{item.voiceInstructions}</p>
                                    </div>
                                ) : null}
                                {item.kind === "character" ? (
                                    <GuideAssetLooks character={item} looks={looks.filter((look) => look.parentId === item.id)} busy={busy} onGenerate={onGenerate} selectedIds={selectedIds} onSelect={onSelect} sharedLookIds={sharedLookIds} />
                                ) : null}
                            </div>
                            <GuideAssetImageActions cast={item} compact={compact} busy={busy} onGenerate={onGenerate} />
                        </article>
                    ))}
                </div>
            )}
        </div>
    );
}

function GuideAssetGenerateButton({ cast, compact = false, busy, onGenerate }: { cast: DramaCast; compact?: boolean; busy: boolean; onGenerate: (cast: DramaCast) => void }) {
    const context = useDramaMediaContext();
    const label = cast.imageResourceId ? "重新生成图片" : "生成图片";
    const name = cast.parentId ? `${cast.name} · ${cast.lookName || "未命名造型"}` : cast.name;
    return (
        <QuotedMediaButton
            tooltip
            iconOnly={compact}
            size="small"
            type={compact ? "text" : undefined}
            icon={<ImagePlus className="size-3.5" />}
            aria-label={`${name}：${label}`}
            request={dramaCastImageAction(cast, context?.episodeId)}
            label={label}
            disabled={busy || mediaBusy(cast.imageStatus)}
            loading={mediaBusy(cast.imageStatus)}
            onClick={() => onGenerate(cast)}
        />
    );
}

function GuideAssetImageActions({ cast, compact = false, busy, onGenerate }: { cast: DramaCast; compact?: boolean; busy: boolean; onGenerate: (cast: DramaCast) => void }) {
    const showStatus = !compact || cast.imageStatus === "failed" || cast.imageStatus === "stale" || mediaBusy(cast.imageStatus);
    if (compact && !showStatus) return null;
    return (
        <footer>
            {showStatus ? (
                <span className="drama-guide-note" role="status">
                    {cast.imageStatus === "failed" ? "参考图生成失败，可重试" : cast.imageStatus === "stale" ? "设定已调整，参考图已过期" : mediaBusy(cast.imageStatus) ? "参考图正在生成" : cast.imageResourceId ? "已有参考图" : "尚未生成参考图"}
                </span>
            ) : null}
            {!compact ? <GuideAssetGenerateButton cast={cast} busy={busy} onGenerate={onGenerate} /> : null}
        </footer>
    );
}

function GuideAssetLooks({
    character,
    looks,
    busy,
    onGenerate,
    selectedIds,
    onSelect,
    sharedLookIds,
}: {
    character: DramaCast;
    looks: DramaCast[];
    busy: boolean;
    onGenerate: (cast: DramaCast) => void;
    selectedIds?: Set<string>;
    onSelect?: (cast: DramaCast, checked: boolean) => void;
    sharedLookIds?: Set<string>;
}) {
    if (!looks.length) return null;
    return (
        <details className="drama-guide-cast-looks">
            <summary>其他造型（{looks.length}）</summary>
            <div className="drama-guide-stack">
                {looks.map((look) => (
                    <article className="drama-guide-look" key={look.id} aria-label={`${character.name} · ${look.lookName || "未命名造型"}`}>
                        {sharedLookIds?.has(look.id) ? <small>作品共享 · 本集未引用</small> : null}
                        {onSelect ? (
                            <label>
                                <input type="checkbox" aria-label={`选择${character.name} · ${look.lookName || "未命名造型"}`} checked={selectedIds?.has(look.id) || false} disabled={busy} onChange={(event) => onSelect(look, event.target.checked)} />
                                选择此造型
                            </label>
                        ) : null}
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
