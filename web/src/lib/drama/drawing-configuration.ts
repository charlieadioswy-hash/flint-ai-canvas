import type { DramaDrawingConfiguration, DramaSettings } from "@/services/api/drama";

export function dramaDrawingConfiguration(settings: DramaSettings): DramaDrawingConfiguration {
    return {
        assets: settings.assets,
        models: {
            image: settings.models.image,
            characterImage: settings.models.characterImage || {},
            sceneImage: settings.models.sceneImage || {},
        },
    };
}
