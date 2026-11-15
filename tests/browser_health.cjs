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

// Optional read-only report exported from a real completed session for acceptance checks.
const reconciliationReport = process.env.ACTIVITY_REPORT_FIXTURE
    ? JSON.parse(fs.readFileSync(process.env.ACTIVITY_REPORT_FIXTURE, 'utf8'))
    : {
        session: {id:700,status:'completed'},
        report: {session_id:700,duration_seconds:10,mean_latency_ms:45,total_triggers:1,ai_anomalies:0,latency_delay_events:1,packet_loss_events:0},
        telemetry_count:3,
        alerts:[{batch_id:2,alert_type:'HIGH_LATENCY',severity:'DEGRADED',timestamp:'2026-11-15T18:56:12.408310',diagnostic:'[PERF ALERT] Saved latency warning.',recommended_fix:'Saved recommendation.'}],
        activity_samples:[
            {session_id:700,batch_id:1,timestamp:'2026-11-15T18:56:09.928224',latency_ms:23,packet_loss_pct:0,rf_classification:'Normal',system_state:'OPTIMAL',diagnostic:'Within configured limits.',recommended_fix:''},
            {session_id:700,batch_id:2,timestamp:'2026-11-15T18:56:12.408310',latency_ms:85,packet_loss_pct:0,rf_classification:'Normal',system_state:'DEGRADED',diagnostic:'[PERF ALERT] Saved latency warning.',recommended_fix:'Saved recommendation.'},
            {session_id:700,batch_id:3,timestamp:'2026-11-15T18:56:15.081664',latency_ms:27,packet_loss_pct:0,rf_classification:'Normal',system_state:'OPTIMAL',diagnostic:'Within configured limits.',recommended_fix:''}
        ]
    };

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

async function checkAccessibility(name) {
    await check(`${name}: accessible names, tab relationships, text contrast and keyboard focus`, async () => {
        const result = await evaluate(`(() => {
            const issues = [];
            const visible = el => el.getClientRects().length && !el.closest('.hidden') && !el.classList.contains('sr-only');
            const rgb = value => (value.match(/[\\d.]+/g) || []).map(Number);
            const luminance = color => color.slice(0, 3).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
            const background = el => {
                if (!el) return [255, 255, 255];
                const color = rgb(getComputedStyle(el).backgroundColor);
                const alpha = color.length === 4 ? color[3] : 1;
                return alpha === 1 ? color : background(el.parentElement).map((c, i) => color[i] * alpha + c * (1 - alpha));
            };
            for (const el of document.querySelectorAll('body *')) {
                if (!visible(el) || ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) || ['SCRIPT','STYLE'].includes(el.tagName)) continue;
                const style = getComputedStyle(el);
                if (parseFloat(style.fontSize) === 0) continue; // Decorative separator has no rendered text.
                const fg = luminance(rgb(style.color)), bg = luminance(background(el));
                const contrast = (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
                const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
                if (contrast < (large ? 3 : 4.5)) issues.push(el.tagName + '#' + el.id + ' contrast ' + contrast.toFixed(2));
            }
            for (const el of document.querySelectorAll('button, summary, canvas')) {
                if (visible(el) && !(el.getAttribute('aria-label') || el.textContent.trim())) issues.push('Missing accessible name: ' + el.tagName);
            }
            const tabs = [...document.querySelectorAll('[role=tab]')];
            if (tabs.length !== 3 || tabs.filter(t => t.getAttribute('aria-selected') === 'true').length !== 1) issues.push('Invalid selected tab');
            for (const tab of tabs) {
                const panel = document.getElementById(tab.getAttribute('aria-controls'));
                if (!panel || panel.getAttribute('aria-labelledby') !== tab.id) issues.push('Broken tab relationship');
            }
            document.querySelector('[role=tab][aria-selected=true]').focus();
            return {issues, focus: document.activeElement.id};
        })()`);
        assert.deepEqual(result.issues, []);
        assert.match(result.focus, /^tab-btn-/);
        await send('Input.dispatchKeyEvent', {type:'keyDown', key:'Tab', code:'Tab', windowsVirtualKeyCode:9});
        await send('Input.dispatchKeyEvent', {type:'keyUp', key:'Tab', code:'Tab', windowsVirtualKeyCode:9});
        const focused = await evaluate(`({tag:document.activeElement.tagName, outline:getComputedStyle(document.activeElement).outlineStyle})`);
        assert.ok(['BUTTON','SUMMARY'].includes(focused.tag));
        assert.notEqual(focused.outline, 'none');
        const tree = await send('Accessibility.getFullAXTree');
        assert.equal(tree.nodes.filter(n => !n.ignored && n.role?.value === 'tab').length, 3);
    });
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
                if (window.__savedReport && url === '/api/session/' + window.__savedReport.data.session.id) {
                    return {ok:true, json:async () => structuredClone(window.__savedReport)};
                }
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
        for (const [name, width, height] of [['desktop-1920x1080', 1920, 1080], ['laptop-1366x768', 1366, 768], ['desktop', 1440, 1000], ['tablet', 768, 1024], ['mobile', 390, 844]]) {
            await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            for (const state of ['OPTIMAL', 'DEGRADED', 'CRITICAL', 'OPTIMAL']) {
                const diagnostic = state === 'CRITICAL' ? '[AI ALERT] Unusual traffic pattern flagged by the Random Forest classifier (for example, a large transfer or traffic burst, not a confirmed attack).' :
                    state === 'DEGRADED' ? '[PERF ALERT] Round-trip latency to 1.1.1.1 exceeded the 80 ms threshold, which can cause noticeable delay.' : '[INFO] Latency, ICMP probe responses, and traffic classification are within configured limits.';
                const expectedSummary = state === 'CRITICAL' ? 'Unusual traffic flagged. Review the activity log.' :
                    state === 'DEGRADED' ? 'High latency detected (>80 ms).' : 'Latest readings are within the configured limits.';
                await evaluate(`window.__fixture = ${JSON.stringify({ status: 'success', is_monitoring: true, session_id: 1, session_generation: 1,
                    batch_id: ++batch, system_state: state, diagnostic, recommended_fix: '', metrics: { latency: state === 'DEGRADED' ? 95 : 20, jitter: 2, packet_loss: 0, throughput_mbps: 5 },
                    classification: state === 'CRITICAL' ? 'Abnormal' : 'Normal', forecasted_latency: 25, interpretability: { top_features: [{ feature_name: 'Flow Duration', current_value: 120000, importance_percent: 32.4 }], classification_confidence: 0.95 } })};
                    window.__fixture.timestamp = Math.floor(Date.now()/1000); acceptTelemetry(window.__fixture, true);`);
                await sleep(100);
                await check(`${name}: ${state} state, diagnostic and live-region semantics`, async () => {
                    const values = await evaluate(`(() => {
                        const health = document.getElementById('network-health');
                        return {state: health.dataset.state, text: document.getElementById('health-state').textContent,
                            diagnostic: document.getElementById('health-explanation').textContent,
                            role: health.getAttribute('role'), atomic: health.getAttribute('aria-atomic'),
                            live: health.getAttribute('aria-live'), color: getComputedStyle(document.getElementById('health-state')).color,
                            announced: window.__healthMutations.includes('${state}'),
                            rf:document.querySelector('#rf-interpretation-content strong').textContent,
                            latency:document.getElementById('m-latency').textContent,
                            metricsStatus:document.getElementById('metrics-status').textContent};
                    })()`);
                    assert.equal(values.state, state);
                    assert.equal(values.text, state);
                    assert.equal(values.diagnostic, expectedSummary);
                    assert.equal(values.role, 'status'); assert.equal(values.atomic, 'true'); assert.equal(values.live, 'polite');
                    assert.equal(values.announced, true);
                    assert.equal(values.rf, state === 'CRITICAL' ? 'Abnormal' : 'Normal');
                    assert.equal(values.latency, state === 'DEGRADED' ? '95.0 ms' : '20.0 ms');
                    assert.equal(values.metricsStatus, 'METRICS: CURRENT SAMPLE');
                    assert.equal(values.color, { OPTIMAL: 'rgb(110, 231, 183)', DEGRADED: 'rgb(252, 211, 77)', CRITICAL: 'rgb(252, 165, 165)' }[state]);
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
            if (name === 'desktop-1920x1080' || name === 'laptop-1366x768') {
                await check(`${name}: Activity Log is event-focused while every alert remains recorded`, async () => {
                    const firstBatch = batch + 1;
                    batch += 6;
                    const result = await evaluate(`(() => {
                        cancelPolling();
                        const logger = document.getElementById('console-logs');
                        const initialEntries = new Set(logger.children);
                        const eventTimestamp = Math.floor(Date.now()/1000);
                        const initialRows = logger.children.length;
                        const initialAlerts = totalAlerts;
                        const initialHistory = sessionAlertsHistory.length;
                        let batch = ${firstBatch};
                        const push = warning => {
                            window.__fixture = {...window.__fixture, batch_id:batch++, timestamp:eventTimestamp,
                                system_state:warning ? 'CRITICAL' : 'OPTIMAL', classification:warning ? 'Abnormal' : 'Normal',
                                diagnostic:warning ? 'Unusual traffic flagged.' : 'Network conditions are within configured limits.',
                                recommended_fix:warning ? 'Review active applications.' : '',
                                metrics:{latency:warning ? 95 : 20, packet_loss:warning ? 10 : 0, jitter:2, throughput_mbps:5}};
                            acceptTelemetry(window.__fixture, true);
                        };
                        push(false); push(false);
                        const healthyRows = logger.children.length;
                        push(true);
                        const firstWarningRows = logger.children.length;
                        push(true);
                        const repeatedRows = logger.children.length;
                        push(false);
                        const recoveredRows = logger.children.length;
                        push(true);
                        const categoryRows = [...logger.children].filter(row => !initialEntries.has(row) && /Unusual traffic flagged|Round-trip latency exceeded|Failed ICMP probes exceeded/.test(row.textContent));
                        return {initialRows, healthyRows, firstWarningRows, repeatedRows, recoveredRows, finalRows:logger.children.length,
                            alerts:totalAlerts-initialAlerts, history:sessionAlertsHistory.length-initialHistory,
                            times:categoryRows.map(row => row.querySelector('time').getAttribute('datetime')),
                            expectedTime:new Date(window.__fixture.timestamp*1000).toISOString(),
                            messageColor:getComputedStyle(logger.firstElementChild.children[2]).color,
                            width:logger.scrollWidth, availableWidth:logger.clientWidth};
                    })()`);
                    assert.equal(result.healthyRows, result.initialRows);
                    assert.equal(result.firstWarningRows, result.healthyRows + 3);
                    assert.equal(result.repeatedRows, result.firstWarningRows);
                    assert.equal(result.recoveredRows, result.repeatedRows + 1);
                    assert.equal(result.finalRows, result.recoveredRows + 3);
                    assert.equal(result.alerts, 9);
                    assert.equal(result.history, 9);
                    assert.ok(result.times.every(time => time === result.expectedTime));
                    assert.equal(result.messageColor, 'rgb(229, 233, 240)');
                    assert.ok(result.width <= result.availableWidth);
                    await sleep(200);
                    const shot = await send('Page.captureScreenshot', {format:'png', captureBeyondViewport:false});
                    fs.writeFileSync(path.join(artifacts, `${name}-activity-events.png`), Buffer.from(shot.data, 'base64'));
                });
                await checkAccessibility(`${name}: Live Monitor`);
                for (const availability of ['stale', 'unavailable', 'stopped']) {
                    await check(`${name}: ${availability} retains readings only as not live`, async () => {
                        const values = await evaluate(`(async () => {
                            cancelPolling();
                            const before = {metric:document.getElementById('m-latency').textContent, alerts:totalAlerts, points:chartData.labels.length};
                            if ('${availability}' === 'stale') {
                                lastSample.timestamp = (Date.now() - SAMPLE_MAX_AGE_MS) / 1000;
                                renderHealth();
                            } else if ('${availability}' === 'unavailable') {
                                const fetchBefore = window.fetch;
                                window.fetch = async () => { throw new Error('Offline browser fixture'); };
                                await streamTelemetry();
                                window.fetch = fetchBefore;
                            } else {
                                window.__fixture.is_monitoring = false;
                                acceptTelemetry(window.__fixture, true);
                            }
                            return {before, metric:document.getElementById('m-latency').textContent, alerts:totalAlerts, points:chartData.labels.length,
                                state:document.getElementById('network-health').dataset.state,
                                label:document.getElementById('health-state').textContent,
                                status:document.getElementById('metrics-status').textContent};
                        })()`);
                        assert.equal(values.state, 'UNAVAILABLE');
                        assert.equal(values.label, {stale:'Telemetry stale', unavailable:'Telemetry unavailable', stopped:'Monitoring stopped'}[availability]);
                        assert.equal(values.status, 'METRICS: LAST RECORDED (NOT LIVE)');
                        assert.equal(values.metric, values.before.metric);
                        assert.equal(values.alerts, values.before.alerts);
                        assert.equal(values.points, values.before.points);
                        // Allow CDN utility styles and the existing control transition to settle.
                        await sleep(200);
                        const shot = await send('Page.captureScreenshot', {format:'png', captureBeyondViewport:false});
                        fs.writeFileSync(path.join(artifacts, `${name}-${availability}.png`), Buffer.from(shot.data, 'base64'));
                    });
                }
                await check(`${name}: Session Analytics and Alert Center render accurately without horizontal overflow`, async () => {
                    await evaluate(`(() => {
                        applySavedSessionReport({
                            session: { id: 1, status: 'completed', duration_seconds: 42, mean_latency_ms: 24.6, total_triggers: 3, ai_anomalies: 1, latency_delay_events: 1, packet_loss_events: 1 },
                            report: { session_id: 1, duration_seconds: 42, mean_latency_ms: 24.6, total_triggers: 3, ai_anomalies: 1, latency_delay_events: 1, packet_loss_events: 1 },
                            telemetry_count: 20,
                            alerts: [
                                { alert_type: 'AI_ANOMALY', severity: 'CRITICAL', diagnostic: '[AI ALERT] Unusual traffic pattern flagged by the Random Forest classifier (for example, a large transfer or traffic burst, not a confirmed attack).', timestamp: '2026-11-13T09:00:10.000000' },
                                { alert_type: 'HIGH_LATENCY', severity: 'DEGRADED', diagnostic: '[PERF ALERT] Round-trip latency to 1.1.1.1 exceeded the 80 ms threshold, which can cause noticeable delay.', timestamp: '2026-11-13T09:00:10.000000' },
                                { alert_type: 'PACKET_LOSS', severity: 'DEGRADED', diagnostic: '[PERF ALERT] Failed ICMP probes exceeded the 2% threshold across recent checks, which can indicate link instability.', timestamp: '2026-11-13T09:00:18.000000' }
                            ]
                        });
                        switchTab('analytics');
                    })()`);
                    await sleep(150);
                    const analyticsShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                    fs.writeFileSync(path.join(artifacts, `${name}-analytics.png`), Buffer.from(analyticsShot.data, 'base64'));
                    const analyticsState = await evaluate(`({
                        selected: document.getElementById('tab-btn-analytics').getAttribute('aria-selected'),
                        duration: document.getElementById('an-duration').textContent,
                        totalAlerts: document.getElementById('an-total-alerts').textContent,
                        anomalies: document.getElementById('an-anomalies').textContent,
                        avgLatency: document.getElementById('an-avg-latency').textContent,
                        docWidth: document.documentElement.scrollWidth
                    })`);
                    assert.equal(analyticsState.selected, 'true');
                    assert.equal(analyticsState.duration, '42s');
                    assert.equal(analyticsState.totalAlerts, '3');
                    assert.equal(analyticsState.anomalies, '1');
                    assert.equal(analyticsState.avgLatency, '24.6 ms');
                    assert.ok(analyticsState.docWidth <= width);
                    await checkAccessibility(`${name}: Session Analytics`);

                    await evaluate(`switchTab('alert-center')`);
                    await sleep(100);
                    const alertsShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                    fs.writeFileSync(path.join(artifacts, `${name}-alerts.png`), Buffer.from(alertsShot.data, 'base64'));
                    const alertsState = await evaluate(`({
                        selected: document.getElementById('tab-btn-alert-center').getAttribute('aria-selected'),
                        badge: document.getElementById('ac-count-badge').textContent,
                        cards: document.getElementById('alert-list-container').children.length,
                        docWidth: document.documentElement.scrollWidth
                    })`);
                    assert.equal(alertsState.selected, 'true');
                    assert.equal(alertsState.badge, '3 ALERTS');
                    assert.equal(alertsState.cards, 3);
                    assert.ok(alertsState.docWidth <= width);
                    await checkAccessibility(`${name}: Alert Center`);
                    const disclosure = await evaluate(`(() => {
                        const details = document.querySelector('#alert-list-container details');
                        const before = details.open;
                        details.querySelector('summary').focus();
                        return {before, text:details.textContent};
                    })()`);
                    assert.equal(disclosure.before, true);
                    assert.match(disclosure.text, /Review active applications/);
                    await send('Input.dispatchKeyEvent', {type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, text:'\r', unmodifiedText:'\r'});
                    await send('Input.dispatchKeyEvent', {type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13});
                    assert.equal(await evaluate(`document.querySelector('#alert-list-container details').open`), false);
                    await send('Input.dispatchKeyEvent', {type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, text:'\r', unmodifiedText:'\r'});
                    await send('Input.dispatchKeyEvent', {type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13});
                    assert.equal(await evaluate(`document.querySelector('#alert-list-container details').open`), true);

                    await evaluate(`switchTab('live-stream')`);
                });
            }
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
        for (const [width,height] of [[1366,768],[1920,1080]]) {
            await send('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false});
            await check(`${width}x${height}: completed session ${reconciliationReport.session.id} has the same warning in Activity Log and Alert Center`, async () => {
                const result = await evaluate(`(async () => {
                    cancelPolling();
                    window.__savedReport = {status:'success',data:${JSON.stringify(reconciliationReport)}};
                    const details = window.__savedReport.data;
                    const live = row => ({status:'success',is_monitoring:true,session_id:details.session.id,session_generation:${width},
                        batch_id:row.batch_id,timestamp:Date.parse(row.timestamp.replace(/Z$/, '') + 'Z')/1000,
                        system_state:row.system_state,classification:row.rf_classification,
                        metrics:{latency:row.latency_ms,packet_loss:row.packet_loss_pct},diagnostic:row.diagnostic,recommended_fix:row.recommended_fix});
                    // Only the first and last healthy batches reach the browser.
                    window.__fixture=live(details.activity_samples[0]); acceptTelemetry(window.__fixture,true);
                    window.__fixture=live(details.activity_samples.at(-1)); acceptTelemetry(window.__fixture,true);
                    const cleanDiagnostic=details.alerts[0].diagnostic.replace(/^\\[[^\\]]+\\]\\s*/, '');
                    const before=document.getElementById('console-logs').textContent.includes(cleanDiagnostic);
                    window.__fixture.is_monitoring=false; acceptTelemetry(window.__fixture,true);
                    await new Promise(resolve=>setTimeout(resolve,0));
                    const rows=[...document.querySelectorAll('#console-logs .log-row')];
                    const warning=rows.filter(row=>row.dataset.eventSource==='saved-condition' && row.textContent.includes(cleanDiagnostic));
                    switchTab('live-stream'); document.querySelector('main').scrollTop=0;
                    return {before,warnings:warning.length,time:warning[0]?.querySelector('time').getAttribute('datetime'),
                        logText:warning[0]?.textContent,alertText:document.getElementById('alert-list-container').textContent,
                        badge:document.getElementById('ac-count-badge').textContent,
                        total:document.getElementById('an-total-alerts').textContent,
                        cards:document.getElementById('alert-list-container').children.length,
                        metrics:document.getElementById('metrics-status').textContent,
                        health:document.getElementById('health-state').textContent,
                        chartPoints:chartData.labels.length};
                })()`);
                assert.equal(result.before,false);
                assert.equal(result.warnings,1);
                assert.equal(result.time,new Date(reconciliationReport.alerts[0].timestamp.replace(/Z$/, '')+'Z').toISOString());
                assert.ok(result.logText.includes(reconciliationReport.alerts[0].recommended_fix));
                assert.ok(result.alertText.includes(reconciliationReport.alerts[0].recommended_fix));
                assert.equal(result.badge,`${reconciliationReport.alerts.length} ALERTS`);
                assert.equal(result.total,String(reconciliationReport.alerts.length));
                assert.equal(result.cards,reconciliationReport.alerts.length);
                assert.equal(result.metrics,'METRICS: LAST RECORDED (NOT LIVE)');
                assert.equal(result.health,'Monitoring stopped');
                assert.equal(result.chartPoints,2);
                await sleep(200);
                const logShot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
                fs.writeFileSync(path.join(artifacts,`${width}x${height}-session-${reconciliationReport.session.id}-reconciled-log.png`),Buffer.from(logShot.data,'base64'));
                await checkAccessibility(`${width}x${height}: reconciled Activity Log`);
                await evaluate(`switchTab('alert-center')`);
                await sleep(150);
                const alertShot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
                fs.writeFileSync(path.join(artifacts,`${width}x${height}-session-${reconciliationReport.session.id}-reconciled-alerts.png`),Buffer.from(alertShot.data,'base64'));
                assert.deepEqual(errors,[]);
            });
        }
        const report = JSON.stringify({ passed, failed: failures.length, failures, artifacts, reconciledSession:reconciliationReport.session.id }, null, 2);
        fs.writeFileSync(path.join(artifacts, 'results.json'), report);
        console.log(report);
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
