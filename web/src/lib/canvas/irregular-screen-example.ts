import type { ScreenGenerationSettings } from "./irregular-screen-model";

// A repeatable starting point; visual acceptance still needs the target model.
export const screenCarExample = {
    prompt: "裸眼 3D 转角异形屏内容，一辆完整的银白色未来科幻超跑，从深蓝色空间舱内向观察者冲出。观察者站在屏幕中央外转角的下方，低机位仰视，两侧屏面共用同一个视点、连续空间与透视。车头位于中央转角前方，车尾和尾部蓝色能量轨迹自然延伸到侧屏；只有一辆车，一个连续车身，车轮、底盘和车身衔接完整。前景车头明显放大，背景深邃，强烈近大远小、遮挡关系、接触阴影与统一光源，形成冲出屏面的纵深错觉。车体与光带连续跨越转角，不按颜色区域分镜，不在转角处分割主体。画面只包含屏幕播放内容，不出现建筑、屏幕外框、观看者、文字或水印。",
    settings: {
        steps: 20,
        sampler: 15,
        cfgScale: 7,
        seed: 20261022,
        denoisingStrength: 0.75,
        strength: 0.6,
        start: 0,
        end: 0.6,
        resolution: 512,
        lowThreshold: 100,
        highThreshold: 200,
        negativePrompt: "split screen, diptych, collage, multiple cars, duplicated car, disconnected body, cut vehicle, inconsistent perspective, flat composition, building, billboard frame, people, text, watermark, logo, blurry, deformed wheels",
    } satisfies Partial<ScreenGenerationSettings>,
};

export function applyScreenCarExample(settings: ScreenGenerationSettings): ScreenGenerationSettings {
    const { strength, start, end, resolution, lowThreshold, highThreshold, ...generation } = screenCarExample.settings;
    const canny = (settings.controlType || settings.preprocessor || "canny") === "canny";
    return { ...settings, ...generation, ...(canny ? { strength, start, end, resolution, lowThreshold, highThreshold } : {}) };
}
