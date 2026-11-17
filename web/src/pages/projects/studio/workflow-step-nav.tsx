import { useState } from "react";
import { Dropdown } from "antd";
import { ChevronDown, ChevronRight } from "lucide-react";

import type { WorkflowStep } from "../workflow-state";

type Step = { key: WorkflowStep; title: string; disabled: boolean };

export function WorkflowStepNav({ active, steps, onSelect }: { active: WorkflowStep; steps: readonly Step[]; onSelect: (step: WorkflowStep) => void }) {
    const [menuOpen, setMenuOpen] = useState(false);
    const activeIndex = steps.findIndex((step) => step.key === active);
    const title = steps[activeIndex]?.title || "制作步骤";

    return (
        <>
            <nav className="drama-workflow-steps" aria-label="短剧制作步骤">
                {steps.map((step, index) => (
                    <div key={step.key} className="drama-workflow-step-item">
                        {index ? <ChevronRight aria-hidden="true" /> : null}
                        <button type="button" aria-current={active === step.key ? "step" : undefined} data-passed={index < activeIndex || undefined} disabled={step.disabled} onClick={() => onSelect(step.key)}>
                            {step.title}
                        </button>
                    </div>
                ))}
            </nav>
            <Dropdown
                trigger={["click"]}
                placement="bottomLeft"
                autoFocus
                open={menuOpen}
                onOpenChange={setMenuOpen}
                menu={{
                    selectedKeys: [active],
                    items: steps.map((step) => ({
                        key: step.key,
                        label: <span aria-current={step.key === active ? "step" : undefined}>{step.title}</span>,
                        disabled: step.disabled,
                        onClick: () => {
                            setMenuOpen(false);
                            onSelect(step.key);
                        },
                    })),
                }}
            >
                <button type="button" className="drama-workflow-step-picker" aria-label={`当前步骤：${title}，切换制作步骤`} aria-haspopup="menu" aria-expanded={menuOpen}>
                    {title}
                    <ChevronDown aria-hidden="true" />
                </button>
            </Dropdown>
        </>
    );
}
