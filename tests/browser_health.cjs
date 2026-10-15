// Optional real-browser checks, using an already installed Chrome/Edge and Node only.
// Run: node tests/browser_health.cjs
// No Flask process. API responses are mocked; only the template's existing CDN assets
// are allowed through the browser network. Screenshots/profile live in the OS temp dir.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const browser = process.env.HEALTH_TEST_BROWSER || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(p => fs.existsSync(p));
if (!browser) throw new Error('No installed browser found. Set HEALTH_TEST_BROWSER; do not install automatically.');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-health-browser-'));
const profile = path.join(artifacts, 'profile');
const child = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-extensions',
    '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
let socket;
const pending = new Map();
let serial = 0;
let sessionId;
let passed = 0;
const failures = [];
const errors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const template = pathToFileURL(path.resolve(__dirname, '../templates/index.html')).href;

async function send(method, params = {}, session = sessionId) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
        pending.set(id, { resolve, reject, timeout });
        socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
    });
}
async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
}
async function check(name, fn) {
    try { await fn(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}

(async () => {
    try {
        let portInfo;
        for (let i = 0; i < 100; i++) {
            if (child.exitCode !== null) throw new Error(`Browser exited: ${child.exitCode}`);
            try { portInfo = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/); break; }
            catch { await sleep(100); }
        }
        if (!portInfo) throw new Error('Browser did not expose its local automation endpoint');
        socket = new WebSocket(`ws://127.0.0.1:${portInfo[0]}${portInfo[1]}`);
        await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.id) {
                const entry = pending.get(message.id);
                if (!entry) return;
                pending.delete(message.id);
                clearTimeout(entry.timeout);
                if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
                else entry.resolve(message.result);
            }
            if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
            if (message.method === 'Fetch.requestPaused') {
                const { requestId, request } = message.params;
                const allowed = request.url === template || /^https:\/\/(cdn\.tailwindcss\.com|cdn\.jsdelivr\.net)\//.test(request.url);
                send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
                    allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' }, message.sessionId).catch(error => errors.push(error.message));
            }
        });
        const target = await send('Target.createTarget', { url: 'about:blank' }, null);
        sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId;
        await send('Page.enable');
        await send('Runtime.enable');
        await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
        await send('Page.addScriptToEvaluateOnNewDocument', { source: `
            window.__fixture = {status:'warmup', is_monitoring:false};
            window.fetch = async (url) => {
                if (!['/api/telemetry','/api/telemetry/stream'].includes(url)) throw new Error('Unexpected test request: ' + url);
                return {ok:true, json:async () => structuredClone(window.__fixture)};
            };
            window.__healthMutations = [];
            document.addEventListener('DOMContentLoaded', () => {
                new MutationObserver(() => window.__healthMutations.push(document.getElementById('health-state').textContent))
                    .observe(document.getElementById('network-health'), {subtree:true, childList:true, characterData:true});
            });
        ` });
        await send('Page.navigate', { url: template });
        let ready = false;
        for (let i = 0; i < 100; i++) {
            ready = await evaluate(`(() => { try { return typeof consoleChart !== 'undefined' && document.getElementById('health-state').textContent === 'Monitoring stopped'; } catch { return false; } })()`);
            if (ready) break;
            await sleep(200);
        }
        if (!ready) throw new Error(`Dashboard did not initialize (existing CDN assets may be unavailable): ${JSON.stringify(errors)}`);
        let batch = 0;
        for (const [name, width, height] of [['desktop', 1440, 1000], ['tablet', 768, 1024], ['mobile', 390, 844]]) {
            await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            for (const state of ['OPTIMAL', 'DEGRADED', 'CRITICAL', 'OPTIMAL']) {
                const diagnostic = state === 'CRITICAL' ? '[AI ALERT] Unusual traffic pattern detected! This looks like a network attack or strange behavior.' :
                    state === 'DEGRADED' ? '[PERF ALERT] High latency is causing a network delay.' : '[INFO] Network traffic is smooth and normal.';
                await evaluate(`window.__fixture = ${JSON.stringify({ status: 'success', is_monitoring: true, session_id: 1, session_generation: 1,
                    batch_id: ++batch, system_state: state, diagnostic, recommended_fix: '', metrics: { latency: state === 'DEGRADED' ? 95 : 20, jitter: 2, packet_loss: 0, throughput_mbps: 5 },
                    classification: state === 'CRITICAL' ? 'Abnormal' : 'Normal', forecasted_latency: 25, interpretability: { top_features: [], classification_confidence: 0.95 } })};
                    window.__fixture.timestamp = Math.floor(Date.now()/1000); acceptTelemetry(window.__fixture, true);`);
                await sleep(100);
                await check(`${name}: ${state} state, diagnostic and live-region semantics`, async () => {
                    const values = await evaluate(`(() => {
                        const health = document.getElementById('network-health');
                        return {state: health.dataset.state, text: document.getElementById('health-state').textContent,
                            diagnostic: document.getElementById('health-explanation').textContent,
                            role: health.getAttribute('role'), atomic: health.getAttribute('aria-atomic'),
                            live: health.getAttribute('aria-live'), color: getComputedStyle(health).color,
                            announced: window.__healthMutations.includes('${state}'),
                            rf:document.querySelector('#rf-interpretation-content strong').textContent,
                            latency:document.getElementById('m-latency').textContent,
                            metricsStatus:document.getElementById('metrics-status').textContent};
                    })()`);
                    assert.equal(values.state, state);
                    assert.equal(values.text, state);
                    assert.equal(values.diagnostic, diagnostic.replace(/^\[[^\]]+\]\s*/, ''));
                    assert.equal(values.role, 'status'); assert.equal(values.atomic, 'true'); assert.equal(values.live, 'polite');
                    assert.equal(values.announced, true);
                    assert.equal(values.rf, state === 'CRITICAL' ? 'Abnormal' : 'Normal');
                    assert.equal(values.latency, state === 'DEGRADED' ? '95.0 ms' : '20.0 ms');
                    assert.equal(values.metricsStatus, 'METRICS: CURRENT SAMPLE');
                    assert.equal(values.color, { OPTIMAL: 'rgb(110, 231, 183)', DEGRADED: 'rgb(252, 211, 77)', CRITICAL: 'rgb(253, 164, 175)' }[state]);
                });
                if (state === 'CRITICAL') {
                    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                    fs.writeFileSync(path.join(artifacts, `${name}.png`), Buffer.from(shot.data, 'base64'));
                }
            }
            await check(`${name}: header fits, explanation wraps, controls remain visible`, async () => {
                const layout = await evaluate(`(() => {
                    const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; };
                    return {width:innerWidth, header:document.querySelector('header').getBoundingClientRect().bottom,
                        health:rect('network-health'), explanation:rect('health-explanation'), button:rect('monitor-btn'),
                        documentWidth:document.documentElement.scrollWidth, viewportHeight:innerHeight};
                })()`);
                for (const r of [layout.health, layout.explanation, layout.button]) {
                    assert.ok(r.left >= 0 && r.right <= width, JSON.stringify(layout));
                    assert.ok(r.top >= 0 && r.bottom <= height, JSON.stringify(layout));
                }
                assert.ok(layout.header < height / 2, JSON.stringify(layout));
                assert.ok(layout.documentWidth <= width, JSON.stringify(layout));
            });
            await check(`${name}: metric values fit and lower panels remain reachable`, async () => {
                const layout = await evaluate(`(() => {
                    const main = document.querySelector('main');
                    const values = ['m-latency','m-forecast','m-jitter','m-loss','m-bandwidth'].map(id => {
                        const el = document.getElementById(id);
                        return {id, width:el.clientWidth, content:el.scrollWidth};
                    });
                    document.getElementById('rf-interpretation-content').scrollIntoView({block:'end'});
                    const panel = document.getElementById('rf-interpretation-content').getBoundingClientRect();
                    return {values, overflow:getComputedStyle(main).overflowY, mainBottom:main.getBoundingClientRect().bottom,
                        panelBottom:panel.bottom, panelRight:panel.right, width:innerWidth};
                })()`);
                for (const value of layout.values) assert.ok(value.content <= value.width, JSON.stringify(value));
                assert.equal(layout.overflow, 'auto');
                assert.ok(layout.panelBottom <= layout.mainBottom + 1, JSON.stringify(layout));
                assert.ok(layout.panelRight <= width, JSON.stringify(layout));
                const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                fs.writeFileSync(path.join(artifacts, `${name}-details.png`), Buffer.from(shot.data, 'base64'));
                await evaluate(`document.querySelector('main').scrollTop = 0`);
            });
        }
        await check('literal backend text remains inert; no uncaught browser exceptions', async () => {
            const markup = '<img src=x onerror="window.__injected=true"><script>window.__injected=true</script>& text';
            const result = await evaluate(`(() => {
                const markup = ${JSON.stringify(markup)};
                window.__fixture = {...window.__fixture, batch_id:${++batch}, timestamp:Math.floor(Date.now()/1000),
                    system_state:'CRITICAL', diagnostic:markup, recommended_fix:markup, classification:markup,
                    interpretability:{classification_confidence:markup, top_features:[{feature_name:markup,current_value:markup,importance_percent:markup}]}};
                acceptTelemetry(window.__fixture, true);
                buildAlertCenter();
                const ids = ['console-logs','alert-list-container','rf-interpretation-content'];
                const literal = ids.every(id => document.getElementById(id).textContent.includes(markup));
                const injectedElements = ids.reduce((n,id) => n + document.getElementById(id).querySelectorAll('img,script').length, 0);
                window.__fixture.is_monitoring = false;
                acceptTelemetry(window.__fixture, false);
                return {literal, injectedElements, executed:window.__injected === true,
                    metricsStatus:document.getElementById('metrics-status').textContent};
            })()`);
            assert.equal(result.literal, true);
            assert.equal(result.injectedElements, 0);
            assert.equal(result.executed, false);
            assert.equal(result.metricsStatus, 'METRICS: LAST RECORDED (NOT LIVE)');
            assert.deepEqual(errors, []);
        });
        console.log(JSON.stringify({ passed, failed: failures.length, failures, artifacts }, null, 2));
        process.exitCode = failures.length ? 1 : 0;
    } catch (error) {
        console.error(error.stack);
        console.error(`Artifacts: ${artifacts}`);
        process.exitCode = 1;
    } finally {
        if (socket?.readyState === WebSocket.OPEN) {
            try { await send('Browser.close', {}, null); } catch {}
            socket.close();
        }
        child.kill();
        for (const entry of pending.values()) clearTimeout(entry.timeout);
    }
})();
