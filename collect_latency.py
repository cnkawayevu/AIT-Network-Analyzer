import argparse
import subprocess
import time
import csv
from datetime import datetime

def parse_args():
    parser = argparse.ArgumentParser(description="Collect genuine ICMP RTT time-series for LSTM training.")
    parser.add_argument("--duration", type=int, default=3600, help="Duration to run in seconds (default: 3600).")
    parser.add_argument("--interval", type=int, default=2, help="Ping interval in seconds (default: 2).")
    parser.add_argument("--output", type=str, default="latency_baseline.csv", help="Output CSV file path.")
    return parser.parse_args()

def collect():
    args = parse_args()
    print(f"Starting latency collection for {args.duration}s at {args.interval}s intervals.")
    print(f"Output will be saved to {args.output}")

    attempted = 0
    successful = 0
    failed = 0
    numeric_successful = 0
    min_rtt = float('inf')
    max_rtt = -float('inf')
    sum_rtt = 0.0

    start_time = time.time()
    
    with open(args.output, 'w', newline='') as csvfile:
        writer = csv.writer(csvfile)
        writer.writerow(['timestamp', 'latency_ms', 'success'])
        
        try:
            while time.time() - start_time < args.duration:
                attempt_start = time.time()
                attempted += 1
                
                # Use Windows ping as in app.py
                try:
                    startupinfo = subprocess.STARTUPINFO()
                    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                    result = subprocess.run(
                        ["ping", "-n", "1", "1.1.1.1"],
                        startupinfo=startupinfo,
                        universal_newlines=True,
                        timeout=2,
                        capture_output=True
                    )
                    
                    if result.returncode == 0:
                        success = 1
                        successful += 1
                        latency_ms = ""
                        if "time=" in result.stdout:
                            try:
                                time_str = result.stdout.split("time=")[1].split("ms")[0].strip()
                                val = float(time_str)
                                import math
                                if math.isfinite(val):
                                    latency_ms = val
                                    numeric_successful += 1
                                    min_rtt = min(min_rtt, val)
                                    max_rtt = max(max_rtt, val)
                                    sum_rtt += val
                            except Exception:
                                pass
                        elif "time<1ms" in result.stdout:
                            pass
                    else:
                        latency_ms = ""
                        success = 0
                        failed += 1
                        
                except Exception:
                    latency_ms = ""
                    success = 0
                    failed += 1
                
                iso_time = datetime.now().isoformat()
                writer.writerow([iso_time, latency_ms, success])
                csvfile.flush()
                
                status = f"RTT: {latency_ms}ms" if success else "FAILED"
                print(f"[{iso_time}] Probe {attempted} -> {status}")
                
                elapsed = time.time() - attempt_start
                sleep_time = args.interval - elapsed
                if sleep_time > 0:
                    time.sleep(sleep_time)
                    
        except KeyboardInterrupt:
            print("\nCollection interrupted by user.")
            
    print("\n--- LATENCY COLLECTION SUMMARY ---")
    print(f"Probes attempted   : {attempted}")
    print(f"Successful probes  : {successful}")
    print(f"Failed probes      : {failed}")
    if numeric_successful > 0:
        print(f"Mean RTT           : {sum_rtt / numeric_successful:.2f} ms")
        print(f"Min RTT            : {min_rtt:.2f} ms")
        print(f"Max RTT            : {max_rtt:.2f} ms")
    else:
        print("Mean RTT           : N/A")
        print("Min RTT            : N/A")
        print("Max RTT            : N/A")

if __name__ == "__main__":
    collect()
