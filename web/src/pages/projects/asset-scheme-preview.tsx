import { Ban, PenLine } from "lucide-react";

import type { DramaAssetMode } from "@/services/api/drama";

const TEMPLATE_PREVIEWS: Record<Exclude<DramaAssetMode, "none" | "custom">, string> = {
    closeup_turnaround: "/character-template-previews/closeup_turnaround.jpg",
    closeup_front_no_face: "/character-template-previews/closeup_front_no_face.jpg",
    closeup_turnaround_no_head: "/character-template-previews/closeup_turnaround_no_head.jpg",
    closeup_fullbody: "/character-template-previews/closeup_fullbody.jpg",
    dual_closeup_front_back_no_head: "/character-template-previews/dual_closeup_front_back_no_head.jpg",
    triple_closeup_front_no_face: "/character-template-previews/triple_closeup_front_no_face.jpg",
    turnaround_triple_closeup: "/character-template-previews/turnaround_triple_closeup.jpg",
    turnaround_five_angle_halfbody: "/character-template-previews/turnaround_five_angle_halfbody.jpg",
    headshot_fullbody: "/character-template-previews/headshot_fullbody.jpg",
};

export function AssetSchemePreview({ mode }: { mode: DramaAssetMode }) {
    if (mode === "none" || mode === "custom") {
        const Icon = mode === "none" ? Ban : PenLine;
        return (
            <span className="drama-assets-template-preview is-symbol" aria-hidden="true" data-template={mode}>
                <Icon />
            </span>
        );
    }
    return (
        <span className="drama-assets-template-preview" aria-hidden="true" data-template={mode}>
            <img src={TEMPLATE_PREVIEWS[mode]} alt="" draggable={false} decoding="async" />
        </span>
    );
}
