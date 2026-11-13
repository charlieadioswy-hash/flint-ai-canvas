import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("创意扩写使用独立文字任务并隔离旧会话回执", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-workflow-idea.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 45_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("13 pass");
    expect(output).toContain("0 fail");
}, 50_000);
