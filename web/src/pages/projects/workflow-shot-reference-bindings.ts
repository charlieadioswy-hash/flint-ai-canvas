import type { DramaShotMediaConfig } from "@/services/api/drama-shot-media";

export function shotImageMentionToken(id: string): string {
    return `@[shot-image:${id}]`;
}

export function shotImageMentionIds(prompt: string): string[] {
    return [...new Set([...prompt.matchAll(/@\[shot-image:([^\]\s]+)\]/g)].map((match) => match[1]))];
}

/** 数字编号只在当前附图顺序中有效；改动附图前将手工引用绑定到原资源。 */
export function preserveShotImageMentions(config: DramaShotMediaConfig, patch: Partial<DramaShotMediaConfig>, kind: "image" | "video"): Partial<DramaShotMediaConfig> {
    if (patch.prompt !== undefined || (kind === "video" && config.promptSourceHash) || !patch.referenceResourceIds || patch.referenceResourceIds.join("\n") === config.referenceResourceIds.join("\n")) return patch;
    const prompt = config.prompt.replace(/@?参考图\s*(\d+)/g, (text, ordinal: string) => {
        const id = config.referenceResourceIds[Number(ordinal) - 1];
        return id ? shotImageMentionToken(id) : text;
    });
    return prompt === config.prompt ? patch : { ...patch, prompt, promptSourceHash: "" };
}
