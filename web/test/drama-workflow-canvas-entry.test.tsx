import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("画布创作入口保留技能与参考草稿并隔离确认中的账号", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-workflow-canvas-entry.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("3 pass");
    expect(output).toContain("0 fail");
}, 20_000);
