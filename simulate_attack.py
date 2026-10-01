"""
SAFE LOCAL CAPSTONE VALIDATION UTILITY
--------------------------------------
This script is intended ONLY for:
- localhost / host-owned machine testing
- the capstone lab environment
- controlled anomaly-validation

It targets the host's active local IPv4 address dynamically to verify that the
sniffer and Random Forest classifier correctly process high-volume, atypical
flow characteristics.

DO NOT use this to target external networks.
DO NOT increase traffic intensity beyond what is necessary for a short local test.
"""

import time
from scapy.all import send, IP, TCP
import random
from interface_selector import get_active_ip

def run_attack_simulation():
    print("[SYSTEM INFO] Initializing safe local capstone validation stream...")
    
    target_ip = get_active_ip()
    if not target_ip or target_ip == "127.0.0.1":
        print("[WARNING] Could not resolve active local IP, defaulting to 127.0.0.1.")
        target_ip = "127.0.0.1"

    print(f"[SYSTEM INFO] Targeting host machine IP: {target_ip}. Press CTRL+C to halt.")
    
    # We use a real local IP to ensure Windows routes it through the monitored interface
    # but send to random high ports to generate rejected traffic volume.
    try:
        while True:
            # Generate atypical packet volume to influence RF features (e.g., bwd_packets_per_sec)
            for _ in range(30):
                random_port = random.randint(10000, 60000)
                pkt = IP(dst=target_ip)/TCP(dport=random_port, flags="S")
                send(pkt, verbose=0)
            
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n[SYSTEM INFO] Test suite paused. Interface returned to standard baseline operation.")

if __name__ == "__main__":
    run_attack_simulation()