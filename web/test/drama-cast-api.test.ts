import { afterEach, expect, test } from "bun:test";
import { createDramaCast, deleteDramaCast } from "@/services/api/drama";
import { ApiError, apiClient } from "@/services/api/request";

const originalAdapter = apiClient.defaults.adapter;
afterEach(() => {
    apiClient.defaults.adapter = originalAdapter;
});

test("asset creation sends the guide revision and deletion sends the reviewed scope in the JSON body", async () => {
    const calls: Array<{ method?: string; url?: string; body: unknown }> = [];
    apiClient.defaults.adapter = async (config) => {
        calls.push({ method: config.method, url: config.url, body: JSON.parse(config.data) });
        return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: config.method === "post" ? { cast: { id: "cast/1" } } : { deleted: true, castId: "cast/1" } } };
    };
    expect(await createDramaCast("project/1", { kind: "scene", name: "小院", expectedRevision: 7 })).toEqual({ cast: { id: "cast/1" } });
    expect(await deleteDramaCast("project/1", "cast/1", 8, "reviewed-token")).toEqual({ deleted: true, castId: "cast/1" });
    expect(calls).toEqual([
        { method: "post", url: "/dramas/project%2F1/cast", body: { kind: "scene", name: "小院", expectedRevision: 7 } },
        { method: "delete", url: "/dramas/project%2F1/cast/cast%2F1", body: { expectedRevision: 8, deleteScopeToken: "reviewed-token" } },
    ]);
});

test("asset deletion preserves the server conflict while a generation task is running", async () => {
    let calls = 0;
    apiClient.defaults.adapter = async (config) => {
        calls++;
        return { config, headers: {}, status: 409, statusText: "Conflict", data: { code: 409, data: null, msg: "该资产的生成任务尚未结束，请完成后再删除", reason: "conflict" } };
    };
    const error = await deleteDramaCast("project", "cast", 8, "reviewed-token").catch((value) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe("该资产的生成任务尚未结束，请完成后再删除");
    expect(error.reason).toBe("conflict");
    expect(calls).toBe(1);
});
