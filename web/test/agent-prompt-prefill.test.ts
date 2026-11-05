import { describe, expect, it } from "bun:test";
import { appendAgentPromptPrefill, claimDramaAgentPrefill } from "@/lib/canvas/agent-prompt-prefill";

describe("Agent prompt node prefill", () => {
    it("preserves a long composer draft and appends the node reference with space separator", () => {
        const draft = "请继续按下面的拍摄方案调整画面。".repeat(20).trimEnd();
        const reference = "@[node:image-reference-123] ";

        expect(appendAgentPromptPrefill(draft, reference)).toBe(`${draft} @[node:image-reference-123]`);
    });

    it("uses the prefill directly when the composer is empty", () => {
        expect(appendAgentPromptPrefill("", "@[node:text-reference-123] ")).toBe("@[node:text-reference-123] ");
    });

    it("appends with single space separator, no forced line breaks", () => {
        expect(appendAgentPromptPrefill("已有要求", "@[node:text-reference-123] ")).toBe("已有要求 @[node:text-reference-123]");
        expect(appendAgentPromptPrefill("已有要求 ", "@[node:text-reference-123] ")).toBe("已有要求 @[node:text-reference-123]");
    });

    it("does not resend a guide button request when its conversation is bound or restored", () => {
        const receipts = new Set<string>();
        expect(claimDramaAgentPrefill(receipts, "user-a", "drama-a", 101)).toBe(true);
        // 会话首轮绑定、路由上下文重注册、恢复历史不改变按钮请求身份。
        expect(claimDramaAgentPrefill(receipts, "user-a", "drama-a", 101)).toBe(false);
        expect(claimDramaAgentPrefill(receipts, "user-a", "drama-a", 101)).toBe(false);
        expect(claimDramaAgentPrefill(receipts, "user-a", "drama-a", 102)).toBe(true);
        expect(claimDramaAgentPrefill(receipts, "user-a", "drama-b", 101)).toBe(true);
        expect(claimDramaAgentPrefill(receipts, "user-b", "drama-a", 101)).toBe(true);
    });
});
