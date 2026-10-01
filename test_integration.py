import urllib.request
import time
import json
import sqlite3
import subprocess
import os

def req(url, data=None):
    if data:
        r = urllib.request.Request(url, data=json.dumps(data).encode('utf-8'), headers={'Content-Type': 'application/json'})
    else:
        r = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(r) as response:
            return json.loads(response.read().decode())
    except urllib.error.URLError as e:
        return {"error": str(e)}

print("Starting background app...")
p = subprocess.Popen([r".\venv\Scripts\python.exe", "app.py"])
time.sleep(5)

try:
    print("\n--- TEST 1: Normal session ---")
    res1 = req('http://localhost:5000/api/control', {'action': 'start'})
    print("Start 1:", res1)
    time.sleep(10)
    res2 = req('http://localhost:5000/api/control', {'action': 'stop'})
    print("Stop 1:", res2)

    print("\n--- TEST 2: Repeated START ---")
    res3 = req('http://localhost:5000/api/control', {'action': 'start'})
    res4 = req('http://localhost:5000/api/control', {'action': 'start'})
    print("Start A:", res3)
    print("Start B:", res4)
    time.sleep(2)

    print("\n--- TEST 3: Repeated STOP ---")
    res5 = req('http://localhost:5000/api/control', {'action': 'stop'})
    res6 = req('http://localhost:5000/api/control', {'action': 'stop'})
    print("Stop A:", res5)
    print("Stop B:", res6)

    print("\n--- DB Dump ---")
    conn = sqlite3.connect('network_analyzer.db')
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    
    for t in ['sessions', 'telemetry', 'alerts', 'session_reports']:
        cur.execute(f"SELECT * FROM {t}")
        rows = [dict(r) for r in cur.fetchall()]
        print(f"{t} count:", len(rows))
        if t == 'session_reports':
            print("reports:", rows)
        if t == 'sessions':
            print("sessions:", rows)
            
    print("\n--- TEST 5: PRAGMA foreign_key_check ---")
    cur.execute("PRAGMA foreign_key_check;")
    print("violations:", cur.fetchall())

finally:
    print("Killing app...")
    p.kill()

print("\n--- TEST 6: Persistence ---")
p2 = subprocess.Popen([r".\venv\Scripts\python.exe", "app.py"])
time.sleep(15)
try:
    res = req('http://localhost:5000/api/sessions')
    print("Sessions on restart:", len(res.get('sessions', [])))
finally:
    p2.kill()
