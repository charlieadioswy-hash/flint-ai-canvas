export function appendAgentPromptPrefill(current: string, prefill: string) {
    if (!prefill.trim()) return current;
    if (!current.trim()) return prefill;

    // 追加到末尾，用空格分隔而非换行，保持在同一段落中
    const separator = current.endsWith(" ") ? "" : " ";
    return `${current}${separator}${prefill.trim()}`;
}

/** 同一引导请求在会话绑定、恢复或上下文重注册后仍只消费一次。 */
export function claimDramaAgentPrefill(receipts: Set<string>, accountScope: string, projectId: string, requestId: number) {
    const key = JSON.stringify([accountScope, projectId, requestId]);
    if (receipts.has(key)) return false;
    receipts.add(key);
    return true;
}
