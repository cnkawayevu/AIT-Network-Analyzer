// Run: node --test tests/frontend_health.test.cjs
// Executes the real inline dashboard script with no server, network, or dependencies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../templates/index.html'), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
const START = 1800000000000;
const escapeHTML = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class TextNode {
    constructor(value) { this.textContent = String(value); }
    get outerHTML() { return escapeHTML(this.textContent); }
}

class Element {
    constructor(attributes = '', tagName = 'div') {
        this.tagName = tagName;
        this.attributes = Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
        this.className = this.attributes.class || '';
        this.dataset = { state: this.attributes['data-state'] };
        this.childNodes = [];
        this._text = '';
        this._html = '';
        this.disabled = false;
        this.classList = {
            add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].join(' '); },
            remove: (...names) => { this.className = this.className.split(/\s+/).filter(n => !names.includes(n)).join(' '); },
            contains: name => this.className.split(/\s+/).includes(name)
        };
    }
    set textContent(value) { this._text = String(value); this._html = ''; this.childNodes = []; }
    get textContent() { return this._text + this.childNodes.map(n => n.textContent).join(''); }
    set innerHTML(value) { this._html = String(value); this._text = ''; this.childNodes = []; }
    get innerHTML() { return this._html || escapeHTML(this._text) + this.childNodes.map(n => n.outerHTML).join(''); }
    get outerHTML() { return `<${this.tagName} class="${escapeHTML(this.className)}">${this.innerHTML}</${this.tagName}>`; }
    get children() { return this.childNodes.filter(n => n instanceof Element); }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes.at(-1) || null; }
    append(...nodes) { this.childNodes.push(...nodes.map(n => typeof n === 'string' ? new TextNode(n) : n)); }
    replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
    appendChild(child) { this.childNodes.push(child); }
    insertBefore(child, before) { this.childNodes.splice(before ? this.childNodes.indexOf(before) : this.childNodes.length, 0, child); }
    removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1); }
    getContext() { return this; }
}

async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

function dashboard() {
    let now = START;
    let nextTimer = 1;
    const timers = new Map();
    const requests = [];
    const elements = new Map();
    for (const match of html.matchAll(/<\w+\b([^>]*\bid="([^"]+)"[^>]*)>/g)) elements.set(match[2], new Element(match[1]));
    const schedule = (fn, delay, repeat = false) => {
        const id = nextTimer++;
        timers.set(id, { fn, due: now + delay, delay, repeat });
        return id;
    };
    class FakeDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const charts = [];
    class Chart {
        constructor(ctx, config) { this.config = config; this.updates = 0; charts.push(this); }
        update() { this.updates++; }
        destroy() { this.destroyed = true; }
    }
    const context = vm.createContext({
        document: {
            getElementById: id => elements.get(id) || null,
            createElement: tag => new Element('', tag)
        },
        Chart, Date: FakeDate, AbortController, console: { error() {} },
        setTimeout: (fn, ms) => schedule(fn, ms),
        setInterval: (fn, ms) => schedule(fn, ms, true),
        clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
        fetch: (url, options) => new Promise((resolve, reject) => {
            // Intentionally allow late settlement after abort to exercise lifecycle guards.
            requests.push({ url, options, resolve, reject });
        })
    });
    vm.runInContext(script, context, { filename: 'templates/index.html' });
    return {
        requests, charts, elements,
        get now() { return now; },
        el: id => elements.get(id),
        read: expression => vm.runInContext(expression, context),
        call: expression => vm.runInContext(expression, context),
        async respond(data, request = requests.at(-1)) {
            request.resolve({ ok: true, json: async () => data });
            await flush();
        },
        async poll(data) {
            vm.runInContext('streamTelemetry()', context);
            await this.respond(data);
        },
        async tick(ms) {
            const target = now + ms;
            for (;;) {
                const next = [...timers.entries()].filter(([, t]) => t.due <= target).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
                if (!next) break;
                const [id, timer] = next;
                now = timer.due;
                if (timer.repeat) timer.due += timer.delay;
                else timers.delete(id);
                timer.fn();
                await flush();
            }
            now = target;
            await flush();
        },
        intervals: () => [...timers.values()].filter(t => t.repeat).length
    };
}

function sample(overrides = {}) {
    return {
        status: 'success', is_monitoring: true, session_id: 1, session_generation: 1,
        batch_id: 1, timestamp: START / 1000, system_state: 'OPTIMAL',
        diagnostic: '[INFO] Network traffic is smooth and normal.', recommended_fix: '',
        metrics: { latency: 20, jitter: 2, packet_loss: 0, throughput_mbps: 5 },
        classification: 'Normal', forecasted_latency: 25,
        interpretability: { top_features: [{ feature_name: 'Flow Duration', current_value: 100, importance_percent: 32 }], classification_confidence: 0.9 },
        ...overrides
    };
}

test('header has explicit accessible status semantics, state colors, and wrapping', () => {
    const d = dashboard();
    assert.equal(d.el('network-health').attributes.role, 'status');
    assert.equal(d.el('network-health').attributes['aria-atomic'], 'true');
    assert.equal(d.el('network-health').attributes['aria-live'], 'polite');
    assert.match(html, /<header\s+class="[^"]*flex-wrap/);
    for (const state of ['OPTIMAL', 'DEGRADED', 'CRITICAL']) assert.ok(html.includes(`[data-state="${state}"]`));
    assert.ok(!html.includes('LIVE SCAPY STREAM'));
});

for (const [state, diagnostic] of [
    ['OPTIMAL', '[INFO] All supplied checks normal.'],
    ['DEGRADED', '[PERF ALERT] High latency is causing a network delay.'],
    ['CRITICAL', '[AI ALERT] Unusual traffic pattern detected!']
]) {
    test(`${state} and the backend diagnostic render immediately on initialization`, async () => {
        const d = dashboard();
        await d.respond(sample({ system_state: state, diagnostic }));
        assert.equal(d.el('network-health').dataset.state, state);
        assert.equal(d.el('health-state').textContent, state);
        assert.equal(d.el('health-explanation').textContent, diagnostic.replace(/^\[[^\]]+\]\s*/, ''));
        assert.equal(d.el('stream-status').textContent, 'TELEMETRY: RESPONDING');
        assert.equal(d.requests.length, 1);
        assert.equal(d.requests[0].url, '/api/telemetry');
        assert.equal(d.intervals(), 1);
    });
}

test('all directed health transitions replace text and styling without changing RF classification', async () => {
    const d = dashboard();
    const states = ['OPTIMAL', 'DEGRADED', 'CRITICAL', 'OPTIMAL', 'CRITICAL', 'DEGRADED', 'OPTIMAL'];
    for (const [index, state] of states.entries()) {
        const data = sample({ batch_id: index + 1, system_state: state, diagnostic: `Backend reason ${index}` });
        if (index === 0) await d.respond(data);
        else await d.poll(data);
        assert.equal(d.el('health-state').textContent, state);
        assert.equal(d.el('network-health').dataset.state, state);
        assert.equal(d.el('health-explanation').textContent, `Backend reason ${index}`);
        assert.match(d.el('rf-interpretation-content').innerHTML, />Normal<\/strong>/);
    }
    assert.equal(d.read('totalAlerts'), 4);
    assert.equal(d.read('chartData.labels.length'), 7);
});

test('health follows the backend even when metrics and RF classification would suggest otherwise', async () => {
    const d = dashboard();
    await d.respond(sample({ system_state: 'OPTIMAL', classification: 'Abnormal', metrics: { latency: 900, packet_loss: 90 } }));
    assert.equal(d.el('health-state').textContent, 'OPTIMAL');
    assert.match(d.el('rf-interpretation-content').innerHTML, />Abnormal<\/strong>/);
});

test('diagnostic markup is displayed as text in the header', async () => {
    const d = dashboard();
    await d.respond(sample({ diagnostic: '[INFO] <b>Backend text</b>' }));
    assert.equal(d.el('health-explanation').textContent, '<b>Backend text</b>');
    assert.equal(d.el('health-explanation').innerHTML, '&lt;b&gt;Backend text&lt;/b&gt;');
});

test('backend markup is literal text in diagnostic logs, alert cards and every RF field', async () => {
    const d = dashboard();
    const markup = '<img src=x onerror="alert(1)"><script>alert(2)</script>& text';
    await d.respond(sample({ system_state: 'CRITICAL', diagnostic: markup, recommended_fix: markup, classification: markup,
        interpretability: { classification_confidence: markup, top_features: [{ feature_name: markup, current_value: markup, importance_percent: markup }] } }));
    d.call('buildAlertCenter()');
    for (const element of [d.el('console-logs').firstChild, d.el('alert-list-container').firstChild, d.el('rf-interpretation-content')]) {
        assert.ok(element.textContent.includes(markup));
        assert.ok(element.innerHTML.includes(escapeHTML(markup)));
        assert.ok(!element.innerHTML.includes('<img'));
        assert.ok(!element.innerHTML.includes('<script'));
    }
    assert.equal(d.el('console-logs').firstChild.textContent.split(markup).length - 1, 2);
    assert.equal(d.el('alert-list-container').firstChild.textContent.split(markup).length - 1, 2);
    assert.equal(d.el('rf-interpretation-content').textContent.split(markup).length - 1, 5);
    assert.equal(d.el('network-health').dataset.state, 'CRITICAL');
});

for (const availability of ['stopped', 'stale', 'unavailable']) {
    test(`${availability} labels retained metric readings as last recorded and preserves history`, async () => {
        const d = dashboard();
        await d.respond(sample({ system_state: 'DEGRADED', diagnostic: 'High latency delay' }));
        assert.equal(d.el('metrics-status').textContent, 'METRICS: CURRENT SAMPLE');
        const chart = d.read('JSON.stringify(chartData)');
        if (availability === 'stopped') await d.poll(sample({ is_monitoring: false }));
        if (availability === 'stale') {
            for (let i = 0; i < 6; i++) { await d.tick(2000); await d.respond(sample()); }
        }
        if (availability === 'unavailable') {
            d.call('streamTelemetry()');
            d.requests.at(-1).reject(new Error('offline'));
            await flush();
        }
        assert.equal(d.el('metrics-status').textContent, 'METRICS: LAST RECORDED (NOT LIVE)');
        assert.equal(d.el('m-latency').textContent, '20.0 ms');
        assert.equal(d.read('JSON.stringify(chartData)'), chart);
        assert.equal(d.read('totalAlerts'), 1);
        d.call('buildAnalyticsTab()');
        assert.equal(d.el('an-total-alerts').textContent, '1');
        assert.equal(d.el('an-avg-latency').textContent, '20.0 ms');
        if (availability !== 'stopped') {
            await d.poll(sample({ batch_id: 2, timestamp: d.now / 1000 }));
            assert.equal(d.el('metrics-status').textContent, 'METRICS: CURRENT SAMPLE');
        }
    });
}

test('warmup never promotes the API placeholder OPTIMAL to current health', async () => {
    const d = dashboard();
    await d.respond(sample({ status: 'warmup', batch_id: undefined }));
    assert.equal(d.el('health-state').textContent, 'Awaiting telemetry');
    assert.equal(d.el('network-health').dataset.state, 'UNAVAILABLE');
    assert.equal(d.read('chartData.labels.length'), 0);
    assert.equal(d.el('m-latency').textContent, '--');
});

test('stopped initialization ignores retained CRITICAL batch and stops polling', async () => {
    const d = dashboard();
    await d.respond(sample({ is_monitoring: false, system_state: 'CRITICAL' }));
    assert.equal(d.el('health-state').textContent, 'Monitoring stopped');
    assert.equal(d.el('network-health').dataset.state, 'UNAVAILABLE');
    assert.equal(d.intervals(), 0);
    await d.tick(20000);
    assert.equal(d.requests.length, 1);
});

for (const state of [undefined, null, '', 'UNKNOWN', 'constructor']) {
    test(`missing or unrecognized state ${String(state)} is neutral`, async () => {
        const d = dashboard();
        await d.respond(sample({ system_state: state }));
        assert.equal(d.el('health-state').textContent, 'Health unavailable');
        assert.equal(d.el('network-health').dataset.state, 'UNAVAILABLE');
        assert.equal(d.read('totalAlerts'), 0);
        assert.equal(d.el('m-latency').textContent, '20.0 ms');
    });
}

for (const kind of ['network', 'http', 'json', 'schema']) {
    test(`${kind} error makes health unavailable and a later sample recovers`, async () => {
        const d = dashboard();
        const request = d.requests[0];
        if (kind === 'network') request.reject(new Error('offline'));
        if (kind === 'http') request.resolve({ ok: false, status: 503 });
        if (kind === 'json') request.resolve({ ok: true, json: async () => { throw new Error('invalid JSON'); } });
        if (kind === 'schema') request.resolve({ ok: true, json: async () => ({ status: 'error' }) });
        await flush();
        assert.equal(d.el('health-state').textContent, 'Telemetry unavailable');
        await d.tick(2000);
        await d.respond(sample());
        assert.equal(d.el('health-state').textContent, 'OPTIMAL');
        assert.equal(d.el('console-logs').children.length, 2);
    });
}

for (const stage of ['headers', 'body']) {
    test(`hanging ${stage} times out at eight seconds without overlapping GETs`, async () => {
        const d = dashboard();
        const old = d.requests[0];
        if (stage === 'body') old.resolve({ ok: true, json: () => new Promise(() => {}) });
        await flush();
        await d.tick(7999);
        assert.equal(d.requests.length, 1);
        assert.equal(old.options.signal.aborted, false);
        await d.tick(1);
        assert.equal(old.options.signal.aborted, true);
        assert.equal(d.el('health-state').textContent, 'Telemetry unavailable');
        await d.tick(2000);
        assert.equal(d.requests.length, 2);
        await d.respond(sample({ timestamp: d.now / 1000 }));
        await d.respond(sample({ system_state: 'CRITICAL' }), old);
        assert.equal(d.el('health-state').textContent, 'OPTIMAL');
    });
}

test('freshness expires at exactly twelve seconds, including while a GET is pending', async () => {
    const d = dashboard();
    const data = sample();
    await d.respond(data);
    const footer = d.el('footer-ts').textContent;
    for (let i = 0; i < 4; i++) { await d.tick(2000); await d.respond(data); }
    await d.tick(3999);
    assert.equal(d.el('health-state').textContent, 'OPTIMAL');
    assert.equal(d.el('footer-ts').textContent, footer);
    await d.tick(1);
    assert.equal(d.el('health-state').textContent, 'Telemetry stale');
    assert.equal(d.el('network-health').dataset.state, 'UNAVAILABLE');
    await d.respond(sample({ batch_id: 2, timestamp: d.now / 1000 }));
    assert.equal(d.el('health-state').textContent, 'OPTIMAL');
    assert.notEqual(d.el('footer-ts').textContent, footer);
});

test('an already stale snapshot is neutral on arrival', async () => {
    const d = dashboard();
    await d.respond(sample({ timestamp: (START - 12000) / 1000 }));
    assert.equal(d.el('health-state').textContent, 'Telemetry stale');
    assert.match(d.el('footer-ts').textContent, new RegExp(new Date(START - 12000).toISOString().replace(/\./g, '\\.')));
});

test('duplicates and reversed batches cannot roll back readings, diagnostics, history, or sample time', async () => {
    const d = dashboard();
    await d.respond(sample({ batch_id: 3, system_state: 'DEGRADED', diagnostic: 'Current latency delay' }));
    const footer = d.el('footer-ts').textContent;
    await d.poll(sample({ batch_id: 3, system_state: 'CRITICAL', diagnostic: 'Changed duplicate', metrics: { latency: 999 } }));
    await d.poll(sample({ batch_id: 2, system_state: 'CRITICAL', metrics: { latency: 999 } }));
    assert.equal(d.el('health-state').textContent, 'DEGRADED');
    assert.equal(d.el('health-explanation').textContent, 'Current latency delay');
    assert.equal(d.el('m-latency').textContent, '20.0 ms');
    assert.equal(d.el('footer-ts').textContent, footer);
    assert.equal(d.read('totalAlerts'), 1);
    assert.equal(d.read('chartData.labels.length'), 1);
    assert.equal(d.el('console-logs').children.length, 1);
});

test('newer batch with regressed timestamp is ignored; invalid timestamps are neutral', async () => {
    const d = dashboard();
    await d.respond(sample());
    await d.poll(sample({ batch_id: 2, timestamp: START / 1000 - 1, system_state: 'CRITICAL' }));
    assert.equal(d.el('health-state').textContent, 'OPTIMAL');
    assert.equal(d.read('chartData.labels.length'), 1);
    for (const timestamp of [undefined, 'bad', NaN, Infinity, 0, START / 1000 + 2]) {
        await d.poll(sample({ batch_id: 2, timestamp }));
        assert.equal(d.el('health-state').textContent, 'Sample unavailable');
    }
});

test('stop cancels an obsolete request; restart clears the prior session and ignores late results', async () => {
    const d = dashboard();
    await d.respond(sample({ system_state: 'CRITICAL' }));
    await d.tick(2000);
    const obsolete = d.requests.at(-1);
    d.call('toggleMonitoring()');
    assert.equal(obsolete.options.signal.aborted, true);
    await d.respond({ status: 'success', is_monitoring: false });
    assert.equal(d.el('health-state').textContent, 'Monitoring stopped');
    assert.equal(d.intervals(), 0);
    assert.equal(d.el('an-anomalies').textContent, '1');
    assert.equal(d.el('ac-count-badge').textContent, '1 ALERTS');
    d.call('toggleMonitoring()');
    await d.respond({ status: 'success', is_monitoring: true, session_id: 2, session_generation: 2 });
    assert.equal(d.el('m-latency').textContent, '--');
    assert.equal(d.read('chartData.labels.length'), 0);
    assert.equal(d.read('totalAlerts'), 0);
    assert.equal(d.el('rf-interpretation-content').textContent, 'Awaiting session telemetry.');
    await d.respond(sample({ session_id: 2, session_generation: 2, status: 'warmup' }));
    await d.respond(sample({ batch_id: 9, system_state: 'CRITICAL' }), obsolete);
    assert.equal(d.el('health-state').textContent, 'Awaiting telemetry');
    await d.poll(sample({ session_id: 2, session_generation: 2, timestamp: d.now / 1000 }));
    assert.equal(d.el('health-state').textContent, 'OPTIMAL');
    assert.equal(d.intervals(), 1);
});

test('external stop is honored even when the backend retains its last completed batch', async () => {
    const d = dashboard();
    await d.respond(sample());
    await d.poll(sample({ is_monitoring: false }));
    assert.equal(d.el('health-state').textContent, 'Monitoring stopped');
    assert.equal(d.el('monitor-btn').textContent, 'Start Monitoring Session');
    assert.equal(d.intervals(), 0);
});

test('changed session is confirmed before adoption and old statistics are reset', async () => {
    const d = dashboard();
    await d.respond(sample({ batch_id: 50, system_state: 'CRITICAL' }));
    const next = sample({ session_id: 2, session_generation: 2, status: 'warmup' });
    await d.poll(next);
    assert.equal(d.el('health-state').textContent, 'Session changed');
    assert.equal(d.read('totalAlerts'), 1);
    await d.poll(next);
    assert.equal(d.requests.at(-1).url, '/api/telemetry');
    assert.equal(d.el('health-state').textContent, 'Awaiting telemetry');
    assert.equal(d.read('totalAlerts'), 0);
    await d.poll(sample({ session_id: 2, session_generation: 2 }));
    assert.equal(d.el('health-state').textContent, 'OPTIMAL');
    assert.equal(d.read('chartData.labels.length'), 1);
});

test('failed control reconciles via GET without repeating the POST', async () => {
    const d = dashboard();
    await d.respond(sample({ is_monitoring: false }));
    d.call('toggleMonitoring()');
    d.call('toggleMonitoring()');
    assert.equal(d.requests.filter(r => r.url === '/api/control').length, 1);
    await d.tick(8000);
    assert.equal(d.requests.at(-1).url, '/api/telemetry');
    await d.respond(sample({ session_id: 2, session_generation: 2, timestamp: d.now / 1000 }));
    assert.equal(d.el('health-state').textContent, 'OPTIMAL');
    assert.equal(d.el('monitor-btn').disabled, false);
    assert.equal(d.requests.filter(r => r.url === '/api/control').length, 1);
});

test('successful stop during session reconciliation does not restart polling', async () => {
    const d = dashboard();
    await d.respond(sample());
    await d.poll(sample({ session_id: 2, session_generation: 2 }));
    assert.equal(d.el('health-state').textContent, 'Session changed');
    d.call('toggleMonitoring()');
    const count = d.requests.length;
    await d.respond({ status: 'success', is_monitoring: false });
    await d.tick(20000);
    assert.equal(d.intervals(), 0);
    assert.equal(d.requests.length, count);
    assert.equal(d.el('health-state').textContent, 'Monitoring stopped');
});

test('initialization cancelled by start cannot restore the obsolete session', async () => {
    const d = dashboard();
    const initial = d.requests[0];
    d.call('toggleMonitoring()');
    assert.equal(initial.options.signal.aborted, true);
    await d.respond({ status: 'success', is_monitoring: true, session_id: 2, session_generation: 2 });
    await d.respond(sample({ session_id: 2, session_generation: 2 }));
    initial.reject(new Error('obsolete initialization failed'));
    await flush();
    assert.equal(d.el('health-state').textContent, 'OPTIMAL');
    assert.equal(d.read('activeSessionId'), 2);
    assert.equal(d.el('console-logs').children.length, 2);
});

test('an active-session error removes prior health and recovery retains the original sample age', async () => {
    const d = dashboard();
    await d.respond(sample());
    await d.tick(1999);
    assert.equal(d.requests.length, 1);
    await d.tick(1);
    assert.equal(d.requests.length, 2);
    d.requests.at(-1).reject(new Error('offline'));
    await flush();
    assert.equal(d.el('health-state').textContent, 'Telemetry unavailable');
    assert.equal(d.el('network-health').dataset.state, 'UNAVAILABLE');
    assert.equal(d.el('m-latency').textContent, '20.0 ms');
    for (let i = 0; i < 5; i++) { await d.tick(2000); await d.respond(sample()); }
    assert.equal(d.el('health-state').textContent, 'Telemetry stale');
    assert.equal(d.read('chartData.labels.length'), 1);
});

test('metrics, null gaps, RF interpretation, charts, diagnostic limits, analytics and alerts survive', async () => {
    const d = dashboard();
    await d.respond(sample({ is_monitoring: false }));
    d.call('toggleMonitoring()');
    await d.respond({ status: 'success', is_monitoring: true, session_id: 1, session_generation: 1 });
    await d.respond(sample({ metrics: { latency: null, jitter: null, packet_loss: null, throughput_mbps: 0 }, forecasted_latency: null, interpretability: null }));
    for (const id of ['m-latency', 'm-jitter', 'm-loss', 'm-forecast']) assert.equal(d.el(id).textContent, 'N/A');
    assert.equal(d.read('chartData.datasets[0].data[0]'), null);
    assert.equal(d.read('chartData.datasets[1].data[0]'), null);
    assert.match(d.el('rf-interpretation-content').innerHTML, /Interpretation unavailable/);
    for (let batch_id = 2; batch_id <= 55; batch_id++) {
        await d.poll(sample({ batch_id, system_state: batch_id === 2 ? 'CRITICAL' : batch_id === 3 || batch_id === 4 ? 'DEGRADED' : 'OPTIMAL',
            diagnostic: batch_id === 3 ? 'High latency delay' : batch_id === 4 ? 'Probe failures' : 'Backend diagnosis', recommended_fix: 'Backend remedy' }));
    }
    assert.equal(d.el('m-latency').textContent, '20.0 ms');
    assert.equal(d.el('m-forecast').textContent, '25.0 ms');
    assert.equal(d.el('m-loss').textContent, '0.00 %');
    assert.equal(d.el('m-jitter').textContent, '2.0 ms');
    assert.equal(d.el('m-bandwidth').textContent, '5.0 Mbps');
    assert.equal(d.el('m-latency').classList.contains('text-slate-500'), false);
    assert.match(d.el('rf-interpretation-content').innerHTML, /Flow Duration/);
    assert.match(d.el('rf-interpretation-content').innerHTML, /90.0%/);
    assert.equal(d.read('chartData.labels.length'), 20);
    assert.equal(d.read('chartData.datasets.every(ds => ds.data.length === 20)'), true);
    assert.equal(d.el('console-logs').children.length, 50);
    assert.match(d.el('console-logs').firstChild.innerHTML, /Backend diagnosis.*Backend remedy/s);
    await d.tick(5000);
    d.call('toggleMonitoring()');
    await d.respond({ status: 'success', is_monitoring: false });
    assert.equal(d.el('an-duration').textContent, '5s');
    assert.equal(d.el('an-total-alerts').textContent, '3');
    assert.equal(d.el('an-anomalies').textContent, '1');
    assert.equal(d.el('an-avg-latency').textContent, '20.0 ms');
    assert.equal(d.el('ac-count-badge').textContent, '3 ALERTS');
    assert.equal(d.el('alert-list-container').children.length, 3);
    assert.match(d.el('alert-list-container').children[0].innerHTML, /CRITICAL.*Backend remedy/s);
    assert.equal(d.el('tab-analytics').classList.contains('hidden'), false);
    assert.deepEqual(Array.from(d.charts.at(-1).config.data.datasets[0].data), [1, 1, 1]);
});
