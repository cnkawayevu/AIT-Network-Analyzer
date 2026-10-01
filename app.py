import os
os.environ["SCAPY_USE_LIBPCAP"] = "0"

from flask import Flask, render_template, jsonify, request
import time
import threading
import random
import subprocess
import json
from datetime import datetime
from scapy.all import sniff, IP
from interface_selector import get_active_interface, get_active_ip
from network_models import NetworkAIEngine
import database as db

db.init_db()

app = Flask(__name__)

# Initialize AI Research Engine matching Chapter 3 Framework
ai_engine = NetworkAIEngine(rf_model_path="rf_model.joblib", time_steps=10)

# Ensure pre-trained Random Forest model exists
if not ai_engine.is_trained and os.path.exists("optimized_training_data.csv"):
    print("[app.py] Pre-training RandomForest on optimized_training_data.csv...")
    ai_engine.train_anomaly_detector("optimized_training_data.csv")

# Ensure LSTM Forecaster exists or train it
if not ai_engine.lstm_available:
    if os.path.exists("latency_baseline.csv"):
        print("[app.py] Training LSTM forecaster on latency_baseline.csv...")
        ai_engine.train_lstm_forecaster("latency_baseline.csv")
    else:
        print("[app.py] WARNING: latency_baseline.csv not found. LSTM forecaster will remain unavailable.")

# Rolling queues for QoS metric generation
historical_latencies = []
historical_ping_results = []
historical_valid_rtts = []

latest_completed_batch = None
batch_counter = 0

# Live packet capture aggregates (interval reset)
captured_bytes = 0
fwd_lengths = []
bwd_lengths = []
first_packet_time = None
last_packet_time = None
packet_count = 0

last_check_time = time.time()
data_lock = threading.Lock()
session_lock = threading.Lock()
is_monitoring = False
current_session_id = None

def evaluate_health(rf_classification, latency_ms, packet_loss_pct):
    alerts = []
    
    if rf_classification == 'Abnormal':
        alerts.append({
            "alert_type": "AI_ANOMALY",
            "severity": "CRITICAL",
            "diagnostic": "[AI ALERT] Unusual traffic pattern detected! This looks like a network attack or strange behavior.",
            "recommended_fix": "How to fix: Check your connected devices for unwanted users. Look at your firewall logs to see blocked connections, and disconnect the affected computers to be safe."
        })
        
    if latency_ms is not None and latency_ms > 80.0:
        alerts.append({
            "alert_type": "HIGH_LATENCY",
            "severity": "DEGRADED",
            "diagnostic": "[PERF ALERT] High latency is causing a network delay.",
            "recommended_fix": "How to fix: Find out which apps or users are downloading large files and limit their speed (traffic shaping)."
        })
        
    if packet_loss_pct is not None and packet_loss_pct > 2.0:
        alerts.append({
            "alert_type": "PACKET_LOSS",
            "severity": "DEGRADED",
            "diagnostic": "[PERF ALERT] Too many data packets are getting lost (over 2%). This forces the network to keep resending data, making things slow.",
            "recommended_fix": "How to fix: Check for damaged network cables or loose plugs. Make sure router and switch settings match perfectly on both ends (check duplex settings)."
        })
        
    if any(a["severity"] == "CRITICAL" for a in alerts):
        system_state = "CRITICAL"
    elif any(a["severity"] == "DEGRADED" for a in alerts):
        system_state = "DEGRADED"
    else:
        system_state = "OPTIMAL"
        
    if any(a["alert_type"] == "AI_ANOMALY" for a in alerts):
        diagnostic = "[AI ALERT] Unusual traffic pattern detected! This looks like a network attack or strange behavior."
        recommended_fix = "How to fix: Check your connected devices for unwanted users. Look at your firewall logs to see blocked connections, and disconnect the affected computers to be safe."
    elif any(a["alert_type"] == "HIGH_LATENCY" for a in alerts):
        diagnostic = "[PERF ALERT] High latency is causing a network delay."
        recommended_fix = "How to fix: Find out which apps or users are downloading large files and limit their speed (traffic shaping)."
    elif any(a["alert_type"] == "PACKET_LOSS" for a in alerts):
        diagnostic = "[PERF ALERT] Too many data packets are getting lost (over 2%). This forces the network to keep resending data, making things slow."
        recommended_fix = "How to fix: Check for damaged network cables or loose plugs. Make sure router and switch settings match perfectly on both ends (check duplex settings)."
    else:
        diagnostic = "[INFO] Network traffic is smooth and normal."
        recommended_fix = ""
        
    return {
        "system_state": system_state,
        "diagnostic": diagnostic,
        "recommended_fix": recommended_fix,
        "alerts": alerts
    }

# Resolve the best active physical interface once at startup
ACTIVE_IFACE = get_active_interface()   # e.g. "WiFi" or "Ethernet"; None = all interfaces
ACTIVE_IP = get_active_ip()


def live_packet_sniffer():
    """Continuously monitors the active network interface socket stream.

    Binds scapy's sniff() exclusively to the auto-detected physical interface.
    Logs terminal errors on interface drops without crashing the Flask server.
    """
    global packet_count, captured_bytes, fwd_lengths, bwd_lengths, first_packet_time, last_packet_time

    def process_packet(packet):
        global packet_count, captured_bytes, fwd_lengths, bwd_lengths, first_packet_time, last_packet_time, is_monitoring
        if not is_monitoring:
            return
        if packet.haslayer(IP):
            ip_src = packet[IP].src
            ip_dst = packet[IP].dst
            pkt_len = len(packet)
            pkt_time = float(packet.time)
            
            if ip_src == ACTIVE_IP or ip_dst == ACTIVE_IP:
                with data_lock:
                    packet_count += 1
                    captured_bytes += pkt_len
                    
                    if first_packet_time is None:
                        first_packet_time = pkt_time
                    last_packet_time = pkt_time

                    if ip_src == ACTIVE_IP:
                        fwd_lengths.append(pkt_len)
                    elif ip_dst == ACTIVE_IP:
                        bwd_lengths.append(pkt_len)

    iface_label = ACTIVE_IFACE if ACTIVE_IFACE else "ALL interfaces (fallback)"
    print(f"[sniffer] Starting packet capture on interface: {iface_label}")

    while True:
        try:
            from scapy.config import conf
            sock = conf.L3socket if not getattr(conf, 'use_pcap', True) else None
            sniff(
                iface=ACTIVE_IFACE,
                L2socket=sock,
                prn=process_packet,
                store=0
            )
        except OSError as os_err:
            print(f"[sniffer] OSError on interface '{iface_label}': {os_err}")
            time.sleep(5)
        except Exception as exc:
            print(f"[sniffer] Capture notice on '{iface_label}': {exc}")
            time.sleep(5)


def track_performance_metrics():
    """Calculates true dynamic QoS network performance values periodically."""
    global packet_count, captured_bytes, fwd_lengths, bwd_lengths, first_packet_time, last_packet_time
    global last_check_time, latest_completed_batch, batch_counter, is_monitoring
    global historical_latencies, historical_ping_results, historical_valid_rtts

    while True:
        time.sleep(2)
        if not is_monitoring:
            with data_lock:
                packet_count = 0
                captured_bytes = 0
                fwd_lengths = []
                bwd_lengths = []
                first_packet_time = None
                last_packet_time = None
                historical_latencies = []
                historical_ping_results = []
                historical_valid_rtts = []
                last_check_time = time.time()
                latest_completed_batch = None
                batch_counter = 0
            continue

        current_time = time.time()
        elapsed = current_time - last_check_time

        with data_lock:
            snap_bytes = captured_bytes
            
            captured_bytes = 0
            packet_count = 0
            
            snap_fwd = list(fwd_lengths)
            snap_bwd = list(bwd_lengths)
            snap_first_time = first_packet_time
            snap_last_time = last_packet_time

            fwd_lengths = []
            bwd_lengths = []
            first_packet_time = None
            last_packet_time = None
            last_check_time = current_time

        # 1. Throughput calculation
        throughput_bps = (snap_bytes * 8) / elapsed if elapsed > 0 else 0.0
        throughput_mbps = round(throughput_bps / 1_000_000.0, 2)

        # 2. Query True System Latency via ICMP Ping
        latency_val = None
        try:
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            output = subprocess.check_output(
                ["ping", "-n", "1", "1.1.1.1"],
                startupinfo=startupinfo,
                universal_newlines=True,
                timeout=2
            )
            if "time=" in output:
                time_str = output.split("time=")[1].split("ms")[0].strip()
                latency_val = float(time_str)
        except Exception:
            pass

        if latency_val is not None:
            if len(historical_ping_results) >= 10: historical_ping_results.pop(0)
            historical_ping_results.append(0)
            if len(historical_valid_rtts) >= 10: historical_valid_rtts.pop(0)
            historical_valid_rtts.append(latency_val)
        else:
            if len(historical_ping_results) >= 10: historical_ping_results.pop(0)
            historical_ping_results.append(1)

        packet_loss_pct = None
        if len(historical_ping_results) > 0:
            packet_loss_pct = round((sum(historical_ping_results) / len(historical_ping_results)) * 100.0, 2)

        jitter_val = None
        if len(historical_valid_rtts) >= 2:
            diffs = [abs(historical_valid_rtts[i] - historical_valid_rtts[i-1]) for i in range(1, len(historical_valid_rtts))]
            jitter_val = round(sum(diffs) / len(diffs), 2)

        # 3. RF Feature Extraction (OUTSIDE the lock)
        if snap_first_time is not None and snap_last_time is not None:
            flow_duration_us = (snap_last_time - snap_first_time) * 1_000_000.0
        else:
            flow_duration_us = 0.0

        total_fwd_packets = float(len(snap_fwd))
        total_bwd_packets = float(len(snap_bwd))
        total_packets = total_fwd_packets + total_bwd_packets

        bwd_packets_per_sec = total_bwd_packets / elapsed if elapsed > 0 else 0.0
        flow_packets_per_sec = total_packets / elapsed if elapsed > 0 else 0.0

        total_fwd_bytes = sum(snap_fwd)
        total_bwd_bytes = sum(snap_bwd)
        flow_bytes_per_sec = (total_fwd_bytes + total_bwd_bytes) / elapsed if elapsed > 0 else 0.0

        fwd_len_max = float(max(snap_fwd)) if snap_fwd else 0.0
        fwd_len_min = float(min(snap_fwd)) if snap_fwd else 0.0
        bwd_len_max = float(max(snap_bwd)) if snap_bwd else 0.0
        bwd_len_min = float(min(snap_bwd)) if snap_bwd else 0.0

        live_features = [
            flow_duration_us,
            total_fwd_packets,
            bwd_packets_per_sec,
            fwd_len_max,
            fwd_len_min,
            bwd_len_max,
            bwd_len_min,
            flow_packets_per_sec,
            flow_bytes_per_sec
        ]

        # 4. ML Inference
        rf_classification = ai_engine.predict(live_features)

        if latency_val is not None:
            if len(historical_latencies) >= 10:
                historical_latencies.pop(0)
            historical_latencies.append(latency_val)

        forecasted_latency = ai_engine.predict_latency(historical_latencies)

        # 5. Health evaluation: RF classification + performance threshold rules
        health_status = evaluate_health(rf_classification, latency_val, packet_loss_pct)
        system_state = health_status["system_state"]
        diagnostic = health_status["diagnostic"]
        recommended_fix = health_status["recommended_fix"]
        active_alerts = health_status["alerts"]

        batch_counter += 1
        # 6. Interpretability (Feature-aware)
        rf_interpretation = ai_engine.get_rf_interpretation(live_features)

        latest_completed_batch = {
            "batch_id": batch_counter,
            "status": "success",
            "timestamp": int(time.time()),
            "system_state": system_state,
            "metrics": {
                "latency": latency_val,
                "latency_ms": latency_val,
                "jitter": jitter_val,
                "jitter_ms": jitter_val,
                "packet_loss": packet_loss_pct,
                "packet_loss_pct": packet_loss_pct,
                "throughput_mbps": throughput_mbps,
            },
            "predictions": {
                "classification": rf_classification,
                "is_anomaly": (rf_classification == 'Abnormal'),
                "forecasted_latency": forecasted_latency
            },
            "classification": rf_classification,
            "forecasted_latency": forecasted_latency,
            "diagnostic": diagnostic,
            "recommended_fix": recommended_fix,
            "interpretability": rf_interpretation
        }

        with session_lock:
            if is_monitoring and current_session_id is not None:
                sid = current_session_id
                ts = datetime.utcnow().isoformat()
                
                db.db_queue.put(('telemetry', (
                    sid,
                    batch_counter,
                    ts,
                    latency_val,
                    jitter_val,
                    packet_loss_pct,
                    throughput_mbps,
                    forecasted_latency,
                    rf_classification,
                    system_state,
                    diagnostic,
                    recommended_fix,
                    json.dumps(live_features)
                )))

                for alert in active_alerts:
                    db.db_queue.put(('alerts', (
                        sid, 
                        batch_counter, 
                        ts, 
                        alert["alert_type"], 
                        alert["severity"], 
                        alert["diagnostic"], 
                        alert["recommended_fix"]
                    )))


# Spin up concurrent hardware background execution threads
threading.Thread(target=live_packet_sniffer, daemon=True).start()
threading.Thread(target=track_performance_metrics, daemon=True).start()


@app.route('/')
def console():
    """Serves the main operations dashboard console."""
    return render_template('index.html')


@app.route('/api/control', methods=['POST'])
def control():
    """Toggles background network monitoring."""
    global is_monitoring, current_session_id
    data = request.get_json()
    if data and "action" in data:
        if data["action"] == "start":
            with session_lock:
                if is_monitoring:
                    return jsonify({"status": "success", "is_monitoring": True, "session_id": current_session_id})
                try:
                    new_id = db.start_session()
                    current_session_id = new_id
                    is_monitoring = True
                    return jsonify({"status": "success", "is_monitoring": True, "session_id": current_session_id})
                except Exception as e:
                    return jsonify({"status": "error", "message": "Failed to start DB session"}), 500

        elif data["action"] == "stop":
            with session_lock:
                if not is_monitoring or current_session_id is None:
                    return jsonify({"status": "success", "is_monitoring": False})
                
                sid = current_session_id
                is_monitoring = False
                
                try:
                    db.stop_session(sid)
                    current_session_id = None
                    return jsonify({"status": "success", "is_monitoring": False, "session_id": sid})
                except Exception as e:
                    print(f"[app.py] Error finalizing session: {e}")
                    return jsonify({"status": "error", "message": "Failed to finalize DB session"}), 500

    return jsonify({"status": "error", "message": "Invalid payload"}), 400


@app.route('/api/telemetry')
@app.route('/api/telemetry/stream')
def get_telemetry():
    """Combined JSON API route serving live metrics and AI model predictions.

    Reads the latest completed micro-batch to ensure coherent single-inference reporting.
    """
    global latest_completed_batch
    
    if latest_completed_batch is None:
        # Provide a warm-up placeholder before the first interval completes
        return jsonify({
            "status": "warmup",
            "timestamp": int(time.time()),
            "system_state": "OPTIMAL",
            "metrics": {
                "latency": None, "latency_ms": None,
                "jitter": None, "jitter_ms": None,
                "packet_loss": None, "packet_loss_pct": None,
                "throughput_mbps": 0.0
            },
            "predictions": {
                "classification": "Normal",
                "is_anomaly": False,
                "forecasted_latency": None
            },
            "classification": "Normal",
            "forecasted_latency": None,
            "diagnostic": "[INIT] Gathering telemetry window...",
            "recommended_fix": "",
            "interpretability": None
        })
        
    return jsonify(latest_completed_batch)


@app.route('/api/sessions')
def list_sessions():
    return jsonify({"status": "success", "sessions": db.get_recent_sessions()})


@app.route('/api/session/<int:session_id>')
def session_details(session_id):
    details = db.get_session_details(session_id)
    if not details:
        return jsonify({"status": "error", "message": "Session not found"}), 404
    return jsonify({"status": "success", "data": details})

if __name__ == '__main__':
    app.run(debug=False, port=5000, use_reloader=False)
