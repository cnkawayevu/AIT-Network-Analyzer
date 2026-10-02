import urllib.request
import time
import json
import sqlite3
import subprocess
import os
import sys
import numpy as np
from network_models import NetworkAIEngine

def req(url, payload=None, has_payload=False, method="GET", request_timeout=1.0):
    r = urllib.request.Request(url, method=method)
    if has_payload:
        r.add_header('Content-Type', 'application/json')
        r.data = json.dumps(payload).encode('utf-8')
    try:
        with urllib.request.urlopen(r, timeout=request_timeout) as response:
            return json.loads(response.read().decode())
    except urllib.error.URLError as e:
        return {"error": str(e)}

def wait_for_http(process, timeout=15):
    start = time.monotonic()
    deadline = start + timeout

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise Exception("Timeout waiting for HTTP readiness")

        if process.poll() is not None:
            raise Exception("Child process exited early")

        request_timeout = min(1.0, remaining)
        try:
            r = req('http://localhost:5000/api/telemetry', request_timeout=request_timeout)
        except Exception:
            r = None

        remaining_after = deadline - time.monotonic()
        if remaining_after < 0:
            raise Exception("Timeout waiting for HTTP readiness")

        if isinstance(r, dict) and 'error' not in r:
            status = r.get('status')
            if status in ("warmup", "success"):
                if "is_monitoring" in r and isinstance(r["is_monitoring"], bool):
                    if "session_id" in r and "session_generation" in r:
                        if status == "success":
                            if "batch_id" in r:
                                return
                        else:
                            return

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise Exception("Timeout waiting for HTTP readiness")

        time.sleep(min(0.25, remaining))

def run_targeted_tests():
    print("\n=== TARGETED TESTS ===")

    print("\n--- T1: predict_latency robustness ---")
    engine = NetworkAIEngine()

    cases = [
        ("None", None),
        ("[]", []),
        ("np.array([])", np.array([])),
        ("[25]", [25]),
        ("np.array([10.,20.])", np.array([10., 20.])),
        ("[25,'bad',nan,inf]", [25, "bad", np.nan, float('inf')]),
        ("10 valid", [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]),
        ("12 valid", [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]),
    ]
    for name, data in cases:
        try:
            res = engine.predict_latency(data)
            print(f"T1 {name}: {res}")
        except Exception as e:
            print(f"T1 {name} EXCEPTION: {e}")

run_targeted_tests()

print("\n=== INTEGRATION TESTS ===")

env = os.environ.copy()
env["CAPSTONE_FROZEN_TEST"] = "1"

created_sessions = []

p = subprocess.Popen([sys.executable, "app.py"], env=env)
try:
    wait_for_http(p, timeout=45)
    print("Startup readiness: OK")

    print("\n--- TEST 1: Normal session ---")
    res1 = req('http://localhost:5000/api/control', payload={'action': 'start'}, has_payload=True, method="POST")
    print("Start 1:", res1)
    assert res1.get("status") == "success" and res1.get("is_monitoring") is True, "Start failed"
    sid1 = res1.get("session_id")
    created_sessions.append(sid1)

    time.sleep(5)
    res2 = req('http://localhost:5000/api/control', payload={'action': 'stop'}, has_payload=True, method="POST")
    print("Stop 1:", res2)
    assert res2.get("status") == "success" and res2.get("is_monitoring") is False, "Stop failed"

    print("\n--- TEST 2: Repeated START ---")
    res3 = req('http://localhost:5000/api/control', payload={'action': 'start'}, has_payload=True, method="POST")
    res4 = req('http://localhost:5000/api/control', payload={'action': 'start'}, has_payload=True, method="POST")
    print("Start A:", res3)
    print("Start B:", res4)
    assert res3.get("status") == "success" and res4.get("status") == "success"
    assert res3.get("session_id") == res4.get("session_id"), "Repeated Start must retain same session"
    sid2 = res3.get("session_id")
    created_sessions.append(sid2)

    time.sleep(2)

    print("\n--- TEST 3: Repeated STOP ---")
    res5 = req('http://localhost:5000/api/control', payload={'action': 'stop'}, has_payload=True, method="POST")
    res6 = req('http://localhost:5000/api/control', payload={'action': 'stop'}, has_payload=True, method="POST")
    print("Stop A:", res5)
    print("Stop B:", res6)
    assert res5.get("status") == "success" and res6.get("status") == "success"

    print("\n--- TEST T6: Malformed /api/control matrix ---")
    cases = [None, [], "start", 123, {}, {"action": "invalid"}]
    for c in cases:
        r = req('http://localhost:5000/api/control', payload=c, has_payload=True, method="POST")
        print(f"POST {c}: {r}")
        assert "error" in r and "400" in r["error"], f"Malformed {c} did not return 400. Got: {r}"

    print("\n--- DB Dump / Coverage ---")
    conn = sqlite3.connect('network_analyzer.db')
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    for t in ['sessions', 'telemetry', 'alerts', 'session_reports']:
        cur.execute(f"SELECT * FROM {t}")
        rows = [dict(r) for r in cur.fetchall()]
        print(f"{t} count:", len(rows))

    cur.execute("PRAGMA foreign_key_check;")
    fk_violations = cur.fetchall()
    print("FK violations:", fk_violations)
    assert len(fk_violations) == 0, "Foreign key check failed"

finally:
    print("Killing app...")
    p.kill()
    p.wait()

print("\n--- TEST 6: Persistence ---")
p2 = subprocess.Popen([sys.executable, "app.py"], env=env)
try:
    wait_for_http(p2, timeout=45)
    res = req('http://localhost:5000/api/sessions')
    sessions = res.get('sessions', [])
    print("Sessions on restart:", len(sessions))
    fetched_sids = [s.get('id') for s in sessions]
    for sid in created_sessions:
        assert sid in fetched_sids, f"Session {sid} not found in persistence!"
    print("Exact session persistence asserted successfully.")
finally:
    p2.kill()
    p2.wait()
