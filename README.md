<div align="center">

# ⚡ AI-Powered Network Performance Analyzer

### Real-time network visibility, anomaly detection, latency forecasting, and actionable diagnostics — in one lightweight dashboard.

![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)
![Flask](https://img.shields.io/badge/Flask-3.1-000000?logo=flask&logoColor=white)
![TensorFlow](https://img.shields.io/badge/TensorFlow-2.21-FF6F00?logo=tensorflow&logoColor=white)
![scikit-learn](https://img.shields.io/badge/scikit--learn-1.9-F7931E?logo=scikitlearn&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite&logoColor=white)
![Scapy](https://img.shields.io/badge/Packet%20Capture-Scapy-4B8BBE)
![Status](https://img.shields.io/badge/status-stable-success)

</div>

---

## 🚀 What is this?

**AI-Powered Network Performance Analyzer** is a real-time network monitoring application that combines traditional performance metrics with machine learning.

Instead of only showing raw numbers, the system captures live host traffic, measures latency and RTT variation, classifies current traffic patterns with a **Random Forest**, forecasts short-term latency with an **LSTM**, and translates the results into readable health states, alerts, diagnostics, and recommended actions.

It is built as a lightweight local web application using **Python, Flask, Scapy, TensorFlow, scikit-learn, Chart.js, Tailwind CSS, and SQLite**.

---

## ✨ Highlights

- 📡 **Live packet capture** from the active host IPv4 network interface using Scapy
- ⏱️ **Real-time RTT monitoring** using ICMP probes
- 📊 **Throughput, RTT variation, and rolling probe-failure tracking**
- 🌲 **Random Forest anomaly classification** — `Normal` / `Abnormal`
- 🧠 **LSTM one-step-ahead latency forecasting**
- 🔎 **Model interpretation** using global Random Forest feature importance and current feature values
- 🚦 **Health states** — `OPTIMAL`, `DEGRADED`, and `CRITICAL`
- 🛠️ **Automatic diagnostics and recommended actions**
- 💾 **SQLite persistence** for sessions, telemetry, alerts, and reports
- 📈 **Interactive browser dashboard** powered by Chart.js
- 🧾 **Session summaries and historical API endpoints**
- ✅ **Formally tested frozen release** preserved with a Git tag

---

## 🧠 How it works

```text
Host Network Interface
        │
        ├───────────────┐
        ▼               ▼
 Scapy Capture      ICMP RTT Probe
        │               │
        └───────┬───────┘
                ▼
      Metric & Feature Processing
                │
        ┌───────┴────────┐
        ▼                ▼
 Random Forest       LSTM Forecaster
 Normal/Abnormal     Next RTT estimate
        │                │
        └──────┬─────────┘
               ▼
   Health / Diagnostic Logic
               │
               ▼
        Flask Backend / API
          ┌────┴────┐
          ▼         ▼
    Web Dashboard  SQLite
                  Sessions
                  Telemetry
                  Alerts
                  Reports
```

---

## 🤖 Machine Learning

### Random Forest — anomaly classification

The live classifier uses nine aggregate traffic features:

| # | Feature |
|---:|---|
| 1 | Flow Duration |
| 2 | Total Fwd Packets |
| 3 | Bwd Packets/s |
| 4 | Fwd Packet Length Max |
| 5 | Fwd Packet Length Min |
| 6 | Bwd Packet Length Max |
| 7 | Bwd Packet Length Min |
| 8 | Flow Packets/s |
| 9 | Flow Bytes/s |

The model produces a `Normal` or `Abnormal` classification together with predicted-class probability and model-level feature importance information.

### LSTM — latency forecasting

The LSTM performs **one-step-ahead RTT forecasting** using a rolling sequence of the latest 10 valid RTT observations.

---

## 📊 Evaluation snapshot

The project includes model-level and system-level testing.

| Component | Result |
|---|---:|
| Random Forest accuracy | **99.20%** |
| Random Forest precision | **99.38%** |
| Random Forest recall | **99.02%** |
| Random Forest F1-score | **99.20%** |
| RF non-overlap subset accuracy | **99.19%** |
| LSTM MAE | **6.80 ms** |
| LSTM RMSE | **8.93 ms** |
| Live-session forecast replay | **88 / 88 reproduced** |

> **Note:** The Random Forest evaluation identified exact feature-vector overlap between parts of the training and test sets. A separate non-overlap subset was therefore also evaluated. The replay result for the LSTM demonstrates inference reproducibility, not forecasting accuracy.

---

## 🖥️ Dashboard

The dashboard displays live and session-level information including:

- latency
- RTT variation / jitter
- rolling ICMP probe-failure percentage
- throughput
- Random Forest classification
- predicted-class probability
- important model features and current values
- LSTM latency forecast
- system health state
- diagnostics
- recommended actions
- alerts and session analytics

The frontend uses regular **HTTP polling** against the Flask backend.

---

## 💾 Persistence

SQLite stores four core data groups:

```text
sessions
├── telemetry
├── alerts
└── session_reports
```

Each monitoring session keeps its own telemetry history, generated alerts, aggregate statistics, and final report.

---

## 🛠️ Tech stack

**Backend**
- Python
- Flask
- SQLite

**Networking**
- Scapy
- ICMP probing

**Machine Learning**
- scikit-learn
- TensorFlow / Keras
- NumPy
- pandas

**Frontend**
- HTML
- Tailwind CSS
- JavaScript
- Chart.js

**Development**
- Git
- GitHub

---

## ⚙️ Getting started

### 1. Clone the repository

```bash
git clone https://github.com/cnkawayevu/AIT-Network-Analyzer.git
cd AIT-Network-Analyzer
```

### 2. Create a virtual environment

**Windows**

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
```

**macOS / Linux**

```bash
python3 -m venv venv
source venv/bin/activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Run the application

```bash
python app.py
```

Then open:

```text
http://127.0.0.1:5000
```

> Packet capture may require elevated privileges or a compatible packet capture driver depending on your operating system.

---

## 📁 Project structure

```text
AIT-Network-Analyzer/
│
├── app.py                     # Flask app, monitoring loop and API routes
├── database.py                # SQLite persistence and report aggregation
├── network_models.py          # Random Forest + LSTM logic
├── interface_selector.py      # Active network interface selection
├── collect_latency.py         # RTT dataset collection utility
│
├── rf_model.joblib            # Trained Random Forest model
├── lstm_latency_model.keras   # Trained LSTM model
├── lstm_scaler.joblib         # LSTM scaler
├── lstm_evaluation.json       # Forecast evaluation results
├── latency_baseline.csv       # Collected latency observations
│
├── templates/
│   └── index.html             # Main dashboard
│
├── test_integration.py        # Integration tests
├── requirements.txt
└── README.md
```

---

## 🔐 Health logic

The system combines AI classification with live performance conditions:

| Condition | Result |
|---|---|
| RF detects abnormal traffic | `CRITICAL` |
| RTT exceeds 80 ms | `DEGRADED` |
| rolling ICMP probe-failure exceeds 2% | `DEGRADED` |
| no active issue | `OPTIMAL` |

The health layer also produces plain-language diagnostics and recommended next actions.

---

## 🧪 Tested release

The exact implementation used for formal system validation is permanently preserved as:

```text
Commit: e2925f8d8da28509bdc15e5637f3ffae1293c177
Tag:    capstone-final-tested-e2925f8
```

This makes it possible to distinguish the tested software release from later documentation-only or presentation updates.

---

## ⚠️ Current scope

This project is intentionally lightweight and currently focuses on **host/interface-level IPv4 monitoring**.

A few things to keep in mind:

- it is not a full enterprise-wide network sensor;
- the internal `packet_loss_pct` metric represents rolling ICMP probe-failure percentage;
- Random Forest feature importance is global/model-level interpretation, not a causal explanation for a single prediction;
- the Flask application currently runs locally using the development server;
- offline training data and live micro-batch traffic are not identical data representations.

---

## 🔭 Ideas for future development

Potential directions include:

- remote deployment and production WSGI hosting
- multi-host / multi-interface monitoring
- richer historical analytics
- additional independently collected evaluation datasets
- per-prediction explainability
- configurable alert thresholds
- authentication and multi-user dashboards
- notifications and external integrations
- model monitoring and retraining workflows

---

## 👨🏽‍💻 Maintainer

**Caleb Awayevu**

Software engineering • Networking • Cloud • AI/ML

Built as a hands-on project exploring how networking, full-stack development, and machine learning can work together in one practical system.

---

<div align="center">

### ⭐ If you find the project interesting, feel free to star the repository.

</div>
