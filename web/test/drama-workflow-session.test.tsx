import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("真实短剧工作流的草稿保护、生命周期和异步回执隔离", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-workflow-session.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("65 pass");
    expect(output).toContain("0 fail");
}, 25_000);
