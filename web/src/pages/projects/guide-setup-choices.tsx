import { useId, useState } from "react";

import type { DramaAgentProposal } from "@/services/api/agent";

import "./guide-setup-choices.css";

type ChoiceGroup = { key: string; title: string; proposals: DramaAgentProposal[] };
type ChoiceProps = {
    proposals: DramaAgentProposal[];
    busy: boolean;
    isValid: (proposal: DramaAgentProposal) => boolean;
    issue: (proposal: DramaAgentProposal) => string;
    onChoose: (proposal: DramaAgentProposal) => void;
    onCustom: (text: string, proposal: DramaAgentProposal) => void;
    onRefresh?: (proposal: DramaAgentProposal) => void;
};

const DECISION_FIELDS = {
    styleName: "style",
    stylePrompt: "style",
    aspectRatio: "frame",
    videoResolution: "frame",
    language: "language",
    episodeSeconds: "duration",
} as const;
const DECISION_TITLES: Record<string, string> = { style: "视觉风格", frame: "视频画幅与清晰度", language: "对白语言", duration: "单集时长" };

function decisionFields(proposal: DramaAgentProposal) {
    return Object.entries(DECISION_FIELDS)
        .filter(([field]) => (field === "episodeSeconds" ? typeof proposal.changes[field] === "number" && Number.isFinite(proposal.changes[field]) : typeof proposal.changes[field] === "string"))
        .map(([, decision]) => decision);
}

function choiceGroups(proposals: DramaAgentProposal[]) {
    const groups = new Map<string, ChoiceGroup>();
    for (const proposal of proposals) {
        if (proposal.kind !== "setup") continue;
        const decisions = [...new Set(decisionFields(proposal))].sort();
        if (!decisions.length) continue;
        const key = JSON.stringify([proposal.runId, proposal.baseRevision, decisions]);
        const group = groups.get(key);
        if (group) group.proposals.push(proposal);
        else groups.set(key, { key, title: decisions.length === 1 ? DECISION_TITLES[decisions[0]] : "创作方案", proposals: [proposal] });
    }
    return [...groups.values()];
}

function choiceLabel(proposal: DramaAgentProposal) {
    const changes = proposal.changes;
    const parts = [
        typeof changes.styleName === "string" && changes.styleName.trim() ? changes.styleName : typeof changes.stylePrompt === "string" ? "自定义风格" : "",
        typeof changes.aspectRatio === "string" ? changes.aspectRatio : "",
        typeof changes.videoResolution === "string" ? changes.videoResolution || "模型默认清晰度" : "",
        typeof changes.language === "string" ? changes.language : "",
        typeof changes.episodeSeconds === "number" && Number.isFinite(changes.episodeSeconds) ? `${changes.episodeSeconds} 秒` : "",
    ];
    return parts.filter(Boolean).join(" · ");
}

function SetupChoiceGroup({ group, busy, isValid, issue, onChoose, onCustom, onRefresh }: Omit<ChoiceProps, "proposals"> & { group: ChoiceGroup }) {
    const [custom, setCustom] = useState("");
    const headingId = useId();
    const representative = group.proposals[0];
    const blocked = group.proposals.some((proposal) => !isValid(proposal) || Boolean(issue(proposal)));
    return (
        <section className="drama-guide-setup-choices" aria-labelledby={headingId}>
            <div className="drama-guide-setup-choice-heading">
                <h3 id={headingId}>选择{group.title}</h3>
                <p>点选后直接保存</p>
            </div>
            <div className="drama-guide-setup-choice-list" role="group" aria-label={`${group.title}选项`}>
                {group.proposals.map((proposal, index) => {
                    const valid = isValid(proposal);
                    const problem = valid ? issue(proposal) : "此选项已过期，请重新推荐";
                    const label = choiceLabel(proposal);
                    const detail = proposal.explanation?.trim() || (typeof proposal.changes.stylePrompt === "string" ? proposal.changes.stylePrompt : "");
                    const problemId = `${headingId}-problem-${index}`;
                    return (
                        <div className="drama-guide-setup-choice-item" key={`${proposal.runId}:${proposal.toolCallId}`}>
                            <button type="button" className="drama-guide-setup-choice" disabled={busy || !valid || Boolean(problem)} aria-describedby={problem ? problemId : undefined} onClick={() => onChoose(proposal)}>
                                <span className="drama-guide-setup-choice-number" aria-hidden="true">
                                    {index + 1}
                                </span>
                                <span className="drama-guide-setup-choice-copy">
                                    <strong>{label}</strong>
                                    {detail ? <span>{detail}</span> : null}
                                </span>
                            </button>
                            {problem ? (
                                <p className="drama-guide-setup-choice-problem" id={problemId}>
                                    {problem}
                                </p>
                            ) : null}
                        </div>
                    );
                })}
            </div>
            <form
                className="drama-guide-setup-custom"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (!busy && custom.trim()) onCustom(custom.trim(), representative);
                }}
            >
                <label>
                    <span>其他，自己填写</span>
                    <input aria-label={`自定义${group.title}`} value={custom} disabled={busy} maxLength={1600} placeholder={`输入你希望的${group.title}`} onChange={(event) => setCustom(event.target.value)} />
                </label>
                <button type="submit" disabled={busy || !custom.trim()}>
                    发送
                </button>
            </form>
            {blocked && onRefresh ? (
                <button type="button" className="drama-guide-setup-refresh" disabled={busy} onClick={() => onRefresh(representative)}>
                    重新推荐{group.title}
                </button>
            ) : null}
        </section>
    );
}

export function GuideSetupChoices({ proposals, ...props }: ChoiceProps) {
    return choiceGroups(proposals).map((group) => <SetupChoiceGroup key={group.key} group={group} {...props} />);
}

export type GuideStageChoice = { key: string; title: string; detail: string };

/** 将阶段确认放进 Agent 回复，点击后直接推进已有引导状态机。 */
export function GuideStageChoices({ title, choices, busy, onChoose }: { title: string; choices: GuideStageChoice[]; busy: boolean; onChoose: (choice: GuideStageChoice) => void }) {
    const headingId = useId();
    return (
        <section className="drama-guide-setup-choices" aria-labelledby={headingId}>
            <div className="drama-guide-setup-choice-heading">
                <h3 id={headingId}>{title}</h3>
                <p>选择后继续当前创作流程</p>
            </div>
            <div className="drama-guide-setup-choice-list" role="group" aria-label={title}>
                {choices.map((choice, index) => (
                    <button type="button" className="drama-guide-setup-choice" key={choice.key} disabled={busy} onClick={() => onChoose(choice)}>
                        <span className="drama-guide-setup-choice-number" aria-hidden="true">
                            {index + 1}
                        </span>
                        <span className="drama-guide-setup-choice-copy">
                            <strong>{choice.title}</strong>
                            <span>{choice.detail}</span>
                        </span>
                    </button>
                ))}
            </div>
        </section>
    );
}
