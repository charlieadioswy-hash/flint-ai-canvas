import { createContext, useContext, useEffect, useLayoutEffect, type ReactNode } from "react";
import { Button, type ButtonProps } from "antd";
import { RefreshCw } from "lucide-react";
import { Tooltip } from "@/components/ui/base/tooltip/tooltip";

import { generationLabel } from "../workflow-generation";
import { dramaMediaActionKey, type DramaMediaActionTarget } from "./drama-media-action-request";
import type { DramaMediaActionController, DramaMediaQuote } from "./use-drama-media-action";

type MediaContext = { controller: DramaMediaActionController; projectId?: string; revision?: number; episodeId?: string };
const Context = createContext<MediaContext | null>(null);

export function DramaMediaActionProvider({ children, ...value }: MediaContext & { children: ReactNode }) {
    return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function DramaMediaEpisodeScope({ episodeId, children }: { episodeId?: string; children: ReactNode }) {
    const context = useContext(Context);
    return <Context.Provider value={context ? { ...context, episodeId } : null}>{children}</Context.Provider>;
}

export function useDramaMediaContext() {
    return useContext(Context);
}

export function useContextMediaQuote(request: DramaMediaActionTarget | null): DramaMediaQuote {
    const context = useContext(Context);
    const key = request ? dramaMediaActionKey(request) : "";
    const quote = context && request ? context.controller.quoteAction(request) : { preview: null, loading: false, submitting: false, disabled: true };
    useLayoutEffect(() => {
        if (context && request && quote.preview) context.controller.acknowledgeQuote(request, quote.preview);
    }, [context?.controller.acknowledgeQuote, context?.controller.scopeKey, key, quote.preview]);
    useEffect(() => {
        if (context && request) void context.controller.prepareAction(request);
    }, [context?.controller.prepareAction, context?.controller.scopeKey, context?.revision, key]);
    return quote;
}

export function QuotedMediaButton({ request, label, disabled, loading, title, tooltip, iconOnly = false, ...props }: Omit<ButtonProps, "children"> & { request: DramaMediaActionTarget | null; label: string; tooltip?: boolean; iconOnly?: boolean }) {
    const context = useDramaMediaContext();
    const quote = useContextMediaQuote(request);
    const priceLabel = generationLabel(label, quote.preview, quote.loading);
    const description = quote.error || quote.preview?.reason || quote.notice || title || priceLabel;
    const tooltipLabel = iconOnly && description !== priceLabel ? `${priceLabel}；${description}` : description;
    const button = (
        <Button {...props} aria-label={iconOnly ? props["aria-label"] || label : props["aria-label"]} disabled={disabled || quote.disabled} loading={loading || quote.submitting} title={iconOnly ? undefined : description}>
            {iconOnly ? undefined : priceLabel}
        </Button>
    );
    const retry =
        quote.error && context && request ? (
            <Button
                size="small"
                type={iconOnly ? "text" : "link"}
                icon={iconOnly ? <RefreshCw className="size-3.5" /> : undefined}
                aria-label={iconOnly ? "重新计价" : undefined}
                disabled={disabled || quote.loading || quote.submitting}
                onClick={() => void context.controller.prepareAction(request, { force: true })}
            >
                {iconOnly ? undefined : "重新计价"}
            </Button>
        ) : null;
    return (
        <>
            {tooltip || iconOnly ? (
                <Tooltip title={tooltipLabel} placement="top" delay={iconOnly ? 200 : undefined}>
                    {button}
                </Tooltip>
            ) : (
                button
            )}
            {retry && iconOnly ? (
                <Tooltip title="重新计价" placement="top" delay={200}>
                    {retry}
                </Tooltip>
            ) : (
                retry
            )}
        </>
    );
}
