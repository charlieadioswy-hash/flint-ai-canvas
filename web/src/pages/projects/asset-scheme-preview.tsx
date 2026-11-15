import { Ban, PenLine } from "lucide-react";

import type { DramaAssetMode } from "@/services/api/drama";

type FigureView = "front" | "side" | "left-side" | "back" | "three-quarter" | "left-three-quarter";
type FigureCrop = "full" | "headless" | "closeup" | "halfbody" | "headshot";

function Figure({ x, y, width, height, view = "front", crop = "full" }: { x: number; y: number; width: number; height: number; view?: FigureView; crop?: FigureCrop }) {
    const back = view === "back";
    const side = view === "side" || view === "left-side";
    const mirrored = view === "left-side" || view === "left-three-quarter";
    const angled = view === "three-quarter" || view === "left-three-quarter";
    const head = crop !== "headless";
    const viewBox = crop === "headless" ? "0 42 80 118" : crop === "closeup" ? "0 0 80 78" : crop === "halfbody" ? "0 0 80 103" : crop === "headshot" ? "15 0 50 43" : "0 0 80 160";
    return (
        <svg x={x} y={y} width={width} height={height} viewBox={viewBox} preserveAspectRatio="xMidYMax meet" data-crop={crop} data-view={view} className="drama-template-figure">
            <g transform={mirrored ? "translate(80 0) scale(-1 1)" : undefined}>
                <g transform={side ? "translate(14 0) scale(.65 1)" : undefined}>
                    {head ? (
                        <>
                            <path className="is-skin" d="M33 35h14v15H33z" />
                            <ellipse className={back ? "is-hair" : "is-skin"} cx="40" cy="22" rx="15" ry="19" />
                            <path className="is-hair" d="M25 23V16C25 4 31 0 41 0c12 0 16 8 15 21l-7-9-10 5-7-3z" />
                            {!back ? <g className="is-features">{side ? <path d="m52 20 5 7-6 1M46 20h3M46 33h5" /> : <path d={angled ? "M35 22h3m8 0h3m-7 2 2 6h-4m-4 5h9" : "M30 22h5m10 0h5m-10 3-2 5h4m-8 5h12"} />}</g> : null}
                        </>
                    ) : null}
                    <path className="is-outfit" d="m31 43-12 5-9 55 10 3 9-42-2 41h26l-2-41 9 42 10-3-9-55-12-5-9 8z" />
                    <path className="is-outfit" d="m27 101-3 48h13l4-38 3 38h13l-4-48z" />
                    <path className="is-hair" d="M24 147h13v10H19v-5zm20 0h13l6 5v5H44z" />
                    <path className="is-detail" d={back ? "M30 52h20M40 55v43" : "m31 45 9 9 9-9M40 54v45M28 91h8m8 0h8"} />
                </g>
            </g>
        </svg>
    );
}

/** 缩略图只说明单张参考图中的构图；裁头身体不画空白脸或第二个人头。 */
export function AssetSchemePreview({ mode }: { mode: DramaAssetMode }) {
    if (mode === "none" || mode === "custom") {
        const Icon = mode === "none" ? Ban : PenLine;
        return (
            <span className="drama-assets-template-preview is-symbol" aria-hidden="true" data-template={mode}>
                <Icon />
            </span>
        );
    }
    const vertical = mode === "dual_closeup_front_back_no_head";
    return (
        <span className="drama-assets-template-preview" aria-hidden="true" data-template={mode}>
            <svg viewBox="0 0 240 135" focusable="false">
                <rect className="drama-template-sheet" x={vertical ? 82 : 0} y="0" width={vertical ? 76 : 240} height="135" rx="2" />
                {mode === "closeup_turnaround" ? (
                    <>
                        <Figure x={0} y={3} width={96} height={132} crop="closeup" />
                        <Figure x={96} y={5} width={48} height={126} />
                        <Figure x={144} y={5} width={48} height={126} view="side" />
                        <Figure x={192} y={5} width={48} height={126} view="back" />
                    </>
                ) : null}
                {mode === "closeup_front_no_face" || mode === "closeup_fullbody" || mode === "headshot_fullbody" ? (
                    <>
                        <Figure x={0} y={3} width={160} height={132} crop={mode === "headshot_fullbody" ? "headshot" : "closeup"} />
                        <Figure x={164} y={5} width={72} height={126} crop={mode === "closeup_fullbody" ? "full" : "headless"} />
                    </>
                ) : null}
                {mode === "closeup_turnaround_no_head" ? (
                    <>
                        <Figure x={0} y={3} width={96} height={132} crop="closeup" />
                        <Figure x={96} y={5} width={48} height={126} crop="headless" />
                        <Figure x={144} y={5} width={48} height={126} crop="headless" view="side" />
                        <Figure x={192} y={5} width={48} height={126} crop="headless" view="back" />
                    </>
                ) : null}
                {vertical ? (
                    <>
                        <Figure x={83} y={1} width={36} height={39} crop="closeup" />
                        <Figure x={121} y={1} width={36} height={39} crop="closeup" view="side" />
                        <Figure x={84} y={42} width={34} height={90} crop="headless" />
                        <Figure x={122} y={42} width={34} height={90} crop="headless" view="back" />
                    </>
                ) : null}
                {mode === "triple_closeup_front_no_face" ? (
                    <>
                        <Figure x={0} y={1} width={88} height={134} crop="closeup" />
                        <Figure x={88} y={5} width={62} height={126} crop="headless" />
                        <Figure x={152} y={0} width={88} height={66} crop="closeup" />
                        <Figure x={152} y={69} width={43} height={66} crop="closeup" view="left-three-quarter" />
                        <Figure x={197} y={69} width={43} height={66} crop="closeup" view="three-quarter" />
                    </>
                ) : null}
                {mode === "turnaround_triple_closeup" || mode === "turnaround_five_angle_halfbody" ? (
                    <>
                        <Figure x={0} y={5} width={48} height={126} />
                        <Figure x={48} y={5} width={48} height={126} view="side" />
                        <Figure x={96} y={5} width={48} height={126} view="back" />
                        {mode === "turnaround_triple_closeup" ? (
                            <>
                                <Figure x={146} y={0} width={94} height={66} crop="closeup" />
                                <Figure x={146} y={69} width={46} height={66} crop="closeup" view="left-three-quarter" />
                                <Figure x={194} y={69} width={46} height={66} crop="closeup" view="three-quarter" />
                            </>
                        ) : (
                            <>
                                <Figure x={146} y={0} width={46} height={66} crop="halfbody" />
                                <Figure x={194} y={0} width={46} height={66} crop="halfbody" view="side" />
                                <Figure x={146} y={69} width={30} height={66} crop="halfbody" view="left-three-quarter" />
                                <Figure x={178} y={69} width={30} height={66} crop="halfbody" view="three-quarter" />
                                <Figure x={210} y={69} width={30} height={66} crop="halfbody" view="back" />
                            </>
                        )}
                    </>
                ) : null}
            </svg>
        </span>
    );
}
