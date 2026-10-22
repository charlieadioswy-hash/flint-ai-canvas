import { useEffect, useRef } from "react";

export function AgentAvatarVideo({ src, loop = true, onError, className }: { src: string; loop?: boolean; onError?: () => void; className?: string }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const errorRef = useRef(onError);
    const playbackFailedRef = useRef(false);
    errorRef.current = onError;

    useEffect(() => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas) return;
        playbackFailedRef.current = false;
        let animationFrame = 0;
        let videoFrame = 0;
        let disposed = false;
        let lastFrameTime = -1;
        const stopFrames = () => {
            disposed = true;
            if (animationFrame) cancelAnimationFrame(animationFrame);
            if (videoFrame && typeof video.cancelVideoFrameCallback === "function") video.cancelVideoFrameCallback(videoFrame);
        };
        const fail = () => {
            if (disposed) return;
            playbackFailedRef.current = true;
            stopFrames();
            video.pause();
            canvas.width = canvas.width;
            errorRef.current?.();
        };
        const cleanup = () => {
            stopFrames();
            video.removeEventListener("error", fail);
        };
        video.addEventListener("error", fail);
        // Reset both the previous frame and the origin-clean flag when changing clips.
        canvas.width = canvas.width;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context || video.error) {
            fail();
            return cleanup;
        }
        const drawFrame = () => {
            if (disposed || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth <= 0 || video.videoHeight <= 0 || video.currentTime === lastFrameTime) return;
            lastFrameTime = video.currentTime;
            try {
                const scale = Math.min(1, 320 / Math.max(video.videoWidth, video.videoHeight));
                const width = Math.max(1, Math.round(video.videoWidth * scale));
                const height = Math.max(1, Math.round(video.videoHeight * scale));
                if (canvas.width !== width || canvas.height !== height) {
                    canvas.width = width;
                    canvas.height = height;
                }
                context.drawImage(video, 0, 0, width, height);
                const image = context.getImageData(0, 0, width, height);
                const pixels = image.data;
                for (let index = 0; index < pixels.length; index += 4) {
                    const red = pixels[index];
                    const green = pixels[index + 1];
                    const blue = pixels[index + 2];
                    const greenLead = green - Math.max(red, blue);
                    if (green > 70 && greenLead > 12 && green > red * 1.12 && green > blue * 1.08) {
                        const opacity = Math.max(0, Math.min(1, (38 - greenLead) / 26));
                        pixels[index + 1] = Math.max(red, blue, green - Math.round((1 - opacity) * greenLead * 0.75));
                        pixels[index + 3] = Math.round(pixels[index + 3] * opacity);
                    }
                }
                context.putImageData(image, 0, 0);
            } catch {
                fail();
            }
        };
        const scheduleFrame = () => {
            if (disposed) return;
            if (typeof video.requestVideoFrameCallback === "function") {
                videoFrame = video.requestVideoFrameCallback(() => {
                    drawFrame();
                    scheduleFrame();
                });
            } else {
                animationFrame = requestAnimationFrame(() => {
                    drawFrame();
                    scheduleFrame();
                });
            }
        };
        drawFrame();
        scheduleFrame();
        return cleanup;
    }, [src]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video || playbackFailedRef.current) return;
        video.loop = loop;
        if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) void video.play().catch(() => undefined);
    }, [src, loop]);

    return (
        <>
            <canvas ref={canvasRef} className={className ?? "canvas-agent-keyed-video"} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none", userSelect: "none" }} aria-hidden="true" />
            <video
                ref={videoRef}
                crossOrigin="use-credentials"
                src={src}
                autoPlay
                muted
                loop={loop}
                playsInline
                preload="auto"
                aria-hidden="true"
                draggable={false}
                className="canvas-agent-video-source"
                style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
            />
        </>
    );
}
