import type { DramaSettings } from "@/services/api/drama";

export function dramaGenerationConfiguration(settings: DramaSettings) {
    return {
        assets: settings.assets,
        aspectRatio: settings.aspectRatio,
        videoResolution: settings.videoResolution,
        videoContinuity: settings.videoContinuity,
        referenceLimit: settings.referenceLimit,
        models: {
            image: settings.models.image,
            video: settings.models.video,
            characterImage: settings.models.characterImage,
            propImage: settings.models.propImage,
            sceneImage: settings.models.sceneImage,
        },
    };
}

/** 自动同步生成参数时保留其他文字、流程和预算草稿。 */
export function applyDramaGenerationConfiguration(baseline: DramaSettings, changed: DramaSettings): DramaSettings {
    const configuration = dramaGenerationConfiguration(changed);
    return { ...baseline, ...configuration, models: { ...baseline.models, ...configuration.models } };
}
