import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageSizePicker } from "../src/components/image-size-picker";
import { imageResolutionTiers, imageSizePresets, imageTierAvailable, nativeImageAspectRatios } from "../src/lib/image-size-presets";
import { defaultImageCapabilityConfig, normalizeImageValue, normalizeLegacyImageResolutionConfig } from "../src/lib/model-capabilities";

describe("Wangsu native image sizes", () => {
    test("Nano displays all documented ratios and independent resolution without invented pixels", () => {
        const profile = defaultImageCapabilityConfig("wangsu-gemini-image", "gemini-nano-banana-2.1");
        expect(profile.references.maxImages).toBe(14);
        expect(nativeImageAspectRatios(profile)).toHaveLength(14);
        expect(imageSizePresets(profile)).toEqual([]);
        expect(imageResolutionTiers(profile)).toEqual(["1k", "2k", "4k"]);
        expect(imageTierAvailable(profile, "4k")).toBe(true);
        const picker = renderToStaticMarkup(<ImageSizePicker profile={profile} size="1:8" imageResolution="4k" onChange={() => {}} />);
        for (const ratio of ["1:4", "1:8", "4:1", "8:1"]) expect(picker).toContain(`<span>${ratio}</span>`);
        for (const resolution of ["1K", "2K", "4K"]) expect(picker).toMatch(new RegExp(`<button[^>]*>${resolution}`));
        expect(picker).toMatch(/aria-pressed="true"[^>]*>4K/);
        expect(picker).toContain("1:8 · 4K");
        expect(picker).not.toMatch(/\d+\s*[×x]\s*\d+|自定义/);
    });

    test("legacy Gemini quality tiers project to resolution while ordinary quality stays independent", () => {
        for (const protocol of ["wangsu-gemini-image", "wangsu-chat-image"]) {
            const profile = defaultImageCapabilityConfig(protocol, "gemini-3-pro-image");
            profile.resolution = { supported: false, values: [], default: "auto" };
            profile.quality = { supported: true, values: ["1k", "2k", "4k"], default: "2k" };
            const normalized = normalizeLegacyImageResolutionConfig(protocol, profile);
            expect(normalized.resolution).toEqual({ supported: true, values: ["1k", "2k", "4k"], default: "2k" });
            expect(normalized.quality).toEqual({ supported: false, values: [], default: "auto" });
            expect(normalized.resolutionUsesQuality).toBe(false);
            expect(normalizeImageValue(normalized, { quality: "4k" }, protocol).imageResolution).toBe("4k");
            expect(normalizeImageValue(normalized, { quality: "high" }, protocol).imageResolution).toBe("2k");
            expect(normalizeImageValue(normalized, { quality: "4k", imageResolution: "2k" }, protocol).imageResolution).toBe("2k");
        }
        const gpt = defaultImageCapabilityConfig("wangsu-images", "gpt-image-2");
        expect(gpt.resolution.supported).toBe(false);
        expect(gpt.size.values).toEqual(["1024x1024", "1536x1024", "1024x1536"]);
        expect(gpt.quality.values).toEqual(["auto", "low", "high"]);
        expect(nativeImageAspectRatios(gpt)).toEqual([]);
    });
});
