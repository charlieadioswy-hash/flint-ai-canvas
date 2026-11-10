import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("短剧配置选项直接点选并支持自定义", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/guide-setup-choices.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("6 pass");
    expect(output).toContain("0 fail");
}, 20_000);
