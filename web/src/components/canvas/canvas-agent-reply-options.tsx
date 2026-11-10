import { ArrowRight } from "lucide-react";
import { useRef, useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";

import { agentReplyOptionNeedsInput, type AgentReplyOption } from "@/lib/canvas/agent-reply-options";

export function useAgentReplyOptionDrafts(scopeKey: string) {
    const [state, setState] = useState<{ scopeKey: string; values: Record<string, string> }>({ scopeKey, values: {} });
    return {
        values: state.scopeKey === scopeKey ? state.values : {},
        onChange: (key: string, value: string) => setState((previous) => ({ scopeKey, values: { ...(previous.scopeKey === scopeKey ? previous.values : {}), [key]: value } })),
    };
}

type AgentReplyOptionCardsProps = {
    options: readonly AgentReplyOption[];
    onSelect: (option: AgentReplyOption) => void;
    disabled?: boolean;
    /** 选项组的可读名称，读屏时作为分组标题。 */
    label?: string;
    scopeKey?: string;
    /** 放在消息或提问组件中，发送期间暂时隐藏选项也不会丢掉失败后的填写内容。 */
    drafts?: ReturnType<typeof useAgentReplyOptionDrafts>;
};

// 选项可能出现在可拖拽的面板里，按下时不要把事件交给面板或画布的拖拽逻辑。
const stop = (event: SyntheticEvent) => event.stopPropagation();

function ReplyOptionInput({ option, value, disabled, onChange, onSelect }: { option: AgentReplyOption; value: string; disabled: boolean; onChange: (value: string) => void; onSelect: (option: AgentReplyOption) => void }) {
    const composing = useRef(false);
    const submit = () => {
        if (!disabled && !composing.current && value.trim()) onSelect({ ...option, text: value.trim() });
    };
    return (
        <form
            className="agent-reply-option agent-reply-option-input"
            data-disabled={disabled || undefined}
            onMouseDown={stop}
            onPointerDown={stop}
            onSubmit={(event) => {
                event.preventDefault();
                stop(event);
                submit();
            }}
        >
            <span className="agent-reply-option-marker" aria-hidden="true">
                {option.marker}
            </span>
            <label className="agent-reply-option-copy">
                <input
                    className="agent-question-input"
                    aria-label={option.title}
                    placeholder={option.text}
                    title={`${option.text}，回车发送`}
                    value={value}
                    disabled={disabled}
                    maxLength={8000}
                    onChange={(event) => onChange(event.target.value)}
                    onCompositionStart={() => (composing.current = true)}
                    onCompositionEnd={() => (composing.current = false)}
                    onKeyDown={(event) => {
                        stop(event);
                        if (event.key !== "Enter") return;
                        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) return;
                        event.preventDefault();
                        submit();
                    }}
                />
            </label>
            <button type="submit" className="agent-reply-option-send" disabled={disabled || !value.trim()} aria-label={`发送${option.title}`}>
                <ArrowRight className="agent-reply-option-arrow" aria-hidden="true" />
            </button>
        </form>
    );
}

/** 编号回复和 ask_user 共用：普通选项点击回复，输入型选项提交填写内容。 */
export function AgentReplyOptionCards({ options, onSelect, disabled = false, label, scopeKey = "", drafts }: AgentReplyOptionCardsProps) {
    const { t } = useTranslation();
    const localDrafts = useAgentReplyOptionDrafts(scopeKey);
    const currentDrafts = drafts || localDrafts;
    return (
        <div className="agent-reply-options" role="group" aria-label={label ?? t("canvasA.replyOptions.label")}>
            {options.map((option) =>
                option.input || [option.title, option.detail, option.text].some((text) => text && agentReplyOptionNeedsInput(text)) ? (
                    <ReplyOptionInput
                        key={`${scopeKey}:${option.marker}:${option.text}`}
                        option={option}
                        value={currentDrafts.values[`${option.marker}:${option.text}`] || ""}
                        disabled={disabled}
                        onChange={(value) => currentDrafts.onChange(`${option.marker}:${option.text}`, value)}
                        onSelect={onSelect}
                    />
                ) : (
                    <button
                        key={`${scopeKey}:${option.marker}:${option.text}`}
                        type="button"
                        className="agent-reply-option"
                        disabled={disabled}
                        title={option.text}
                        onMouseDown={stop}
                        onPointerDown={stop}
                        onClick={(event) => {
                            stop(event);
                            onSelect(option);
                        }}
                    >
                        <span className="agent-reply-option-marker" aria-hidden="true">
                            {option.marker}
                        </span>
                        <span className="agent-reply-option-copy">
                            <span className="agent-reply-option-title">{option.title}</span>
                            {option.detail ? <span className="agent-reply-option-detail">{option.detail}</span> : null}
                        </span>
                        <ArrowRight className="agent-reply-option-arrow" aria-hidden="true" />
                    </button>
                ),
            )}
        </div>
    );
}
