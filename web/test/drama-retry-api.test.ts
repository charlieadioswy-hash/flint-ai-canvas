import { afterEach, expect, test } from "bun:test";
import { retryFailedDrama } from "@/services/api/drama";
import { apiClient } from "@/services/api/request";

const originalAdapter = apiClient.defaults.adapter;
afterEach(() => {
    apiClient.defaults.adapter = originalAdapter;
});

test("本集重试准确发送目标，省略目标保留全局重试，空目标不能扩大重试范围", async () => {
    const calls: Array<{ method?: string; url?: string; body: unknown }> = [];
    apiClient.defaults.adapter = async (config) => {
        const body = config.data === undefined ? undefined : JSON.parse(config.data);
        calls.push({ method: config.method, url: config.url, body });
        return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: body === undefined ? { segments: 1, casts: 0 } : { jobs: 1 } } };
    };

    expect(await retryFailedDrama("project/1", "episode-9")).toEqual({ jobs: 1 });
    expect(await retryFailedDrama("project/1")).toEqual({ segments: 1, casts: 0 });
    await retryFailedDrama("project/1", undefined);
    await retryFailedDrama("project/1", "");

    expect(calls).toEqual([
        { method: "post", url: "/dramas/project%2F1/retry-failed", body: { episodeId: "episode-9" } },
        { method: "post", url: "/dramas/project%2F1/retry-failed", body: undefined },
        { method: "post", url: "/dramas/project%2F1/retry-failed", body: undefined },
        { method: "post", url: "/dramas/project%2F1/retry-failed", body: { episodeId: "" } },
    ]);
});
