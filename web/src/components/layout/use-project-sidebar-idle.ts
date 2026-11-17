import { useCallback, useEffect, useRef, useState, type HTMLAttributes } from "react";

const SIDEBAR_IDLE_MS = 10_000;
const DESKTOP_QUERY = "(min-width: 1024px)";

export function projectSidebarScope(pathname: string) {
    const match = /^\/projects\/([^/]+)(?:\/guide|\/e\/[^/]+)?\/?$/.exec(pathname);
    return match && match[1] !== "new" ? match[1] : null;
}

function isSidebarToggle(target: EventTarget) {
    return target instanceof Element && target.closest("[data-workspace-sidebar-toggle]") !== null;
}

/** 项目制作时临时收起导航，不改写其他页面使用的侧栏偏好。 */
export function useProjectSidebarIdle(pathname: string) {
    const scope = projectSidebarScope(pathname);
    const [desktop, setDesktop] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1024);
    const [collapsed, setCollapsed] = useState(false);
    const [manualChoice, setManualChoice] = useState<{ scope: string; collapsed: boolean } | null>(null);
    const timer = useRef<number | null>(null);
    const hovered = useRef(false);
    const keyboardFocused = useRef(false);
    const pointerFocus = useRef(false);
    const active = Boolean(scope) && desktop;
    const manualCollapsed = manualChoice?.scope === scope ? manualChoice.collapsed : null;
    const automatic = active && manualCollapsed === null;

    const clearTimer = useCallback(() => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
    }, []);

    const scheduleCollapse = useCallback(() => {
        clearTimer();
        if (!automatic || hovered.current || keyboardFocused.current) return;
        timer.current = window.setTimeout(() => {
            timer.current = null;
            setCollapsed(true);
        }, SIDEBAR_IDLE_MS);
    }, [automatic, clearTimer]);

    const expand = useCallback(() => {
        clearTimer();
        setCollapsed(false);
    }, [clearTimer]);

    const setManuallyCollapsed = (next: boolean) => {
        if (!scope || !desktop) return;
        clearTimer();
        setManualChoice({ scope, collapsed: next });
    };

    useEffect(() => {
        const media = window.matchMedia(DESKTOP_QUERY);
        const update = () => setDesktop(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);

    useEffect(() => {
        setManualChoice(null);
    }, [scope]);

    useEffect(() => {
        setCollapsed(false);
        hovered.current = false;
        keyboardFocused.current = false;
        pointerFocus.current = false;
        scheduleCollapse();
        return clearTimer;
    }, [scope, scheduleCollapse, clearTimer]);

    const interactionProps: HTMLAttributes<HTMLElement> = automatic
        ? {
              onMouseOver: (event) => {
                  hovered.current = true;
                  // 悬停品牌区时保持开关的位置，避免用户移向按钮时自动展开。
                  if (event.target instanceof Element && event.target.closest(".app-workspace-sidebar-brand-row")) clearTimer();
                  else if (collapsed || timer.current !== null) expand();
              },
              onMouseLeave: () => {
                  hovered.current = false;
                  scheduleCollapse();
              },
              onPointerDownCapture: () => {
                  pointerFocus.current = true;
                  keyboardFocused.current = false;
              },
              onKeyDownCapture: (event) => {
                  pointerFocus.current = false;
                  keyboardFocused.current = true;
                  if (isSidebarToggle(event.target)) clearTimer();
                  else expand();
              },
              onFocusCapture: (event) => {
                  keyboardFocused.current = !pointerFocus.current;
                  if (isSidebarToggle(event.target)) clearTimer();
                  else expand();
              },
              onBlurCapture: (event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      keyboardFocused.current = false;
                      scheduleCollapse();
                  }
              },
              onClickCapture: (event) => {
                  pointerFocus.current = false;
                  if (isSidebarToggle(event.target)) return;
                  expand();
                  scheduleCollapse();
              },
          }
        : {};

    return { enabled: Boolean(scope), collapsed: active && (manualCollapsed ?? collapsed), setManuallyCollapsed, interactionProps };
}
