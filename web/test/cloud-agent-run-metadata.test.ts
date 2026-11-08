import { expect, test } from "bun:test";
import type { CloudAgentChatMessage } from "@/components/canvas/canvas-cloud-agent-chat-ui";
import { applyAgentEvent, upsertTextMessage } from "@/lib/canvas/cloud-agent-events";
import type { AgentEvent } from "@/services/api/agent";

function reduce(events: AgentEvent[], initial: CloudAgentChatMessage[] = []) {
    let messages = initial;
    for (const event of events) {
        applyAgentEvent(
            event,
            (update) => {
                messages = typeof update === "function" ? update(messages) : update;
            },
            () => {},
            () => {},
        );
    }
    return messages;
}
const event = (type: string, text: string, runId?: string): AgentEvent => ({ type, runId: runId!, eventId: `${type}-event`, seq: 1, createdAt: "2026-11-08T00:00:00Z", payload: { messageId: "answer", text } });

test.each(["assistant_delta", "assistant_message", "assistant_snapshot", "reasoning_delta", "reasoning_message"])("文本事件保存所属轮次：%s", (type) => {
    const messages = reduce([event(type, "本轮建议", "run-2")]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: "answer", runId: "run-2", text: "本轮建议", role: "assistant", streaming: type.endsWith("delta") });
    expect(Boolean(messages[0].reasoning)).toBe(type.startsWith("reasoning"));
});

test("流式消息收敛到完整快照时保留同一身份与轮次", () => {
    const messages = reduce([event("assistant_delta", "中文", "run-2"), event("assistant_delta", "普通话", "run-2"), event("assistant_message", "中文普通话", "run-2"), event("assistant_snapshot", "中文普通话", "run-2")]);
    expect(messages).toEqual([{ id: "answer", role: "assistant", text: "中文普通话", streaming: false, runId: "run-2" }]);
});

test("相同正文的重放补齐旧缓存缺失的runId，随后不再重复更新", () => {
    const cached: CloudAgentChatMessage[] = [{ id: "answer", role: "assistant", text: "本轮建议", streaming: false }];
    const updated = upsertTextMessage(cached, "answer", "本轮建议", false, "run-2");
    expect(updated).not.toBe(cached);
    expect(updated[0].runId).toBe("run-2");
    expect(cached[0].runId).toBeUndefined();
    expect(upsertTextMessage(updated, "answer", "本轮建议", false, "run-2")).toBe(updated);
});

test("旧事件缺少runId时不擦除已知归属，也不要求旧调用增加参数", () => {
    const cached: CloudAgentChatMessage[] = [{ id: "answer", role: "assistant", text: "本轮建议", streaming: false, runId: "run-2" }];
    expect(reduce([event("assistant_snapshot", "本轮建议")], cached)).toBe(cached);
    expect(reduce([event("assistant_message", "更新正文")], cached)[0]).toMatchObject({ runId: "run-2", text: "更新正文" });
    expect(upsertTextMessage([], "legacy", "旧消息", false)).toEqual([{ id: "legacy", role: "assistant", text: "旧消息", streaming: false }]);
});

test("相同正文但明确轮次不同仍更新归属，普通画布正文不做短剧选项解析", () => {
    const text = "1. 中文普通话\n2. 粤语";
    const first = upsertTextMessage([], "answer", text, false, "run-1");
    const next = upsertTextMessage(first, "answer", text, false, "run-2");
    expect(next[0]).toMatchObject({ runId: "run-2", text });
    expect(first[0].runId).toBe("run-1");
});

test.each(["completed", "failed", "cancelled", "rejected"])("运行进入 %s 后收敛本轮未完成的回复与推理，保留其他轮次", (status) => {
    const initial: CloudAgentChatMessage[] = [
        { id: "other-answer", role: "assistant", text: "其他轮次仍在输出", streaming: true, runId: "run-1" },
        { id: "legacy-answer", role: "assistant", text: "未知轮次的缓存", streaming: true },
        { id: "plan-run-2", role: "tool", text: "", planItems: [{ id: "choose", title: "选择语言", status: "doing" }], streaming: true },
    ];
    const messages = reduce(
        [event("assistant_delta", "请选择语言", "run-2"), { ...event("reasoning_delta", "已生成选项", "run-2"), payload: { messageId: "reasoning", text: "已生成选项" } }, { ...event("run_status", "", "run-2"), payload: { status } }],
        initial,
    );
    expect(messages.find((message) => message.id === "answer")).toMatchObject({ text: "请选择语言", runId: "run-2", streaming: false });
    expect(messages.find((message) => message.id === "reasoning")).toMatchObject({ text: "已生成选项", runId: "run-2", reasoning: true, streaming: false });
    expect(messages.find((message) => message.id === "plan-run-2")).toMatchObject({ planTerminal: true, streaming: false });
    expect(messages[0]).toBe(initial[0]);
    expect(messages[1]).toBe(initial[1]);
    expect(initial.every((message) => message.streaming)).toBe(true);
});

test.each(["running", "queued", "waiting_approval"])("运行状态 %s 不结束尚未完成的流式回复", (status) => {
    const messages = reduce([event("assistant_delta", "正在提供选项", "run-2"), { ...event("run_status", "", "run-2"), payload: { status } }]);
    expect(messages[0]).toMatchObject({ text: "正在提供选项", runId: "run-2", streaming: true });
});
