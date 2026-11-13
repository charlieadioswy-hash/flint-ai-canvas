import { Button } from "antd";
import { ImagePlus, ImageIcon, Pencil, Shirt, UsersRound } from "lucide-react";

import type { DramaCast } from "@/services/api/drama";
import { CAST_KIND_LABEL, mediaBusy, MediaThumb } from "./drama-shared";

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
