import { expect, test } from "bun:test";
import { hasExplicitDramaStageTransition, prepareDramaProposalMessage, prepareDramaSetupMessage, prepareDramaStageMessage } from "@/lib/canvas/drama-setup-presentation";
import type { DramaAgentProposal } from "@/services/api/agent";

const proposal = (changes: Record<string, unknown>, toolCallId = "call"): DramaAgentProposal => ({ kind: "setup", changes, baseRevision: 4, runId: "run", toolCallId });
const languages = ["中文普通话", "中文普通话（北方口语，少量方言语气词）", "粤语", "英语"];
const languageChoices = () => languages.map((language, index) => proposal({ language }, `language-${index}`));

test("阶段确认编号选项原位转为可点击内容，保留前后正文及模型文案", () => {
    const result = prepareDramaStageMessage("四项配置现已齐全，是否按当前配置推进？\n\n1. 确认，进入下一阶段\n2. 继续调整（可说明想改哪一项）\n\n图片可以到制作台再生成。");
    expect(result).toEqual({ body: "四项配置现已齐全，是否按当前配置推进？", after: "图片可以到制作台再生成。", labels: { confirm: "确认，进入下一阶段", adjust: "继续调整（可说明想改哪一项）" } });
});

test("阶段选项按语义绑定确认与调整，兼容加粗编号和反序文案", () => {
    expect(prepareDramaStageMessage("请选择：\n**1. 继续调整**\n\n**2. 确认资产，开始改编剧本与分镜**")).toEqual({ body: "请选择：", after: "", labels: { confirm: "确认资产，开始改编剧本与分镜", adjust: "继续调整" } });
});

test.each(["确认这版对白", "确认角色设定", "同意这一版镜头台词", "确认第 3 镜头对白，继续推进改写", "确认并继续", "确认，继续推进"])("普通创意确认不作为阶段推进：%s", (label) => {
    const text = `请选择对白处理方式：\n\n1. ${label}\n2. 修改第 3 镜头的台词`;
    expect(hasExplicitDramaStageTransition(text)).toBe(false);
});

test.each(["确认配置，开始提取资产", "确认资产，开始改编剧本与分镜", "确认剧本与分镜，进入制作台", "确认，进入改编与分镜阶段", "进入下一阶段"])("明确阶段推进仍识别为阶段选项：%s", (label) => {
    const text = `请选择下一步：\n\n1. ${label}\n2. 继续调整`;
    const result = prepareDramaStageMessage(text);
    expect(result.labels).toEqual({ confirm: label, adjust: "继续调整" });
    expect(hasExplicitDramaStageTransition(text)).toBe(true);
});

test("整套配置仅保留一组采用与修改操作，不影响真实建议数据", () => {
    const proposals = [proposal({ aspectRatio: "9:16", videoResolution: "720p", language: "中文", episodeSeconds: 60 })];
    const result = prepareDramaSetupMessage("配置已整理好，请选择：\n1. 采用推荐配置\n2. 在推荐配置基础上修改\n\n风格保持不变。", proposals);
    expect(result.body).toBe("配置已整理好，请选择：\n\n风格保持不变。");
    expect(result.proposals).toBe(proposals);
    const incomplete = [proposal({ language: "中文" })];
    expect(prepareDramaSetupMessage("1. 采用推荐配置\n2. 在推荐配置基础上修改", incomplete).body).toContain("1. 采用推荐配置");
});

test.each(["执行步骤：\n1. 阅读正文\n2. 确认人设", "请选择：\n1. 确认\n2. 继续调整\n3. 删除全部", "```markdown\n1. 确认\n2. 继续调整\n```", "> 1. 确认\n> 2. 继续调整", "1. 暂不确认\n2. 继续调整", "1. 确认角色资料\n2. 确认场景资料"])(
    "无明确两种阶段决策时保持原文：%s",
    (text) => {
        expect(prepareDramaStageMessage(text)).toEqual({ body: text, after: "" });
    },
);

test("语言编号列表合并到选项说明，保留前后正文及多行说明", () => {
    const text = [
        "请选择对白语言。",
        "",
        "1. **中文普通话** —— 标准配音，适合平台分发。",
        "2. **中文普通话（北方口语，少量方言语气词）** —— 保留市井语感。",
        "   兄弟与邻居冲突更接地气。",
        "3. **粤语** —— 主打粤语区时可选。",
        "4. **英语** —— 面向海外发行。",
        "",
        "保存后再确认单集时长，图片和视频不会自动生成。",
    ].join("\n");
    const proposals = languageChoices();
    proposals[2].explanation = "工具已提供的准确说明";
    const original = structuredClone(proposals);
    const result = prepareDramaSetupMessage(text, proposals);
    expect(result.body).toBe("请选择对白语言。\n\n保存后再确认单集时长，图片和视频不会自动生成。");
    expect(result.proposals.map((item) => item.explanation)).toEqual(["标准配音，适合平台分发。", "保留市井语感。\n兄弟与邻居冲突更接地气。", "工具已提供的准确说明", "面向海外发行。"]);
    expect(result.proposals.map((item) => item.toolCallId)).toEqual(proposals.map((item) => item.toolCallId));
    expect(result.proposals[2]).toBe(proposals[2]);
    expect(proposals).toEqual(original);
});

test("按真实标签映射反序选项，不依赖编号与工具调用顺序", () => {
    const proposals = [proposal({ language: "英语" }, "english"), proposal({ language: "粤语" }, "cantonese")];
    const result = prepareDramaSetupMessage("8. **粤语**：本地表达。\n3. **英语**：海外发行——需要翻译。", proposals);
    expect(result.body).toBe("");
    expect(result.proposals.map((item) => [item.toolCallId, item.explanation])).toEqual([
        ["english", "海外发行——需要翻译。"],
        ["cantonese", "本地表达。"],
    ]);
});

test.each([
    {
        changes: [
            { styleName: "写实电影", stylePrompt: "具体布光与材质" },
            { styleName: "国风动画", stylePrompt: "具体线条与色彩" },
        ],
        labels: ["写实电影", "国风动画"],
    },
    { changes: [{ aspectRatio: "9:16" }, { aspectRatio: "16:9" }], labels: ["9:16 竖屏", "16:9（横屏）"] },
    { changes: [{ videoResolution: "720p" }, { videoResolution: "1080p" }], labels: ["720P", "1080p"] },
    { changes: [{ episodeSeconds: 60 }, { episodeSeconds: 90 }], labels: ["60 秒", "单集 90 秒"] },
    {
        changes: [
            { aspectRatio: "9:16", videoResolution: "720p" },
            { aspectRatio: "16:9", videoResolution: "1080p" },
        ],
        labels: ["9:16 竖屏 · 720p", "16:9 · 1080p"],
    },
])("仅在各配置字段全部匹配时合并：%j", ({ changes, labels }) => {
    const proposals = changes.map((value, index) => proposal(value, String(index)));
    const text = labels.map((label, index) => `${index + 1}. **${label}** —— 方案说明${index + 1}`).join("\n");
    const result = prepareDramaSetupMessage(text, proposals);
    expect(result.body).toBe("");
    expect(result.proposals.map((item) => item.explanation)).toEqual(["方案说明1", "方案说明2"]);
});

test("推荐标记不与实际配置值混淆，空说明不伪造内容", () => {
    const result = prepareDramaSetupMessage("1. **粤语（推荐）**：地方语感。\n2. **英语**", [proposal({ language: "粤语" }), proposal({ language: "英语" })]);
    expect(result.body).toBe("");
    expect(result.proposals.map((item) => item.explanation)).toEqual(["地方语感。", undefined]);
});

test("前置无关编号列表、后置段落与说明内破折号保持完整", () => {
    const text = "创作流程：\n1. 阅读文档\n2. 确认人设\n\n请选择语言：\n\n1. 粤语 —— 本地观众——保留原句。\n说明也可以软换行。\n2. 英语 —— 海外发行。\n\n后续仍需确认分镜。";
    const result = prepareDramaSetupMessage(text, [proposal({ language: "粤语" }), proposal({ language: "英语" })]);
    expect(result.body).toBe("创作流程：\n1. 阅读文档\n2. 确认人设\n\n请选择语言：\n\n后续仍需确认分镜。");
    expect(result.proposals[0].explanation).toBe("本地观众——保留原句。\n说明也可以软换行。");
});

test.each([
    { text: "1. 粤语 —— 适合本地。\n2. 法语 —— 不存在的选项。", proposals: [proposal({ language: "粤语" }), proposal({ language: "英语" })] },
    { text: "1. 粤语\n2. 英语\n3. 法语", proposals: [proposal({ language: "粤语" }), proposal({ language: "英语" })] },
    { text: "1. 粤语\n2. 英语", proposals: [proposal({ language: "粤语" }), proposal({ language: "粤语" })] },
    { text: "1. 中文普通话\n2. 中文普通话", proposals: [proposal({ language: "中文普通话" }), proposal({ language: "中文普通话（北方口语）" })] },
    { text: "1. 国风动画\n2. 写实电影", proposals: [proposal({ stylePrompt: "国风动画" }), proposal({ stylePrompt: "写实电影" })] },
    { text: "1. 9:16\n2. 16:9", proposals: [proposal({ aspectRatio: "9:16", videoResolution: "720p" }), proposal({ aspectRatio: "16:9", videoResolution: "1080p" })] },
    { text: "1. 粤语\n2. 英语", proposals: [proposal({ language: "粤语" }), { ...proposal({ language: "英语" }), kind: "cast" as const }] },
    { text: "1. 粤语\n2. 英语", proposals: [] },
])("无法逐项唯一核验的文本保持原样：%j", ({ text, proposals }) => {
    const result = prepareDramaSetupMessage(text, proposals);
    expect(result.body).toBe(text);
    expect(result.proposals).toBe(proposals);
});

test.each(["```markdown\n1. 粤语\n2. 英语\n```", "````markdown\n```示例\n1. 粤语\n2. 英语\n````", "~~~markdown\n1. 粤语\n2. 英语\n~~~"])("代码块中的编号示例保留：%s", (text) => {
    expect(prepareDramaSetupMessage(text, [proposal({ language: "粤语" }), proposal({ language: "英语" })]).body).toBe(text);
});

test("非配置建议移除重复的编号候选，保留前后引导", () => {
    const proposals: DramaAgentProposal[] = [
        { kind: "cast", targetId: "cast-1", baseRevision: 4, runId: "run", toolCallId: "appearance-1", changes: { appearance: "保留现有外观" } },
        { kind: "cast", targetId: "cast-1", baseRevision: 4, runId: "run", toolCallId: "appearance-2", changes: { appearance: "改为冷色调服装" } },
    ];
    const text = ["我整理了两种角色外观调整方案：", "", "1. **保留现有外观**：维持当前设定。", "2. **改为冷色调服装**：强化夜戏氛围。", "", "请选择后我再继续处理。"].join("\n");
    const result = prepareDramaProposalMessage(text, proposals);
    expect(result.body).toBe("我整理了两种角色外观调整方案：\n\n请选择后我再继续处理。");
    expect(result.proposals).toBe(proposals);
});

test("非候选编号内容不满足识别条件时保持原文", () => {
    const proposals: DramaAgentProposal[] = [
        { kind: "cast", targetId: "cast-1", baseRevision: 4, runId: "run", toolCallId: "one", changes: { appearance: "红衣" } },
        { kind: "cast", targetId: "cast-1", baseRevision: 4, runId: "run", toolCallId: "two", changes: { appearance: "黑衣" } },
    ];
    const text = "执行步骤：\n1. 读取角色资料\n2. 检查现有引用";
    expect(prepareDramaProposalMessage(text, proposals).body).toBe(text);
});
