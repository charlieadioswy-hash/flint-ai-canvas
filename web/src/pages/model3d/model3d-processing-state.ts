import type { Model3DProcessing, Model3DProcessingOperation, Model3DTaskView } from "@/services/api/model3d";

export const MODEL3D_PROCESSING_LABELS: Record<Model3DProcessingOperation, string> = {
    segment: "部件拆分",
    complete: "部件补全",
    rig_check: "绑骨检查",
    rig: "自动绑骨",
    animate: "生成动画",
};
export const MODEL3D_RIG_LABELS: Record<string, string> = {
    biped: "人形／双足",
    quadruped: "四足动物",
    hexapod: "六足",
    octopod: "八足",
    avian: "鸟类",
    serpentine: "蛇形",
    aquatic: "水生",
    others: "其他",
};
const bipedPresets = ["idle", "walk", "run", "dive", "climb", "jump", "slash", "shoot", "hurt", "fall", "turn"];
const animationLabels: Record<string, string> = { idle: "待机", walk: "行走", run: "奔跑", dive: "俯冲", climb: "攀爬", jump: "跳跃", slash: "挥砍", shoot: "射击", hurt: "受击", fall: "跌倒", turn: "转身", march: "移动" };

export function model3DAnimationOptions(rigType: string) {
    const values = rigType === "biped" ? bipedPresets.map((name) => `preset:${name}`) : ["quadruped", "hexapod", "octopod"].includes(rigType) ? [`preset:${rigType}:walk`] : ["serpentine", "aquatic"].includes(rigType) ? [`preset:${rigType}:march`] : [];
    return values.map((value) => ({ value, label: animationLabels[value.split(":").at(-1)!] }));
}

export function model3DProcessingOptions(task: Model3DTaskView): Model3DProcessingOperation[] {
    if (task.status !== "succeeded" || task.scope !== "standalone") return [];
    if (task.processing?.operation === "rig_check") return task.rigCheck?.riggable ? ["rig"] : [];
    if (!task.result?.resourceId) return [];
    if (!task.processing) return ["segment", "rig_check"];
    if (task.processing.operation === "segment") return ["complete"];
    if (task.processing.operation === "rig" && model3DAnimationOptions(task.processing.rigType || "").length) return ["animate"];
    return [];
}

export function defaultModel3DProcessing(task: Model3DTaskView, operation: Model3DProcessingOperation): Model3DProcessing {
    const base = { operation, sourceTaskId: task.id };
    switch (operation) {
        case "segment":
            return { ...base, model: "v2.0-20260430", granularity: "balanced", splitByConnectivity: true };
        case "complete":
            return { ...base, completionMode: "ai_completion" };
        case "rig": {
            const rigType = task.rigCheck?.rigType || "";
            return { ...base, model: "v3.0-20260909", rigType, ...(rigType === "biped" ? { spec: "tripo" } : {}), outFormat: "glb" };
        }
        case "animate": {
            const rigType = task.processing?.rigType || "";
            return { ...base, rigType, animation: model3DAnimationOptions(rigType)[0]?.value, animateInPlace: true, outFormat: "glb" };
        }
        default:
            return base;
    }
}
