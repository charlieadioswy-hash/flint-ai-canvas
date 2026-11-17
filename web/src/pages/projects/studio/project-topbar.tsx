import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";
import { useWorkspaceTopBarMount } from "@/components/layout/workspace-top-bar-extension";

export function DramaProjectTopbar({ name, stage, controls, inlineControls = false, children }: { name: string; stage: string; controls?: ReactNode; inlineControls?: boolean; children?: ReactNode }) {
    const mount = useWorkspaceTopBarMount();
    const navigation = controls ? <div className="drama-project-topbar-controls">{controls}</div> : null;
    const identity = (
        <div className="drama-project-topbar-identity">
            <Link to="/projects" className="drama-project-back" aria-label="返回短剧列表">
                <ArrowLeft aria-hidden="true" />
            </Link>
            <h1 title={name}>{name}</h1>
        </div>
    );
    const actions = (
        <div className="drama-project-topbar-actions">
            <span className="drama-project-mode">{stage}</span>
            {children}
        </div>
    );
    const content = (
        <div className={`drama-project-topbar${controls && inlineControls ? " has-inline-controls" : ""}`}>
            {inlineControls ? (
                <div className="drama-project-topbar-main">
                    {identity}
                    {navigation}
                    {actions}
                </div>
            ) : (
                <>
                    <div className="drama-project-topbar-main">
                        {identity}
                        {actions}
                    </div>
                    {navigation}
                </>
            )}
        </div>
    );
    return mount ? createPortal(content, mount) : mount === undefined ? content : null;
}
