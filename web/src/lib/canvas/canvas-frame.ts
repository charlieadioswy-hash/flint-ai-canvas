import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type Position } from "@/types/canvas";
import { buildCanvasSpatialIndex, canvasNodeBounds, type CanvasSpatialIndex } from "@/lib/canvas/canvas-spatial-index";

export const FRAME_HEADER_HEIGHT = 36;
export const FRAME_PADDING = 24;
export const FRAME_COLLAPSED_WIDTH = 240;
export const FRAME_COLLAPSED_HEIGHT = 144;
export const FOLDER_COLLAPSED_WIDTH = 360;
export const FOLDER_COLLAPSED_HEIGHT = 280;

export function isFrameNode(node?: CanvasNodeData | null): node is CanvasNodeData & { type: CanvasNodeType.Frame } {
    return node?.type === CanvasNodeType.Frame;
}

export function isCanvasFolderNode(node?: CanvasNodeData | null) {
    return isFrameNode(node) && Boolean(node.metadata?.folder);
}

export function canFrameContain(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Drawing || node.type === CanvasNodeType.Script || node.type === CanvasNodeType.Video;
}

export function canFolderContain(node: CanvasNodeData) {
    return node.type !== CanvasNodeType.Frame;
}

export function canLinkedFolderArchive(node: CanvasNodeData) {
    return (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio || node.type === CanvasNodeType.Text) && Boolean(node.metadata?.assetId || node.metadata?.content?.trim());
}

export function getFrameChildren(frameId: string, nodes: CanvasNodeData[]) {
    return nodes.filter((node) => node.parentId === frameId);
}

export function getFrameChildIds(frameId: string, nodes: CanvasNodeData[]) {
    return new Set(getFrameChildren(frameId, nodes).map((node) => node.id));
}

export function getCollapsedParentFrame(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    if (!node.parentId) return null;
    const frame = nodes.find((item) => item.id === node.parentId && isFrameNode(item));
    return frame?.metadata?.frame?.collapsed ? frame : null;
}

export function isNodeHiddenByCollapsedFrame(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    return Boolean(getCollapsedParentFrame(node, nodes));
}

/** Build minimap input in one pass; parent lookup must stay O(1) on large canvases. */
export function visibleCanvasMinimapNodes(nodes: CanvasNodeData[]) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const collapsedFrameIds = new Set(nodes.filter((node) => isFrameNode(node) && node.metadata?.frame?.collapsed).map((node) => node.id));
    return nodes.filter((node) => {
        const parent = node.parentId ? byId.get(node.parentId) : undefined;
        return !parent || !collapsedFrameIds.has(parent.id);
    });
}

export function findFrameDropTarget(nodes: CanvasNodeData[], draggedNodeIds: Set<string>) {
    const dragged = nodes.filter((node) => draggedNodeIds.has(node.id));
    if (!dragged.length) return null;

    return [...nodes].reverse().find((frame) => isValidFrameDropTarget(frame, dragged, draggedNodeIds))?.id || null;
}

export type CanvasFrameDropIndex = CanvasSpatialIndex<CanvasNodeData>;

export function buildCanvasFrameDropIndex(nodes: CanvasNodeData[]): CanvasFrameDropIndex {
    return buildCanvasSpatialIndex(nodes.filter(isFrameNode).map((node) => ({ id: node.id, bounds: canvasNodeBounds(node), value: node })));
}

/** Finds a drop target using the drag preview offset without rebuilding all node positions. */
export function findFrameDropTargetFromIndex(index: CanvasFrameDropIndex, draggedNodes: CanvasNodeData[], draggedNodeIds: Set<string>, offset: Position) {
    if (!draggedNodes.length) return null;
    const centers = draggedNodes.map((node) => ({ x: node.position.x + offset.x + node.width / 2, y: node.position.y + offset.y + node.height / 2 }));
    const left = Math.min(...centers.map((center) => center.x)) - 0.01;
    const top = Math.min(...centers.map((center) => center.y)) - 0.01;
    const right = Math.max(...centers.map((center) => center.x)) + 0.01;
    const bottom = Math.max(...centers.map((center) => center.y)) + 0.01;
    return [...index.query({ left, top, right, bottom })].reverse().find((frame) => isValidFrameDropTarget(frame, draggedNodes, draggedNodeIds, offset))?.id || null;
}

function isValidFrameDropTarget(frame: CanvasNodeData, dragged: CanvasNodeData[], draggedNodeIds: Set<string>, offset: Position = { x: 0, y: 0 }) {
    if (!isFrameNode(frame) || (frame.metadata?.frame?.collapsed && !isCanvasFolderNode(frame)) || draggedNodeIds.has(frame.id)) return false;
    const canContain = frame.metadata?.folder?.assetFolderId ? canLinkedFolderArchive : isCanvasFolderNode(frame) ? canFolderContain : canFrameContain;
    if (!dragged.every(canContain)) return false;
    const left = frame.position.x;
    const top = frame.position.y + (isCanvasFolderNode(frame) && frame.metadata?.frame?.collapsed ? 0 : FRAME_HEADER_HEIGHT);
    const right = frame.position.x + frame.width;
    const bottom = frame.position.y + frame.height;
    return dragged.every((node) => {
        const centerX = node.position.x + offset.x + node.width / 2;
        const centerY = node.position.y + offset.y + node.height / 2;
        return centerX >= left && centerX <= right && centerY >= top && centerY <= bottom;
    });
}

export function applyFrameDrop(nodes: CanvasNodeData[], draggedNodeIds: Set<string>, frameId: string | null) {
    const target = frameId ? nodes.find((node) => node.id === frameId && isFrameNode(node)) : null;
    const canContain = target?.metadata?.folder?.assetFolderId ? canLinkedFolderArchive : target && isCanvasFolderNode(target) ? canFolderContain : canFrameContain;
    const next = nodes.map((node) => {
        if (!draggedNodeIds.has(node.id)) return node;
        if (!frameId) return node.parentId ? { ...node, parentId: undefined } : node;
        return target && canContain(node) ? { ...node, parentId: frameId } : node;
    });
    if (!target) return next;

    const children = getFrameChildren(target.id, next);
    if (!children.length) return next;
    const updates = new Map<string, CanvasNodeData>();
    collectFrameLayoutUpdates(target, children, updates);
    return next.map((node) => updates.get(node.id) || node);
}

/** Settle each directly dragged node independently; carried group children retain their parent. */
export function applyFrameDrops(nodes: CanvasNodeData[], draggedNodeIds: Set<string>) {
    const index = buildCanvasFrameDropIndex(nodes.filter((node) => !draggedNodeIds.has(node.id)));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const parentById = new Map<string, string | null>();
    const childrenByFrame = new Map<string, CanvasNodeData[]>();
    const archives = new Map<string, { folder: CanvasNodeData; nodes: CanvasNodeData[] }>();
    for (const id of draggedNodeIds) {
        const node = byId.get(id);
        if (!node || isFrameNode(node)) continue;
        const targetId = findFrameDropTargetFromIndex(index, [node], draggedNodeIds, { x: 0, y: 0 });
        const target = targetId ? byId.get(targetId) : undefined;
        if (target?.metadata?.folder?.assetFolderId) {
            const archive = archives.get(target.id) || { folder: target, nodes: [] };
            archive.nodes.push(node);
            archives.set(target.id, archive);
            continue;
        }
        parentById.set(id, targetId);
        if (targetId && !childrenByFrame.has(targetId)) childrenByFrame.set(targetId, []);
    }
    if (!parentById.size) return { nodes, archives: Array.from(archives.values()) };

    // Resolve all memberships before measuring frames, so departing children cannot expand or be laid out in their old frame.
    const next = nodes.map((node) => {
        const parentId = parentById.get(node.id);
        const updated = parentById.has(node.id) && node.parentId !== (parentId || undefined) ? { ...node, parentId: parentId || undefined } : node;
        if (updated.parentId) childrenByFrame.get(updated.parentId)?.push(updated);
        return updated;
    });
    const updates = new Map<string, CanvasNodeData>();
    for (const [frameId, children] of childrenByFrame) {
        collectFrameLayoutUpdates(byId.get(frameId)!, children, updates);
    }
    return { nodes: updates.size ? next.map((node) => updates.get(node.id) || node) : next, archives: Array.from(archives.values()) };
}

function collectFrameLayoutUpdates(frame: CanvasNodeData, children: CanvasNodeData[], updates: Map<string, CanvasNodeData>) {
    if (!children.length) return;
    if (isCanvasFolderNode(frame) && frame.metadata?.frame?.collapsed) {
        collectCollapsedFolderLayoutUpdates(frame, children, updates);
        return;
    }

    let left = frame.position.x;
    let top = frame.position.y;
    let right = left + frame.width;
    let bottom = top + frame.height;
    for (const child of children) {
        left = Math.min(left, child.position.x - FRAME_PADDING);
        top = Math.min(top, child.position.y - FRAME_HEADER_HEIGHT - FRAME_PADDING);
        right = Math.max(right, child.position.x + child.width + FRAME_PADDING);
        bottom = Math.max(bottom, child.position.y + child.height + FRAME_PADDING);
    }
    updates.set(frame.id, {
        ...frame,
        position: { x: left, y: top },
        width: right - left,
        height: bottom - top,
        metadata: {
            ...frame.metadata,
            frame: {
                ...frame.metadata?.frame,
                collapsed: false,
                expandedWidth: right - left,
                expandedHeight: bottom - top,
            },
        },
    });
}

function collectCollapsedFolderLayoutUpdates(folder: CanvasNodeData, children: CanvasNodeData[], updates: Map<string, CanvasNodeData>) {
    const gap = 24;
    const padding = FRAME_PADDING;
    const columns = Math.min(3, Math.ceil(Math.sqrt(children.length)));
    const rows = Math.ceil(children.length / columns);
    let cellWidth = 0;
    let cellHeight = 0;
    for (const child of children) {
        cellWidth = Math.max(cellWidth, child.width);
        cellHeight = Math.max(cellHeight, child.height);
    }
    const expandedWidth = padding * 2 + columns * cellWidth + Math.max(columns - 1, 0) * gap;
    const expandedHeight = FRAME_HEADER_HEIGHT + padding * 2 + rows * cellHeight + Math.max(rows - 1, 0) * gap;
    updates.set(folder.id, {
        ...folder,
        metadata: {
            ...folder.metadata,
            frame: { ...folder.metadata?.frame, collapsed: true, expandedWidth, expandedHeight },
        },
    });
    children.forEach((node, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        updates.set(node.id, {
            ...node,
            position: {
                x: folder.position.x + padding + column * (cellWidth + gap) + (cellWidth - node.width) / 2,
                y: folder.position.y + FRAME_HEADER_HEIGHT + padding + row * (cellHeight + gap) + (cellHeight - node.height) / 2,
            },
        });
    });
}

export function resolveFrameConnection(connection: CanvasConnection, nodes: CanvasNodeData[]) {
    const from = nodes.find((node) => node.id === connection.fromNodeId);
    const to = nodes.find((node) => node.id === connection.toNodeId);
    if (!from || !to) return null;

    const displayFrom = getCollapsedParentFrame(from, nodes) || from;
    const displayTo = getCollapsedParentFrame(to, nodes) || to;
    if (displayFrom.id === displayTo.id) return null;
    return { from: displayFrom, to: displayTo };
}
