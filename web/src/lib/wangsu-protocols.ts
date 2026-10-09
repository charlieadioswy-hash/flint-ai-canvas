const baseProtocols: Record<string, string> = {
    "wangsu-chat": "chat-completion",
    "wangsu-responses": "openai-response",
    "wangsu-openai-chat": "chat-completion",
    "wangsu-openai-responses": "openai-response",
    "wangsu-anthropic": "claude-api",
    "wangsu-gemini": "gemini-image",
    "wangsu-gemini-image": "gemini-image",
    "wangsu-chat-image": "wangsu-chat-image",
    "wangsu-images": "openai-image",
    "wangsu-openai-images": "openai-image",
    "wangsu-videos": "newapi",
    "wangsu-openai-videos": "newapi",
    "wangsu-audio": "openai-audio",
    "wangsu-openai-audio": "openai-audio",
};

// The selected provider ID stays intact; only the wire format is shared.
export function wangsuBaseProtocol(protocol?: string) {
    return protocol ? baseProtocols[protocol] || protocol : protocol;
}

export function wangsuRequestPath(protocol: string | undefined, path: string) {
    if (!protocol || !baseProtocols[protocol]) return undefined;
    if (protocol.startsWith("wangsu-openai-")) return `/openai${path}`;
    if (protocol === "wangsu-anthropic") return `/anthropic/v1${path}`;
    if (protocol === "wangsu-gemini" || protocol === "wangsu-gemini-image") return `/gemini/v1beta${path}`;
    return path;
}
