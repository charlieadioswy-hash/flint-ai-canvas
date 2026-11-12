import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "antd";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";
import { useWorkspaceTopBarMount } from "@/components/layout/workspace-top-bar-extension";

export function DramaProjectTopbar({ name, stage, controls, children }: { name: string; stage: string; controls?: ReactNode; children?: ReactNode }) {
    const mount = useWorkspaceTopBarMount();
    const content = (
        <div className={`drama-project-topbar${controls ? " has-controls" : ""}`}>
            <Link to="/projects">
                <Button type="text" icon={<ArrowLeft className="size-4" />} aria-label="返回短剧列表" />
            </Link>
            <h1 title={name}>{name}</h1>
            <span className="drama-project-mode">{stage}</span>
            {controls ? <div className="drama-project-topbar-controls">{controls}</div> : null}
            <div className="drama-project-topbar-actions">{children}</div>
        </div>
    );
    return mount ? createPortal(content, mount) : mount === undefined ? content : null;
}
