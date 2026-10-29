// Real /screen-creation route, local API fixture, no supplier calls.
// Run: cd web && bun scripts/check-checkbox-scroll.mjs (CHROME_BIN optional).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultImageCapabilityConfig } from "../src/lib/model-capabilities.ts";

const root = resolve(import.meta.dir, "../..");
const output = join(root, ".local/cache/checkbox-scroll");
const chromePath = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find(existsSync);
assert(chromePath, "Set CHROME_BIN to an installed Chromium executable");
await mkdir(output, { recursive: true });
const image = defaultImageCapabilityConfig("liblib-image");
const controlModel = "a311363995dd4f2fa42ee3fc9582d920";
image.controlNet = { supported: true, baseModel: "sdxl", maxUnits: 1, preprocessors: ["inpaint_only"], models: [controlModel] };
const channels = [{ id: "layout-check", name: "Liblib", displayName: "Liblib", models: [{
    id: "layout-model", modelKey: "layout-model", displayName: "Layout fixture", capability: "image", protocol: "liblib-image",
    capabilityConfig: { version: 1, image }, defaultOptions: { family: "sd", textToImageTemplateUuid: "e10adc3949ba59abbe56e057f20f883e", controlNetModel: controlModel }, available: true,
    priceTiers: [{ id: "layout-price", selector: {}, billingMode: "fixed_request", unitPriceMicrocredits: 1000000 }],
    pricingMode: "fixed_request", displayPrice: 1000000,
}] }];
const features = { welcomeEnabled: false, shortDramaEnabled: true, taskCenterEnabled: true, creditsEnabled: false, customChannelsEnabled: true, frontendModelsEnabled: false, pluginCenterEnabled: false, systemPluginsVisibleToUsers: false };
const writes = [];
const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (!["GET", "HEAD"].includes(request.method)) {
        writes.push({ method: request.method, path });
        return Response.json({ code: 403, msg: "Writes disabled in layout check" }, { status: 403 });
    }
    let data = {};
    if (path === "/api/auth/session") data = { user: { id: "layout-test", username: "layout-test", displayName: "布局验证", role: "user", status: "active" }, features, runtimeLimits: { activeTaskLimit: 5, resourceUploadMB: 128, storedFileGB: 5 } };
    else if (path === "/api/model-catalog") data = { source: "system", channels };
    else if (path === "/api/channels/system") data = { channels: [] };
    else if (path === "/api/canvas-projects") data = { projects: [], total: 0, hasMore: false, page: 1, pageSize: 40 };
    else if (path === "/api/user-data/snapshot") data = { projects: [], assets: [] };
    else if (path === "/api/features") data = { features };
    else if (path === "/api/plugins") data = { plugins: [], states: {} };
    else if (path === "/api/plugins/status") data = { statuses: {}, states: {} };
    else if (path === "/api/public/appearance") data = { appearance: { brandName: "影策", brandSlug: "yingce", skinId: "classic", configured: false, revision: "test" } };
    else if (path.includes("announcements")) data = { announcements: [] };
    else if (path === "/api/resources/storage-usage") data = { usage: { usedBytes: 0, limitBytes: 5368709120, remainingBytes: 5368709120, usedPercent: 0 } };
    return Response.json({ code: 0, data, msg: "ok" });
} });
const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
const port = portProbe.port;
portProbe.stop(true);
const profile = await mkdtemp(join(tmpdir(), "flint-checkbox-scroll-"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        const value = await test();
        if (value) return value;
        await delay(50);
    }
    throw new Error(`Timed out: ${label}`);
}
let chrome, vite, socket;
const records = [], errors = [];
try {
    vite = spawn(process.execPath, ["--bun", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
        cwd: join(root, "web"), stdio: "ignore",
        env: { ...process.env, VITE_API_PROXY_TARGET: `http://127.0.0.1:${api.port}`, VITE_CANVAS_BACKEND_URL: "/api" },
    });
    await until(() => fetch(`http://127.0.0.1:${port}`).then(r => r.ok).catch(() => false), "Vite");
    chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--no-proxy-server", "about:blank"], { stdio: "ignore" });
    const active = await until(() => readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => null), "Chrome");
    const target = (await fetch(`http://127.0.0.1:${active.split("\n")[0]}/json/list`).then(r => r.json())).find(t => t.type === "page");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const pending = new Map();
    let sequence = 0;
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
        const entry = pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(message.id);
        message.error ? entry.reject(Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    };
    socket.onclose = () => {
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error("Browser closed")); }
        pending.clear();
    };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 15_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
        const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
        return response.result.value;
    };
    const selector = 'input[aria-label="完美像素（Pixel Perfect）"]';
    const input = `document.querySelector(${JSON.stringify(selector)})`;
    const settle = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const state = () => evaluate(`(() => {
        const input = ${input};
        const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        const hidden = [];
        for (let p = input.parentElement; p; p = p.parentElement) {
            const s = getComputedStyle(p);
            if ([s.overflowX, s.overflowY].includes('hidden')) hidden.push({ tag: p.tagName, className: p.className, top: p.scrollTop, left: p.scrollLeft });
        }
        const main = document.querySelector('main');
        return { checked: input.checked, focused: document.activeElement === input, open: document.querySelector('.screen-creation-advanced').open,
            main: rect(main), scrollTop: main.scrollTop, scrollLeft: main.scrollLeft, hidden };
    })()`);
    const click = async element => {
        const point = await evaluate(`(() => { const r = (${element}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
        await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
        await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
        await settle();
    };
    const centerInMain = async element => {
        await evaluate(`(() => { const main = document.querySelector('main'); const element = ${element};
            main.scrollTop += element.getBoundingClientRect().y - main.getBoundingClientRect().y - main.clientHeight / 2;
        })()`);
        await settle();
    };
    await call("Runtime.enable");
    await call("Page.enable");
    for (const [name, width, height, theme] of [["desktop-light", 1600, 1000, "light"], ["desktop-dark", 1600, 1000, "dark"], ["narrow-light", 390, 844, "light"], ["narrow-dark", 390, 844, "dark"]]) {
        await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
        await call("Page.navigate", { url: `http://127.0.0.1:${port}/screen-creation?new=1` });
        await until(() => evaluate(`Boolean(${input}) && document.querySelector('.screen-creation-advanced').textContent.includes('Inpaint')`), "screen creation route with configured model");
        await evaluate(`import('/src/stores/use-theme-store.ts').then(m => m.useThemeStore.getState().setTheme('${theme}'))`);
        await evaluate("document.fonts.ready.then(() => true)");
        await centerInMain("document.querySelector('.screen-creation-advanced > summary')");
        await click("document.querySelector('.screen-creation-advanced > summary')");
        // Only scroll the intended content area. scrollIntoView on the hidden input could mask the defect.
        await centerInMain(`${input}.closest('label')`);
        const before = await state();
        assert(before.open, `${name}: advanced settings open`);
        const verify = async action => {
            const after = await state();
            records.push({ name, action, before, after });
            const screenshot = await call("Page.captureScreenshot", { format: "png" });
            await writeFile(join(output, `${name}-${action}.png`), Buffer.from(screenshot.data, "base64"));
            assert.deepEqual(after.hidden.filter(p => p.top || p.left), [], `${name}: hidden workspace ancestors must not scroll on checkbox focus`);
            assert.deepEqual(after.main, before.main, `${name}: content viewport preserved`);
            assert.equal(after.scrollTop, before.scrollTop, `${name}: content scroll preserved`);
            assert.equal(after.scrollLeft, before.scrollLeft, `${name}: content horizontal scroll preserved`);
            assert(after.open && after.focused, `${name}: settings stay open and input keeps native focus`);
            return after;
        };
        await click(`${input}.closest('label').lastElementChild`);
        assert.equal((await verify("label")).checked, !before.checked, `${name}: label toggles on`);
        await call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
        await call("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
        await settle();
        assert.equal((await verify("space")).checked, before.checked, `${name}: Space toggles back`);
        await click(`${input}.nextElementSibling`);
        assert.equal((await verify("glyph")).checked, !before.checked, `${name}: glyph toggles on`);
        console.log(`PASS ${name}: label, Space and glyph preserve the workspace layout`);
    }
    assert.deepEqual(errors, [], "No uncaught browser errors");
    assert.deepEqual(writes, [], "No application writes or generation requests");
} finally {
    await writeFile(join(output, "result.json"), JSON.stringify({ records, errors, writes }, null, 2));
    socket?.close();
    async function stop(child) {
        if (!child || child.exitCode !== null) return;
        await new Promise(resolve => {
            const timer = setTimeout(() => { child.kill("SIGKILL"); }, 3000);
            child.once("exit", () => { clearTimeout(timer); resolve(); });
            child.kill("SIGTERM");
        });
    }
    await Promise.allSettled([stop(chrome), stop(vite)]);
    api.stop(true);
    await rm(profile, { recursive: true, force: true });
}
