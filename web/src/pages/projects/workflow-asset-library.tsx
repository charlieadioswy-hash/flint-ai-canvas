import { useEffect, useRef, useState } from "react";
import { VenetianMask } from "lucide-react";

import { IconButton } from "@/components/ui/base/buttons";
import { Tooltip } from "@/components/ui/base/tooltip/tooltip";
import type { DramaCast } from "@/services/api/drama";

import { CAST_KIND_LABEL } from "./drama-shared";
import { CastProjectImport } from "./studio/cast-project-import";

type WorkflowAssetLibraryProps = {
    projectId: string;
    episodeId?: string;
    kind: "scene" | "prop";
    cast: DramaCast[];
    busy: boolean;
    onChanged: () => void;
    onDirtyChange: (dirty: boolean, busy: boolean) => void;
};

export function WorkflowAssetLibrary(props: WorkflowAssetLibraryProps) {
    return <WorkflowAssetLibrarySession key={JSON.stringify([props.projectId, props.episodeId, props.kind])} {...props} />;
}

function WorkflowAssetLibrarySession({ projectId, episodeId, kind, cast, busy, onChanged, onDirtyChange }: WorkflowAssetLibraryProps) {
    const [open, setOpen] = useState(false);
    const latest = useRef(onDirtyChange);
    latest.current = onDirtyChange;
    useEffect(() => {
        if (!open) latest.current(false, false);
    }, [open]);
    useEffect(() => () => latest.current(false, false), []);
    const label = CAST_KIND_LABEL[kind];
    return (
        <>
            <Tooltip title={`${label}库`}>
                <IconButton size="sm" icon={VenetianMask} aria-label={`从${label}库导入`} disabled={busy} onClick={() => setOpen(true)} />
            </Tooltip>
            {open ? <CastProjectImport projectId={projectId} episodeId={episodeId} kind={kind} currentCast={cast} disabled={busy} onClose={() => setOpen(false)} onImported={onChanged} onStateChange={onDirtyChange} /> : null}
        </>
    );
}
