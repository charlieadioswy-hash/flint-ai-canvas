import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("短剧阶段确认直接点选，继续调整在原位输入具体要求", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/guide-stage-choices.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("4 pass");
    expect(output).toContain("0 fail");
}, 20_000);
