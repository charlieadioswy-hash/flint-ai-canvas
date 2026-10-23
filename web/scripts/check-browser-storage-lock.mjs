// Exercises the production mutex in isolated Chromium pages; no application API
// or supplier is called. Run with bun scripts/check-browser-storage-lock.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const output = join(root, ".local/cache/http-storage-lock");
const candidates = [
    process.env.CHROME_BIN,
    join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
].filter(Boolean);
const chromePath = candidates.find(existsSync);
assert(chromePath, "Set CHROME_BIN to an installed Chromium executable");
const build = await Bun.build({ entrypoints: [join(root, "web/scripts/helpers/browser-storage-lock-fixture.ts")], target: "browser", format: "esm", define: { "import.meta.env": "{}" } });
assert(build.success, String(build.logs));
const moduleSource = await build.outputs[0].text();
const html = `<!doctype html><script type="module">
import * as fixture from '/lock.js';
await fixture.ready;
window.fixture = fixture;
window.withLock = fixture.withBrowserStorageLock;
window.sleep = fixture.sleep;
window.state = fixture.state;
window.increment = fixture.increment;
window.ready = true;
</script>`;
const requests = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(request.url);
    return new Response(new URL(request.url).pathname === "/lock.js" ? moduleSource : html, { headers: { "Content-Type": new URL(request.url).pathname === "/lock.js" ? "application/javascript" : "text/html" } });
} });
const profile = await mkdtemp(join(tmpdir(), "flint-storage-lock-check-"));
const browserEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/proxy/i.test(key)));
const browserProcess = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--no-proxy-server", "--proxy-server=direct://", "--proxy-bypass-list=*", "--host-resolver-rules=MAP storage-lock.test 127.0.0.1", "about:blank"], { stdio: "ignore", env: browserEnvironment });
const sockets = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(operation) {
    const started = Date.now();
    while (Date.now() - started < 15_000) {
        const value = await operation();
        if (value) return value;
        await delay(25);
    }
    throw new Error("Browser check timed out");
}
async function connect(url) {
    const socket = new WebSocket(url);
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const pending = new Map();
    const events = [];
    let nextId = 0;
    socket.onmessage = event => {
        const message = JSON.parse(String(event.data));
        if (["Runtime.exceptionThrown", "Network.loadingFailed", "Network.responseReceived"].includes(message.method)) events.push({method: message.method, ...message.params});
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
    };
    socket.onclose = () => { for (const entry of pending.values()) entry.reject(new Error("Browser page closed")); pending.clear(); };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });
    return { call, events, async evaluate(expression) {
        const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
        return response.result.value;
    } };
}
let browser;
try {
    const activePort = await until(() => readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => undefined));
    const [port, path] = activePort.trim().split("\n");
    browser = await connect(`ws://127.0.0.1:${port}${path}`);
    async function page(host = "storage-lock.test") {
        const { targetId } = await browser.call("Target.createTarget", { url: `http://${host}:${server.port}/` });
        const target = await until(async () => (await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())).find(candidate => candidate.id === targetId));
        const client = await connect(target.webSocketDebuggerUrl);
        await client.call("Runtime.enable");
        await client.call("Network.enable");
        const navigation = await client.call("Page.navigate", { url: `http://${host}:${server.port}/` });
        assert(!navigation.errorText, navigation.errorText);
        try {
            await until(() => client.evaluate("window.ready === true"));
        } catch (error) {
            console.error(JSON.stringify({page: await client.evaluate("({url:location.href,html:document.documentElement.outerHTML})"), navigation, requests, events: client.events}, null, 2));
            throw error;
        }
        return { ...client, targetId };
    }
    const a = await page();
    const b = await page();
    const support = await a.evaluate("({ secure: isSecureContext, locks: Boolean(navigator.locks), uuid: typeof crypto.randomUUID, indexedDB: Boolean(indexedDB) })");
    assert.deepEqual(support, { secure: false, locks: false, uuid: "undefined", indexedDB: true });
    await a.evaluate("state({count:0,active:false})");
    await Promise.all([a.evaluate("increment(12)"), b.evaluate("increment(12)")]);
    assert.deepEqual(await a.evaluate("state()"), { count: 24, active: false });
    const nested = await a.evaluate("withLock('generation-effect', 'outer', () => withLock('canvas-storage', 'inner', async () => 42))");
    assert.equal(nested, 42);
    await assert.rejects(a.evaluate("withLock('generation-effect', 'failure', async () => { throw new Error('intentional callback failure'); })"), /intentional callback failure/);
    assert.equal(await b.evaluate("withLock('generation-effect', 'failure', async () => 'reentered')"), "reentered");

    const closing = await page();
    await closing.evaluate("window.holding = false; window.held = withLock('generation-effect', 'closed-owner', async () => { window.holding = true; await new Promise(() => {}); }); true");
    await until(() => closing.evaluate("window.holding"));
    await b.evaluate("window.entered = false; window.waiter = withLock('generation-effect', 'closed-owner', async () => { window.entered = true; return 'released'; }); true");
    await delay(100);
    assert.equal(await b.evaluate("window.entered"), false);
    await browser.call("Target.closeTarget", { targetId: closing.targetId });
    assert.equal(await b.evaluate("window.waiter"), "released");

    const denied = await page();
    const deniedResult = await denied.evaluate("(async () => { Object.defineProperty(globalThis, 'indexedDB', { value: undefined }); let entered = false; try { await withLock('canvas-storage', 'denied', async () => { entered = true; }); return { entered, rejected: false }; } catch (error) { return { entered, rejected: true, message: error.message }; } })()");
    assert.equal(deniedResult.entered, false);
    assert.equal(deniedResult.rejected, true);
    assert.match(deniedResult.message, /IndexedDB/);
    const secure = await page("127.0.0.1");
    assert.equal(await secure.evaluate("isSecureContext && Boolean(navigator.locks)"), true);
    assert.equal(await secure.evaluate("Object.defineProperty(globalThis, 'indexedDB', { value: undefined }); withLock('canvas-storage', 'native', async () => 'native')"), "native");

    const abortOrderings = [];
    for (const kind of ["suspended", "delayed-ready", "started-write"]) {
        const key = `abort-${kind}`;
        await b.evaluate(`fixture.write('${key}', 'baseline')`);
        await a.evaluate(`fixture.beginAbortCase('${key}', '${kind}'); true`);
        const phase = kind === "started-write" ? "data-started" : kind === "delayed-ready" ? "delayed-ready" : "entered";
        await until(() => a.evaluate(`fixture.status().phase === '${phase}'`));
        await a.evaluate("fixture.abortMutex(); true");
        assert.equal(await a.evaluate("fixture.settled()"), "rejected");
        const competitor = await b.evaluate(`fixture.compete('${key}', 'competitor')`);
        assert.deepEqual(competitor, { before: "baseline", after: "competitor" });
        await a.evaluate("fixture.resume(); true");
        assert.equal(await a.evaluate("fixture.callbackSettled()"), "rejected");
        assert.equal(await b.evaluate(`fixture.read('${key}')`), "competitor");
        const status = await a.evaluate("fixture.status()");
        if (kind === "started-write") {
            assert.equal(status.dataTransactions, 1);
            assert.equal(status.dataAborted, true);
            assert.deepEqual(status.events, ["data-started", "mutex-aborted", "data-aborted"]);
        } else assert.equal(status.dataTransactions, 0);
        abortOrderings.push({ kind, ...status, staleWriteRejected: true, competitor });
    }

    const consumer = await a.evaluate("fixture.consumer()");
    assert.equal(consumer.applied, 1);
    assert.equal(consumer.assetCount, 1);
    for (const node of [consumer.live, consumer.durable]) {
        assert.equal(node.metadata.status, "success");
        assert.equal(node.metadata.storageKey, "resource:http-image");
        assert.equal(node.metadata.assetId, "generation_e8a36a9adf905e4dfd72cd164c1f5b412e6464d00dc490e3d988121db742e6e4");
        assert.equal(node.title, "用户标题");
        assert.deepEqual(node.position, {x:700,y:100});
        assert.equal(node.width, 320);
        assert.equal(node.height, 240);
    }

    await a.call("Performance.enable");
    const metrics = async () => Object.fromEntries((await a.call("Performance.getMetrics")).metrics.map(metric => [metric.name, metric.value]));
    const keepAlive = [];
    for (const mode of ["get", "getKey", "batch32"]) {
        const before = await metrics();
        const start = performance.now();
        const requestCount = await a.evaluate(`fixture.cpuSample('${mode}')`);
        const elapsedMs = performance.now() - start;
        const after = await metrics();
        keepAlive.push({ mode, elapsedMs, requestCount, taskMs: (after.TaskDuration - before.TaskDuration) * 1000, scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000 });
    }
    const evidence = { support, realms: 2, concurrentIncrements: 24, noOverlaps: true, nestedNamespaces: true, failureReentry: true, closedWindowRelease: true, unavailableRejected: true, nativeWebLocks: true, abortOrderings, consumer, keepAlive };
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "browser-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify(evidence, null, 2));
} finally {
    for (const socket of sockets) socket.close();
    server.stop(true);
    browserProcess.kill("SIGTERM");
    await new Promise(resolve => { if (browserProcess.exitCode !== null || browserProcess.signalCode !== null) resolve(); else browserProcess.once("exit", resolve); });
    await rm(profile, { recursive: true, force: true });
}
