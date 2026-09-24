import time
from scapy.all import send, IP, TCP
import random

def run_attack_simulation():
    print("[SYSTEM INFO] Initializing custom security evaluation stream...")
    print("[SYSTEM INFO] Injecting micro-burst test vectors onto local loopback. Press CTRL+C to halt.")
    
    # Target local host interface to avoid disrupting external network nodes
    target_ip = "127.0.0.1"
    
    try:
        while True:
            # Generate atypical packet parameters to trip Random Forest classifier flags
            for _ in range(50):
                spoofed_port = random.randint(1024, 65535)
                # Craft raw packet with inverted flow characteristics matching attack vectors
                pkt = IP(src="10.0.0.99", dst=target_ip)/TCP(sport=spoofed_port, dport=80, flags="S")
                send(pkt, verbose=0)
            
            time.sleep(1) # Interval delay to prevent CPU lock
    except KeyboardInterrupt:
        print("\n[SYSTEM INFO] Test suite paused. Interface returned to standard baseline operation.")

if __name__ == "__main__":
    run_attack_simulation()