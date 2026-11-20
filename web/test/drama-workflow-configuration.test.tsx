import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("真实风格配置参数阻断的展开、用户定位和单集字段上限", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-workflow-configuration.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("5 pass");
    expect(output).toContain("0 fail");
}, 25_000);
