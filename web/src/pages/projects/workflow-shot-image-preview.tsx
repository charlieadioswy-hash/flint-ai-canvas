import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Button } from "antd";
import { FlipHorizontal2, FlipVertical2, LoaderCircle, RotateCcw, RotateCw, ZoomIn, ZoomOut } from "lucide-react";

import { AntTooltip } from "@/components/ui/base/tooltip/ant-tooltip";
import { AppModal } from "@/components/ui/product/app-modal";
import { zoomImagePreviewAt } from "@/lib/canvas/canvas-image-preview";
import { wheelDeltaToPixels } from "@/lib/canvas/canvas-wheel";

import { useResourceMediaUrl } from "./drama-shared";
import "./workflow-shot-image-preview.css";

type PreviewProps = { resourceId: string; name: string; onClose: () => void };

const FIT = { x: 0, y: 0, k: 1 };
const CENTER = { x: 0, y: 0 };

export function WorkflowShotImagePreview(props: PreviewProps) {
    return <PreviewContent key={props.resourceId} {...props} />;
}

function PreviewContent({ resourceId, name, onClose }: PreviewProps) {
    const url = useResourceMediaUrl(resourceId);
    const [loadedSrc, setLoadedSrc] = useState("");
    const [failedSrc, setFailedSrc] = useState("");
    const [viewport, setViewport] = useState(FIT);
    const [orientation, setOrientation] = useState({ turns: 0, flipX: false, flipY: false });
    const [dragging, setDragging] = useState(false);
    const stage = useRef<HTMLDivElement>(null);
    const drag = useRef<{ pointerId: number; x: number; y: number }>(null);
    const failed = Boolean(url && failedSrc === url);
    const ready = Boolean(url && loadedSrc === url && !failed);

    useEffect(() => {
        const element = stage.current;
        if (!element || !ready) return;
        const wheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            const { left, top, width, height } = element.getBoundingClientRect();
            const point = { x: event.clientX - left - width / 2, y: event.clientY - top - height / 2 };
            const delta = wheelDeltaToPixels(event.deltaY, event.deltaMode);
            setViewport((current) => zoomAt(current, delta, point));
        };
        element.addEventListener("wheel", wheel, { passive: false });
        return () => element.removeEventListener("wheel", wheel);
    }, [ready]);

    const zoom = (delta: number) => setViewport((current) => zoomAt(current, delta, CENTER));
    const rotate = (steps: number) => {
        setViewport((current) => ({ ...current, ...CENTER }));
        setOrientation(({ turns, flipX, flipY }) => ({ turns: (turns + steps + 4) % 4, flipX: flipY, flipY: flipX }));
    };
    const startDrag = (event: PointerEvent<HTMLDivElement>) => {
        if (!ready || viewport.k <= 1 || event.button !== 0 || drag.current) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        setDragging(true);
    };
    const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        const x = event.clientX - active.x;
        const y = event.clientY - active.y;
        active.x = event.clientX;
        active.y = event.clientY;
        setViewport((current) => ({ ...current, x: current.x + x, y: current.y + y }));
    };
    const endDrag = (event: PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        setDragging(false);
    };

    const actions = [
        { label: "垂直翻转", icon: FlipVertical2, run: () => setOrientation((current) => ({ ...current, flipY: !current.flipY })) },
        { label: "水平翻转", icon: FlipHorizontal2, run: () => setOrientation((current) => ({ ...current, flipX: !current.flipX })) },
        { label: "逆时针旋转", icon: RotateCcw, run: () => rotate(-1) },
        { label: "顺时针旋转", icon: RotateCw, run: () => rotate(1) },
        { label: "缩小图片", icon: ZoomOut, run: () => zoom(100), disabled: viewport.k <= 0.25 },
        { label: "放大图片", icon: ZoomIn, run: () => zoom(-100), disabled: viewport.k >= 8 },
    ];

    return (
        <AppModal
            open
            centered
            title={
                <div className="workflow-shot-image-preview-title" title={name}>
                    {name}
                </div>
            }
            width="min(calc(100vw - 24px), max(50vw, 420px))"
            footer={null}
            onCancel={onClose}
        >
            <div
                ref={stage}
                className="workflow-shot-image-preview-stage"
                data-draggable={ready && viewport.k > 1}
                data-dragging={dragging}
                data-canvas-no-zoom
                data-canvas-wheel-scroll
                onPointerDown={startDrag}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onLostPointerCapture={endDrag}
            >
                {!ready ? (
                    <span className="workflow-shot-image-preview-state" role={failed ? "alert" : "status"}>
                        {failed ? null : <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />}
                        {failed ? "图片加载失败" : "正在读取图片…"}
                    </span>
                ) : null}
                {url ? (
                    <img
                        className="workflow-shot-image-preview-image"
                        data-rotated={orientation.turns % 2 === 1}
                        hidden={!ready}
                        src={url}
                        alt={name}
                        draggable={false}
                        style={{
                            transform: `translate(-50%, -50%) translate(${viewport.x}px, ${viewport.y}px) scale(${orientation.flipX ? -viewport.k : viewport.k}, ${orientation.flipY ? -viewport.k : viewport.k}) rotate(${orientation.turns * 90}deg)`,
                        }}
                        onLoad={() => {
                            setFailedSrc("");
                            setLoadedSrc(url);
                        }}
                        onError={() => setFailedSrc(url)}
                    />
                ) : null}
            </div>
            <div className="workflow-shot-image-preview-tools" role="group" aria-label="图片预览工具">
                {actions.map(({ label, icon: Icon, run, disabled }) => (
                    <AntTooltip key={label} title={label} trigger={["hover", "focus"]}>
                        <Button type="text" size="small" aria-label={label} icon={<Icon className="size-4" aria-hidden />} disabled={!ready || disabled} onClick={run} />
                    </AntTooltip>
                ))}
            </div>
        </AppModal>
    );
}

function zoomAt(current: typeof FIT, delta: number, point: typeof CENTER) {
    const next = zoomImagePreviewAt(current, point, delta);
    return next.k <= 1 ? { ...next, ...CENTER } : next;
}
