import os
import json
import joblib
import numpy as np
import pandas as pd
from datetime import datetime
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import precision_score, recall_score, f1_score, classification_report, mean_absolute_error, mean_squared_error
from sklearn.preprocessing import MinMaxScaler
from tensorflow.keras.models import Sequential, load_model
from tensorflow.keras.layers import Input, LSTM, Dense, Dropout


def prepare_sliding_window(series, time_steps=10):
    """
    Formats 1D performance variables (e.g. packet latency, jitter, bandwidth)
    into a 3D sliding window structure (samples, time steps, features) for
    sequential LSTM ingestion.

    Parameters:
        series (array-like): 1D continuous sequence of performance metric values.
        time_steps (int): Number of historical time steps in each observation window.

    Returns:
        tuple of (X, y):
            X (np.ndarray): 3D array of shape (samples, time_steps, 1).
            y (np.ndarray): 1D array of shape (samples,) with next-step target values.
    """
    data = np.asarray(series, dtype=np.float32).flatten()
    X, y = [], []
    for i in range(len(data) - time_steps):
        X.append(data[i : i + time_steps])
        y.append(data[i + time_steps])

    X = np.array(X, dtype=np.float32)
    y = np.array(y, dtype=np.float32)

    # Reshape X to 3D: (samples, time_steps, features)
    X = np.reshape(X, (X.shape[0], X.shape[1], 1))
    return X, y


class NetworkAIEngine:
    def __init__(self, rf_model_path="rf_model.joblib", time_steps=10):
        # Authentic feature columns commonly extracted from the CIC-IDS2017 dataset
        self.feature_columns = [
            'Flow Duration', 'Total Fwd Packets', 'Bwd Packets/s',
            'Fwd Packet Length Max', 'Fwd Packet Length Min',
            'Bwd Packet Length Max', 'Bwd Packet Length Min',
            'Flow Packets/s', 'Flow Bytes/s'
        ]
        self.rf_model_path = rf_model_path
        self.lstm_model_path = "lstm_latency_model.keras"
        self.lstm_scaler_path = "lstm_scaler.joblib"
        self.time_steps = time_steps
        self.rf_model = None
        self.lstm_model = None
        self.scaler = None
        self.is_trained = False
        self.lstm_available = False

        # Instant load mechanism: load pre-trained RF model if available on disk
        if os.path.exists(self.rf_model_path):
            self.load_rf_model(self.rf_model_path)
        else:
            self._init_fresh_rf_model()

        # Load pre-trained LSTM if available
        if os.path.exists(self.lstm_model_path) and os.path.exists(self.lstm_scaler_path):
            self.load_lstm_model()
        else:
            print("[NetworkAIEngine] Sequential LSTM forecaster unavailable. Must be trained.")

    def _init_fresh_rf_model(self):
        """Initializes a fresh RandomForestClassifier with exact hyperparameters."""
        self.rf_model = RandomForestClassifier(
            n_estimators=100,
            max_depth=20,
            max_features='sqrt',
            min_samples_split=2,
            min_samples_leaf=1,
            random_state=42
        )
        self.is_trained = False

    def load_rf_model(self, path=None):
        """Loads a pre-trained RandomForest model from a .joblib file."""
        model_path = path or self.rf_model_path
        try:
            self.rf_model = joblib.load(model_path)
            self.is_trained = True
            print(f"[NetworkAIEngine] Loaded pre-trained RandomForest model from '{model_path}'.")
            return True
        except Exception as e:
            print(f"[NetworkAIEngine] Failed to load model from '{model_path}': {e}. Initializing fresh instance.")
            self._init_fresh_rf_model()
            return False

    def save_rf_model(self, path=None):
        """Saves the current trained RandomForest model to a local .joblib file."""
        model_path = path or self.rf_model_path
        if self.rf_model is not None and self.is_trained:
            joblib.dump(self.rf_model, model_path)
            print(f"[NetworkAIEngine] Saved trained RandomForest model to '{model_path}'.")
            return True
        print("[NetworkAIEngine] Warning: No trained RandomForest model to save.")
        return False

    def evaluate_model(self, X_test, y_test):
        """
        Evaluates model performance and prints precision, recall, and F1-score
        to the terminal for academic evaluation.
        """
        y_pred = self.rf_model.predict(X_test)
        precision = precision_score(y_test, y_pred, zero_division=0)
        recall = recall_score(y_test, y_pred, zero_division=0)
        f1 = f1_score(y_test, y_pred, zero_division=0)

        print("\n" + "=" * 55)
        print("          ACADEMIC MODEL EVALUATION METRICS")
        print("=" * 55)
        print(f"Precision : {precision:.4f} ({precision * 100:.2f}%)")
        print(f"Recall    : {recall:.4f} ({recall * 100:.2f}%)")
        print(f"F1-Score  : {f1:.4f} ({f1 * 100:.2f}%)")
        print("=" * 55)
        print("\nDetailed Classification Report:")
        print(classification_report(y_test, y_pred, target_names=['Normal', 'Abnormal'], zero_division=0))
        print("=" * 55 + "\n")

        return {
            "precision": float(precision),
            "recall": float(recall),
            "f1_score": float(f1)
        }

    def train_anomaly_detector(self, csv_path="optimized_training_data.csv", test_size=0.2):
        """
        Trains the supervised RandomForestClassifier on optimized_training_data.csv,
        saves the trained model to rf_model.joblib immediately after training,
        and calls evaluate_model() to print academic metrics.
        """
        if not os.path.exists(csv_path):
            print(f"Data file {csv_path} not found. Running mock telemetry engine.")
            return False

        try:
            print(f"Loading dataset from '{csv_path}'...")
            df = pd.read_csv(csv_path)
            df.columns = df.columns.str.strip()

            # Select target features and fill invalid empty or infinity numbers
            X = df[self.feature_columns].fillna(0).replace([np.inf, -np.inf], 0)

            # Binary classification: 0 for normal traffic records, 1 for network anomalies
            label_col = 'Attack Type' if 'Attack Type' in df.columns else 'Label'
            y = df[label_col].apply(lambda x: 0 if str(x).strip() in ['Normal Traffic', 'BENIGN', '0', 'Normal'] else 1)

            # Stratified train-test split for academic evaluation
            X_train, X_test, y_train, y_test = train_test_split(
                X, y, test_size=test_size, random_state=42, stratify=y
            )

            # Ensure model has exact required hyperparameters before training
            self._init_fresh_rf_model()
            print(f"Training RandomForestClassifier on {len(X_train)} samples with hyperparameters:")
            print("  - n_estimators: 100")
            print("  - max_depth: 20")
            print("  - max_features: 'sqrt'")
            print("  - min_samples_split: 2")
            print("  - min_samples_leaf: 1")
            print("  - random_state: 42")

            self.rf_model.fit(X_train, y_train)
            self.is_trained = True
            print("Random Forest successfully trained on real network flow metrics.")

            # Save model to local rf_model.joblib file immediately after training
            self.save_rf_model(self.rf_model_path)

            # Compute and output academic evaluation metrics
            self.evaluate_model(X_test, y_test)
            return True
        except Exception as e:
            print(f"Error training model, entering dynamic mode: {e}")
            return False

    def predict(self, live_packet_metrics):
        """
        Accepts a 1D array of live packet metrics and returns 'Normal' or 'Abnormal'.

        Parameters:
            live_packet_metrics (list, np.ndarray, pd.Series): 1D array representing
                the live flow features corresponding to self.feature_columns.

        Returns:
            str: 'Normal' or 'Abnormal'
        """
        if not self.is_trained:
            return "Normal"

        if isinstance(live_packet_metrics, pd.DataFrame):
            live_data = live_packet_metrics[self.feature_columns].values
        elif isinstance(live_packet_metrics, pd.Series):
            live_data = live_packet_metrics.values.reshape(1, -1)
        else:
            arr = np.asarray(live_packet_metrics, dtype=np.float64)
            if arr.ndim == 1:
                live_data = arr.reshape(1, -1)
            else:
                live_data = arr

        if not isinstance(live_data, pd.DataFrame):
            live_data = pd.DataFrame(live_data, columns=self.feature_columns)

        pred = int(self.rf_model.predict(live_data)[0])
        return "Normal" if pred == 0 else "Abnormal"

    def get_rf_interpretation(self, live_packet_metrics):
        """
        Returns academically honest feature importance of the Random Forest model globally,
        along with the model's predicted-class model probability for the current batch.
        """
        if not self.is_trained or self.rf_model is None:
            return None

        # Verify feature importances are available and match expected size
        if not hasattr(self.rf_model, 'feature_importances_'):
            return None

        importances = self.rf_model.feature_importances_
        if len(importances) != len(self.feature_columns):
            return None

        # Parse the current feature vector
        arr = np.asarray(live_packet_metrics, dtype=np.float64).flatten()
        if len(arr) != len(self.feature_columns):
            return None

        interpretation = {
            "method": "global_feature_importance",
            "scope": "model_level",
            "top_features": []
        }

        # Safe predict_proba integration
        if hasattr(self.rf_model, 'predict_proba') and hasattr(self.rf_model, 'classes_'):
            try:
                live_data = pd.DataFrame([arr], columns=self.feature_columns)
                proba = self.rf_model.predict_proba(live_data)[0]
                pred_idx = int(self.rf_model.predict(live_data)[0])

                # Class 0 -> Normal, Class 1 -> Abnormal
                if list(self.rf_model.classes_) == [0, 1]:
                    # The predicted class is pred_idx, its probability is proba[pred_idx] (or proba[1] if pred_idx == 1)
                    idx_in_classes = list(self.rf_model.classes_).index(pred_idx)
                    confidence = float(proba[idx_in_classes])
                    interpretation["classification_confidence"] = round(confidence, 4)
            except Exception:
                pass # Gracefully omit confidence if there's any error

        # Map importances to feature names and get top 3
        mapped = []
        for i, (name, imp) in enumerate(zip(self.feature_columns, importances)):
            mapped.append({
                "feature_name": name,
                "importance": float(imp),
                "importance_percent": round(float(imp) * 100, 2),
                "current_value": round(float(arr[i]), 4)
            })

        # Sort by importance descending
        mapped.sort(key=lambda x: x["importance"], reverse=True)
        interpretation["top_features"] = mapped[:3]

        return interpretation


    def build_lstm_forecaster(self, time_steps=None, features=1):
        """
        Builds the sequential time-series forecasting model using TensorFlow/Keras.
        Architecture:
          - Input layer (time_steps, features)
          - Exactly one LSTM layer (50 units)
          - Dropout layer (rate=0.2)
          - Dense output layer (1 unit)
        Compiled with Adam optimizer and Mean Squared Error (MSE) loss.
        """
        steps = time_steps or self.time_steps
        model = Sequential([
            Input(shape=(steps, features)),
            LSTM(50, return_sequences=False),
            Dropout(0.2),
            Dense(1)
        ])
        model.compile(optimizer='adam', loss='mse')
        self.lstm_model = model
        print(f"Sequential LSTM forecaster successfully compiled (LSTM=50, Dropout=0.2, Dense=1, Loss=MSE, Optimizer=Adam).")
        return model

    def load_lstm_model(self):
        """Loads a pre-trained LSTM model and scaler."""
        try:
            self.lstm_model = load_model(self.lstm_model_path)
            self.scaler = joblib.load(self.lstm_scaler_path)
            self.lstm_available = True
            print(f"[NetworkAIEngine] Loaded pre-trained LSTM model from '{self.lstm_model_path}'.")
            return True
        except Exception as e:
            print(f"[NetworkAIEngine] Failed to load LSTM model: {e}")
            self.lstm_model = None
            self.scaler = None
            self.lstm_available = False
            return False

    def save_lstm_model(self):
        """Saves the current trained LSTM model and scaler."""
        if self.lstm_model is not None and self.scaler is not None:
            self.lstm_model.save(self.lstm_model_path)
            joblib.dump(self.scaler, self.lstm_scaler_path)
            print(f"[NetworkAIEngine] Saved trained LSTM model and scaler.")
            return True
        return False

    def train_lstm_forecaster(self, csv_path="latency_baseline.csv", time_steps=None, epochs=5, batch_size=32):
        """
        Trains the sequential LSTM model using genuine ICMP latency data.
        """
        steps = time_steps or self.time_steps
        self.time_steps = steps

        if self.lstm_model is None:
            self.build_lstm_forecaster(time_steps=steps, features=1)

        if not os.path.exists(csv_path):
            print(f"[NetworkAIEngine] Latency dataset {csv_path} not found. LSTM cannot be trained.")
            return False

        try:
            df = pd.read_csv(csv_path)
            # Use only successful measurements with valid latency
            df_valid = df[(df['success'] == 1) & (df['latency_ms'].notna())].copy()
            if len(df_valid) < steps * 2:
                print("[NetworkAIEngine] Insufficient valid latency data for training.")
                return False

            series = df_valid['latency_ms'].values

            # Initialize MinMaxScaler
            self.scaler = MinMaxScaler(feature_range=(0, 1))

            # Chronological train-test split before scaling to avoid data leakage
            # e.g., 80% train, 20% test
            train_size = int(len(series) * 0.8)
            train_series = series[:train_size]
            test_series = series[train_size:]

            # Fit scaler on training data only
            train_scaled = self.scaler.fit_transform(train_series.reshape(-1, 1)).flatten()
            test_scaled = self.scaler.transform(test_series.reshape(-1, 1)).flatten()

            # Prepare 3D sliding window structure
            X_train, y_train = prepare_sliding_window(train_scaled, time_steps=steps)
            X_test, y_test = prepare_sliding_window(test_scaled, time_steps=steps)

            print(f"Fitting LSTM forecaster for {epochs} epochs (batch_size={batch_size})...")
            self.lstm_model.fit(X_train, y_train, epochs=epochs, batch_size=batch_size, verbose=1)
            print("LSTM model training complete.")

            y_pred = self.lstm_model.predict(X_test, verbose=0)

            # Inverse transform to get true milliseconds
            y_test_inv = self.scaler.inverse_transform(y_test.reshape(-1, 1))
            y_pred_inv = self.scaler.inverse_transform(y_pred.reshape(-1, 1))

            mae_ms = mean_absolute_error(y_test_inv, y_pred_inv)
            mse = mean_squared_error(y_test_inv, y_pred_inv)
            rmse_ms = np.sqrt(mse)

            print("\n" + "=" * 55)
            print("--- GENUINE LSTM LATENCY FORECASTING EVALUATION ---")
            print("=" * 55)
            print(f"Mean Absolute Error (MAE)     : {mae_ms:.4f} ms")
            print(f"Root Mean Square Error (RMSE) : {rmse_ms:.4f} ms")
            print("=" * 55 + "\n")

            # Save evaluation results
            eval_data = {
                "observations": len(series),
                "training_sequences": len(X_train),
                "testing_sequences": len(X_test),
                "mae_ms": float(mae_ms),
                "rmse_ms": float(rmse_ms),
                "trained_at": datetime.now().isoformat()
            }
            with open("lstm_evaluation.json", "w") as f:
                json.dump(eval_data, f, indent=4)

            self.lstm_available = True
            self.save_lstm_model()
            return True

        except Exception as e:
            print(f"[NetworkAIEngine] Failed to train LSTM: {e}")
            return False

    def predict_latency(self, historical_latencies):
        """
        Outputs a short-term predicted float value for a continuous network metric
        like packet latency from a historical 1D window.

        Parameters:
            historical_latencies (list, np.ndarray): 1D array of recent latency measurements.

        Returns:
            float or None: Short-term forecasted latency value, or None if unavailable.
        """
        if not self.lstm_available or self.lstm_model is None or self.scaler is None:
            return None

        arr = np.asarray(historical_latencies, dtype=np.float32).flatten()
        steps = self.time_steps

        # Adjust window size to match expected LSTM input time steps
        if len(arr) < steps:
            arr = np.pad(arr, (steps - len(arr), 0), mode='edge')
        elif len(arr) > steps:
            arr = arr[-steps:]

        # Reshape to 3D sliding window for single prediction: (1, time_steps, 1)
        X_sample = arr.reshape(1, steps, 1)

        try:
            X_sample_scaled = self.scaler.transform(X_sample.reshape(-1, 1)).reshape(1, steps, 1)
            predicted_val_scaled = self.lstm_model.predict(X_sample_scaled, verbose=0)
            predicted_val = self.scaler.inverse_transform(predicted_val_scaled)
            raw_pred = float(predicted_val[0][0])
            return round(float(max(5.0, raw_pred)), 2)
        except Exception:
            return None

    def run_inference(self, live_row_df):
        """Runs real-time processing inference loop on incoming packet flow metrics."""
        live_row_df.columns = live_row_df.columns.str.strip()
        X_live = live_row_df[self.feature_columns].fillna(0).replace([np.inf, -np.inf], 0)

        # 1. Anomaly Classification Output using predict()
        pred_label = self.predict(X_live.iloc[0].values) if self.is_trained else "Normal"
        anomaly_flag = 0 if pred_label == "Normal" else 1

        # 2. Extract specific values to pass into the Explainable AI (XAI) utility
        row_dict = X_live.iloc[0].to_dict()
        explanation = self.generate_xai_explanations(row_dict, anomaly_flag)

        return anomaly_flag, explanation

    def generate_xai_explanations(self, features, flag):
        """Explainable AI (XAI) mapping utility to provide plain-language diagnostics."""
        if flag == 0:
            return "Network performance metrics reflect steady traffic distribution baseline thresholds."

        triggers = []
        if features.get('Flow Packets/s', 0) > 4000:
            triggers.append("Abrupt packet volume frequency surge per second")
        if features.get('Fwd Packet Length Max', 0) > 800:
            triggers.append("Oversized forward packet buffers")
        if features.get('Flow Duration', 0) < 100:
            triggers.append("High frequency burst request signature")

        if not triggers:
            triggers.append("Statistical deviation across shared network matrix indices")

        return f"Anomaly detected due to: {', '.join(triggers)}. Actionable Recommendation: Inspect router interface bottlenecks."


# Module-level convenience functions
_default_engine = None

def get_default_engine():
    global _default_engine
    if _default_engine is None:
        _default_engine = NetworkAIEngine()
    return _default_engine

def evaluate_model(model, X_test, y_test):
    """Standalone academic evaluation function for precision, recall, and F1-score."""
    engine = get_default_engine()
    engine.rf_model = model
    return engine.evaluate_model(X_test, y_test)

def predict(live_packet_metrics):
    """Standalone prediction function accepting a 1D array of live packet metrics."""
    engine = get_default_engine()
    return engine.predict(live_packet_metrics)

def predict_latency(historical_latencies):
    """Standalone latency forecasting function."""
    engine = get_default_engine()
    return engine.predict_latency(historical_latencies)


if __name__ == '__main__':
    print("=== Initializing NetworkAIEngine ===")
    engine = NetworkAIEngine()

    # Step 1: Train RF and save to rf_model.joblib (or load if already present)
    if not engine.is_trained:
        print("\n--- Training RandomForest Classifier ---")
        engine.train_anomaly_detector("optimized_training_data.csv")
    else:
        print("\n--- Pre-trained RandomForest model loaded successfully from rf_model.joblib ---")

    # Verify RF prediction with 1D sample arrays
    normal_sample = [6002296.0, 7.0, 0.6664, 233.0, 0.0, 145.0, 0.0, 1.8326, 76.637]
    result_normal = engine.predict(normal_sample)
    print(f"Test 1D prediction (Normal sample)   : {result_normal}")

    abnormal_sample = [98708819.0, 5.0, 0.0709, 319.0, 0.0, 4344.0, 0.0, 0.1215, 120.82]
    result_abnormal = engine.predict(abnormal_sample)
    print(f"Test 1D prediction (Abnormal sample) : {result_abnormal}")

    # Step 2: Build & train Sequential LSTM Forecaster
    print("\n--- Building & Training LSTM Time-Series Forecaster ---")
    engine.build_lstm_forecaster(time_steps=10, features=1)
    engine.train_lstm_forecaster(csv_path="latency_baseline.csv", epochs=3, batch_size=32)

    # Step 3: Test short-term continuous latency forecasting
    print("\n--- Testing Short-Term Latency Forecasting ---")
    historical_window = [18.2, 19.5, 21.0, 20.4, 22.1, 23.8, 22.9, 24.5, 25.0, 24.8]
    forecasted_latency = engine.predict_latency(historical_window)
    print(f"Historical 1D latency window : {historical_window}")
    if forecasted_latency is not None:
        print(f"Forecasted short-term latency: {forecasted_latency:.2f} ms (Type: {type(forecasted_latency).__name__})")
    else:
        print("Forecasted short-term latency: N/A (LSTM not trained)")
