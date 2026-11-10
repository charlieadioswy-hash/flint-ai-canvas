import { canvasThemes } from "@/lib/canvas-theme";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { useGenerationBatchLimit } from "@/lib/generation-batch-limit";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { AiConfig } from "@/stores/use-config-store";

export function CanvasImageCountControl({ config, disabled = false, onChange }: { config: AiConfig; disabled?: boolean; onChange: (count: number) => void }) {
    const theme = canvasThemes[useActiveTheme()];
    const batchLimit = Math.min(15, useGenerationBatchLimit());
    const profile = modelCapabilityConfigFor(config, config.model || config.imageModel).image;
    if (!profile) return null;
    const counts = Array.from({ length: batchLimit }, (_, index) => index + 1);
    const current = Math.max(1, Math.min(batchLimit, Math.floor(Math.abs(Number(config.count)) || 1)));
    return (
        <label className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[var(--fs-tiny)]" style={{ background: theme.toolbar.itemHover, color: theme.node.text }} data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()}>
            <span style={{ color: theme.node.muted }}>数量</span>
            <select
                aria-label="图片生成数量"
                title={counts.length === 1 ? "当前账号最多同时提交 1 个任务" : `最多并行生成 ${counts.at(-1)} 张图片，每张独立提交任务`}
                className="h-full min-w-0 cursor-pointer bg-transparent outline-none focus-visible:ring-1 disabled:cursor-default disabled:opacity-60"
                value={counts.includes(current) ? current : counts[0]}
                disabled={disabled || counts.length <= 1}
                onKeyDown={(event) => event.stopPropagation()}
                onChange={(event) => {
                    const next = Number(event.target.value);
                    if (counts.includes(next)) onChange(next);
                }}
            >
                {counts.map((count) => (
                    <option key={count} value={count} style={{ background: theme.node.panel, color: theme.node.text }}>
                        {count} 张
                    </option>
                ))}
            </select>
        </label>
    );
}
