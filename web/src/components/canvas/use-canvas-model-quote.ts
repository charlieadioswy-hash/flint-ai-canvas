import { useEffect, useState } from "react";
import { quoteModel, type LogicalModelQuote, type ModelQuoteRequest } from "@/services/api/logical-models";

type QuoteResult = {
    requestKey: string;
    quote: LogicalModelQuote | null;
    error: string;
};

// taskCount is only supplied for identical, independently submitted tasks.
// Callers quoting one batch request keep the default, since its quote is total.
export function useCanvasModelQuote(request: ModelQuoteRequest | undefined, enabled: boolean, taskCount = 1) {
    const countError = enabled && request && (!Number.isInteger(taskCount) || taskCount < 1 || taskCount > 15) ? "生成任务数量必须为 1–15 的整数" : "";
    const requestKey = enabled && request && !countError ? JSON.stringify({ request, taskCount }) : "";
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
        const { request: currentRequest, taskCount: currentTaskCount } = JSON.parse(requestKey) as { request: ModelQuoteRequest; taskCount: number };
        quoteModel(currentRequest, controller.signal)
            .then(({ quote }) => {
                if (!controller.signal.aborted) setResult({ requestKey, quote: { ...quote, quantity: quote.quantity * currentTaskCount, amountMicrocredits: quote.amountMicrocredits * currentTaskCount }, error: "" });
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
        error: countError || current?.error || "",
        pending: Boolean(requestKey && !current),
        retry: () => {
            setResult(null);
            setRetryCount((count) => count + 1);
        },
    };
}
