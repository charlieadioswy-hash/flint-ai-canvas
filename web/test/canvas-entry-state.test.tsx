import { afterAll, expect, test } from "bun:test";
import { useCanvasUiStore } from "../src/stores/canvas/use-canvas-ui-store";
import { useCanvasStore } from "../src/stores/canvas/use-canvas-store";
import { resolveCanvasEmptyStateKind } from "../src/lib/canvas/canvas-starter";

const canvasOptions = useCanvasStore.persist.getOptions();
const canvasState = useCanvasStore.getState();
const uiState = useCanvasUiStore.getState();
useCanvasStore.persist.setOptions({ storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } });
await useCanvasStore.persist.rehydrate();
afterAll(() => {
    useCanvasStore.setState(canvasState);
    useCanvasStore.persist.setOptions(canvasOptions);
    useCanvasUiStore.setState(uiState);
});

test("new canvas enters freeform while historical imports and guided entries retain their meaning", () => {
    const state = useCanvasStore.getState();
    const created = state.createProject("New canvas");
    const kind = (id: string) => {
        const project = useCanvasStore.getState().openProject(id)!;
        return resolveCanvasEmptyStateKind({ nodeCount: project.nodes.length, starterMode: project.starterMode, shortDramaEnabled: true, isProjectLinked: Boolean(project.projectId) });
    };
    expect(kind(created)).toBe("freeform");
    expect(kind(state.importProject({ title: "Legacy" }))).toBe("guided");
    expect(kind(state.importProject({ title: "Guided", starterMode: "guided" }))).toBe("guided");
    expect(kind(state.createProject("Project canvas", "project-1"))).toBe("linked");
    state.updateProject(created, { starterMode: "guided" });
    expect(kind(created)).toBe("guided");
});

test("minimap starts expanded and user choice survives other canvas UI interactions", () => {
    expect(useCanvasUiStore.getInitialState().isMiniMapOpen).toBe(true);
    useCanvasUiStore.setState({ isMiniMapOpen: true });
    useCanvasUiStore.getState().toggleMiniMap();
    useCanvasUiStore.getState().startEditingProject("other-canvas", "Other canvas");
    useCanvasUiStore.getState().stopEditingProject();
    expect(useCanvasUiStore.getState().isMiniMapOpen).toBe(false);
    useCanvasUiStore.getState().toggleMiniMap();
    expect(useCanvasUiStore.getState().isMiniMapOpen).toBe(true);
});
