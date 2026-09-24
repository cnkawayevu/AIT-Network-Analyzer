"""
prepare_data.py
---------------
Memory-safe data sampling utility for AIT-Network-Analyzer.

Reads 'cicids2017_sample.csv' in chunks of 10,000 rows to protect system RAM,
then draws a balanced random sample of 50,000 rows (25,000 BENIGN + 25,000
anomalous) and saves the result as 'optimized_training_data.csv' in the project
root. If one class has fewer rows than the target quota, the minority class is
taken in full and the remaining quota is filled from the majority class.
"""

import os
import pandas as pd
import numpy as np

# ── Configuration ──────────────────────────────────────────────────────────────
INPUT_FILE  = "cicids2017_sample.csv"
OUTPUT_FILE = "optimized_training_data.csv"
CHUNK_SIZE  = 10_000
TARGET_TOTAL = 50_000
TARGET_PER_CLASS = TARGET_TOTAL // 2   # 25,000 each

LABEL_COL = "Attack Type"
BENIGN_LABEL = "Normal Traffic"

# ── Pass 1: Stream through file, accumulate class buckets ─────────────────────
print(f"[1/4] Reading '{INPUT_FILE}' in chunks of {CHUNK_SIZE:,} rows …")

benign_frames   = []
anomaly_frames  = []
total_rows_read = 0

for chunk in pd.read_csv(INPUT_FILE, chunksize=CHUNK_SIZE, low_memory=False):
    chunk.columns = chunk.columns.str.strip()        # strip whitespace from headers
    total_rows_read += len(chunk)

    is_benign = chunk[LABEL_COL].astype(str).str.strip() == BENIGN_LABEL
    benign_frames.append(chunk[is_benign])
    anomaly_frames.append(chunk[~is_benign])

print(f"    -> Finished streaming {total_rows_read:,} total rows.")

# ── Pass 2: Concatenate buckets ───────────────────────────────────────────────
print("[2/4] Concatenating class buckets …")
df_benign  = pd.concat(benign_frames,  ignore_index=True)
df_anomaly = pd.concat(anomaly_frames, ignore_index=True)

n_benign  = len(df_benign)
n_anomaly = len(df_anomaly)
print(f"    -> BENIGN rows : {n_benign:,}")
print(f"    -> Anomaly rows: {n_anomaly:,}")

# ── Pass 3: Draw balanced sample ──────────────────────────────────────────────
print("[3/4] Drawing balanced random sample …")

# Adaptive quota: if one class is short, give the surplus to the other
quota_benign  = min(TARGET_PER_CLASS, n_benign)
quota_anomaly = min(TARGET_PER_CLASS, n_anomaly)

shortage_benign  = TARGET_PER_CLASS - quota_benign
shortage_anomaly = TARGET_PER_CLASS - quota_anomaly

# Compensate shortage from the other class (capped by available rows)
quota_benign  += min(shortage_anomaly, n_benign  - quota_benign)
quota_anomaly += min(shortage_benign,  n_anomaly - quota_anomaly)

sample_benign  = df_benign.sample(n=quota_benign,  random_state=42)
sample_anomaly = df_anomaly.sample(n=quota_anomaly, random_state=42)

df_combined = (
    pd.concat([sample_benign, sample_anomaly], ignore_index=True)
      .sample(frac=1, random_state=42)   # shuffle
      .reset_index(drop=True)
)

print(f"    -> Sampled BENIGN : {quota_benign:,}")
print(f"    -> Sampled Anomaly: {quota_anomaly:,}")
print(f"    -> Combined total : {len(df_combined):,} rows")

# ── Pass 4: Save ──────────────────────────────────────────────────────────────
print(f"[4/4] Saving to '{OUTPUT_FILE}' …")
df_combined.to_csv(OUTPUT_FILE, index=False)
size_mb = os.path.getsize(OUTPUT_FILE) / (1024 * 1024)
print(f"    -> Done! File size: {size_mb:.1f} MB")
print()
print("[OK] optimized_training_data.csv is ready.")
