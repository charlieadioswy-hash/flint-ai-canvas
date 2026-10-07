import { createContext, useContext } from "react";
import type { Model3DCapabilities } from "@/services/api/model3d";
import type { CanvasNodeData } from "@/types/canvas";

export type CanvasModel3DContextValue = {
    capabilities: Model3DCapabilities | null;
    nodes: CanvasNodeData[];
    inputNodes: (nodeId: string) => CanvasNodeData[];
    generate: (nodeId: string) => Promise<void>;
    refreshTask: (nodeId: string, recover?: boolean) => Promise<void>;
    openParameters: (nodeId: string) => void;
};
export const CanvasModel3DContext = createContext<CanvasModel3DContextValue | null>(null);
export function useCanvasModel3DContext() {
    return useContext(CanvasModel3DContext);
}
