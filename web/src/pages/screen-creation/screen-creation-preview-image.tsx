import { useState, type ImgHTMLAttributes, type ReactNode } from "react";

import { CachedResourceImage } from "@/components/cached-resource-image";

type ScreenCreationPreviewImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
    src: string;
    storageKey?: string;
    fallback: ReactNode;
    eager?: boolean;
};

// Unsaved files belong to this form's session, while saved images need resource
// authorization and URL refresh through the shared media component.
export function ScreenCreationPreviewImage({ storageKey, src, eager, ...props }: ScreenCreationPreviewImageProps) {
    if (!storageKey && src.startsWith("blob:")) return <LocalPreviewImage key={src} src={src} {...props} />;
    return <CachedResourceImage storageKey={storageKey} src={src.startsWith("blob:") ? "" : src} eager={eager} {...props} />;
}

function LocalPreviewImage({ src, fallback, onError, ...props }: Omit<ScreenCreationPreviewImageProps, "storageKey" | "eager">) {
    const [failed, setFailed] = useState(false);
    if (failed) return <>{fallback}</>;
    return <img {...props} src={src} decoding="async" onError={(event) => { setFailed(true); onError?.(event); }} />;
}
