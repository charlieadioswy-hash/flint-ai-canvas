import { useEffect, useState } from "react";
import { quoteModel, type LogicalModelQuote, type ModelQuoteRequest } from "@/services/api/logical-models";

type QuoteResult = {
    requestKey: string;
    quote: LogicalModelQuote | null;
    error: string;
};

export function useCanvasModelQuote(request: ModelQuoteRequest | undefined, enabled: boolean) {
    const requestKey = enabled && request ? JSON.stringify(request) : "";
    const [activeRequestKey, setActiveRequestKey] = useState(requestKey);
    const [result, setResult] = useState<QuoteResult | null>(null);
    const [retryCount, setRetryCount] = useState(0);

    if (activeRequestKey !== requestKey) {
        setActiveRequestKey(requestKey);
        setResult(null);
    }

    useEffect(() => {
        if (!requestKey) return;
        const controller = new AbortController();
        const currentRequest = JSON.parse(requestKey) as ModelQuoteRequest;
        quoteModel(currentRequest, controller.signal)
            .then(({ quote }) => {
                if (!controller.signal.aborted) setResult({ requestKey, quote, error: "" });
            })
            .catch((error: unknown) => {
                if (!controller.signal.aborted) {
                    setResult({ requestKey, quote: null, error: error instanceof Error && error.message ? error.message : "费用确认失败，请重试" });
                }
            });
        return () => controller.abort();
    }, [requestKey, retryCount]);

    const current = requestKey && result?.requestKey === requestKey ? result : null;
    return {
        quote: current?.quote ?? null,
        error: current?.error || "",
        pending: Boolean(requestKey && !current),
        retry: () => {
            setResult(null);
            setRetryCount((count) => count + 1);
        },
    };
}
