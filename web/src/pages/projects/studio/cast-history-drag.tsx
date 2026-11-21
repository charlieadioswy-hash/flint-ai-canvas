import { createContext, useContext, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";

export type CastHistoryImage = { takeId: string; sourceViewId?: string };

const HISTORY_DRAG_TYPE = "application/x-yingce-cast-history";
type HistorySelection = { source: CastHistoryImage; keyboard: boolean };
const CastHistoryDragContext = createContext<ReturnType<typeof useCastHistoryDragState> | null>(null);

function setHistoryDragImage(event: DragEvent<HTMLElement>) {
    const source = event.currentTarget;
    const style = getComputedStyle(source);
    const width = parseInt(style.getPropertyValue("--drama-view-thumb-width"), 10) || 80;
    const height = parseInt(style.getPropertyValue("--drama-view-thumb-height"), 10) || 64;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context) {
        context.fillStyle = style.getPropertyValue("--surface").trim() || style.backgroundColor;
        context.fillRect(0, 0, width, height);
        const image = source.querySelector("img");
        if (image?.complete && image.naturalWidth && image.naturalHeight) {
            const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
            const imageWidth = image.naturalWidth * scale;
            const imageHeight = image.naturalHeight * scale;
            context.drawImage(image, (width - imageWidth) / 2, (height - imageHeight) / 2, imageWidth, imageHeight);
        }
    }
    // Keep the canvas mounted until the browser captures its drag image.
    canvas.style.cssText = `position:fixed;top:0;left:0;pointer-events:none;width:${width}px;height:${height}px`;
    canvas.setAttribute("aria-hidden", "true");
    document.body.append(canvas);
    event.dataTransfer.setDragImage(canvas, width / 2, height / 2);
    requestAnimationFrame(() => canvas.remove());
}

export function CastHistoryDragProvider({ children }: { children: ReactNode }) {
    return <CastHistoryDragContext.Provider value={useCastHistoryDragState()}>{children}</CastHistoryDragContext.Provider>;
}

export function useCastHistoryDrag() {
    const drag = useContext(CastHistoryDragContext);
    if (!drag) throw new Error("Missing CastHistoryDragProvider");
    return drag;
}

function useCastHistoryDragState() {
    const active = useRef<HistorySelection>(null);
    const [source, setSource] = useState<CastHistoryImage>();
    const [keyboardSource, setKeyboardSource] = useState<HTMLElement | null>(null);
    const keyboardActive = keyboardSource !== null;

    const clear = () => {
        active.current = null;
        setSource(undefined);
        setKeyboardSource(null);
    };
    useEffect(() => {
        if (!keyboardSource) return;
        const editor = keyboardSource.closest(".drama-editor, .drama-cast-views-body");
        const navigate = (event: globalThis.KeyboardEvent) => {
            if (!keyboardSource.isConnected) {
                clear();
                return;
            }
            if (event.key === "Tab" && editor) {
                const targets = Array.from(editor.querySelectorAll<HTMLElement>("[data-cast-history-target]"));
                if (!targets.length) return;
                const index = targets.indexOf(document.activeElement as HTMLElement);
                const next = index < 0 ? (event.shiftKey ? targets.length - 1 : 0) : (index + (event.shiftKey ? targets.length - 1 : 1)) % targets.length;
                event.preventDefault();
                event.stopPropagation();
                targets[next].focus();
                return;
            }
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            clear();
            keyboardSource.focus({ preventScroll: true });
        };
        document.addEventListener("keydown", navigate, true);
        document.addEventListener("pointerdown", clear, true);
        return () => {
            document.removeEventListener("keydown", navigate, true);
            document.removeEventListener("pointerdown", clear, true);
        };
    }, [keyboardSource]);

    const sourceProps = (source: CastHistoryImage, disabled = false) => ({
        draggable: !disabled,
        "aria-keyshortcuts": disabled ? undefined : "Shift+Enter",
        onDragStart: (event: DragEvent<HTMLElement>) => {
            if (disabled) return event.preventDefault();
            event.stopPropagation();
            clear();
            active.current = { source, keyboard: false };
            event.dataTransfer.clearData();
            event.dataTransfer.setData(HISTORY_DRAG_TYPE, source.takeId);
            event.dataTransfer.effectAllowed = "copy";
            setHistoryDragImage(event);
            setSource(source);
        },
        onDragEnd: clear,
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
            if (disabled || event.key !== "Enter" || !event.shiftKey) return;
            event.preventDefault();
            event.stopPropagation();
            active.current = { source, keyboard: true };
            setKeyboardSource(event.currentTarget);
            setSource(source);
        },
    });
    const targetProps = (onDrop: (source: CastHistoryImage) => void, disabled = false) => ({
        "data-cast-history-target": !disabled && keyboardActive ? "" : undefined,
        "data-cast-history-available": !disabled && source && !keyboardActive ? "" : undefined,
        onDragOver: (event: DragEvent<HTMLElement>) => {
            if (!active.current || !event.dataTransfer.types.includes(HISTORY_DRAG_TYPE)) return;
            event.stopPropagation();
            if (disabled) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
        },
        onDrop: (event: DragEvent<HTMLElement>) => {
            const selection = active.current;
            if (!selection || !event.dataTransfer.types.includes(HISTORY_DRAG_TYPE)) return;
            event.stopPropagation();
            event.preventDefault();
            clear();
            if (!disabled && !selection.keyboard && event.dataTransfer.getData(HISTORY_DRAG_TYPE) === selection.source.takeId) onDrop(selection.source);
        },
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
            if (disabled || !active.current?.keyboard || event.target !== event.currentTarget || event.key !== "Enter") return;
            event.stopPropagation();
            event.preventDefault();
            const { source } = active.current;
            clear();
            onDrop(source);
        },
    });
    return { keyboardActive, source, sourceProps, targetProps };
}
