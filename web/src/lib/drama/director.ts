export const DIRECTOR_TEMPLATES = [
    { value: "", label: "标准分镜", detail: "沿用作品的镜头节奏与所选写作技能" },
    { value: "smart_drama", label: "智能导演 · 剧集版", detail: "建立空间关系，按剧情节拍组织动作、正反打和反应镜头" },
    { value: "storyboard_detail", label: "手绘故事板 · 详细分镜版", detail: "细化构图、站位、动作起止与运镜，逐镜形成可绘制的起幅" },
] as const;

export const CAMERA_PRESETS = ["无运镜", "推镜头", "拉镜头", "摇镜头", "移镜头", "跟镜头", "环绕镜头", "升镜头", "航拍镜头", "手持镜头", "荷兰角镜头", "希区柯克镜头", "POV镜头", "FPV镜头"];

const CAMERA_ALIASES = new Map([
    ["固定", "无运镜"],
    ["推", "推镜头"],
    ["拉", "拉镜头"],
    ["摇", "摇镜头"],
    ["移", "移镜头"],
    ["跟", "跟镜头"],
    ["环绕", "环绕镜头"],
    ["手持", "手持镜头"],
]);
const CAMERA_INTENT = "【运镜意图】";

function cameraPreset(camera: string) {
    const value = camera.trim();
    return CAMERA_ALIASES.get(value) ?? CAMERA_PRESETS.find((preset) => preset === value);
}

function cameraIntentLine(line: string) {
    const text = line.trimStart();
    return text.startsWith(CAMERA_INTENT) ? cameraPreset(text.slice(CAMERA_INTENT.length)) : undefined;
}

export function shotVideoCameraValue(prompt: string, inherited: string, explicit?: string) {
    const preset = cameraPreset(explicit ?? "");
    if (preset) return preset;
    for (const line of prompt.split(/\r?\n/).reverse()) {
        const value = cameraIntentLine(line);
        if (value) return value;
    }
    return cameraPreset(inherited) ?? inherited.trim();
}

export function withoutLegacyShotVideoCameraIntent(prompt: string) {
    const lines = prompt.split(/\r?\n/);
    const body = lines.filter((line) => !cameraIntentLine(line));
    return body.length === lines.length ? prompt : body.join("\n").trimEnd();
}
