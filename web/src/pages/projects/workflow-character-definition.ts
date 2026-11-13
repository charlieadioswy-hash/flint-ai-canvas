export const CHARACTER_FIELDS = [
    ["role", "角色定位"],
    ["age", "年龄"],
    ["gender", "性别"],
    ["personality", "性格"],
    ["background", "背景"],
    ["physique", "体型"],
    ["clothing", "服装"],
    ["props", "随身物品"],
    ["consistencyPrompt", "形象一致性说明"],
    ["multiViewPrompt", "多视图说明"],
    ["voiceLanguage", "声音语言"],
    ["voiceAge", "声音年龄"],
    ["voiceTimbre", "音色"],
] as const;

export function parseCharacterDefinition(raw?: string): Record<string, unknown> {
    if (!raw?.trim()) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("人物定义格式异常，请保留当前数据并联系管理员检查。");
    return value as Record<string, unknown>;
}

export function characterFieldValues(definition: Record<string, unknown>, role: string) {
    return Object.fromEntries(CHARACTER_FIELDS.map(([key]) => [key, key === "role" ? role : typeof definition[key] === "string" ? definition[key] : definition[key] == null ? "" : JSON.stringify(definition[key])])) as Record<string, string>;
}

/** 仅提交用户改过的字段；未编辑字段和未知键留在服务端完整定义中。 */
export function changedCharacterFields(baseline: Record<string, string>, current: Record<string, string>) {
    return Object.fromEntries(CHARACTER_FIELDS.filter(([key]) => baseline[key] !== current[key]).map(([key]) => [key, current[key] ?? ""]));
}
