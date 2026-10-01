import sqlite3
import queue
import threading
import json
from datetime import datetime

DB_FILE = 'network_analyzer.db'
db_queue = queue.Queue()

def _get_connection(row_factory=None, check_same_thread=True):
    conn = sqlite3.connect(DB_FILE, check_same_thread=check_same_thread)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    if row_factory:
        conn.row_factory = row_factory
    return conn

def init_db():
    with _get_connection() as conn:
        
        # 1. sessions
        conn.execute('''
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                start_time TEXT NOT NULL,
                end_time TEXT,
                status TEXT NOT NULL,
                duration_seconds REAL,
                mean_latency_ms REAL,
                total_triggers INTEGER DEFAULT 0,
                ai_anomalies INTEGER DEFAULT 0,
                latency_delay_events INTEGER DEFAULT 0,
                packet_loss_events INTEGER DEFAULT 0
            )
        ''')
        
        # 2. telemetry
        conn.execute('''
            CREATE TABLE IF NOT EXISTS telemetry (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                batch_id INTEGER NOT NULL,
                timestamp TEXT NOT NULL,
                latency_ms REAL,
                jitter_ms REAL,
                packet_loss_pct REAL,
                throughput_mbps REAL,
                lstm_forecast_ms REAL,
                rf_classification TEXT,
                system_state TEXT,
                diagnostic TEXT,
                recommended_fix TEXT,
                rf_features_json TEXT,
                FOREIGN KEY(session_id) REFERENCES sessions(id),
                UNIQUE(session_id, batch_id)
            )
        ''')
        
        # 3. alerts
        conn.execute('''
            CREATE TABLE IF NOT EXISTS alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                batch_id INTEGER NOT NULL,
                timestamp TEXT NOT NULL,
                alert_type TEXT NOT NULL,
                severity TEXT NOT NULL,
                diagnostic TEXT,
                recommended_fix TEXT,
                FOREIGN KEY(session_id) REFERENCES sessions(id),
                UNIQUE(session_id, batch_id, alert_type)
            )
        ''')
        
        # 4. session_reports
        conn.execute('''
            CREATE TABLE IF NOT EXISTS session_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL UNIQUE,
                generated_at TEXT NOT NULL,
                duration_seconds REAL,
                mean_latency_ms REAL,
                mean_jitter_ms REAL,
                mean_packet_loss_pct REAL,
                mean_throughput_mbps REAL,
                max_latency_ms REAL,
                max_throughput_mbps REAL,
                total_triggers INTEGER DEFAULT 0,
                ai_anomalies INTEGER DEFAULT 0,
                latency_delay_events INTEGER DEFAULT 0,
                packet_loss_events INTEGER DEFAULT 0,
                summary TEXT,
                FOREIGN KEY(session_id) REFERENCES sessions(id)
            )
        ''')
        
        # Startup Recovery: Mark interrupted sessions
        conn.execute("UPDATE sessions SET status='interrupted' WHERE status='active'")
        conn.commit()


def db_worker():
    """Dedicated background thread for non-blocking telemetry & alert inserts."""
    conn = _get_connection(check_same_thread=False)
    
    while True:
        item = db_queue.get()
        if item is None:
            db_queue.task_done()
            break
        
        table, data = item
        try:
            if table == 'telemetry':
                conn.execute('''
                    INSERT OR IGNORE INTO telemetry
                    (session_id, batch_id, timestamp, latency_ms, jitter_ms, packet_loss_pct, throughput_mbps, 
                     lstm_forecast_ms, rf_classification, system_state, diagnostic, recommended_fix, rf_features_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''', data)
            elif table == 'alerts':
                conn.execute('''
                    INSERT OR IGNORE INTO alerts
                    (session_id, batch_id, timestamp, alert_type, severity, diagnostic, recommended_fix)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                ''', data)
            conn.commit()
        except Exception as e:
            conn.rollback()
            print(f"[database] Error inserting into {table}: {e}")
        finally:
            db_queue.task_done()

# Start the DB writer thread on module import
threading.Thread(target=db_worker, daemon=True).start()


def start_session():
    """Synchronous creation of a new session."""
    with _get_connection() as conn:
        cur = conn.cursor()
        cur.execute("INSERT INTO sessions (start_time, status) VALUES (?, 'active')", (datetime.utcnow().isoformat(),))
        conn.commit()
        return cur.lastrowid

def flush_queue():
    db_queue.join()

def stop_session(session_id):
    """Flushes writes and safely computes final session aggregates."""
    flush_queue()
    
    with _get_connection(row_factory=sqlite3.Row) as conn:
        cur = conn.cursor()
        cur.execute("SELECT start_time, status FROM sessions WHERE id=?", (session_id,))
        row = cur.fetchone()
        if not row:
            return
            
        if row['status'] in ('completed', 'interrupted'):
            return

        start_time = datetime.fromisoformat(row['start_time'])
        end_time = datetime.utcnow()
        duration_seconds = (end_time - start_time).total_seconds()
        
        # Calculate aggregates mathematically from telemetry rows
        cur.execute("""
            SELECT 
                AVG(latency_ms) as mean_latency,
                AVG(jitter_ms) as mean_jitter,
                AVG(packet_loss_pct) as mean_loss,
                AVG(throughput_mbps) as mean_throughput,
                MAX(latency_ms) as max_latency,
                MAX(throughput_mbps) as max_throughput
            FROM telemetry WHERE session_id=?
        """, (session_id,))
        aggs = cur.fetchone()

        cur.execute("""
            SELECT alert_type, COUNT(*) as cnt
            FROM alerts WHERE session_id=?
            GROUP BY alert_type
        """, (session_id,))
        alerts_counts = cur.fetchall()
        
        ai_anom = lat_delay = pkt_loss = 0
        for r in alerts_counts:
            if r['alert_type'] == 'AI_ANOMALY': ai_anom = r['cnt']
            elif r['alert_type'] == 'HIGH_LATENCY': lat_delay = r['cnt']
            elif r['alert_type'] == 'PACKET_LOSS': pkt_loss = r['cnt']
            
        total_triggers = ai_anom + lat_delay + pkt_loss
        
        mean_latency = aggs['mean_latency'] if aggs['mean_latency'] is not None else None
        
        # Update session
        cur.execute("""
            UPDATE sessions 
            SET end_time=?, status='completed', duration_seconds=?, mean_latency_ms=?,
                total_triggers=?, ai_anomalies=?, latency_delay_events=?, packet_loss_events=?
            WHERE id=?
        """, (
            end_time.isoformat(), duration_seconds, mean_latency, 
            total_triggers, ai_anom, lat_delay, pkt_loss, session_id
        ))
        
        # Insert report
        summary = f"Session {session_id} completed. Duration: {duration_seconds:.1f}s. Alerts triggered: {total_triggers}."
        cur.execute("""
            INSERT OR REPLACE INTO session_reports 
            (session_id, generated_at, duration_seconds, mean_latency_ms, mean_jitter_ms, mean_packet_loss_pct,
             mean_throughput_mbps, max_latency_ms, max_throughput_mbps, total_triggers, ai_anomalies, 
             latency_delay_events, packet_loss_events, summary)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            session_id, end_time.isoformat(), duration_seconds, mean_latency,
            aggs['mean_jitter'], aggs['mean_loss'], aggs['mean_throughput'],
            aggs['max_latency'], aggs['max_throughput'],
            total_triggers, ai_anom, lat_delay, pkt_loss, summary
        ))
        conn.commit()

def get_recent_sessions(limit=20):
    with _get_connection(row_factory=sqlite3.Row) as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, start_time, end_time, status, duration_seconds, mean_latency_ms, total_triggers FROM sessions ORDER BY id DESC LIMIT ?", (limit,))
        return [dict(row) for row in cur.fetchall()]

def get_session_details(session_id):
    with _get_connection(row_factory=sqlite3.Row) as conn:
        cur = conn.cursor()
        
        cur.execute("SELECT * FROM sessions WHERE id=?", (session_id,))
        session = cur.fetchone()
        if not session:
            return None
            
        cur.execute("SELECT * FROM session_reports WHERE session_id=?", (session_id,))
        report = cur.fetchone()
        
        cur.execute("SELECT COUNT(*) as cnt FROM telemetry WHERE session_id=?", (session_id,))
        telemetry_count = cur.fetchone()['cnt']
        
        cur.execute("SELECT alert_type, severity, diagnostic, timestamp FROM alerts WHERE session_id=? ORDER BY id ASC", (session_id,))
        alerts = [dict(r) for r in cur.fetchall()]
        
        return {
            "session": dict(session),
            "report": dict(report) if report else None,
            "telemetry_count": telemetry_count,
            "alerts": alerts
        }
