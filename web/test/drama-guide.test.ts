import { describe, expect, test } from "bun:test";

import { activeDramaGuide, dramaProjectPath } from "../src/pages/projects/guide-state";

describe("短剧存量项目路由恢复", () => {
    test("制作中的旧引导进入新的步骤页面", () => {
        expect(activeDramaGuide(undefined)).toBe(false);
        expect(dramaProjectPath("manual-project")).toBe("/projects/manual-project");
        expect(dramaProjectPath("auto-project", "")).toBe("/projects/auto-project");
        for (const step of ["configuring", "assets", "story"] as const) {
            expect(activeDramaGuide(step)).toBe(true);
            expect(dramaProjectPath("guided", step)).toBe("/projects/guided/guide");
        }
    });

    test("已完成项目保留项目地址，由制作台路由选择视图", () => {
        expect(activeDramaGuide("completed")).toBe(false);
        expect(dramaProjectPath("guided", "completed")).toBe("/projects/guided");
        expect(dramaProjectPath("project/id", "story")).toBe("/projects/project%2Fid/guide");
    });
});
