import { AnimationMixer, type AnimationAction, type Object3D } from "three";

type PlaybackState = { index: number; playing: boolean; time: number; duration: number };

/** Owns a frame only while explicitly playing; pausing/unmounting frees it immediately. */
export function createModel3DPlayback(model: Object3D, render: () => void, onState: (state: PlaybackState) => void, schedule = requestAnimationFrame, cancel = cancelAnimationFrame) {
    const mixer = new AnimationMixer(model);
    const clips = model.animations.filter((clip) => clip.duration > 0 && Number.isFinite(clip.duration));
    let index = 0;
    let playing = false;
    let disposed = false;
    let visible = true;
    let frame: number | undefined;
    let last = 0;
    let lastReport = 0;
    let action: AnimationAction | undefined;
    const report = () => onState({ index, playing, time: action?.time || 0, duration: clips[index]?.duration || 0 });
    const cancelFrame = () => { if (frame !== undefined) cancel(frame); frame = undefined; last = 0; };
    const tick = (timestamp: number) => {
        frame = undefined;
        if (disposed || !playing || !visible) return;
        mixer.update(last ? Math.min(Math.max((timestamp - last) / 1000, 0), 0.1) : 0);
        last = timestamp;
        render();
        if (timestamp - lastReport >= 200) { report(); lastReport = timestamp; }
        frame = schedule(tick);
    };
    const queue = () => { if (!disposed && playing && visible && frame === undefined) frame = schedule(tick); };
    const select = (value: number) => {
        if (disposed || !clips[value]) return;
        mixer.stopAllAction();
        index = value;
        action = mixer.clipAction(clips[index]);
        action.reset().play();
        mixer.update(0);
        render();
        report();
    };
    return {
        clips: clips.map((clip, i) => ({ name: clip.name || `动作 ${i + 1}`, duration: clip.duration })),
        select,
        play() { if (disposed || !clips.length) return; if (!action) select(index); playing = true; report(); queue(); },
        pause() { playing = false; cancelFrame(); if (!disposed) report(); },
        seek(time: number) { if (disposed || !Number.isFinite(time)) return; if (!action) select(index); if (!action) return; action.time = Math.max(0, Math.min(time, clips[index].duration)); mixer.update(0); render(); report(); },
        setSpeed(speed: number) { if (Number.isFinite(speed) && speed > 0 && speed <= 2) mixer.timeScale = speed; },
        setVisible(value: boolean) { visible = value; if (value) queue(); else cancelFrame(); },
        dispose() { disposed = true; playing = false; cancelFrame(); mixer.stopAllAction(); mixer.uncacheRoot(model); },
    };
}

export function model3DPartObjects(model: Object3D, names: string[]) {
    const wanted = new Set(names);
    const selected = new Set<Object3D>();
    const result: Array<{ id: string; name: string; object: Object3D }> = [];
    model.traverse((object) => {
        const name = typeof object.userData.name === "string" ? object.userData.name : object.name;
        if (!wanted.has(name)) return;
        for (let parent = object.parent; parent; parent = parent.parent) if (selected.has(parent)) return;
        selected.add(object);
        result.push({ id: object.uuid, name, object });
    });
    return result;
}
