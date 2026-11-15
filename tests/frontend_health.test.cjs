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
            createElement: tag => new Element('', tag),
            visibilityState: 'visible',
            hidden: false,
            addEventListener: (type, fn) => {
                const map = context._listeners || (context._listeners = new Map());
                if (!map.has(type)) map.set(type, new Set());
                map.get(type).add(fn);
            },
            removeEventListener: (type, fn) => context._listeners?.get(type)?.delete(fn),
            dispatchEvent: type => { for (const fn of context._listeners?.get(type) || []) fn({ type }); }
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
        intervals: () => [...timers.values()].filter(t => t.repeat).length,
        jumpTime: ms => {
            now += ms;
            for (const timer of timers.values()) {
                if (timer.due < now) timer.due = now + (timer.repeat ? timer.delay : 0);
            }
        },
        setVisibility: state => {
            context.document.visibilityState = state;
            context.document.hidden = state === 'hidden';
            context.document.dispatchEvent('visibilitychange');
        }
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

for (const [state, diagnostic, expectedSummary] of [
    ['OPTIMAL', '[INFO] All supplied checks normal.', 'Latest readings are within the configured limits.'],
    ['DEGRADED', '[PERF ALERT] High latency is causing a network delay.', 'High latency detected (>80 ms).'],
    ['CRITICAL', '[AI ALERT] Unusual traffic pattern detected!', 'Unusual traffic flagged. Review the activity log.']
]) {
    test(`${state} and the backend diagnostic render immediately on initialization`, async () => {
        const d = dashboard();
        await d.respond(sample({ system_state: state, diagnostic }));
        assert.equal(d.el('network-health').dataset.state, state);
        assert.equal(d.el('health-state').textContent, state);
        assert.equal(d.el('health-explanation').textContent, expectedSummary);
        assert.match(d.el('console-logs').firstChild.textContent, new RegExp(diagnostic.replace(/^\[[^\]]+\]\s*/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
    assert.equal(d.el('console-logs').children.length, 2); // Active session + first warning.
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
    assert.equal(d.el('m-loss').textContent, '0 %');
    assert.equal(d.el('m-jitter').textContent, '2.0 ms');
    assert.equal(d.el('m-bandwidth').textContent, '5.0 Mbps');
    assert.equal(d.el('m-latency').classList.contains('text-slate-500'), false);
    assert.match(d.el('rf-interpretation-content').innerHTML, /Flow Duration/);
    assert.match(d.el('rf-interpretation-content').innerHTML, /90.0%/);
    assert.equal(d.read('chartData.labels.length'), 20);
    assert.equal(d.read('chartData.datasets.length'), 2);
    assert.equal(d.read('chartData.datasets.every(ds => ds.data.length === 20)'), true);
    assert.equal(d.el('console-logs').children.length, 5);
    assert.match(d.el('console-logs').firstChild.textContent, /Network conditions have returned/);
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

test('simultaneous alert conditions and saved-session report reconciliation via /api/session/<id>', async () => {
    const d = dashboard();
    await d.respond(sample({ is_monitoring: false }));
    d.call('toggleMonitoring()');
    await d.respond({ status: 'success', is_monitoring: true, session_id: 7, session_generation: 1 });
    // Batch 1: CRITICAL + high latency (>80 ms) + packet loss (>2%) -> 3 simultaneous triggers
    await d.respond(sample({
        session_id: 7, session_generation: 1, batch_id: 1,
        system_state: 'CRITICAL', classification: 'Abnormal',
        diagnostic: '[AI ALERT] The Random Forest classifier marked this traffic interval as abnormal.',
        recommended_fix: 'Review active applications.',
        metrics: { latency: 95.0, jitter: 4.0, packet_loss: 10, throughput_mbps: 6.2 }
    }));
    assert.equal(d.el('m-forecast-note').textContent, 'Next reading (warm-up: 1/10 samples)');
    assert.equal(d.el('m-loss').textContent, '10 %');
    assert.equal(d.read('totalAlerts'), 3);
    assert.deepEqual(JSON.parse(d.read('JSON.stringify(alertCounts)')), { latency_delay: 1, packet_loss: 1, anomaly: 1 });
    // Batch 2: DEGRADED with both high latency and packet loss -> 2 simultaneous triggers
    await d.poll(sample({
        session_id: 7, session_generation: 1, batch_id: 2,
        system_state: 'DEGRADED', classification: 'Normal',
        diagnostic: '[PERF ALERT] Round-trip latency to 1.1.1.1 exceeded 80 ms.',
        metrics: { latency: 88.0, jitter: 3.0, packet_loss: 20, throughput_mbps: 4.0 }
    }));
    assert.equal(d.read('totalAlerts'), 5);
    assert.deepEqual(JSON.parse(d.read('JSON.stringify(alertCounts)')), { latency_delay: 2, packet_loss: 2, anomaly: 1 });
    // Stop session with session_id returned -> triggers GET /api/session/7
    d.call('toggleMonitoring()');
    await d.respond({ status: 'success', is_monitoring: false, session_id: 7 });
    assert.equal(d.requests.at(-1).url, '/api/session/7');
    await d.respond({
        status: 'success',
        data: {
            session: { id: 7, status: 'completed', duration_seconds: 12.4, mean_latency_ms: 91.5, total_triggers: 5, ai_anomalies: 1, latency_delay_events: 2, packet_loss_events: 2 },
            report: { session_id: 7, duration_seconds: 12.4, mean_latency_ms: 91.5, total_triggers: 5, ai_anomalies: 1, latency_delay_events: 2, packet_loss_events: 2 },
            telemetry_count: 2,
            alerts: [
                { alert_type: 'AI_ANOMALY', severity: 'CRITICAL', diagnostic: '[AI ALERT] Abnormal traffic pattern.', timestamp: '2026-11-13T09:00:02.000000' },
                { alert_type: 'HIGH_LATENCY', severity: 'DEGRADED', diagnostic: '[PERF ALERT] High latency.', timestamp: '2026-11-13T09:00:02.000000' },
                { alert_type: 'PACKET_LOSS', severity: 'DEGRADED', diagnostic: '[PERF ALERT] Packet loss.', timestamp: '2026-11-13T09:00:02.000000' },
                { alert_type: 'HIGH_LATENCY', severity: 'DEGRADED', diagnostic: '[PERF ALERT] High latency.', timestamp: '2026-11-13T09:00:04.000000' },
                { alert_type: 'PACKET_LOSS', severity: 'DEGRADED', diagnostic: '[PERF ALERT] Packet loss.', timestamp: '2026-11-13T09:00:04.000000' }
            ]
        }
    });
    assert.equal(d.el('an-duration').textContent, '12s');
    assert.equal(d.el('an-total-alerts').textContent, '5');
    assert.equal(d.el('an-anomalies').textContent, '1');
    assert.equal(d.el('an-avg-latency').textContent, '91.5 ms');
    assert.equal(d.el('ac-count-badge').textContent, '5 ALERTS');
    assert.equal(d.el('alert-list-container').children.length, 5);
    assert.equal(d.el('alert-list-container').children[0].lastChild.open, true);
    assert.equal(d.el('alert-list-container').children[1].lastChild.open, true);
    assert.equal(d.el('alert-list-container').children[2].lastChild.open, true);
    assert.equal(Boolean(d.el('alert-list-container').children[3].lastChild.open), false);
    assert.equal(Boolean(d.el('alert-list-container').children[4].lastChild.open), false);
    assert.deepEqual(Array.from(d.charts.at(-1).config.data.datasets[0].data), [1, 2, 2]);
});

test('tab ARIA states and keyboard focus classes are present and updated on tab switch', () => {
    const d = dashboard();
    assert.equal(d.el('tab-btn-live-stream').attributes.role, 'tab');
    assert.equal(d.el('tab-btn-live-stream').attributes['aria-selected'], 'true');
    assert.equal(d.el('tab-btn-analytics').attributes['aria-selected'], 'false');
    d.call("switchTab('analytics')");
    assert.equal(d.el('tab-btn-live-stream').attributes['aria-selected'], 'false');
    assert.equal(d.el('tab-btn-analytics').attributes['aria-selected'], 'true');
    assert.match(d.el('monitor-btn').className, /focus-visible:outline/);
});

test('concise header explanations, plain-language labels, model score wording, and non-redundant alert checks', async () => {
    for (const label of [
        'Current readings',
        'Next-step prediction (LSTM)',
        'Variation in response time',
        'Measured and predicted latency',
        'Activity log',
        'Last completed session',
        'Alert summary',
        'What to check'
    ]) {
        assert.ok(html.includes(label), `Missing expected plain-language label: ${label}`);
    }
    const d = dashboard();
    await d.respond(sample({
        batch_id: 1,
        system_state: 'DEGRADED',
        diagnostic: '[PERF ALERT] Failed ICMP probes exceeded the 2% threshold across recent checks.',
        recommended_fix: 'Suggested check: Check Wi-Fi signal quality and Ethernet cables.',
        metrics: { latency: 22, jitter: 2, packet_loss: 10, throughput_mbps: 4.5 }
    }));
    assert.equal(d.el('health-explanation').textContent, 'Failed ICMP probes detected (>2% loss).');
    assert.match(d.el('rf-interpretation-content').textContent, /What the model considers important:/);
    assert.match(d.el('rf-interpretation-content').textContent, /\(model score: 90\.0%\)/);
    assert.doesNotMatch(d.el('rf-interpretation-content').textContent, /confidence|certainty/i);

    await d.poll(sample({
        batch_id: 2,
        system_state: 'DEGRADED',
        diagnostic: '[PERF ALERT] Round-trip latency to 1.1.1.1 exceeded the 80 ms threshold.',
        metrics: { latency: 92, jitter: 5, packet_loss: 10, throughput_mbps: 4.1 }
    }));
    assert.equal(d.el('health-explanation').textContent, 'High latency and failed ICMP probes detected.');

    d.call('buildAlertCenter()');
    const firstCardText = d.el('alert-list-container').firstChild.textContent;
    assert.match(firstCardText, /What to check/);
    assert.doesNotMatch(firstCardText, /Suggested check:|Recommended check/i);
});

test('polished metrics preserve accessible units and forecasts keep their issue-time alignment', async () => {
    const d = dashboard();
    await d.respond(sample({batch_id: 1, forecasted_latency: 31}));
    await d.poll(sample({batch_id: 2, forecasted_latency: 42, metrics: {latency: 29, jitter: 2, packet_loss: 0, throughput_mbps: 5}}));
    assert.equal(d.el('m-forecast').textContent, '42.0 ms');
    assert.equal(d.el('m-forecast').children[0].tagName, 'small');
    assert.equal(d.el('m-forecast').children[0].textContent, ' ms');
    assert.deepEqual(Array.from(d.read('chartData.datasets[0].data')), [20, 29]);
    assert.deepEqual(Array.from(d.read('chartData.datasets[1].data')), [31, 42]);
    assert.match(d.read('chartData.datasets[1].label'), /Next-step prediction/);
    assert.equal(d.read('chartData.labels.length'), 2);
    d.call("setMetricText(document.getElementById('an-duration'), '2m 3s')");
    assert.equal(d.el('an-duration').textContent, '2m 3s');
    assert.equal(d.el('an-duration').children.length, 2);
    const row = d.el('console-logs').firstChild;
    assert.equal(row.className, 'log-row');
    assert.equal(row.children[0].attributes['aria-hidden'], 'true');
    assert.match(row.textContent, /Optimal:/);
});

const logRows = d => d.el('console-logs').children;
const logMatches = (d, pattern) => logRows(d).filter(row => pattern.test(row.textContent));
const warningSample = (batch_id, overrides = {}) => sample({batch_id, system_state: 'DEGRADED',
    diagnostic: 'Round-trip latency exceeded the configured limit.', recommended_fix: 'Check active transfers.',
    metrics: {latency: 95, jitter: 2, packet_loss: 0, throughput_mbps: 5}, ...overrides});

test('Activity Log records the first healthy sample only, using its backend timestamp', async () => {
    const d = dashboard();
    const timestamp = START / 1000 - 2;
    await d.respond(sample({timestamp}));
    for (let batch_id = 2; batch_id <= 20; batch_id++) await d.poll(sample({batch_id}));
    assert.equal(logRows(d).length, 2);
    assert.equal(logMatches(d, /smooth and normal/).length, 1);
    const reading = logMatches(d, /smooth and normal/)[0];
    assert.equal(reading.children[1].attributes.datetime, new Date(timestamp * 1000).toISOString());
    assert.equal(reading.children[1].attributes.title, 'Backend sample timestamp');
    assert.match(logMatches(d, /session active/)[0].children[1].attributes.title, /observed in this browser/);
    assert.equal(d.read('totalAlerts'), 0);
});

test('Activity Log suppresses persistent warnings, requires verified recovery, and records recurrence', async () => {
    const d = dashboard();
    await d.respond(warningSample(1));
    await d.poll(warningSample(2));
    await d.poll(sample({batch_id: 3, metrics: {latency: null, packet_loss: 0}}));
    await d.poll(warningSample(4));
    assert.equal(logMatches(d, /Round-trip latency exceeded/).length, 1);
    assert.equal(logMatches(d, /returned|normal/).length, 0);
    await d.poll(sample({batch_id: 5}));
    assert.equal(logMatches(d, /Network conditions have returned/).length, 1);
    await d.poll(warningSample(6));
    assert.equal(logMatches(d, /Round-trip latency exceeded/).length, 2);
    assert.equal(d.read('totalAlerts'), 4);
    assert.equal(d.read('sessionAlertsHistory.length'), 4);
    assert.equal(d.read("sessionAlertsHistory.every(a => a.fix === 'Check active transfers.')"), true);
    d.call('buildAlertCenter()');
    assert.equal(d.el('alert-list-container').children.length, 4);
});

test('simultaneous conditions are independent and unknown categories cannot be declared recovered', async () => {
    const d = dashboard();
    const combined = batch_id => warningSample(batch_id, {system_state:'CRITICAL', classification:'Abnormal',
        diagnostic:'Unusual traffic flagged.', metrics:{latency:95,packet_loss:10}});
    await d.respond(combined(1));
    await d.poll(combined(2));
    assert.equal(logRows(d).length, 4); // Three conditions + lifecycle.
    assert.equal(d.read('totalAlerts'), 6);
    for (const pattern of [/Unusual traffic/, /Round-trip latency/, /Failed ICMP probes/]) assert.equal(logMatches(d, pattern).length, 1);
    await d.poll(warningSample(3, {classification:'Normal', metrics:{latency:null,packet_loss:10}}));
    assert.equal(logMatches(d, /Traffic classification has returned/).length, 1);
    assert.equal(logMatches(d, /Latency has returned|ICMP probe loss has returned|Network conditions have returned/).length, 0);
    await d.poll(warningSample(4, {metrics:{latency:20,packet_loss:null}}));
    assert.equal(logMatches(d, /Latency has returned/).length, 1);
    assert.equal(logMatches(d, /ICMP probe loss has returned|Network conditions have returned/).length, 0);
    await d.poll(sample({batch_id:5}));
    assert.equal(logMatches(d, /Network conditions have returned/).length, 1);
    await d.poll(combined(6));
    for (const pattern of [/Unusual traffic/, /Round-trip latency/, /Failed ICMP probes/]) assert.equal(logMatches(d, pattern).length, 2);
});

for (const field of ['latency', 'packet_loss', 'classification']) {
    test(`unknown ${field} never implies recovery even when the backend reports OPTIMAL`, async () => {
        const d = dashboard();
        await d.respond(warningSample(1, {system_state:'CRITICAL', classification:'Abnormal', metrics:{latency:95,packet_loss:10}}));
        for (const [index, missing] of [null, undefined, 'unknown', NaN].entries()) {
            const next = sample({batch_id:index + 2});
            if (field === 'classification') next.classification = missing;
            else next.metrics[field] = missing;
            await d.poll(next);
        }
        assert.equal(logMatches(d, /Network conditions have returned|smooth and normal/).length, 0);
        const category = {latency:/Latency has returned/,packet_loss:/ICMP probe loss has returned/,classification:/Traffic classification has returned/}[field];
        assert.equal(logMatches(d, category).length, 0);
    });
}

for (const availability of ['stopped', 'stale', 'unavailable']) {
    test(`Activity Log records ${availability} once without clearing warning history`, async () => {
        const d = dashboard();
        await d.respond(warningSample(1));
        if (availability === 'stopped') {
            await d.poll(sample({is_monitoring:false}));
            d.call('monitoringStopped()');
            assert.equal(logMatches(d, /session ended/).length, 1);
        } else if (availability === 'stale') {
            d.call('cancelPolling()');
            await d.tick(12000);
            d.call('renderHealth(); renderHealth()');
            assert.equal(logMatches(d, /Telemetry is stale/).length, 1);
        } else {
            for (let i = 0; i < 2; i++) {
                d.call('streamTelemetry()');
                d.requests.at(-1).reject(new Error('offline'));
                await flush();
            }
            assert.equal(logMatches(d, /Telemetry is unavailable/).length, 1);
        }
        assert.equal(logMatches(d, /Round-trip latency exceeded/).length, 1);
        assert.equal(logMatches(d, /returned|resumed/).length, 0);
        assert.equal(d.read('totalAlerts'), 1);
        if (availability !== 'stopped') {
            await d.poll(warningSample(1)); // Duplicate cannot verify sampling recovery.
            assert.equal(logMatches(d, /returned|resumed/).length, 0);
            await d.poll(warningSample(2, {timestamp:d.now / 1000}));
            assert.equal(logMatches(d, /Telemetry resumed/).length, 1);
            assert.equal(logMatches(d, /Round-trip latency exceeded/).length, 1);
            assert.equal(logMatches(d, /Network conditions have returned/).length, 0);
            await d.poll(sample({batch_id:3, timestamp:d.now / 1000}));
            assert.equal(logMatches(d, /Network conditions have returned/).length, 1);
        }
    });
}

test('stale and invalid-health samples cannot resolve a previously active condition', async () => {
    const d = dashboard();
    await d.respond(warningSample(1));
    d.call('cancelPolling()');
    await d.tick(13000);
    await d.poll(sample({batch_id:2}));
    await d.poll(sample({batch_id:3, timestamp:d.now/1000, system_state:'UNKNOWN'}));
    assert.equal(logMatches(d, /returned|resumed|smooth and normal/).length, 0);
    await d.poll(warningSample(4, {timestamp:d.now/1000}));
    assert.equal(logMatches(d, /Round-trip latency exceeded/).length, 1);
    assert.equal(logMatches(d, /Telemetry resumed/).length, 1);
});

test('Activity Log resets only for a confirmed new session and ignores obsolete responses', async () => {
    const d = dashboard();
    await d.respond(warningSample(1, {diagnostic:'Old session warning'}));
    d.call('streamTelemetry()');
    const obsolete = d.requests.at(-1);
    d.call('toggleMonitoring()');
    await d.respond({status:'success',is_monitoring:false});
    assert.equal(logMatches(d, /Old session warning/).length, 1);
    assert.equal(logMatches(d, /session ended/).length, 1);
    d.call('toggleMonitoring()');
    assert.equal(logMatches(d, /Old session warning/).length, 1); // Pending start is not a new session.
    await d.respond({status:'success',is_monitoring:true,session_id:2,session_generation:2});
    assert.equal(logRows(d).length, 1);
    assert.equal(logMatches(d, /session started/).length, 1);
    await d.respond(sample({session_id:2,session_generation:2}));
    const before = d.el('console-logs').innerHTML;
    await d.respond(warningSample(99, {diagnostic:'Late old warning'}), obsolete);
    assert.equal(d.el('console-logs').innerHTML, before);
    await d.poll(warningSample(2, {session_id:1,session_generation:1}));
    assert.equal(logMatches(d, /session changed/).length, 1);
    assert.equal(logMatches(d, /Old session|Late old|Round-trip latency exceeded/).length, 0);
    await d.poll(sample({session_id:2,session_generation:2,batch_id:2}));
    assert.equal(logMatches(d, /session started/).length, 1);
    assert.equal(logMatches(d, /smooth and normal/).length, 1);
});

test('saved-session reconciliation retains every persisted record and never rewrites Activity Log history', async () => {
    const d = dashboard();
    await d.respond(warningSample(1));
    await d.poll(warningSample(2));
    await d.poll(sample({is_monitoring:false}));
    const history = d.el('console-logs').innerHTML;
    const details = {report:{duration_seconds:12, mean_latency_ms:95, total_triggers:3, ai_anomalies:0, latency_delay_events:3, packet_loss_events:0},
        telemetry_count:3, alerts:[1,2,3].map(n => ({alert_type:'HIGH_LATENCY',severity:'DEGRADED',timestamp:`2026-11-15T09:00:0${n}`, diagnostic:'Stored latency warning',recommended_fix:`Stored recommendation ${n}`}))};
    const original = JSON.stringify(details);
    d.call(`globalThis.savedFixture = ${original}; applySavedSessionReport(savedFixture)`);
    assert.equal(d.read('JSON.stringify(savedFixture)'), original);
    assert.equal(d.read('totalAlerts'), 3);
    assert.equal(d.el('ac-count-badge').textContent, '3 ALERTS');
    assert.equal(d.el('alert-list-container').children.length, 3);
    assert.deepEqual(JSON.parse(d.read('JSON.stringify(sessionAlertsHistory.map(a => a.fix))')), ['Stored recommendation 1','Stored recommendation 2','Stored recommendation 3']);
    assert.equal(d.el('console-logs').innerHTML, history);
    assert.ok(d.requests.every(r => !r.options.method || r.options.method === 'GET'));
});

test('Activity Log remains bounded and ordered by event timestamps with literal text', () => {
    const d = dashboard();
    for (let n = 1; n <= 55; n++) d.call(`appendLog('text-slate-400', '', 'Event ${n}', '', ${START/1000 + n})`);
    assert.equal(logRows(d).length, 50);
    assert.match(logRows(d)[0].textContent, /Event 55/);
    assert.match(logRows(d).at(-1).textContent, /Event 6/);
    d.call(`appendLog('text-slate-400', '', '<img src=x>', '', ${START/1000})`);
    assert.equal(logRows(d).length, 50);
    assert.match(logRows(d).at(-1).textContent, /Event 6/);
});

test('returning from a background tab immediately refreshes without false stale or resumed Activity Log entries', async () => {
    const d = dashboard();
    await d.respond(sample({ batch_id: 1 }));
    const initialCount = d.requests.length;

    d.setVisibility('hidden');
    // Simulate browser throttling/suspending timers while hidden past SAMPLE_MAX_AGE_MS.
    d.jumpTime(30000);
    await flush();
    assert.equal(logMatches(d, /Telemetry is stale|Telemetry resumed/).length, 0);

    d.setVisibility('visible');
    assert.equal(d.requests.length, initialCount + 1);
    assert.equal(d.requests.at(-1).url, '/api/telemetry/stream');
    assert.equal(d.requests.at(-1).options.cache, 'no-store');
    assert.equal(d.el('health-state').textContent, 'Checking telemetry');
    assert.equal(d.el('network-health').dataset.state, 'UNAVAILABLE');
    assert.equal(d.el('stream-status').textContent, 'TELEMETRY: CHECKING');
    assert.equal(d.el('metrics-status').textContent, 'METRICS: LAST RECORDED (NOT LIVE)');
    assert.equal(logMatches(d, /Telemetry is stale|Telemetry resumed/).length, 0);

    const resumedTs = d.now / 1000;
    const resumed = sample({ batch_id: 2, timestamp: resumedTs });
    await d.respond(resumed);
    assert.equal(d.el('health-state').textContent, 'OPTIMAL');
    assert.equal(d.el('network-health').dataset.state, 'OPTIMAL');
    assert.equal(d.el('metrics-status').textContent, 'METRICS: CURRENT SAMPLE');
    assert.equal(logMatches(d, /Telemetry is stale|Telemetry resumed/).length, 0);

    // Foreground 12-second freshness rule remains intact after returning.
    for (let i = 0; i < 4; i++) { await d.tick(2000); await d.respond(resumed); }
    await d.tick(3999);
    assert.equal(d.el('health-state').textContent, 'OPTIMAL');
    await d.tick(1);
    assert.equal(d.el('health-state').textContent, 'Telemetry stale');
    assert.equal(logMatches(d, /Telemetry is stale/).length, 1);
});

test('returning near the 12-second boundary transitions to neutral checking without stale log if refresh is in flight', async () => {
    const d = dashboard();
    await d.respond(sample({ batch_id: 1 }));

    d.setVisibility('hidden');
    d.jumpTime(11500);
    d.setVisibility('visible');
    assert.equal(d.el('health-state').textContent, 'OPTIMAL');
    const refresh = d.requests.at(-1);
    assert.equal(refresh.url, '/api/telemetry/stream');

    await d.tick(600);
    assert.equal(d.el('health-state').textContent, 'Checking telemetry');
    assert.equal(d.el('network-health').dataset.state, 'UNAVAILABLE');
    assert.equal(logMatches(d, /Telemetry is stale|Telemetry resumed/).length, 0);

    await d.respond(sample({ batch_id: 2, timestamp: d.now / 1000 }), refresh);
    assert.equal(d.el('health-state').textContent, 'OPTIMAL');
    assert.equal(logMatches(d, /Telemetry is stale|Telemetry resumed/).length, 0);
});

test('return-to-tab refresh reports genuine outdated telemetry or failed refresh and allows recovery', async () => {
    const d = dashboard();
    await d.respond(sample({ batch_id: 1 }));

    d.setVisibility('hidden');
    d.jumpTime(20000);
    d.setVisibility('visible');
    assert.equal(d.el('health-state').textContent, 'Checking telemetry');

    // Duplicate outdated sample confirms genuine staleness.
    await d.respond(sample({ batch_id: 1, timestamp: START / 1000 }));
    assert.equal(d.el('health-state').textContent, 'Telemetry stale');
    assert.equal(logMatches(d, /Telemetry is stale/).length, 1);

    await d.poll(sample({ batch_id: 2, timestamp: d.now / 1000 }));
    assert.equal(d.el('health-state').textContent, 'OPTIMAL');
    assert.equal(logMatches(d, /Telemetry resumed/).length, 1);

    // Failed return-to-tab refresh reports Telemetry unavailable.
    d.setVisibility('hidden');
    d.jumpTime(20000);
    d.setVisibility('visible');
    assert.equal(d.el('health-state').textContent, 'Checking telemetry');
    d.requests.at(-1).reject(new Error('offline on resume'));
    await flush();
    assert.equal(d.el('health-state').textContent, 'Telemetry unavailable');
    assert.equal(logMatches(d, /Telemetry is unavailable/).length, 1);
});

test('visibilitychange does not poll when stopped and avoids overlapping requests across transitions', async () => {
    const d = dashboard();
    await d.respond(sample({ is_monitoring: false }));
    const stoppedRequests = d.requests.length;

    d.setVisibility('hidden');
    d.setVisibility('visible');
    assert.equal(d.requests.length, stoppedRequests);
    assert.equal(d.el('health-state').textContent, 'Monitoring stopped');

    // Active session with an already in-flight request does not issue an overlapping GET on return.
    d.call('toggleMonitoring()');
    await d.respond({ status: 'success', is_monitoring: true, session_id: 2, session_generation: 2 });
    await d.respond(sample({ session_id: 2, session_generation: 2, batch_id: 1, timestamp: d.now / 1000 }));
    await d.tick(2000);
    const pendingBeforeHide = d.requests.length;
    const inflight = d.requests.at(-1);

    d.setVisibility('hidden');
    d.jumpTime(20000);
    d.setVisibility('visible');
    assert.equal(d.requests.length, pendingBeforeHide);
    assert.equal(d.el('health-state').textContent, 'Checking telemetry');

    // Server stopped externally while tab was hidden.
    await d.respond(sample({ is_monitoring: false, session_id: 2, session_generation: 2 }), inflight);
    assert.equal(d.el('health-state').textContent, 'Monitoring stopped');
    assert.equal(d.intervals(), 0);
    assert.equal(logMatches(d, /Telemetry is stale/).length, 0);
});

function recorded(batch, overrides = {}) {
    return sample({batch_id: batch, timestamp: START / 1000 + (batch - 1) * 3, ...overrides});
}
function completedDetails(samples, alertSpecs, sessionId = 1) {
    const alerts = alertSpecs.map(([batch, type, diagnostic = 'Saved latency warning', fix = 'Saved recommendation']) => ({
        batch_id: batch, alert_type: type, severity: type === 'AI_ANOMALY' ? 'CRITICAL' : 'DEGRADED',
        timestamp: new Date(samples.find(s => s.batch_id === batch).timestamp * 1000).toISOString(), diagnostic, recommended_fix: fix
    }));
    return {session: {id: sessionId, status: 'completed'}, telemetry_count: samples.length,
        report: {session_id: sessionId, duration_seconds: 20, mean_latency_ms: 25, total_triggers: alerts.length,
            ai_anomalies: alerts.filter(a => a.alert_type === 'AI_ANOMALY').length,
            latency_delay_events: alerts.filter(a => a.alert_type === 'HIGH_LATENCY').length,
            packet_loss_events: alerts.filter(a => a.alert_type === 'PACKET_LOSS').length}, alerts,
        activity_samples: samples.map(s => ({session_id: sessionId, batch_id:s.batch_id, timestamp:new Date(s.timestamp*1000).toISOString(),
            latency_ms:s.metrics.latency, packet_loss_pct:s.metrics.packet_loss, rf_classification:s.classification,
            system_state:s.system_state, diagnostic:s.diagnostic, recommended_fix:s.recommended_fix}))};
}
async function completeWithReport(d, details) {
    d.call('toggleMonitoring()');
    await d.respond({status:'success',is_monitoring:false,session_id:details.session.id});
    assert.equal(d.requests.at(-1).url, `/api/session/${details.session.id}`);
    await d.respond({status:'success',data:details});
}

test('completed history restores one brief warning missed in a background tab without fabricating live readings', async () => {
    const samples = [recorded(1), recorded(2,{system_state:'DEGRADED',metrics:{latency:85,packet_loss:0}}), recorded(7)];
    const details = completedDetails(samples, [[2,'HIGH_LATENCY']]);
    const d = dashboard();
    await d.respond(samples[0]);
    d.setVisibility('hidden');
    d.jumpTime(20000);
    d.setVisibility('visible');
    await d.respond(samples[2]);
    assert.equal(logMatches(d,/Saved latency warning/).length,0);
    const chart = d.read('JSON.stringify(chartData)');
    const metrics = d.el('m-latency').textContent;
    await completeWithReport(d, details);
    assert.equal(logMatches(d,/Saved latency warning/).length,1);
    assert.equal(logMatches(d,/Network conditions have returned/).length,1);
    assert.equal(logMatches(d,/Telemetry is stale|Telemetry resumed/).length,0);
    const row = logMatches(d,/Saved latency warning/)[0];
    assert.equal(row.children[1].attributes.datetime, details.alerts[0].timestamp);
    assert.equal(row.children[1].attributes.title,'Saved session sample timestamp');
    assert.equal(d.el('ac-count-badge').textContent,'1 ALERTS');
    assert.match(d.el('alert-list-container').textContent,/Saved latency warning.*Saved recommendation/);
    assert.equal(d.read('JSON.stringify(chartData)'),chart);
    assert.equal(d.el('m-latency').textContent,metrics);
    assert.equal(d.el('metrics-status').textContent,'METRICS: LAST RECORDED (NOT LIVE)');
    const reconciled = d.el('console-logs').innerHTML;
    d.call(`applySavedSessionReport(${JSON.stringify(details)})`);
    assert.equal(d.el('console-logs').innerHTML,reconciled);
});

test('persisted repeated warnings form one episode; a verified recovery permits recurrence', async () => {
    const warning = batch => recorded(batch,{system_state:'DEGRADED',metrics:{latency:95,packet_loss:0}});
    const samples = [recorded(1),warning(2),warning(3),recorded(4),warning(5),recorded(6)];
    const details = completedDetails(samples,[[2,'HIGH_LATENCY'],[3,'HIGH_LATENCY'],[5,'HIGH_LATENCY']]);
    const d=dashboard();
    await d.respond(samples[0]);
    d.jumpTime(3000); await d.poll(samples[1]); // One episode was already seen live.
    await completeWithReport(d,details);
    assert.equal(logMatches(d,/Saved latency warning/).length,2);
    assert.equal(logMatches(d,/Network conditions have returned/).length,2);
    assert.equal(logMatches(d,/Round-trip latency/).length,0); // Replaced, not duplicated.
    assert.equal(d.el('alert-list-container').children.length,3);
    assert.equal(d.read('totalAlerts'),3);
});

test('saved simultaneous conditions retain their exact diagnostics and recommendations', async () => {
    const samples=[recorded(1),recorded(2,{system_state:'CRITICAL',classification:'Abnormal',metrics:{latency:95,packet_loss:10}}),recorded(3)];
    const specs=[[2,'AI_ANOMALY','Saved traffic warning','Traffic recommendation'],[2,'HIGH_LATENCY','Saved latency warning','Latency recommendation'],[2,'PACKET_LOSS','Saved probe warning','Probe recommendation']];
    const details=completedDetails(samples,specs);
    const d=dashboard(); await d.respond(samples[0]);
    await completeWithReport(d,details);
    for (const [, ,message,fix] of specs) {
        const rows=logMatches(d,new RegExp(message));
        assert.equal(rows.length,1); assert.ok(rows[0].textContent.includes(fix));
        assert.ok(d.el('alert-list-container').textContent.includes(message));
    }
    assert.equal(d.read('totalAlerts'),3);
    assert.equal(logMatches(d,/Network conditions have returned/).length,1);
});

test('saved unknown measurements and stopped or unavailable states never invent network recovery', async () => {
    const samples=[recorded(1),recorded(2,{system_state:'DEGRADED',metrics:{latency:95,packet_loss:0}}),recorded(3,{metrics:{latency:null,packet_loss:0}})];
    const d=dashboard(); await d.respond(samples[0]);
    d.call('streamTelemetry()'); d.requests.at(-1).reject(new Error('offline')); await flush();
    assert.equal(logMatches(d,/Telemetry is unavailable/).length,1);
    await completeWithReport(d,completedDetails(samples,[[2,'HIGH_LATENCY']]));
    assert.equal(logMatches(d,/Saved latency warning/).length,1);
    assert.equal(logMatches(d,/Network conditions have returned|Latency has returned|Telemetry resumed/).length,0);
    assert.equal(logMatches(d,/Telemetry is unavailable/).length,1);
    assert.equal(logMatches(d,/session ended/).length,1);
});

test('external stop reconciles the completed session, while a late report cannot contaminate a restart', async () => {
    const samples=[recorded(1),recorded(2,{system_state:'DEGRADED',metrics:{latency:95,packet_loss:0}}),recorded(3)];
    const details=completedDetails(samples,[[2,'HIGH_LATENCY']]);
    const d=dashboard(); await d.respond(samples[0]);
    await d.poll({...samples[0],is_monitoring:false});
    assert.equal(d.requests.at(-1).url,'/api/session/1');
    await d.respond({status:'success',data:details});
    assert.equal(logMatches(d,/Saved latency warning/).length,1);
    d.call('loadSavedSessionReport(1)'); const late=d.requests.at(-1);
    d.call('toggleMonitoring()');
    await d.respond({status:'success',is_monitoring:true,session_id:2,session_generation:2});
    await d.respond(recorded(1,{session_id:2,session_generation:2}));
    const before=d.el('console-logs').innerHTML;
    await d.respond({status:'success',data:details},late);
    assert.equal(d.el('console-logs').innerHTML,before);
    assert.equal(d.read('totalAlerts'),0);
});

test('reconciliation validates session and complete history before replacing log events, and renders saved markup literally', async () => {
    const markup='<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const samples=[recorded(1),recorded(2,{system_state:'DEGRADED',metrics:{latency:95,packet_loss:0}}),recorded(3)];
    const details=completedDetails(samples,[[2,'HIGH_LATENCY',markup,markup]]);
    const d=dashboard(); await d.respond(samples[0]); await completeWithReport(d,details);
    const row=logMatches(d,/onerror/)[0];
    assert.ok(row.textContent.includes(markup)); assert.ok(!row.innerHTML.includes('<img'));
    const before=d.el('console-logs').innerHTML;
    const invalids=[{...details,session:{id:99,status:'completed'}},{...details,activity_samples:details.activity_samples.slice(0,2)},
        {...details,activity_samples:[details.activity_samples[0],{...details.activity_samples[1],timestamp:'invalid'},details.activity_samples[2]]}];
    for (const invalid of invalids) {
        d.call(`reconcileActivityLog(${JSON.stringify(invalid)})`);
        assert.equal(d.el('console-logs').innerHTML,before);
    }
});
