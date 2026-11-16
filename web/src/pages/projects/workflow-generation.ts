import { formatDramaCredits } from "@/lib/drama/drama-format";

export type GenerationQuote = { priced: boolean; amountMicrocredits: number };

export function generationLabel(label: string, quote?: GenerationQuote | null, loading = false) {
    if (loading) return `${label} - 计价中`;
    if (!quote?.priced || !Number.isSafeInteger(quote.amountMicrocredits) || quote.amountMicrocredits < 0) return `${label} - 暂无报价`;
    return `${label} - ${formatDramaCredits(quote.amountMicrocredits)}积分`;
}

export function sameGenerationCost(left: GenerationQuote, right: GenerationQuote) {
    return left.priced && right.priced && left.amountMicrocredits === right.amountMicrocredits;
}
