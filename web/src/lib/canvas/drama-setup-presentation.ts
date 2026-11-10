import type { DramaAgentProposal } from "@/services/api/agent";

export type DramaStageChoiceLabels = { confirm: string; adjust: string };

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

function confirmsStageTransition(value: string) {
    const label = normalizedLabel(value);
    if (!/^(?:确认|同意|进入|开始)/u.test(label)) return false;
    return /(?:进入(?:下一阶段|制作台|(?:改编(?:剧本)?(?:与分镜)?|剧本与分镜|资产提取)阶段)|开始提取资产|开始改编(?:剧本|分镜))/u.test(label);
}

function prepareDramaDecisionMessage(text: string, configuration: boolean): { body: string; after: string; labels?: DramaStageChoiceLabels } {
    const lines = text.split(/\r?\n/);
    const choiceLine = /^ {0,3}(?:[-*+]\s+)?(?:\*\*|__)?(?:[1-9]\s*[.)、．）]|[①-⑨])\s*(.+)$/u;
    const plainLabel = (line: string) => line.replace(/\*\*|__|`/gu, "").trim();
    let fence = "";
    for (let start = 0; start < lines.length; start++) {
        const marker = lines[start].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (marker) {
            if (!fence) fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = "";
            continue;
        }
        if (fence || !choiceLine.test(lines[start])) continue;
        const labels: string[] = [];
        let end = start;
        for (; end < lines.length; end++) {
            const item = lines[end].match(choiceLine);
            if (item) labels.push(plainLabel(item[1]));
            else if (lines[end].trim()) break;
        }
        const blockStart = start;
        start = Math.max(start, end - 1);
        if (labels.length !== 2) continue;
        const confirm = labels.filter((label) => (configuration ? /^(?:采用|使用|接受|确认)(?:推荐|这套|该)?配置/u : /^(?:确认|同意|进入下一阶段|进入制作台|开始改编|开始提取)/u).test(label));
        const adjust = labels.filter((label) => (configuration ? /^(?:在(?:推荐|当前|这套)配置(?:的)?基础上(?:修改|调整)|修改推荐配置|调整推荐配置)/u : /^(?:继续调整|调整|修改|返回调整|暂不确认|暂不推进)/u).test(label));
        if (confirm.length !== 1 || adjust.length !== 1 || confirm[0] === adjust[0]) continue;
        return { body: lines.slice(0, blockStart).join("\n").trimEnd(), after: lines.slice(end).join("\n").trimStart(), labels: { confirm: confirm[0], adjust: adjust[0] } };
    }
    return { body: text, after: "" };
}

/** 只把明确的阶段确认/调整列表接到真实业务回调，不从模型文字推断新的操作。 */
export function prepareDramaStageMessage(text: string) {
    return prepareDramaDecisionMessage(text, false);
}

/** 没有真实阶段回调时，只拦截明确的阶段推进，不屏蔽确认对白等普通创作选择。 */
export function hasExplicitDramaStageTransition(text: string) {
    const labels = prepareDramaStageMessage(text).labels;
    return Boolean(labels && confirmsStageTransition(labels.confirm));
}

/** 只合并已能按真实配置值唯一核对的重复选项；编号本身不承担建议映射。 */
export function prepareDramaSetupMessage(text: string, proposals: DramaAgentProposal[]): { body: string; proposals: DramaAgentProposal[] } {
    if (!proposals.length || proposals.some((proposal) => proposal.kind !== "setup")) return { body: text, proposals };
    if (proposals.length === 1 && ["aspectRatio", "videoResolution", "language", "episodeSeconds"].every((field) => Object.hasOwn(proposals[0].changes, field))) {
        const decision = prepareDramaDecisionMessage(text, true);
        if (decision.labels) return { body: [decision.body, decision.after].filter(Boolean).join("\n\n"), proposals };
    }
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

/**
 * 非配置建议也可能被模型重复写成编号列表。候选内容已经由卡片展示，
 * 这里只移除能够明确识别为候选列表的整段正文，保留前后的引导说明。
 */
export function prepareDramaProposalMessage(text: string, proposals: DramaAgentProposal[]): { body: string; proposals: DramaAgentProposal[] } {
    if (!text.trim() || proposals.length < 2 || proposals.every((proposal) => proposal.kind === "setup")) return { body: text, proposals };
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
        const preceding = lines.slice(Math.max(0, blockStart - 3), blockStart).join(" ");
        const hasChoiceIntro = /(方案|建议|推荐|可选|选择|调整|修改|新增|删除|如下)/u.test(preceding);
        const hasChoiceDetails = items.every((item) => /(?:\*\*|：|:\s|[—–-]\s)/u.test(item.heading));
        if (!hasChoiceIntro && !hasChoiceDetails) continue;
        const body = [lines.slice(0, blockStart).join("\n").trimEnd(), lines.slice(end).join("\n").trimStart()].filter(Boolean).join("\n\n");
        return { body, proposals };
    }
    return { body: text, proposals };
}
