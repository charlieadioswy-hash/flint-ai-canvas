import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("真实短剧引导的同轮建议串行接续与版本保护", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-guide-proposal-chain.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 25_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("0 fail");
}, 30_000);
