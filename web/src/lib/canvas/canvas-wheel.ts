/** Common discrete wheel steps, including Windows 125% display scaling. */
export function isDiscreteCanvasWheel(deltaY: number, deltaMode: number) {
    const amount = Math.abs(deltaY);
    if (!Number.isFinite(amount) || !amount) return false;
    if (deltaMode !== 0) return true;
    return amount >= 80 && [100, 120, 125].some((step) => Math.abs(amount - Math.round(amount / step) * step) < 1);
}

export function wheelDeltaToPixels(delta: number, deltaMode: number) {
    if (deltaMode === 1) return delta * 16;
    if (deltaMode === 2) return delta * 720;
    return delta;
}
