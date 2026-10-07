import { lazy, Suspense } from "react";
import { LoaderCircle } from "lucide-react";

import { modelThumbnailFormat } from "@/lib/model-thumbnail";
import type { ModelAsset } from "@/stores/use-asset-store";

const Viewer = lazy(() => import("./model3d-viewer").then((module) => ({ default: module.Model3DViewer })));

export function ModelAssetPreview({ asset }: { asset: ModelAsset }) {
    const format = modelThumbnailFormat(asset.data);
    return (
        <div className="relative h-[clamp(260px,50vh,400px)] w-full overflow-hidden" data-asset-model-preview>
            {format ? (
                <Suspense
                    fallback={
                        <div className="flex size-full items-center justify-center gap-2 bg-background text-xs text-muted-foreground">
                            <LoaderCircle className="size-4 motion-safe:animate-spin" />
                            正在加载模型
                        </div>
                    }
                >
                    <Viewer key={asset.id} storageKey={asset.data.storageKey} url={asset.data.url} format={format} expanded />
                </Suspense>
            ) : (
                <div className="flex size-full items-center justify-center bg-background px-5 text-center text-sm text-muted-foreground">此格式暂不支持在线预览，可下载模型查看。</div>
            )}
        </div>
    );
}
