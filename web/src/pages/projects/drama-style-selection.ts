import type { CanvasStylePreset } from "@/lib/canvas/canvas-style-system";
import { findDramaStyleByLegacyPrompt, type DramaStyle } from "@/lib/drama/drama-styles";
import type { DramaSettings } from "@/services/api/drama";

export const DRAMA_TYPE_OPTIONS = [
    { value: "comic", label: "漫剧", detail: "以 2D 或 3D 动画呈现故事", cover: "/short-drama-types/comic.jpg" },
    { value: "live_action", label: "真人剧", detail: "以真人影像形式创作", cover: "/short-drama-types/live-action.jpg" },
] as const;

export function dramaTypeLabel(type?: DramaSettings["dramaType"]) {
    return type === "narration" ? "解说漫" : DRAMA_TYPE_OPTIONS.find((item) => item.value === type)?.label;
}

export type DramaStyleSettings = Pick<DramaSettings, "styleName" | "stylePrompt" | "styleSelection">;

export function dramaPresetSettings(style: DramaStyle): DramaStyleSettings {
    return { styleName: style.name, stylePrompt: style.prompt, styleSelection: { mode: "preset", presetId: style.id } };
}

export function dramaLibraryStyleInstructions(preset: CanvasStylePreset) {
    return [preset.prompt, preset.profile?.negativePrompt ? `禁止：${preset.profile.negativePrompt}` : ""].filter(Boolean).join("\n");
}

/** 旧风格库选择以自定义文本保存，预览时也要核对单独追加的禁用词。 */
export function matchesLegacyLibraryStyle(preset: CanvasStylePreset, name: string, prompt: string) {
    if (preset.title !== name) return false;
    const negative = preset.profile?.negativePrompt;
    const suffix = negative ? `\n禁止：${negative}` : "";
    if (suffix && !prompt.endsWith(suffix)) return false;
    const savedPrompt = suffix ? prompt.slice(0, -suffix.length) : prompt;
    return findDramaStyleByLegacyPrompt(savedPrompt)?.prompt === preset.prompt;
}
