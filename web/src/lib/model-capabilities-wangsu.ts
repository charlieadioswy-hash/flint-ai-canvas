import type { ImageCapabilityConfig, VideoCapabilityConfig } from "./model-capabilities";

export function wangsuImageCapability(protocol: string | undefined, model: string, fallback: ImageCapabilityConfig): ImageCapabilityConfig {
    if (!["wangsu-images", "wangsu-openai-images", "wangsu-gemini-image", "wangsu-chat-image"].includes(protocol || "")) return fallback;
    const name = model.trim().toLowerCase();
    const gemini = protocol === "wangsu-gemini-image" || (protocol === "wangsu-chat-image" && name !== "qwen-image-edit");
    const image: ImageCapabilityConfig = {
        ...fallback,
        references: { ...fallback.references, maxImages: 0, maskSupported: false },
        size: { parameter: "size", values: ["1024x1024", "1536x1024", "1024x1536"], default: "1024x1024", allowCustom: true },
        quality: { supported: false, values: [], default: "auto" },
        transparentBackground: { supported: false, default: false },
        responseFormat: { supported: true },
        outputFormat: { supported: false },
        maxOutputs: 1,
    };
    if (gemini) {
        image.references.maxImages = fallback.references.maxImages;
        image.size = { parameter: "aspect_ratio", values: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"], default: "1:1", allowCustom: false };
        image.quality = { supported: true, values: ["1k", "2k", "4k"], default: "1k" };
        image.responseFormat.supported = false;
    } else if (protocol === "wangsu-chat-image") {
        image.references.maxImages = 1;
        image.size = { parameter: "none", values: [], default: "auto", allowCustom: false };
        image.responseFormat.supported = false;
    } else if (name.startsWith("gpt-image-")) {
        image.references.maxImages = 1;
        image.references.maskSupported = true;
        image.quality = { supported: true, values: name.startsWith("gpt-image-2.5-") ? ["auto", "low", "medium", "high", "xhigh", "max"] : ["auto", "low", "high"], default: "auto" };
        image.transparentBackground.supported = true;
        image.outputFormat.supported = true;
        image.maxOutputs = 10;
    }
    return image;
}

export function wangsuVideoCapability(protocol: string | undefined, model: string, fallback: VideoCapabilityConfig): VideoCapabilityConfig {
    if (protocol !== "wangsu-videos" && protocol !== "wangsu-openai-videos") return fallback;
    const name = model.trim().toLowerCase();
    const video: VideoCapabilityConfig = {
        ...fallback,
        references: { ...fallback.references, maxImages: 1, maxVideos: 0, maxAudios: 0 },
        duration: { selection: "enum", values: [5], default: 5 },
        ratios: [],
        defaultRatio: "",
        resolutions: [],
        defaultResolution: "",
        generateAudio: { supported: false, default: false },
        watermark: { supported: false, default: false },
        operations: ["text_to_video", "image_to_video"],
        defaultOperation: "text_to_video",
    };
    if (protocol === "wangsu-openai-videos") {
        video.duration = { selection: "enum", values: [4, 8, 12], default: 4 };
        video.ratios = ["16:9", "9:16"];
        video.defaultRatio = "16:9";
        video.resolutions = ["720p"];
        video.defaultResolution = "720p";
    } else if (name === "minimax-hailuo-02" || name === "minimax-hailuo-2.3") {
        video.references = { ...video.references, promptMaxChars: 2000, maxImages: name === "minimax-hailuo-02" ? 2 : 1, maxImageBytes: 20 * 1024 * 1024 };
        video.duration = { selection: "enum", values: [6, 10], default: 6 };
        video.resolutions = name === "minimax-hailuo-02" ? ["512P", "768P", "1080P"] : ["768P", "1080P"];
        video.defaultResolution = "768P";
    } else if (name.startsWith("doubao-seedance-2-")) {
        const v25 = name.startsWith("doubao-seedance-2-5-");
        video.references = {
            ...video.references,
            maxImages: 9,
            maxImageBytes: 10 * 1024 * 1024,
            // The 2.0 gateway page documents video references without a count;
            // start with one and let administrators declare a larger limit.
            maxVideos: v25 ? 3 : 1,
            maxVideoBytes: v25 ? 50 * 1024 * 1024 : 0,
            maxVideoDurationSeconds: v25 ? 15 : 0,
            maxAudios: 3,
            maxAudioBytes: 15 * 1024 * 1024,
            maxAudioDurationSeconds: 15,
        };
        video.duration = { selection: "range", min: 4, max: v25 ? 30 : 15, step: 1, default: 5 };
        video.ratios = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"];
        video.defaultRatio = "16:9";
        video.resolutions = v25 ? ["480p", "720p", "1080p"] : ["480p", "720p", "4k"];
        video.defaultResolution = "720p";
        video.generateAudio = { supported: true, default: true };
        video.operations.push("reference_to_video", "audio_to_video");
    } else if (name === "veo-3.1-generate-001" || name === "veo-3.1-fast-generate-001") {
        video.references.maxImages = 3;
        video.duration = { selection: "enum", values: [4, 6, 8], default: 8 };
        video.ratios = ["16:9", "9:16"];
        video.defaultRatio = "16:9";
        video.resolutions = ["720p", "1080p", "4k"];
        video.defaultResolution = "720p";
        video.generateAudio = { supported: true, default: true };
        video.operations.push("reference_to_video");
    }
    return video;
}
