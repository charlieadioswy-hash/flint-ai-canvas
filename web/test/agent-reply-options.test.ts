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

const productionGuideLead = "请稍等片刻再让我刷新一次；等角色和场景设定落库后，我会把每个资产的名称和设定摘要列出来，供你逐项确认或调整。";
const productionGuideActions = ["刷新资产提取进度", "先调整第一集正文（说明要改哪一处）", "稍后再说，本次不继续"];
const productionGuideReply = `${productionGuideLead}\n\n${productionGuideActions.map((text, index) => `${index + 1}. ${text}`).join("\n")}`;

test("短剧原回复省略选择引语时仍提取明确行动，默认画布规则保持严格", () => {
    expect(extractAgentReplyOptions(productionGuideReply)).toBeNull();
    expect(extractAgentReplyOptions(productionGuideReply, { allowImplicitActions: false })).toBeNull();
    const result = extractAgentReplyOptions(productionGuideReply, { allowImplicitActions: true });
    expect(result?.body).toBe(productionGuideLead);
    expect(result?.options.map((option) => option.text)).toEqual(productionGuideActions);
    expect(result?.options.every((option) => !option.input)).toBe(true);
});

test("省略引语的行动列表须有自填或退让出口，自填身份保持不变", () => {
    expect(extractAgentReplyOptions("1. 查看角色\n2. 检查场景", { allowImplicitActions: true })).toBeNull();
    const result = extractAgentReplyOptions("1. 查看角色\n2. 检查场景\n3. 其他要求（请填写）", { allowImplicitActions: true });
    expect(result?.body).toBe("");
    expect(result?.options.map((option) => Boolean(option.input))).toEqual([false, false, true]);
});

test.each([
    "当前事实：\n1. 角色共有三人\n2. 稍后再说，本次不继续",
    "当前进度：\n1. 生成角色说明\n2. 暂不生成图片",
    "任务状态：\n1. 生成角色说明\n2. 暂不生成图片",
    "执行步骤：\n1. 查看角色\n2. 生成参考图\n3. 暂不生成视频",
    "制作流程\n1. 提取角色\n2. 生成分镜\n3. 暂不生成视频",
    "执行计划\n1. 查看角色\n2. 生成参考图\n3. 暂不生成视频",
    "按顺序执行\n1. 查看角色\n2. 生成参考图\n3. 暂不生成视频",
    "已经完成如下工作：\n1. 查看角色\n2. 其他问题（请填写）",
    "本轮操作记录：\n1. 刷新资产提取进度\n2. 暂不生成图片",
    "1. 刷新资产提取进度已完成\n2. 暂不生成图片",
    "1. 生成角色参考图失败\n2. 稍后再说",
    "1. 生成角色参考图失败，请稍后\n2. 暂不生成图片",
    "1. 生成角色参考图正在排队\n2. 稍后再说",
    "1. 生成角色参考图 50%\n2. 稍后再说",
    "```markdown\n1. 查看角色\n2. 稍后再说\n```",
    "> 1. 查看角色\n> 2. 稍后再说",
    "    1. 查看角色\n    2. 稍后再说",
    "1. 查看角色\n   - 核对姓名\n2. 稍后再说",
    "1. 查看角色\n3. 稍后再说",
    "1. 查看角色\n2. 稍后再说\n\n这里只是额外说明，并非选择提问。",
    `1. 查看${"角色".repeat(50)}\n2. 稍后再说`,
])("短剧隐式行动模式仍保留事实、流程、记录及不符合列表约束的原文：%s", (text) => {
    expect(extractAgentReplyOptions(text, { allowImplicitActions: true })).toBeNull();
});

const screenshotActions = ["重写第 2 段提示词，修正首帧空间错误", "重写第 1 段提示词，统一夜戏光照", "为「小区外围围墙边」生成外景概念图", "保持现状，继续分析第 2 集的衔接", "其他要求（请填写）"];
const actionChoices = (actions = screenshotActions) => `需要我做什么？\n\n${actions.map((action, index) => `${index + 1}. ${action}`).join("\n")}`;
const screenshotRecommendations = ["### 建议的修正优先级", "", "1. 修正第 2 段首帧的空间错误（客厅 vs 卧室、窗帘误植）", "   ——观感影响最大", "2. 统一第 1 段第 3 镜的夜戏光照（阳光→月光）", "3. 为第 4 段补外景参考图，稳定居民楼+双日远景"].join("\n");

test("逐项合并截图中能核对的重复行动，保留说明与目标不明确的建议", () => {
    const analysis = "首帧存在空间错误，夜景光照也不一致。";
    const explanation = "参考图会影响人物与场景的一致性，生成前仍需确认。";
    const result = extractAgentReplyOptions([analysis, screenshotRecommendations, explanation, actionChoices()].join("\n\n"));
    expect(result?.body).toBe(`${analysis}\n\n### 建议的修正优先级\n\n3. 为第 4 段补外景参考图，稳定居民楼+双日远景\n\n${explanation}\n\n需要我做什么？`);
    expect(result?.options.map((option) => option.text)).toEqual(screenshotActions);
    expect(result?.options[0].notes).toContain("客厅 vs 卧室、窗帘误植");
    expect(result?.options[0].notes).toContain("观感影响最大");
    expect(result?.options[1].notes).toContain("第 3 镜");
    expect(result?.options[1].notes).toContain("阳光→月光");
    expect(result?.options.at(-1)?.input).toBe(true);
});

test.each(["**下一步建议：**", "可选操作", "推荐的处理方案"])("候选行动标题下的编号建议只展示一次：%s", (heading) => {
    const result = extractAgentReplyOptions(`${heading}\n1. 查看角色\n2. 检查场景\n\n${actionChoices(["查看角色", "检查场景", "其他（请填写）"])}`);
    expect(result?.body).toBe("需要我做什么？");
    expect(result?.options).toHaveLength(3);
});

test.each(["发现的问题", "原因分析", "已完成的调整", "操作步骤", "推荐的配置"])("非选项列表仍保留：%s", (heading) => {
    const body = `### ${heading}\n\n1. 统一第 1 段光照\n2. 修正第 2 段场景`;
    expect(extractAgentReplyOptions(`${body}\n\n${actionChoices()}`)?.body).toBe(`${body}\n\n需要我做什么？`);
});

test("候选标题下的事实与配置列表保留，不因出现按钮而隐藏", () => {
    const body = "下一步建议\n1. 第 1 段使用 9:16 画幅\n2. 第 2 段仍有 3 个镜头";
    expect(extractAgentReplyOptions(`${body}\n\n${actionChoices()}`)?.body).toBe(`${body}\n\n需要我做什么？`);
});

test("列表后没有空行的普通说明保留", () => {
    const result = extractAgentReplyOptions(`下一步建议\n1. 查看角色\n2. 检查场景\n这两项均不触发生成，不会扣除积分。\n\n${actionChoices(["查看角色", "检查场景"])}`);
    expect(result?.body).toBe("这两项均不触发生成，不会扣除积分。\n\n需要我做什么？");
});

test.each([
    "```markdown\n下一步建议\n1. 查看角色\n2. 检查场景\n```",
    "````markdown\n```示例\n下一步建议\n1. 查看角色\n2. 检查场景\n````",
    "> 下一步建议\n> 1. 查看角色\n> 2. 检查场景",
    "    下一步建议\n    1. 查看角色\n    2. 检查场景",
    "下一步建议\n1. 查看角色\n   - 保留角色原文\n2. 检查场景",
    "下一步建议\n1. 重写对白\n   1. 保留角色原词\n1. 统一光照",
])("代码、引用和嵌套内容不作为重复行动删除：%s", (body) => {
    expect(extractAgentReplyOptions(`${body}\n\n${actionChoices()}`)?.body).toBe(`${body}\n\n需要我做什么？`);
});

test("没有成功提取可点击选项时不清理建议正文", () => {
    expect(extractAgentReplyOptions(`${screenshotRecommendations}\n\n当前尚无可执行选项。`)).toBeNull();
});

test("更早独立章节中的建议不因后续主题的选项而移除", () => {
    const body = "### 下一步建议\n1. 修改角色姓名\n2. 调整角色年龄\n\n## 分镜分析\n夜戏需要统一光照。";
    expect(extractAgentReplyOptions(`${body}\n\n${actionChoices()}`)?.body).toBe(`${body}\n\n需要我做什么？`);
});

test("移除多段候选行动不改变其间的正文", () => {
    const body = "下一步建议\n1. 查看角色\n2. 检查场景\n\n保留这一段说明。\n\n可选操作\n1. 修改提示词\n2. 生成参考图";
    expect(extractAgentReplyOptions(`${body}\n\n${actionChoices(["查看角色", "检查场景", "修改提示词", "生成参考图"])}`)?.body).toBe("保留这一段说明。\n\n需要我做什么？");
});

test("按钮主题不同时保留前文建议，不能按数量或顺序删除", () => {
    const body = "### 下一步建议\n1. 生成角色参考图\n2. 调整角色年龄";
    expect(extractAgentReplyOptions(`${body}\n\n${actionChoices(["查看当前任务状态", "下载已完成视频"])}`)?.body).toBe(`${body}\n\n需要我做什么？`);
});

test("重复候选包含自定义输入时，同样逐项去重且保留输入身份", () => {
    const actions = ["查看角色", "检查场景", "其他要求（请填写）"];
    const body = `### 下一步建议\n${actions.map((action, index) => `${index + 1}. ${action}`).join("\n")}`;
    const result = extractAgentReplyOptions(`${body}\n\n${actionChoices(actions)}`);
    expect(result?.body).toBe("需要我做什么？");
    expect(result?.options.map((option) => Boolean(option.input))).toEqual([false, false, true]);
});

test("按内容匹配反序选项，缩进说明只保留到对应选项且不改变回复内容", () => {
    const body = "### 下一步建议\n1. 修改第1段提示词\n   保留原对白，只调整光照。\n2. 生成第2段视频\n   注意：本段将按当前无参考图状态生成。";
    const actions = ["生成第2段视频", "修改第1段提示词"];
    const result = extractAgentReplyOptions(`${body}\n\n${actionChoices(actions)}`);
    expect(result?.body).toBe("需要我做什么？");
    expect(result?.options.map((option) => option.text)).toEqual(actions);
    expect(result?.options.map((option) => option.notes)).toEqual(["注意：本段将按当前无参考图状态生成。", "保留原对白，只调整光照。"]);
});

test.each([
    { source: "修正第2段首帧空间错误", target: "重写第3段提示词，修正首帧空间错误" },
    { source: "统一第1段第3镜夜戏光照", target: "重写第1段第4镜提示词，统一夜戏光照" },
    { source: "生成参考图：第1段", target: "生成参考图：第2段" },
    { source: "生成参考图：秦子文", target: "生成参考图：秦子武" },
    { source: "生成参考图（秦子文）", target: "生成参考图（秦子武）" },
    { source: "生成参考图（秦子文）", target: "生成参考图" },
    { source: "修改第1段提示词（不要改对白）", target: "修改第1段提示词（修改对白）" },
    { source: "修改第1段提示词（不要改对白）", target: "**修改第1段提示词**（修改对白）" },
    { source: "不修改第1段对白", target: "修改第1段对白" },
    { source: "从第1段复制到第2段", target: "从第2段复制到第1段" },
    { source: "修改画幅为9:16", target: "修改画幅为916" },
])("编号、对象或动作冲突时保留建议：%j", ({ source, target }) => {
    const body = `### 下一步建议\n1. ${source}\n2. 查看角色`;
    const result = extractAgentReplyOptions(`${body}\n\n${actionChoices([target, "查看角色"])}`);
    expect(result?.body).toContain(source);
    expect(result?.body).not.toContain("2. 查看角色");
});

test("同类候选无法唯一对应时不合并说明", () => {
    const body = "### 下一步建议\n1. 修改第1段提示词：保留对白\n2. 查看角色";
    const result = extractAgentReplyOptions(`${body}\n\n${actionChoices(["修改第1段提示词，统一光照", "修改第1段提示词，修正构图", "查看角色"])}`);
    expect(result?.body).toContain("修改第1段提示词：保留对白");
    expect(result?.options.slice(0, 2).every((option) => !option.notes)).toBe(true);
});
