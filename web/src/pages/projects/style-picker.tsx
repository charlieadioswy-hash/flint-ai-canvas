import { useMemo, useState } from "react";
import { Check, Flame, Info, Search, X } from "lucide-react";

import { DRAMA_STYLE_CATEGORIES, dramaStylePresetsForType, filterDramaStyles, findDramaStyle, styleCoverBackground, type DramaStyleCategory } from "@/lib/drama/drama-styles";
import type { DramaSettings } from "@/services/api/drama";
import { dramaTypeLabel } from "./drama-style-selection";
import { DramaStyleDetailModal } from "./style-detail-modal";

type CategoryKey = "all" | "hot" | DramaStyleCategory;

export function DramaStylePicker({ value, onChange, dramaType, disabled = false }: { value: string; onChange: (id: string) => void; dramaType?: DramaSettings["dramaType"]; disabled?: boolean }) {
    const [category, setCategory] = useState<CategoryKey>("hot");
    const [query, setQuery] = useState("");
    const [detailId, setDetailId] = useState<string | null>(null);
    const compatibleIds = useMemo(() => new Set(dramaStylePresetsForType(dramaType).map((style) => style.id)), [dramaType]);
    const counts = useMemo(() => Object.fromEntries(DRAMA_STYLE_CATEGORIES.map((item) => [item.key, filterDramaStyles(item.key, "").filter((style) => compatibleIds.has(style.id)).length])), [compatibleIds]);
    const activeCategory = counts[category] ? category : "all";
    const styles = useMemo(() => filterDramaStyles(query ? "all" : activeCategory, query).filter((style) => compatibleIds.has(style.id)), [activeCategory, compatibleIds, query]);
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
            <div className="drama-styles-tabs" role="tablist" aria-label="风格预设分类">
                {DRAMA_STYLE_CATEGORIES.filter((item) => counts[item.key] > 0).map((item) => (
                    <button
                        key={item.key}
                        type="button"
                        role="tab"
                        aria-selected={!query && activeCategory === item.key}
                        className="drama-styles-tab"
                        onClick={() => {
                            setQuery("");
                            setCategory(item.key);
                        }}
                    >
                        {item.key === "hot" ? <Flame className="size-3.5" /> : null}
                        {item.label}
                        <span>{counts[item.key]}</span>
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
                {!styles.length ? <div className="col-span-full py-10 text-center text-[var(--fs-label)] text-foreground/45">没有找到“{query}”相关的风格</div> : null}
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
