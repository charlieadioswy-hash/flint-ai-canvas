import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { Image as ImageIcon, LoaderCircle, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import { zoomImagePreviewAt } from "@/lib/canvas/canvas-image-preview";
import { wheelDeltaToPixels } from "@/lib/canvas/canvas-wheel";
import { resolveImageUrl } from "@/services/image-storage";
import type { ViewportTransform } from "@/types/canvas";

type CanvasImagePreviewProps = {
    src?: string;
    storageKey?: string;
    alt?: string;
    onClose: () => void;
};

const FIT_TRANSFORM: ViewportTransform = { x: 0, y: 0, k: 1 };

export function CanvasImagePreview(props: CanvasImagePreviewProps) {
    return <CanvasImagePreviewContent key={JSON.stringify([props.src, props.storageKey])} {...props} />;
}

function CanvasImagePreviewContent({ src = "", storageKey, alt = "图片", onClose }: CanvasImagePreviewProps) {
    const [resolvedSrc, setResolvedSrc] = useState(storageKey ? "" : src);
    const [loading, setLoading] = useState(Boolean(src || storageKey));
    const [error, setError] = useState(false);
    const [transform, setTransform] = useState(FIT_TRANSFORM);
    const transformRef = useRef(FIT_TRANSFORM);
    const bodyRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ pointerId: number; clientX: number; clientY: number } | null>(null);
    const [dragging, setDragging] = useState(false);
    const updateTransform = useCallback((next: ViewportTransform) => {
        transformRef.current = next;
        setTransform(next);
    }, []);
    const zoom = (delta: number) => updateTransform(zoomImagePreviewAt(transformRef.current, { x: 0, y: 0 }, delta));
    const reset = () => updateTransform(FIT_TRANSFORM);

    useEffect(() => {
        const body = bodyRef.current;
        if (!body) return;
        const wheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            const stage = stageRef.current;
            if (!stage || loading || error || !(event.target instanceof Node) || !stage.contains(event.target)) return;
            const rect = stage.getBoundingClientRect();
            updateTransform(
                zoomImagePreviewAt(
                    transformRef.current,
                    {
                        x: event.clientX - rect.left - rect.width / 2,
                        y: event.clientY - rect.top - rect.height / 2,
                    },
                    wheelDeltaToPixels(event.deltaY, event.deltaMode),
                ),
            );
        };
        body.addEventListener("wheel", wheel, { passive: false });
        return () => body.removeEventListener("wheel", wheel);
    }, [error, loading, updateTransform]);

    const endDrag = (event: PointerEvent<HTMLDivElement>) => {
        event.stopPropagation();
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };

    useEffect(() => {
        let cancelled = false;
        setResolvedSrc(storageKey ? "" : src);
        setLoading(Boolean(src || storageKey));
        setError(false);
        if (!src && !storageKey)
            return () => {
                cancelled = true;
            };
        void resolveImageUrl(storageKey, src)
            .then((url) => {
                if (cancelled) return;
                if (!url) {
                    setLoading(false);
                    setError(true);
                    return;
                }
                setResolvedSrc(url);
            })
            .catch(() => {
                if (!cancelled) {
                    setLoading(false);
                    setError(true);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [src, storageKey]);

    if (!src && !storageKey) return null;

    return (
        <AppModal
            open
            flush
            title={
                <div className="flex min-w-0 items-center gap-2.5">
                    <span
                        className="grid size-7 shrink-0 place-items-center rounded-[var(--r-sm)] border"
                        style={{
                            borderColor: "var(--workspace-border)",
                            background: "color-mix(in srgb, var(--workspace-surface-strong) 72%, var(--workspace-surface))",
                            color: "var(--workspace-text-muted)",
                        }}
                    >
                        <ImageIcon className="size-4" />
                    </span>
                    <span className="min-w-0 truncate text-sm font-semibold" title={alt}>
                        {alt}
                    </span>
                </div>
            }
            footer={null}
            centered
            width="min(1160px, calc(100vw - 32px))"
            onCancel={onClose}
            className="canvas-image-preview-modal"
        >
            <div
                ref={bodyRef}
                data-canvas-no-zoom
                data-canvas-wheel-scroll
                className="flex flex-col gap-3 border-t p-4 sm:p-6"
                onPointerDown={(event) => event.stopPropagation()}
                onPointerMove={(event) => event.stopPropagation()}
                onPointerUp={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.stopPropagation()}
                style={{
                    borderColor: "var(--workspace-border)",
                    background: "color-mix(in srgb, var(--workspace-surface) 86%, var(--background))",
                }}
            >
                <div
                    ref={stageRef}
                    role="region"
                    aria-label="图片预览，滚轮缩放，拖动查看"
                    tabIndex={0}
                    className="relative w-full overflow-hidden rounded-[var(--r-lg)] border touch-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-text-muted)]"
                    style={{
                        height: "max(80px, min(66dvh, 620px, calc(100dvh - 180px)))",
                        cursor: loading || error ? "default" : dragging ? "grabbing" : "grab",
                        borderColor: "var(--workspace-border-strong)",
                        background: "var(--workspace-surface-strong)",
                        boxShadow: "inset 0 1px 0 color-mix(in srgb, var(--foreground) 5%, transparent), 0 18px 50px color-mix(in srgb, var(--foreground) 14%, transparent)",
                    }}
                    onPointerDown={(event) => {
                        event.stopPropagation();
                        if (loading || error || event.button !== 0 || dragRef.current) return;
                        event.preventDefault();
                        event.currentTarget.focus({ preventScroll: true });
                        event.currentTarget.setPointerCapture(event.pointerId);
                        dragRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
                        setDragging(true);
                    }}
                    onPointerMove={(event) => {
                        event.stopPropagation();
                        const drag = dragRef.current;
                        if (!drag || drag.pointerId !== event.pointerId) return;
                        const current = transformRef.current;
                        updateTransform({ ...current, x: current.x + event.clientX - drag.clientX, y: current.y + event.clientY - drag.clientY });
                        drag.clientX = event.clientX;
                        drag.clientY = event.clientY;
                    }}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onLostPointerCapture={endDrag}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") return;
                        event.stopPropagation();
                        if (loading || error) return;
                        if (event.key === "+" || event.key === "=" || event.key === "-" || event.key === "0") {
                            event.preventDefault();
                            if (event.key === "0") reset();
                            else zoom(event.key === "-" ? 100 : -100);
                        }
                    }}
                >
                    {loading && !error ? (
                        <div
                            className="absolute inset-3 grid place-items-center rounded-[var(--r-md)] border border-dashed sm:inset-5"
                            style={{
                                borderColor: "var(--workspace-border)",
                                background: "color-mix(in srgb, var(--workspace-surface-strong) 68%, var(--workspace-surface))",
                            }}
                            role="status"
                            aria-label="图片加载中"
                        >
                            <div className="flex flex-col items-center gap-3" style={{ color: "var(--workspace-text-muted)" }}>
                                <span className="grid size-11 place-items-center rounded-full border bg-[var(--workspace-surface-strong)]" style={{ borderColor: "var(--workspace-border)" }}>
                                    <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" />
                                </span>
                                <span className="text-xs font-medium">正在加载高清图片</span>
                            </div>
                        </div>
                    ) : null}
                    {error ? (
                        <div
                            className="absolute inset-3 grid place-items-center rounded-[var(--r-md)] border border-dashed sm:inset-5"
                            style={{
                                borderColor: "var(--workspace-border-strong)",
                                background: "color-mix(in srgb, var(--workspace-surface-strong) 68%, var(--workspace-surface))",
                                color: "var(--workspace-text-muted)",
                            }}
                            role="alert"
                        >
                            <div className="flex flex-col items-center gap-3 text-center">
                                <ImageIcon className="size-8 opacity-45" />
                                <div>
                                    <div className="text-sm font-medium">图片暂时无法显示</div>
                                    <div className="mt-1 text-xs opacity-70">请关闭预览后重试</div>
                                </div>
                            </div>
                        </div>
                    ) : null}
                    {resolvedSrc ? (
                        <img
                            src={resolvedSrc}
                            alt={alt}
                            draggable={false}
                            className={`pointer-events-none absolute inset-0 size-full select-none object-contain transition-opacity duration-200 motion-reduce:transition-none ${loading || error ? "opacity-0" : "opacity-100"}`}
                            style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})`, transformOrigin: "center" }}
                            onLoad={() => {
                                setLoading(false);
                                setError(false);
                            }}
                            onError={() => {
                                setLoading(false);
                                setError(true);
                            }}
                        />
                    ) : null}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: "var(--workspace-text-muted)" }}>
                    <span>滚轮缩放 · 拖动查看 · 0 还原</span>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            aria-label="缩小图片"
                            disabled={loading || error || transform.k <= 0.25}
                            onClick={() => zoom(100)}
                            className="grid size-8 place-items-center rounded-[var(--r-sm)] border border-[var(--workspace-border)] hover:bg-[var(--workspace-surface-strong)] disabled:opacity-40"
                        >
                            <ZoomOut className="size-4" />
                        </button>
                        <span className="min-w-10 text-center tabular-nums" aria-label="相对适应窗口的缩放比例">
                            {Math.round(transform.k * 100)}%
                        </span>
                        <button
                            type="button"
                            aria-label="放大图片"
                            disabled={loading || error || transform.k >= 8}
                            onClick={() => zoom(-100)}
                            className="grid size-8 place-items-center rounded-[var(--r-sm)] border border-[var(--workspace-border)] hover:bg-[var(--workspace-surface-strong)] disabled:opacity-40"
                        >
                            <ZoomIn className="size-4" />
                        </button>
                        <button
                            type="button"
                            disabled={loading || error}
                            onClick={reset}
                            className="flex h-8 items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--workspace-border)] px-2 hover:bg-[var(--workspace-surface-strong)] disabled:opacity-40"
                        >
                            <RotateCcw className="size-3.5" />
                            适应窗口
                        </button>
                    </div>
                </div>
            </div>
        </AppModal>
    );
}
