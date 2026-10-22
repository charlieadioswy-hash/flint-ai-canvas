import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isAgentAvatarBundleManifest } from "../src/lib/canvas/agent-appearance";

const manifestForFile = (file: unknown) => ({ version: 1, width: 480, height: 432, clips: { idle: file } });

describe("Agent avatar bundle filename contract", () => {
    test.each(["idle.mp4", "idle loop.mp4", "待机.mp4", "动画 🎬.MP4", " leading space.mp4", ".mp4", "idle..loop.mp4", "idle\u2028loop.mp4"])("accepts backend-supported root MP4 filename %p", (file) => {
        expect(isAgentAvatarBundleManifest(manifestForFile(file))).toBe(true);
    });

    test.each([
        "",
        "idle",
        "idle.webm",
        "idle.mp4 ",
        "../idle.mp4",
        "./idle.mp4",
        "/idle.mp4",
        "clips/idle.mp4",
        "clips\\idle.mp4",
        "drive:idle.mp4",
        "idle%20loop.mp4",
        "idle?loop.mp4",
        "idle#loop.mp4",
        "idle\u0000loop.mp4",
        "idle\nloop.mp4",
        "idle\u007floop.mp4",
        "idle\u0085loop.mp4",
        "idle\u009floop.mp4",
    ])("rejects unsafe paths and invalid MP4 filename %p", (file) => {
        expect(isAgentAvatarBundleManifest(manifestForFile(file))).toBe(false);
    });

    test.each([
        { label: "ASCII at 128 bytes", file: `${"a".repeat(124)}.mp4`, accepted: true },
        { label: "ASCII at 129 bytes", file: `${"a".repeat(125)}.mp4`, accepted: false },
        { label: "Chinese at 128 bytes", file: `${"待".repeat(41)}x.mp4`, accepted: true },
        { label: "Chinese at 129 bytes", file: `${"待".repeat(41)}xx.mp4`, accepted: false },
        { label: "emoji at 128 bytes", file: `${"🎬".repeat(31)}.mp4`, accepted: true },
        { label: "emoji at 129 bytes", file: `${"🎬".repeat(31)}x.mp4`, accepted: false },
    ])("enforces the UTF-8 byte limit: $label", ({ file, accepted }) => {
        expect(isAgentAvatarBundleManifest(manifestForFile(file))).toBe(accepted);
    });

    test("preserves the manifest and clip ID constraints", () => {
        expect(isAgentAvatarBundleManifest(manifestForFile(null))).toBe(false);
        expect(isAgentAvatarBundleManifest(manifestForFile(42))).toBe(false);
        expect(isAgentAvatarBundleManifest({ ...manifestForFile("待机.mp4"), version: 2 })).toBe(false);
        expect(isAgentAvatarBundleManifest({ ...manifestForFile("待机.mp4"), width: 4097 })).toBe(false);
        expect(isAgentAvatarBundleManifest({ ...manifestForFile("待机.mp4"), clips: { 待机: "待机.mp4" } })).toBe(false);
        expect(isAgentAvatarBundleManifest({ ...manifestForFile("待机.mp4"), clips: {} })).toBe(false);
    });

    test("accepts the shipped avatar manifest", () => {
        const manifest = JSON.parse(readFileSync(new URL("../public/doll/avatar.json", import.meta.url), "utf8"));
        expect(isAgentAvatarBundleManifest(manifest)).toBe(true);
    });
});
