import type { ImageCapabilityConfig } from "@/lib/model-capabilities";
import type { AiConfig } from "@/stores/use-config-store";

export type ScreenAdvancedSettings = {
    controlModel: string;
    strength: number;
    start: number;
    end: number;
    lowThreshold: number;
    highThreshold: number;
    resolution: number;
    steps: number;
    sampler: number;
    cfgScale: number;
    seed: number;
    denoisingStrength: number;
    negativePrompt: string;
};

export type ScreenCreationImage = {
    url: string;
    storageKey?: string;
    name: string;
    width?: number;
    height?: number;
};

export type ScreenCreationResult = {
    id: string;
    url: string;
    storageKey?: string;
    width?: number;
    height?: number;
    createdAt?: string;
};

export type ScreenCreationScene = { id: string; name: string; updatedAt?: string };
export type ScreenMaskMode = "auto" | "color" | "luminance" | "alpha";

export type ScreenCreationWorkspaceProps = {
    config: AiConfig;
    model: string;
    setModel: (model: string) => void;
    profile: ImageCapabilityConfig | undefined;
    size: string;
    quality?: string;
    setSize: (size: string, quality?: string) => void;
    mask: ScreenCreationImage | null;
    reference: ScreenCreationImage | null;
    uploadMask: (file: File) => void | Promise<void>;
    uploadReference: (file: File) => void | Promise<void>;
    clearMask: () => void;
    clearReference: () => void;
    maskMode: ScreenMaskMode;
    setMaskMode: (mode: ScreenMaskMode) => void;
    prompt: string;
    setPrompt: (prompt: string) => void;
    advanced: ScreenAdvancedSettings;
    setAdvanced: (patch: Partial<ScreenAdvancedSettings>) => void;
    effectiveMaskUrl?: string;
    effectiveMaskStorageKey?: string;
    results: ScreenCreationResult[];
    selectedResultId: string;
    setSelectedResultId: (id: string) => void;
    busy: boolean;
    uploading: boolean;
    loading: boolean;
    error?: string;
    statusText?: string;
    storageNotice?: string;
    canGenerate: boolean;
    disabledReason?: string;
    generate: () => void | Promise<void>;
    generateLabel?: string;
    quoteLabel?: string;
    quotePending?: boolean;
    canvasId?: string;
    sceneName?: string;
    recentScenes: ScreenCreationScene[];
    recentLoading?: boolean;
    recentError?: string;
    recentHasMore?: boolean;
    recentLoadingMore?: boolean;
    loadMoreScenes?: () => void;
    retryRecentScenes?: () => void;
    openScene: (id: string) => void;
    newScene: () => void;
    openCanvas: () => void;
    downloadResult: (id: string) => void | Promise<void>;
};
