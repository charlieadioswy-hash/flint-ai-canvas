import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("画布 Agent 入口草稿只在当前账号与画布内交接一次", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/canvas-agent-entry.harness.ts"], { cwd: resolve(import.meta.dir, ".."), timeout: 10_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("7 pass");
    expect(output).toContain("0 fail");
}, 15_000);
