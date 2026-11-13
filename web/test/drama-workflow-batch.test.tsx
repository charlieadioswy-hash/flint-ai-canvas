import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("批量预检、明确确认和不确定回执隔离", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-workflow-batch.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("12 pass");
    expect(output).toContain("0 fail");
}, 25_000);
