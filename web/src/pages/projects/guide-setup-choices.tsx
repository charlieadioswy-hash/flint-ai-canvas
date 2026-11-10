import { useId, useRef, useState } from "react";

import { useAgentReplyOptionDrafts } from "@/components/canvas/canvas-agent-reply-options";
import type { DramaAgentProposal } from "@/services/api/agent";

import "./guide-setup-choices.css";

type ChoiceGroup = { key: string; title: string; configuration: boolean; proposals: DramaAgentProposal[] };
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
        const configuration = decisions.some((decision) => decision !== "style");
        const key = JSON.stringify([proposal.runId, proposal.baseRevision, configuration ? "configuration" : "style"]);
        const group = groups.get(key);
        if (group) group.proposals.push(proposal);
        else groups.set(key, { key, title: configuration ? "创作配置" : "视觉风格", configuration, proposals: [proposal] });
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

function completeConfiguration(proposal: DramaAgentProposal) {
    const { aspectRatio, videoResolution, language, episodeSeconds } = proposal.changes;
    return (
        typeof aspectRatio === "string" &&
        Boolean(aspectRatio.trim()) &&
        typeof videoResolution === "string" &&
        typeof language === "string" &&
        Boolean(language.trim()) &&
        typeof episodeSeconds === "number" &&
        Number.isFinite(episodeSeconds) &&
        episodeSeconds > 0
    );
}

function SetupChoiceGroup({ group, busy, isValid, issue, onChoose, onCustom, onRefresh }: Omit<ChoiceProps, "proposals"> & { group: ChoiceGroup }) {
    const [custom, setCustom] = useState("");
    const [editing, setEditing] = useState(false);
    const headingId = useId();
    const representative = group.configuration ? group.proposals.find(completeConfiguration) || group.proposals[0] : group.proposals[0];
    const choices = group.configuration ? [representative] : group.proposals;
    const incomplete = group.configuration && !completeConfiguration(representative);
    const blocked = incomplete || choices.some((proposal) => !isValid(proposal) || Boolean(issue(proposal)));
    return (
        <section className="drama-guide-setup-choices" aria-label={`${group.title}选项`}>
            {group.configuration ? (
                <div className="drama-guide-setup-summary">
                    <p>推荐配置：{choiceLabel(representative)}</p>
                    {representative.explanation?.trim() ? <p>{representative.explanation.trim()}</p> : null}
                </div>
            ) : null}
            <div className="drama-guide-setup-choice-list" role="group" aria-label={`${group.title}选项`}>
                {choices.map((proposal, index) => {
                    const valid = isValid(proposal);
                    const problem = !valid ? "此选项已过期，请重新推荐" : issue(proposal) || (incomplete ? "推荐配置不完整，请重新推荐画幅、清晰度、语言和时长" : "");
                    const label = choiceLabel(proposal);
                    const detail = proposal.explanation?.trim() || (typeof proposal.changes.stylePrompt === "string" ? proposal.changes.stylePrompt : "");
                    const problemId = `${headingId}-problem-${index}`;
                    return (
                        <div className="drama-guide-setup-choice-item" key={`${proposal.runId}:${proposal.toolCallId}`}>
                            <button type="button" className="drama-guide-setup-choice" disabled={busy || !valid || Boolean(problem)} aria-describedby={problem ? problemId : undefined} onClick={() => onChoose(proposal)}>
                                <span className="drama-guide-setup-choice-number" aria-hidden="true">
                                    {index + 1}.
                                </span>
                                <span className="drama-guide-setup-choice-copy">
                                    <strong>{group.configuration ? "采用推荐配置" : label}</strong>
                                    {!group.configuration && detail ? <span>{detail}</span> : null}
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
                {group.configuration ? (
                    <button type="button" className="drama-guide-setup-choice" disabled={busy} aria-expanded={editing} aria-controls={`${headingId}-custom`} onClick={() => setEditing((previous) => !previous)}>
                        <span className="drama-guide-setup-choice-number" aria-hidden="true">
                            2.
                        </span>
                        <span className="drama-guide-setup-choice-copy">
                            <strong>在推荐配置基础上修改</strong>
                        </span>
                    </button>
                ) : null}
            </div>
            {!group.configuration || editing ? (
                <form
                    className="drama-guide-setup-custom"
                    id={`${headingId}-custom`}
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!busy && custom.trim()) onCustom(custom.trim(), representative);
                    }}
                >
                    <label>
                        <span>{group.configuration ? "说明要调整的配置" : "其他，自己填写"}</span>
                        <input
                            aria-label={`自定义${group.title}`}
                            value={custom}
                            disabled={busy}
                            maxLength={1600}
                            placeholder={group.configuration ? "例如：改为横屏和 90 秒，其余保持推荐" : `输入你希望的${group.title}`}
                            onChange={(event) => setCustom(event.target.value)}
                        />
                    </label>
                    <button type="submit" disabled={busy || !custom.trim()}>
                        发送
                    </button>
                </form>
            ) : null}
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

export type GuideStageChoice = { key: string; title: string; detail: string; input?: boolean };

function GuideStageChoiceInput({ choice, index, busy, text, onChange, onChoose }: { choice: GuideStageChoice; index: number; busy: boolean; text: string; onChange: (text: string) => void; onChoose: (choice: GuideStageChoice, text?: string) => void }) {
    const composing = useRef(false);
    const submit = () => {
        if (!busy && !composing.current && text.trim()) onChoose(choice, text.trim());
    };
    return (
        <form
            className="drama-guide-setup-custom drama-guide-stage-input"
            onSubmit={(event) => {
                event.preventDefault();
                submit();
            }}
        >
            <span className="drama-guide-setup-choice-number" aria-hidden="true">
                {index + 1}.
            </span>
            <label>
                <input
                    aria-label={choice.title}
                    placeholder={`${choice.title}，请描述具体要求`}
                    title={`${choice.detail}，回车发送`}
                    value={text}
                    disabled={busy}
                    maxLength={1600}
                    onChange={(event) => onChange(event.target.value)}
                    onCompositionStart={() => (composing.current = true)}
                    onCompositionEnd={() => (composing.current = false)}
                    onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key !== "Enter") return;
                        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) return;
                        event.preventDefault();
                        submit();
                    }}
                />
            </label>
            <button type="submit" disabled={busy || !text.trim()} aria-label={`发送${choice.title}`}>
                发送
            </button>
        </form>
    );
}

/** 将阶段确认放进 Agent 回复，点击后直接推进已有引导状态机。 */
export function GuideStageChoices({
    title,
    choices,
    busy,
    drafts,
    onChoose,
}: {
    title: string;
    choices: GuideStageChoice[];
    busy: boolean;
    drafts?: ReturnType<typeof useAgentReplyOptionDrafts>;
    onChoose: (choice: GuideStageChoice, text?: string) => void;
}) {
    const localDrafts = useAgentReplyOptionDrafts(title);
    const inputDrafts = drafts || localDrafts;
    return (
        <section className="drama-guide-setup-choices" aria-label={title}>
            <div className="drama-guide-setup-choice-list" role="group" aria-label={title}>
                {choices.map((choice, index) =>
                    choice.input ? (
                        <GuideStageChoiceInput key={`${title}:${choice.key}`} choice={choice} index={index} busy={busy} text={inputDrafts.values[choice.key] || ""} onChange={(text) => inputDrafts.onChange(choice.key, text)} onChoose={onChoose} />
                    ) : (
                        <button type="button" className="drama-guide-setup-choice" key={choice.key} disabled={busy} title={choice.detail} onClick={() => onChoose(choice)}>
                            <span className="drama-guide-setup-choice-number" aria-hidden="true">
                                {index + 1}.
                            </span>
                            <span className="drama-guide-setup-choice-copy">
                                <strong>{choice.title}</strong>
                            </span>
                        </button>
                    ),
                )}
            </div>
        </section>
    );
}
