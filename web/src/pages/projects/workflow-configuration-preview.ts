import { composeDramaStyleId, DRAMA_STYLES, DRAMA_STYLE_FORMS, DRAMA_STYLE_THEMES, findDramaStyle, getDramaStyleComposition, type DramaStyle } from "@/lib/drama/drama-styles";

const configurationStyles = [
    ...DRAMA_STYLES,
    ...DRAMA_STYLE_FORMS.flatMap((form) =>
        DRAMA_STYLE_THEMES.flatMap((theme) => {
            const style = findDramaStyle(composeDramaStyleId(form.id, theme.id));
            return style ? [style] : [];
        }),
    ),
];

/** 已保存的提示词是识别依据；同名的手动改写不能被当作原预设。 */
export function resolveWorkflowConfigurationStyle(prompt: string): DramaStyle | undefined {
    return prompt.trim() ? configurationStyles.find((style) => style.prompt.trim() === prompt.trim()) : undefined;
}

/** 组合没有专属样图时，仅借用相同表现形式与题材的现有示意图。 */
export function workflowConfigurationSamples(style?: DramaStyle) {
    if (!style) return [];
    if (style.sampleImages?.length) return style.sampleImages.map((url) => ({ url, label: style.name, illustrative: false }));
    if (style.cover) return [{ url: style.cover, label: style.name, illustrative: false }];
    const composition = getDramaStyleComposition(style.id);
    if (!composition) return [];
    return DRAMA_STYLES.filter((candidate) => {
        const axes = getDramaStyleComposition(candidate.id);
        return candidate.cover && axes?.formId === composition.formId && axes.themeId === composition.themeId;
    })
        .slice(0, 6)
        .map((candidate) => ({ url: candidate.cover!, label: candidate.name, illustrative: true }));
}
