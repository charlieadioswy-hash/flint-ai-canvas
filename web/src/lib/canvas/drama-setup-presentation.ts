import type { DramaAgentProposal } from "@/services/api/agent";

const orderedItem = /^ {0,3}\d+[.)、]\s+(.+)$/;
type ListItem = { heading: string; continuation: string[] };

function normalizedLabel(value: string) {
    return value.normalize("NFKC").replace(/[*_`]/g, "").replace(/\s+/g, "").toLowerCase();
}

function choiceParts(proposal: DramaAgentProposal): string[][] {
    const { changes } = proposal;
    const parts: string[][] = [];
    for (const field of ["styleName", "aspectRatio", "videoResolution", "language"] as const) {
        const value = changes[field];
        if (typeof value !== "string" || !value.trim()) continue;
        const normalized = normalizedLabel(value);
        const labels = [normalized];
        if (field === "aspectRatio") {
            const ratio = normalized.match(/^(\d+):(\d+)$/);
            const orientation = ratio && Number(ratio[1]) !== Number(ratio[2]) ? (Number(ratio[1]) < Number(ratio[2]) ? "竖屏" : "横屏") : "";
            if (orientation) labels.push(normalized + orientation, orientation + normalized, `${normalized}(${orientation})`);
        }
        parts.push(labels);
    }
    if (typeof changes.episodeSeconds === "number" && Number.isFinite(changes.episodeSeconds) && changes.episodeSeconds > 0) {
        const value = changes.episodeSeconds;
        parts.push([`${value}秒`, `${value}s`, `${value}秒/集`, `单集${value}秒`, `每集${value}秒`]);
    }
    return parts;
}

function itemPresentation(item: ListItem) {
    const separator = /\s*[—–]+\s*|\s+-+\s*|：\s*|:\s+/u.exec(item.heading);
    const label = separator ? item.heading.slice(0, separator.index) : item.heading;
    const detail = separator ? item.heading.slice(separator.index + separator[0].length) : "";
    return { label, explanation: [detail, ...item.continuation.map((line) => line.trimStart())].join("\n").trim() };
}

function matchesChoice(label: string, parts: string[][]) {
    if (!parts.length) return false;
    const normalized = normalizedLabel(label).replace(/(?:\((?:推荐|默认)\)|【(?:推荐|默认)】|\[(?:推荐|默认)\])$/u, "");
    if (parts.length === 1) return parts[0].includes(normalized);
    const labels = normalized.split(/[·+|｜]/u);
    return labels.length === parts.length && parts.every((variants) => labels.filter((part) => variants.includes(part)).length === 1) && labels.every((part) => parts.filter((variants) => variants.includes(part)).length === 1);
}

function readList(lines: string[], start: number) {
    const items: ListItem[] = [];
    let end = start;
    for (; end < lines.length; end++) {
        const line = lines[end];
        const numbered = line.match(orderedItem);
        if (numbered) {
            items.push({ heading: numbered[1], continuation: [] });
            continue;
        }
        if (/^ {0,3}(?:#{1,6}\s|`{3,}|~{3,})/.test(line)) break;
        if (!line.trim()) {
            let following = end + 1;
            while (following < lines.length && !lines[following].trim()) following++;
            if (following >= lines.length || (!orderedItem.test(lines[following]) && !/^(?: {2,}|\t)\S/.test(lines[following]))) break;
        }
        items.at(-1)!.continuation.push(line);
    }
    return { items, end };
}

/** 只合并已能按真实配置值唯一核对的重复选项；编号本身不承担建议映射。 */
export function prepareDramaSetupMessage(text: string, proposals: DramaAgentProposal[]): { body: string; proposals: DramaAgentProposal[] } {
    if (!proposals.length || proposals.some((proposal) => proposal.kind !== "setup")) return { body: text, proposals };
    const choices = proposals.map(choiceParts);
    if (choices.some((parts) => !parts.length)) return { body: text, proposals };
    const lines = text.split(/\r?\n/);
    let fence = "";
    for (let start = 0; start < lines.length; start++) {
        const marker = lines[start].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (marker) {
            if (!fence) fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = "";
            continue;
        }
        if (fence || !orderedItem.test(lines[start])) continue;
        const blockStart = start;
        const { items, end } = readList(lines, start);
        start = Math.max(start, end - 1);
        if (items.length !== proposals.length) continue;
        const matched = items.map(itemPresentation).map((item) => ({ ...item, candidates: choices.flatMap((parts, index) => (matchesChoice(item.label, parts) ? [index] : [])) }));
        if (matched.some((item) => item.candidates.length !== 1) || new Set(matched.map((item) => item.candidates[0])).size !== proposals.length) continue;
        const explanations = new Map(matched.map((item) => [item.candidates[0], item.explanation]));
        const body = [lines.slice(0, blockStart).join("\n").trimEnd(), lines.slice(end).join("\n").trimStart()].filter(Boolean).join("\n\n");
        return { body, proposals: proposals.map((proposal, index) => (proposal.explanation?.trim() || !explanations.get(index) ? proposal : { ...proposal, explanation: explanations.get(index) })) };
    }
    return { body: text, proposals };
}
