import { Model3DDownloadModal } from "@/components/assets/model3d-download-modal";
import type { ModelAsset } from "@/stores/use-asset-store";

export function AssetModelDownloadModal({ asset, ownerId, onClose }: { asset: ModelAsset; ownerId: string; onClose: () => void }) {
    return <Model3DDownloadModal source={asset.data} sourceId={asset.id} title={asset.title} ownerId={ownerId} onClose={onClose} />;
}
