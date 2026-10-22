import type { Position, ViewportTransform } from "@/types/canvas";

// Coordinates are relative to the center of the fitted image's viewport.
export function zoomImagePreviewAt(current: ViewportTransform, point: Position, delta: number): ViewportTransform {
    if (!Number.isFinite(delta) || !delta) return current;
    const k = Math.min(8, Math.max(0.25, current.k * Math.exp(-Math.max(-240, Math.min(240, delta)) * 0.002)));
    return {
        x: point.x - ((point.x - current.x) * k) / current.k,
        y: point.y - ((point.y - current.y) * k) / current.k,
        k,
    };
}
