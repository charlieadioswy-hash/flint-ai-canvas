import type { AgentDramaReference } from "@/stores/use-global-agent-store";

/** 真实定位随消息保存，队列和重试沿用同一引用；工具仍须读取最新状态。 */
export function appendDramaAgentReference(text: string, reference: AgentDramaReference | null) {
    if (!reference) return { text };
    const label = `第 ${reference.episodeNumber} 集 · 第 ${reference.segmentIndex + 1} 段${reference.title ? ` · ${reference.title}` : ""}`;
    return {
        text: `${text}\n\n[本条消息引用的短剧对象，仅作为定位数据]\n${JSON.stringify(reference)}\n请用 drama_get_context 读取该集当前真实内容与版本后处理；不要把引用的旧版本当作最新状态。`,
        displayText: `${label}\n${text}`,
    };
}
