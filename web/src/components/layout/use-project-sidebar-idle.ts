import { useCallback, useEffect, useRef, useState, type HTMLAttributes } from "react";

const SIDEBAR_IDLE_MS = 10_000;
const DESKTOP_QUERY = "(min-width: 1024px)";

export function projectSidebarScope(pathname: string) {
    const match = /^\/projects\/([^/]+)(?:\/guide|\/e\/[^/]+)?\/?$/.exec(pathname);
    return match && match[1] !== "new" ? match[1] : null;
}

/** 项目制作时临时收起导航，不改写其他页面使用的侧栏偏好。 */
export function useProjectSidebarIdle(pathname: string) {
    const scope = projectSidebarScope(pathname);
    const [desktop, setDesktop] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1024);
    const [collapsed, setCollapsed] = useState(false);
    const timer = useRef<number | null>(null);
    const hovered = useRef(false);
    const keyboardFocused = useRef(false);
    const pointerFocus = useRef(false);
    const active = Boolean(scope) && desktop;

    const clearTimer = useCallback(() => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
    }, []);

    const scheduleCollapse = useCallback(() => {
        clearTimer();
        if (!active || hovered.current || keyboardFocused.current) return;
        timer.current = window.setTimeout(() => {
            timer.current = null;
            setCollapsed(true);
        }, SIDEBAR_IDLE_MS);
    }, [active, clearTimer]);

    const expand = useCallback(() => {
        clearTimer();
        setCollapsed(false);
    }, [clearTimer]);

    useEffect(() => {
        const media = window.matchMedia(DESKTOP_QUERY);
        const update = () => setDesktop(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);

    useEffect(() => {
        setCollapsed(false);
        hovered.current = false;
        keyboardFocused.current = false;
        pointerFocus.current = false;
        scheduleCollapse();
        return clearTimer;
    }, [scope, scheduleCollapse, clearTimer]);

    const interactionProps: HTMLAttributes<HTMLElement> = active
        ? {
              onMouseEnter: () => {
                  hovered.current = true;
                  expand();
              },
              onMouseLeave: () => {
                  hovered.current = false;
                  scheduleCollapse();
              },
              onPointerDownCapture: () => {
                  pointerFocus.current = true;
                  keyboardFocused.current = false;
              },
              onKeyDownCapture: () => {
                  pointerFocus.current = false;
                  keyboardFocused.current = true;
                  expand();
              },
              onFocusCapture: () => {
                  keyboardFocused.current = !pointerFocus.current;
                  expand();
              },
              onBlurCapture: (event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      keyboardFocused.current = false;
                      scheduleCollapse();
                  }
              },
              onClickCapture: () => {
                  pointerFocus.current = false;
                  expand();
                  scheduleCollapse();
              },
          }
        : {};

    return { enabled: Boolean(scope), collapsed: active && collapsed, interactionProps };
}
