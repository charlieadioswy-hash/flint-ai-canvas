import { describe, expect, test } from "bun:test";
import { isModel3DAdminState, model3DProviderDraft, model3DProviderDraftChanged, model3DProviderInput, model3DProviderResponseMatches, model3DProviderStatus, validateModel3DProviderDraft } from "../src/pages/admin/settings/model3d-settings-form";
import type { Model3DAdminState, Model3DProviderView } from "../src/services/api/model3d";

const provider: Model3DProviderView = {
    id: "provider-1", configId: "config-1", version: 1, name: "测试 Tripo", type: "tripo3d", enabled: true, archived: false,
    defaultModel: "v3.1-20260211", allowedModels: ["v3.1-20260211", "v3.0-20250812"], allowedModes: ["text", "image", "multiview"],
    timeoutSeconds: 60, maxTasksPerDay: 100, apiKeyConfigured: true,
};
const state: Model3DAdminState = {
    providers: [provider], activeProviderId: provider.id, activeConfigId: provider.configId, policyRevision: 1,
    providerTypes: [{ type: "tripo3d", label: "Tripo3D", modes: ["text", "image", "multiview"], modelVersions: provider.allowedModels.map((id) => ({ id, label: id, supportsAdvanced: true, maxFacesStandard: 1500000, maxFacesDetailed: 2000000 })) }],
};

describe("3D provider configuration", () => {
    test("never repopulates secrets and blank keeps the stored key", () => {
        const draft = model3DProviderDraft(provider, state);
        expect(draft.apiKey).toBe("");
        expect(model3DProviderInput(draft)).not.toHaveProperty("apiKey");
        expect(validateModel3DProviderDraft(draft, provider, state)).toBe("");
        expect(model3DProviderDraftChanged(draft, provider, state)).toBe(false);
        expect(validateModel3DProviderDraft(draft, null, state)).toContain("API Key");
    });

    test("blocks a default model that is no longer open", () => {
        const draft = { ...model3DProviderDraft(provider, state), allowedModels: ["v3.0-20250812"] };
        expect(validateModel3DProviderDraft(draft, provider, state)).toContain("默认模型");
        expect(model3DProviderDraftChanged(draft, provider, state)).toBe(true);
    });

    test("blocks unsupported modes/models and non-integral limits", () => {
        const draft = model3DProviderDraft(provider, state);
        expect(validateModel3DProviderDraft({ ...draft, allowedModels: ["unknown"] }, provider, state)).toContain("模型版本");
        expect(validateModel3DProviderDraft({ ...draft, allowedModes: [] }, provider, state)).toContain("生成模式");
        expect(validateModel3DProviderDraft({ ...draft, maxTasksPerDay: 1.2 }, provider, state)).toContain("整数");
        expect(validateModel3DProviderDraft({ ...draft, timeoutSeconds: 0 }, provider, state)).toContain("超时");
    });

    test("retains active version while a new draft version is saved", () => {
        expect(model3DProviderStatus({ ...provider, version: 2, configId: "config-2" }, state)).toEqual({ label: "新版本未应用", tone: "warning" });
        expect(model3DProviderStatus(provider, state).label).toBe("当前生效");
    });

    test("save acknowledgement must match all public fields and advance version", () => {
        const input = model3DProviderInput(model3DProviderDraft(provider, state));
        const saved = { ...provider, version: 2, configId: "config-2" };
        expect(model3DProviderResponseMatches(saved, input, provider)).toBe(true);
        expect(model3DProviderResponseMatches(provider, input, provider)).toBe(false);
        expect(model3DProviderResponseMatches({ ...saved, allowedModes: ["image"] }, input, provider)).toBe(false);
        expect(model3DProviderResponseMatches({ ...saved, apiKeyConfigured: false }, input, provider)).toBe(false);
    });

    test("rejects inconsistent active pointers and malformed provider records", () => {
        expect(isModel3DAdminState(state)).toBe(true);
        expect(isModel3DAdminState({ ...state, activeConfigId: "" })).toBe(false);
        expect(isModel3DAdminState({ ...state, activeProviderId: "missing" })).toBe(false);
        expect(isModel3DAdminState({ ...state, providers: [provider, provider] })).toBe(false);
        expect(isModel3DAdminState({ ...state, providers: [{ ...provider, timeoutSeconds: -1 }] })).toBe(false);
    });
});
