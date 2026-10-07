import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

/** 与后端生成素材登记使用同一 SHA-256 身份；内网 HTTP 也必须保持一致。 */
export function generationAssetId(effectKey: string) {
    return `generation_${bytesToHex(sha256(new TextEncoder().encode(effectKey)))}`;
}
