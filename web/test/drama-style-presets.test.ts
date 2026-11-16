import { expect, test } from "bun:test";

import { canvasStylePresets } from "@/components/canvas/canvas-style-picker-modal";
import { DRAMA_STYLES } from "@/lib/drama/drama-styles";
import { DRAMA_STYLE_PROMPT_MAX_LENGTH } from "@/lib/drama/style-limits";

test("完整系统风格及负面说明均能保存到作品默认与单集独立风格", () => {
    const prompts = [...DRAMA_STYLES.map((style) => style.prompt), ...canvasStylePresets.map((style) => [style.prompt, style.profile?.negativePrompt ? `禁止：${style.profile.negativePrompt}` : ""].filter(Boolean).join("\n"))];
    expect(prompts.some((prompt) => Array.from(prompt).length > 1200)).toBe(true);
    for (const prompt of prompts) expect(Array.from(prompt).length).toBeLessThanOrEqual(DRAMA_STYLE_PROMPT_MAX_LENGTH);
});
