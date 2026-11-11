import { describe, expect, test } from "bun:test";
import { dramaProposalFromToolDetail, type AgentEvent, type AgentRun } from "@/services/api/agent";
import { projectCloudAgentConversation } from "@/services/cloud-agent-history";

describe("短剧 Agent 建议回放", () => {
    test("持久工具事件恢复真实 run/call 身份，供页面去重且不触发保存", () => {
        const at = "2026-11-05T00:00:00Z";
        const event: AgentEvent = {
            eventId: "run:1",
            runId: "run",
            seq: 1,
            type: "tool_completed",
            payload: { toolName: "drama_propose_changes", callId: "proposal", result: { kind: "setup", baseRevision: 7, changes: { language: "中文" } } },
            createdAt: at,
        };
        const run: AgentRun = { id: "run", conversationId: "conversation", canvasId: "", dramaProjectId: "project", status: "completed", permissionMode: "read_only", createdAt: at, updatedAt: at, events: [event] };
        const conversation = projectCloudAgentConversation("conversation", [run]);
        const proposal = dramaProposalFromToolDetail(conversation.messages.find((message) => message.role === "tool")?.detail);
        expect(proposal).toEqual({ kind: "setup", baseRevision: 7, changes: { language: "中文" }, runId: "run", toolCallId: "proposal", targetId: undefined });
        expect(conversation.run?.dramaProjectId).toBe("project");
    });

    test("忽略失败、缺少版本或伪造类型的工具结果", () => {
        const detail = { eventType: "tool_completed", toolName: "drama_propose_changes", runId: "run", callId: "proposal", result: { kind: "cast", targetId: "cast", baseRevision: 1, changes: { name: "主角" } } };
        expect(dramaProposalFromToolDetail({ ...detail, eventType: "tool_failed" })).toBeNull();
        expect(dramaProposalFromToolDetail({ ...detail, result: { ...detail.result, baseRevision: 0 } })).toBeNull();
        expect(dramaProposalFromToolDetail({ ...detail, result: { ...detail.result, kind: "generate_media" } })).toBeNull();
    });

    test("选项说明从工具元数据恢复且不混入配置", () => {
        const detail = { eventType: "tool_completed", toolName: "drama_propose_changes", runId: "run", callId: "choice", result: { kind: "setup", baseRevision: 7, changes: { language: "粤语" }, explanation: "  面向粤语观众  " } };
        const proposal = dramaProposalFromToolDetail(detail)!;
        expect(proposal.explanation).toBe("面向粤语观众");
        expect(proposal.changes).toEqual({ language: "粤语" });
        for (const explanation of [undefined, null, 123, "  "]) expect(dramaProposalFromToolDetail({ ...detail, result: { ...detail.result, explanation } })?.explanation).toBeUndefined();
        expect([...dramaProposalFromToolDetail({ ...detail, result: { ...detail.result, explanation: "🎬".repeat(1001) } })!.explanation!]).toHaveLength(1000);
    });

    test("识别新增资产建议，删除建议必须具有目标与原因", () => {
        const detail = { eventType: "tool_completed", toolName: "drama_propose_changes", runId: "run", callId: "proposal", result: { kind: "cast_create", baseRevision: 3, changes: { kind: "scene", name: "小院" } } };
        expect(dramaProposalFromToolDetail(detail)?.kind).toBe("cast_create");
        const deletion = { ...detail, result: { kind: "cast_delete", targetId: "cast-1", baseRevision: 3, changes: { reason: "重复资产" } } };
        expect(dramaProposalFromToolDetail(deletion)?.kind).toBe("cast_delete");
        expect(dramaProposalFromToolDetail({ ...deletion, result: { ...deletion.result, targetId: undefined } })).toBeNull();
        expect(dramaProposalFromToolDetail({ ...deletion, result: { ...deletion.result, targetId: " " } })).toBeNull();
        expect(dramaProposalFromToolDetail({ ...deletion, result: { ...deletion.result, changes: {} } })).toBeNull();
        expect(dramaProposalFromToolDetail({ ...deletion, result: { ...deletion.result, changes: { reason: " " } } })).toBeNull();
    });

    test("媒体建议绑定真实目标与版本，仅接受首期有限动作", () => {
        const detail = {
            eventType: "tool_completed",
            toolName: "drama_propose_changes",
            runId: "run",
            callId: "video",
            result: { kind: "media", targetId: "segment", baseRevision: 8, changes: { action: "segment_video", episodeId: "episode", targetRevision: 3 } },
        };
        expect(dramaProposalFromToolDetail(detail)?.kind).toBe("media");
        for (const changes of [
            { action: "release_all", targetRevision: 3 },
            { action: "segment_video", targetRevision: 3 },
            { action: "segment_video", episodeId: "episode", targetRevision: -1 },
            { action: "segment_video", episodeId: "episode", targetRevision: 1.5 },
        ]) {
            expect(dramaProposalFromToolDetail({ ...detail, result: { ...detail.result, changes } })).toBeNull();
        }
        expect(dramaProposalFromToolDetail({ ...detail, result: { ...detail.result, targetId: " " } })).toBeNull();
        expect(dramaProposalFromToolDetail({ ...detail, result: { ...detail.result, targetId: "cast", changes: { action: "cast_image", targetRevision: 2 } } })?.kind).toBe("media");
        expect(dramaProposalFromToolDetail({ ...detail, result: { ...detail.result, targetId: "cast", changes: { action: "cast_image", targetRevision: 0 } } })?.changes.targetRevision).toBe(0);
    });
});
