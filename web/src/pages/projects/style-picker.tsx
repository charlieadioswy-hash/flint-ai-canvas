import { useMemo, useState } from "react";
import { Check, Flame, Info, Search, X } from "lucide-react";

import { dramaStylePresetsForType, dramaStyleTagsForType, filterDramaStylePresets, findDramaStyle, styleCoverBackground, type DramaStyleTag } from "@/lib/drama/drama-styles";
import type { DramaSettings } from "@/services/api/drama";
import { dramaTypeLabel } from "./drama-style-selection";
import { DramaStyleDetailModal } from "./style-detail-modal";

type Props = { value: string; onChange: (id: string) => void; dramaType?: DramaSettings["dramaType"]; disabled?: boolean };

export function DramaStylePicker(props: Props) {
    return <DramaStylePickerSession key={props.dramaType} {...props} />;
}

function DramaStylePickerSession({ value, onChange, dramaType, disabled = false }: Props) {
    const [tag, setTag] = useState<"all" | DramaStyleTag>("all");
    const [query, setQuery] = useState("");
    const [detailId, setDetailId] = useState<string | null>(null);
    const compatibleIds = useMemo(() => new Set(dramaStylePresetsForType(dramaType).map((style) => style.id)), [dramaType]);
    const tags = dramaStyleTagsForType(dramaType);
    const styles = filterDramaStylePresets(dramaType, tag, query);
    const selected = findDramaStyle(value);
    return (
        <section className="drama-styles">
            <div className="drama-styles-head">
                <div className="min-w-0">
                    <h2>视觉风格</h2>
                    {dramaTypeLabel(dramaType) ? <p>剧集类型 · {dramaTypeLabel(dramaType)}</p> : null}
                    {selected ? <p>当前风格 · {selected.name}</p> : null}
                </div>
                {selected ? (
                    <button type="button" className="drama-styles-detail-link" onClick={() => setDetailId(selected.id)}>
                        查看风格详情
                    </button>
                ) : null}
            </div>
            <label className="drama-search drama-styles-search">
                <Search className="size-3.5 shrink-0 opacity-40" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索风格预设" aria-label="搜索风格预设" />
                {query ? (
                    <button type="button" onClick={() => setQuery("")} aria-label="清空搜索">
                        <X className="size-3.5 opacity-40" />
                    </button>
                ) : null}
            </label>
            <div className="drama-styles-tabs" role="tablist" aria-label="风格标签">
                {tags.map((item) => (
                    <button key={item.key} type="button" role="tab" aria-selected={tag === item.key} className="drama-styles-tab" onClick={() => setTag(item.key)}>
                        {item.label}
                    </button>
                ))}
            </div>
            <div className="drama-style-grid thin-scrollbar" role="group" aria-label="风格预设">
                {styles.map((style) => (
                    <div key={style.id} className="drama-style" data-active={style.id === value || undefined}>
                        <button type="button" aria-pressed={style.id === value} className="drama-style-pick" disabled={disabled} onClick={() => onChange(style.id)} title={style.description}>
                            <span className="drama-style-swatch" style={{ background: styleCoverBackground(style) }}>
                                {!style.cover ? (
                                    <span className="drama-style-glyph" aria-hidden>
                                        {style.name.replace(/^3D\s*/, "").slice(0, 2)}
                                    </span>
                                ) : null}
                                {style.hot ? (
                                    <span className="drama-style-hot" title="爆款">
                                        <Flame className="size-2.5" />
                                    </span>
                                ) : null}
                                {style.id === value ? (
                                    <span className="drama-style-check">
                                        <Check className="size-3.5" />
                                    </span>
                                ) : null}
                                <span className="drama-style-overlay">
                                    <span className="drama-style-name">{style.name}</span>
                                    <span className="drama-style-tags">{style.tags.join(" · ")}</span>
                                </span>
                            </span>
                        </button>
                        <button type="button" className="drama-style-info" aria-label={`查看“${style.name}”详情`} title="查看详情" onClick={() => setDetailId(style.id)}>
                            <Info className="size-3" />
                        </button>
                    </div>
                ))}
                {!styles.length ? <div className="col-span-full py-10 text-center text-[var(--fs-label)] text-foreground/45">{query.trim() ? `没有找到“${query.trim()}”相关的风格` : "当前标签下暂无预设风格"}</div> : null}
            </div>
            <DramaStyleDetailModal
                styleId={detailId}
                selectedId={value}
                onClose={() => setDetailId(null)}
                onNavigate={setDetailId}
                navigationIds={styles.map((style) => style.id)}
                disabled={disabled || (detailId !== null && !compatibleIds.has(detailId))}
                onUse={(id) => {
                    onChange(id);
                    setDetailId(null);
                }}
            />
        </section>
    );
}
