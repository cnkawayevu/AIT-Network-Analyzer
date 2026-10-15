"""Safe assertion-based regressions. No application import, threads, sockets, or DB.

Run: python -B -m unittest discover -s tests -p test_safe_regressions.py -v
Extracts existing pure functions with AST so app.py/test_integration.py startup
side effects cannot execute. The source files and validated tests are unchanged.
"""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]


def isolated_function(filename, name, namespace=None):
    tree = ast.parse((ROOT / filename).read_text(encoding="utf-8"))
    function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
    function.decorator_list = []
    scope = {} if namespace is None else namespace
    exec(compile(ast.Module(body=[function], type_ignores=[]), filename, "exec"), scope)
    return scope[name], scope


class HealthRules(unittest.TestCase):
    def setUp(self):
        self.evaluate, _ = isolated_function("app.py", "evaluate_health")

    def test_optimal_below_thresholds(self):
        result = self.evaluate("Normal", 20, 0)
        self.assertEqual(result["system_state"], "OPTIMAL")
        self.assertEqual(result["alerts"], [])
        self.assertEqual(result["recommended_fix"], "")

    def test_equality_is_not_a_breach(self):
        self.assertEqual(self.evaluate("Normal", 80, 2)["system_state"], "OPTIMAL")

    def test_latency_just_above_threshold(self):
        result = self.evaluate("Normal", 80.01, 0)
        self.assertEqual(result["system_state"], "DEGRADED")
        self.assertEqual(result["alerts"][0]["alert_type"], "HIGH_LATENCY")

    def test_probe_failures_just_above_threshold(self):
        result = self.evaluate("Normal", 20, 2.01)
        self.assertEqual(result["system_state"], "DEGRADED")
        self.assertEqual(result["alerts"][0]["alert_type"], "PACKET_LOSS")

    def test_abnormal_overrides_healthy_metrics(self):
        result = self.evaluate("Abnormal", 20, 0)
        self.assertEqual(result["system_state"], "CRITICAL")
        self.assertEqual(result["alerts"][0]["alert_type"], "AI_ANOMALY")

    def test_combined_alerts_preserve_critical_precedence(self):
        result = self.evaluate("Abnormal", 81, 3)
        self.assertEqual(result["system_state"], "CRITICAL")
        self.assertEqual([a["alert_type"] for a in result["alerts"]], ["AI_ANOMALY", "HIGH_LATENCY", "PACKET_LOSS"])
        self.assertEqual(result["diagnostic"], result["alerts"][0]["diagnostic"])

    def test_both_performance_alerts_preserved(self):
        result = self.evaluate("Normal", 81, 3)
        self.assertEqual(result["system_state"], "DEGRADED")
        self.assertEqual(len(result["alerts"]), 2)
        self.assertEqual(result["diagnostic"], result["alerts"][0]["diagnostic"])

    def test_null_measurements_keep_validated_behavior(self):
        self.assertEqual(self.evaluate("Normal", None, None)["system_state"], "OPTIMAL")
        self.assertEqual(self.evaluate("Abnormal", None, None)["system_state"], "CRITICAL")


class FakeTime:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class ExistingReadinessFunction(unittest.TestCase):
    """Exercise the actual existing wait_for_http without launching its script."""
    def setUp(self):
        self.clock = FakeTime()
        self.calls = []
        self.process = SimpleNamespace(poll=lambda: None)

    def run_readiness(self, response, timeout=1):
        def request(url, request_timeout):
            self.calls.append((url, request_timeout))
            return response() if callable(response) else response
        function, _ = isolated_function("test_integration.py", "wait_for_http", {"time": self.clock, "req": request})
        return function(self.process, timeout=timeout)

    def test_warmup_is_ready(self):
        self.run_readiness({"status": "warmup", "is_monitoring": False, "session_id": None, "session_generation": 0})
        self.assertEqual(len(self.calls), 1)

    def test_completed_batch_is_ready(self):
        self.run_readiness({"status": "success", "is_monitoring": True, "session_id": 1, "session_generation": 1, "batch_id": 1})
        self.assertEqual(len(self.calls), 1)

    def test_invalid_payload_times_out_with_bounded_requests(self):
        with self.assertRaisesRegex(Exception, "Timeout"):
            self.run_readiness({"status": "success"})
        self.assertEqual(self.clock.now, 1)
        self.assertEqual([timeout for _, timeout in self.calls], [1, 0.75, 0.5, 0.25])

    def test_child_exit_fails_immediately(self):
        self.process.poll = lambda: 1
        with self.assertRaisesRegex(Exception, "exited early"):
            self.run_readiness({})
        self.assertEqual(self.calls, [])

    def test_request_exception_retries_within_deadline(self):
        def fail():
            raise RuntimeError("mock offline")
        with self.assertRaisesRegex(Exception, "Timeout"):
            self.run_readiness(fail)
        self.assertEqual(len(self.calls), 4)
        self.assertEqual(self.clock.now, 1)

    def test_request_crossing_deadline_is_rejected(self):
        def late():
            self.clock.now = 2
            return {"status": "warmup", "is_monitoring": False, "session_id": None, "session_generation": 0}
        with self.assertRaisesRegex(Exception, "Timeout"):
            self.run_readiness(late)
        self.assertEqual(len(self.calls), 1)


if __name__ == "__main__":
    unittest.main()
