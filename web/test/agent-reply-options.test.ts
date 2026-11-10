import { expect, test } from "bun:test";
import { agentReplyOptionNeedsInput, extractAgentReplyOptions } from "@/lib/canvas/agent-reply-options";

test.each([
    "其他问题（请直接描述）",
    "其他",
    "其它想法",
    "自定义",
    "自定义风格",
    "指定集数（请输入）",
    "指定集数",
    "自填内容",
    "补充要求（请填写）",
    "指定集数（请说明）",
    "请提供你的要求",
    "请描述您的想法",
    "直接描述你的要求",
    "请说明你想调整的内容",
    "自己输入想法",
    "自行描述调整要求",
    "Other (please specify)",
    "Custom",
    "Please describe your requirements",
    "Please enter an episode number",
])("明确要求填写的选项识别为输入：%s", (text) => {
    expect(agentReplyOptionNeedsInput(text)).toBe(true);
});

test.each([
    "分析输入图片",
    "检查输入法",
    "输入法设置",
    "说明原因",
    "请说明",
    "请说明分镜审核后的流程",
    "请描述第九集的剧情",
    "请提供一套推荐配置",
    "推荐其他风格",
    "管理自定义风格",
    "查看其他角色",
    "Generate another scene",
    "Analyze input image",
    "Other users",
    "Custom model management",
    "Please describe episode nine",
    "Please provide a recommended configuration",
])("普通动作保持可点击选项：%s", (text) => {
    expect(agentReplyOptionNeedsInput(text)).toBe(false);
});

test("给 Agent 的请求保持直接点选，明确自填的选项才显示输入", () => {
    const result = extractAgentReplyOptions("你想先了解哪一项？\n1. 请说明分镜审核后的流程\n2. 请提供一套推荐配置\n3. 请描述第九集的剧情\n4. 其他问题（请直接描述）");
    expect(result?.options.map((option) => Boolean(option.input))).toEqual([false, false, false, true]);
});

test("编号回复保留普通选项身份，仅给明确输入项附加填写标记", () => {
    const result = extractAgentReplyOptions("你想先做哪一项？\n\n1. 查看角色\n2. 查看场景\n3. 调整分镜\n4. **其他问题**：请直接描述");
    expect(result?.options).toHaveLength(4);
    expect(result?.options[0]).toEqual({ marker: "1", title: "查看角色", text: "查看角色" });
    expect(result?.options[3]).toEqual({ marker: "4", title: "其他问题", detail: "请直接描述", text: "其他问题：请直接描述", input: true });
});

test("同一行的填写选项与普通选择使用同一合同，非选择列表不变", () => {
    const result = extractAgentReplyOptions("请选择：1. 分析输入图片；2. 指定集数（请输入）");
    expect(result?.options.map((option) => Boolean(option.input))).toEqual([false, true]);
    expect(extractAgentReplyOptions("已经完成如下工作：\n1. 查看角色\n2. 其他问题（请描述）")).toBeNull();
});
