import { expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { Model3DParameterPanel } from "@/components/canvas/nodes/model3d-parameter-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { createDefaultModel3DState, model3DParameterError } from "@/lib/canvas/model3d";
import type { Model3DCapabilities } from "@/services/api/model3d";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const capabilities: Model3DCapabilities = {
    available: true, providerName: "Tripo", policyRevision: 1, activeConfigVersion: 1, defaultModel: "h3.1",
    modelVersions: [
        { id: "h3.1", label: "H3.1", supportsAdvanced: true, maxFacesStandard: 1500000, maxFacesDetailed: 2000000 },
        { id: "h2.5", label: "H2.5", supportsAdvanced: false, maxFacesStandard: 500000, maxFacesDetailed: 500000 },
    ],
    modes: ["text", "image", "multiview"],
    inputLimits: { maxBytes: 10000000, mimeTypes: ["image/png", "image/jpeg"], minViews: 2, maxViews: 4, requiredView: "front" },
};

function labeledElement(value: ReactNode, label: string): ReactElement<any> | undefined {
    if (Array.isArray(value)) {
        for (const child of value) { const match = labeledElement(child, label); if (match) return match; }
    } else if (isValidElement<any>(value)) {
        if (value.props.label === label) return value;
        const child = labeledElement(value.props.children, label);
        if (child) return child;
        for (const item of value.props.items || []) { const match = labeledElement(item.children, label); if (match) return match; }
    }
}

function harness() {
    const node: CanvasNodeData = { id: "model", title: "3D", type: CanvasNodeType.Model3D, width: 520, height: 420, position: { x: 0, y: 0 }, metadata: { model3d: createDefaultModel3DState("h3.1") } };
    const render = () => Model3DParameterPanel({ node, nodes: [node], inputNodes: [], theme: canvasThemes.dark, capabilities, capabilityError: "", onChange: (update) => { node.metadata!.model3d!.draft = update(node.metadata!.model3d!.draft); }, onGenerate: () => { throw new Error("unexpected generation"); }, onRefresh: () => {}, onReloadConfig: () => {}, onClose: () => {}, onUpload: async () => { throw new Error("unexpected upload"); } });
    const control = (label: string) => {
        let field = labeledElement(render(), label);
        if (!field) return undefined;
        if (typeof field.type === "function" && ["Toggle", "SeedField"].includes(field.type.name)) field = (field.type as (props: any) => ReactElement<any>)(field.props);
        const children = Array.isArray(field!.props.children) ? field!.props.children : [field!.props.children];
        return children.find((child: ReactNode): child is ReactElement<any> => isValidElement<any>(child) && typeof child.props.onChange === "function") as ReactElement<any> | undefined;
    };
    return { control, get parameters() { return node.metadata!.model3d!.draft.parameters; } };
}

test("real panel displays UV provider default, preserves explicit false and supports H2.5 export options", () => {
    const h = harness();
    expect(h.parameters).not.toHaveProperty("exportUv");
    expect(h.control("导出 UV")?.props.checked).toBe(true);
    h.control("导出 UV")!.props.onChange(false);
    expect(h.control("导出 UV")?.props.checked).toBe(false);
    h.control("生成模型")!.props.onChange("h2.5");
    expect(h.parameters.exportUv).toBe(false);
    expect(h.control("导出 UV")?.props.checked).toBe(false);
    expect(h.control("导出朝向")).toBeDefined();
    h.control("导出朝向")!.props.onChange("-y");
    expect(h.parameters.exportOrientation).toBe("-y");
    expect(h.control("四边形拓扑（输出 FBX）")).toBeUndefined();
});

test("real panel offers delight only for texture 3.5, defaults on and clears stale explicit values", () => {
    const h = harness();
    expect(h.control("去除图像光照")).toBeUndefined();
    h.control("贴图版本")!.props.onChange("v3.5-20260815");
    expect(h.parameters).not.toHaveProperty("delight");
    expect(h.control("去除图像光照")?.props.checked).toBe(true);
    h.control("去除图像光照")!.props.onChange(false);
    expect(h.parameters.delight).toBe(false);
    expect(h.control("去除图像光照")?.props.checked).toBe(false);
    h.control("贴图版本")!.props.onChange("v3.0-20250812");
    expect(h.parameters).not.toHaveProperty("delight");
    expect(h.control("去除图像光照")).toBeUndefined();
    h.control("贴图版本")!.props.onChange("v3.5-20260815");
    expect(h.control("去除图像光照")?.props.checked).toBe(true);
    h.control("去除图像光照")!.props.onChange(false);
    h.control("生成贴图")!.props.onChange(false);
    expect(h.parameters).not.toHaveProperty("delight");
    expect(h.control("去除图像光照")).toBeUndefined();
    expect(h.control("贴图版本")).toBeUndefined();
});

test("real seed inputs allow signed integers without a UI lower bound", () => {
    const h = harness();
    for (const label of ["模型随机种子", "图像随机种子", "贴图随机种子"]) {
        const input = h.control(label)!;
        expect(input.props.min).toBeUndefined();
        input.props.onChange(-42);
        expect(h.control(label)?.props.value).toBe(-42);
    }
    expect(model3DParameterError("text", h.parameters, capabilities)).toBe("");
});
