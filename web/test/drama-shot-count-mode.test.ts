import { expect, test } from "bun:test";
import { normalizeStoryboard, shotTarget } from "@/lib/drama/storyboard";

test("已有镜头数量默认作为智能参考，保留数量供生成使用", () => {
    const settings = normalizeStoryboard({ targetShotCount: 27 });
    expect(settings.shotCountMode).toBe("smart");
    expect(settings.targetShotCount).toBe(27);
    expect(shotTarget(settings, 60)).toBe(27);
});

test("智能参考数为零时随时长节奏估算，固定模式需显式选择", () => {
    const smart = normalizeStoryboard({ targetShotCount: 0, pacing: "relaxed" });
    expect(smart.shotCountMode).toBe("smart");
    expect(shotTarget(smart, 120)).toBe(27);
    expect(normalizeStoryboard({ ...smart, shotCountMode: "fixed", targetShotCount: 12 })).toMatchObject({ shotCountMode: "fixed", targetShotCount: 12 });
});
