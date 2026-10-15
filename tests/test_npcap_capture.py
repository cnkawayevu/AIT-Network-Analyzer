r"""Offline capture regressions: real packet objects, mocked capture handles.

Run: venv\Scripts\python.exe -B -m unittest discover -s tests -p test_npcap_capture.py -v
AST extraction avoids application imports, DB writes, workers and model loading.
Scapy is used only for in-memory packet construction; no capture or sends occur.
"""
import ast
import contextlib
import io
import os
import re
import subprocess
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

# Offline packet construction must not initialize the installed capture driver.
os.environ["SCAPY_USE_LIBPCAP"] = "0"
from scapy.layers.inet import IP, TCP
from scapy.layers.inet6 import IPv6
from scapy.layers.l2 import Ether, Dot1Q, ARP
from scapy.packet import Raw, Padding

ROOT = Path(__file__).resolve().parents[1]
APP = ast.parse((ROOT / "app.py").read_text(encoding="utf-8"))


def setUpModule():
    global network_guard, socket_constructor
    network_guard = patch("socket.socket", side_effect=AssertionError("Network sockets are forbidden in offline tests"))
    socket_constructor = network_guard.start()


def tearDownModule():
    try:
        socket_constructor.assert_not_called()
    finally:
        network_guard.stop()


def ethernet():
    return Ether(src="00:00:00:00:00:01", dst="00:00:00:00:00:02")


def function(name, scope):
    node = next(n for n in ast.walk(APP) if isinstance(n, ast.FunctionDef) and n.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), "app.py", "exec"), scope)
    return scope[name]


def state():
    scope = dict(IP=IP, is_monitoring=True, current_session_id=7,
                 session_generation=3, ACTIVE_IFACE="WiFi", ACTIVE_IP="192.0.2.10",
                 session_lock=threading.Lock(), data_lock=threading.Lock(),
                 packet_count=0, captured_bytes=0, fwd_lengths=[], bwd_lengths=[],
                 first_packet_time=None, last_packet_time=None)
    function("ipv4_datagram_length", scope)
    return scope


def packet(incoming=False, payload=20, wrapped=True):
    host, peer = "192.0.2.10", "198.51.100.20"
    ip = IP(src=peer if incoming else host, dst=host if incoming else peer)
    ip = IP(bytes(ip / TCP(sport=443, dport=50000) / Raw(b"x" * payload)))
    result = ethernet() / ip if wrapped else ip
    result.time = 10.0
    return result


class BackendSelection(unittest.TestCase):
    def test_service_preflight_is_read_only_and_precedes_scapy_import(self):
        run = Mock(return_value=SimpleNamespace(returncode=0, stdout='STATE : 4 RUNNING'))
        scope = dict(os=os, re=re, subprocess=SimpleNamespace(run=run, CREATE_NO_WINDOW=0x08000000,
                                                            TimeoutExpired=subprocess.TimeoutExpired))
        function("require_running_npcap", scope)()
        self.assertEqual(run.call_args.args[0][-2:], ["query", "npcap"])
        self.assertEqual(run.call_count, 1)
        check = next(n for n in APP.body if isinstance(n, ast.If) and "require_running_npcap()" in ast.unparse(n))
        load = next(n for n in APP.body if isinstance(n, ast.ImportFrom) and n.module == "scapy.all")
        self.assertLess(check.lineno, load.lineno)

    def test_stopped_or_missing_service_is_not_started(self):
        for response in [SimpleNamespace(returncode=0, stdout='STATE : 1 STOPPED'),
                         SimpleNamespace(returncode=1060, stdout='service missing')]:
            run = Mock(return_value=response)
            scope = dict(os=os, re=re, subprocess=SimpleNamespace(run=run, CREATE_NO_WINDOW=0,
                                                                TimeoutExpired=subprocess.TimeoutExpired))
            with self.assertRaisesRegex(RuntimeError, "No service start or elevation was attempted"):
                function("require_running_npcap", scope)()
            self.assertEqual(run.call_count, 1)

    def test_service_query_timeout_is_clear(self):
        run = Mock(side_effect=subprocess.TimeoutExpired('sc.exe', 5))
        scope = dict(os=os, re=re, subprocess=SimpleNamespace(run=run, CREATE_NO_WINDOW=0,
                                                            TimeoutExpired=subprocess.TimeoutExpired))
        with self.assertRaisesRegex(RuntimeError, "CAPTURE UNAVAILABLE: cannot query"):
            function("require_running_npcap", scope)()

    def test_windows_enables_libpcap_before_scapy_import(self):
        setting = APP.body[1]
        env = {"SCAPY_USE_LIBPCAP": "0"}
        exec(compile(ast.Module(body=[setting], type_ignores=[]), "app.py", "exec"),
             {"os": SimpleNamespace(name="nt", environ=env)})
        self.assertEqual(env["SCAPY_USE_LIBPCAP"], "1")
        scapy_import = next(n for n in APP.body if isinstance(n, ast.ImportFrom) and n.module == "scapy.all")
        self.assertLess(setting.lineno, scapy_import.lineno)

    def test_backend_is_verified_before_database_import(self):
        selection = next(n for n in APP.body if isinstance(n, ast.Assign) and
                         any(isinstance(t, ast.Name) and t.id == "CAPTURE_SOCKET" for t in n.targets))
        database_import = next(n for n in APP.body if isinstance(n, ast.Import) and
                               any(a.name == "database" for a in n.names))
        self.assertLess(selection.lineno, database_import.lineno)

    def test_windows_selects_explicit_npcap_listen_socket(self):
        select = function("select_capture_socket", {})
        expected = type("L2pcapListenSocket", (), {})
        with patch.dict(sys.modules, {"scapy.arch.libpcap": SimpleNamespace(L2pcapListenSocket=expected)}):
            self.assertIs(select(SimpleNamespace(use_pcap=True, use_npcap=True), True), expected)

    def test_missing_pcap_is_a_clear_error(self):
        select = function("select_capture_socket", {})
        with self.assertRaisesRegex(RuntimeError, "CAPTURE UNAVAILABLE.*Native Windows capture is disabled"):
            select(SimpleNamespace(use_pcap=False, use_npcap=False), True)

    def test_winpcap_is_not_accepted_as_npcap(self):
        with self.assertRaisesRegex(RuntimeError, "Npcap could not initialize"):
            function("select_capture_socket", {})(SimpleNamespace(use_pcap=True, use_npcap=False), True)

    def test_non_windows_keeps_configured_listen_socket(self):
        expected = object()
        self.assertIs(function("select_capture_socket", {})(SimpleNamespace(L2listen=expected), False), expected)


class PacketAccounting(unittest.TestCase):
    def setUp(self):
        self.scope = state()
        self.length = self.scope["ipv4_datagram_length"]
        self.callback = function("make_callback", self.scope)(7, 3)

    def test_native_and_ethernet_ipv4_lengths_match(self):
        self.assertEqual(self.length(packet(wrapped=False)), 60)
        self.assertEqual(self.length(packet()), 60)

    def test_padding_and_vlan_headers_are_excluded(self):
        ip = packet(payload=0, wrapped=False)
        padded = Ether(bytes(ethernet() / ip / Padding(b"\0" * 6)))
        vlan = ethernet() / Dot1Q(vlan=2) / ip / Padding(b"\0" * 12)
        self.assertEqual(self.length(padded), 40)
        self.assertEqual(self.length(vlan), 40)

    def test_ipv4_options_are_part_of_datagram(self):
        ip = IP(bytes(IP(src="192.0.2.10", dst="198.51.100.20", options=b"\x01" * 4) / TCP()))
        self.assertEqual(self.length(ethernet() / ip), 44)

    def test_truncated_datagram_is_rejected(self):
        bad = IP(bytes(packet(wrapped=False))[:-1])
        self.assertIsNone(self.length(bad))
        self.callback(bad)
        self.assertEqual(self.scope["captured_bytes"], 0)

    def test_invalid_lengths_headers_and_version_are_rejected(self):
        for total, ihl, version in [(0, 5, 4), (19, 5, 4), (23, 6, 4), (40, 4, 4), (40, 5, 6)]:
            with self.subTest(total=total, ihl=ihl, version=version):
                self.assertIsNone(self.length(IP(src="192.0.2.10", dst="198.51.100.20", len=total, ihl=ihl, version=version) / TCP()))

    def test_incoming_and_outgoing_tcp_update_same_byte_basis(self):
        outgoing = packet(payload=20)
        incoming = packet(incoming=True, payload=40)
        incoming.time = 11.0
        self.callback(outgoing)
        self.callback(incoming)
        self.assertEqual(self.scope["packet_count"], 2)
        self.assertEqual(self.scope["captured_bytes"], 140)
        self.assertEqual(self.scope["fwd_lengths"], [60])
        self.assertEqual(self.scope["bwd_lengths"], [80])
        self.assertEqual(self.scope["first_packet_time"], 10)
        self.assertEqual(self.scope["last_packet_time"], 11)

    def test_unrelated_host_and_non_ipv4_are_ignored(self):
        other = packet()
        other[IP].src = "198.51.100.30"
        self.callback(other)
        self.callback(ethernet() / ARP())
        self.assertEqual(self.scope["packet_count"], 0)
        self.assertEqual(self.scope["captured_bytes"], 0)

    def test_ipv6_remains_outside_capture_accounting(self):
        self.callback(ethernet() / IPv6(src="2001:db8::1", dst="2001:db8::2") / TCP())
        self.assertEqual(self.scope["packet_count"], 0)
        self.assertEqual(self.scope["captured_bytes"], 0)

    def test_obsolete_session_id_is_ignored(self):
        self.scope["current_session_id"] = 8
        self.callback(packet())
        self.assertEqual(self.scope["packet_count"], 0)

    def test_obsolete_generation_is_ignored(self):
        self.scope["session_generation"] = 4
        self.callback(packet())
        self.assertEqual(self.scope["captured_bytes"], 0)

    def test_stopped_callback_is_ignored(self):
        self.scope["is_monitoring"] = False
        self.callback(packet())
        self.assertEqual(self.scope["fwd_lengths"], [])

    def test_real_throughput_and_rf_calculations_preserve_feature_order(self):
        self.callback(packet(payload=20))
        incoming = packet(incoming=True, payload=40)
        incoming.time = 11
        self.callback(incoming)
        scope = dict(self.scope, snap_bytes=self.scope["captured_bytes"], elapsed=2,
                     snap_fwd=self.scope["fwd_lengths"], snap_bwd=self.scope["bwd_lengths"],
                     snap_first_time=10, snap_last_time=11)
        worker = next(n for n in APP.body if isinstance(n, ast.FunctionDef) and n.name == "track_performance_metrics")
        body = next(n for n in worker.body if isinstance(n, ast.While)).body
        assignments = lambda n: isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name)
        throughput = [n for n in body if assignments(n) and n.targets[0].id in ("throughput_bps", "throughput_mbps")]
        start = next(i for i, n in enumerate(body) if isinstance(n, ast.If) and "snap_first_time" in ast.unparse(n.test))
        end = next(i for i, n in enumerate(body) if assignments(n) and n.targets[0].id == "live_features")
        code = compile(ast.Module(body=throughput + body[start:end + 1], type_ignores=[]), "app.py", "exec")
        exec(code, scope)
        self.assertEqual(scope["throughput_bps"], 560)
        self.assertEqual(scope["live_features"], [1000000, 1, 0.5, 60, 60, 80, 80, 1, 70])
        scope.update(snap_bytes=1400000, elapsed=2)
        exec(code, scope)
        self.assertEqual(scope["throughput_mbps"], 5.6)


class HaltWorker(BaseException):
    pass


class CaptureLifecycle(unittest.TestCase):
    def setUp(self):
        self.scope = state()
        self.handle = Mock()
        self.factory = Mock(return_value=self.handle)
        self.factory.__name__ = "L2pcapListenSocket"
        self.scope["CAPTURE_SOCKET"] = self.factory
        self.scope["time"] = SimpleNamespace(sleep=Mock(side_effect=HaltWorker))
        self.scope["sniff"] = Mock(side_effect=lambda **kw: self.scope.update(is_monitoring=False))
        self.worker = function("live_packet_sniffer", self.scope)
        self.output = io.StringIO()

    def run_worker(self):
        with contextlib.redirect_stdout(self.output), self.assertRaises(HaltWorker):
            self.worker()

    def test_selected_wifi_handle_and_timeout_are_used_and_closed(self):
        self.run_worker()
        self.factory.assert_called_once_with(iface="WiFi")
        kwargs = self.scope["sniff"].call_args.kwargs
        self.assertIs(kwargs["opened_socket"], self.handle)
        self.assertEqual(kwargs["timeout"], 1)
        self.assertEqual(kwargs["store"], 0)
        self.assertNotIn("L2socket", kwargs)
        self.handle.close.assert_called_once_with()

    def test_idle_worker_does_not_open_capture(self):
        self.scope["is_monitoring"] = False
        self.run_worker()
        self.factory.assert_not_called()

    def test_each_capture_window_closes_its_own_handle(self):
        second = Mock()
        self.factory.side_effect = [self.handle, second]
        def finish_window(**kwargs):
            if kwargs["opened_socket"] is second:
                self.scope["is_monitoring"] = False
        self.scope["sniff"].side_effect = finish_window
        self.run_worker()
        self.assertEqual(self.factory.call_count, 2)
        self.handle.close.assert_called_once_with()
        second.close.assert_called_once_with()
        self.assertEqual(self.scope["current_session_id"], 7)
        self.assertEqual(self.scope["session_generation"], 3)

    def test_missing_adapter_fails_without_using_default_interface(self):
        self.scope["ACTIVE_IFACE"] = None
        self.run_worker()
        self.factory.assert_not_called()
        self.assertIn("CAPTURE UNAVAILABLE", self.output.getvalue())

    def test_missing_host_address_fails_without_capture(self):
        self.scope["ACTIVE_IP"] = None
        self.run_worker()
        self.factory.assert_not_called()

    def test_permission_failure_is_clear_and_never_calls_sniff(self):
        self.factory.side_effect = PermissionError("access denied")
        self.run_worker()
        self.scope["sniff"].assert_not_called()
        self.assertIn("CAPTURE UNAVAILABLE", self.output.getvalue())
        self.assertIn("Administrator application terminal", self.output.getvalue())
        self.handle.close.assert_not_called()

    def test_capture_exception_closes_handle_before_retry(self):
        self.scope["sniff"].side_effect = RuntimeError("capture failed")
        self.run_worker()
        self.handle.close.assert_called_once_with()
        self.assertIn("capture failed", self.output.getvalue())

    def test_interrupt_also_closes_handle(self):
        self.scope["sniff"].side_effect = HaltWorker
        self.run_worker()
        self.handle.close.assert_called_once_with()

    def test_stop_filter_and_callback_reject_restarted_session(self):
        def restart(**kwargs):
            self.scope.update(current_session_id=8, session_generation=4)
            self.assertTrue(kwargs["stop_filter"](packet()))
            kwargs["prn"](packet())
            self.scope["is_monitoring"] = False
        self.scope["sniff"].side_effect = restart
        self.run_worker()
        self.assertEqual(self.scope["packet_count"], 0)
        self.handle.close.assert_called_once_with()


class InterfaceSelection(unittest.TestCase):
    def test_existing_selector_identifies_wifi_and_excludes_virtual_adapters(self):
        source = (ROOT / "interface_selector.py").read_text(encoding="utf-8")
        scope = {}
        exec(compile(source, "interface_selector.py", "exec"), scope)
        response = '\n'.join([
            'Configuration for interface "Npcap Loopback Adapter"', ' IP Address: 192.0.2.1',
            'Configuration for interface "Ethernet"', ' IP Address: 192.0.2.2',
            'Configuration for interface "WiFi"', ' IP Address: 192.0.2.10',
            'Configuration for interface "vEthernet (Hyper-V)"', ' IP Address: 192.0.2.3',
        ])
        with patch.object(scope["subprocess"], "run", return_value=SimpleNamespace(stdout=response)) as run:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(scope["get_active_interface"](), "WiFi")
                self.assertEqual(scope["get_active_ip"](), "192.0.2.10")
            self.assertEqual(run.call_count, 2)
            self.assertEqual(run.call_args.args[0], ["netsh", "interface", "ipv4", "show", "addresses"])


class SavedModelCompatibility(unittest.TestCase):
    def test_saved_rf_accepts_unchanged_nine_feature_schema(self):
        import joblib
        import pandas as pd
        model = joblib.load(ROOT / "rf_model.joblib")
        columns = ['Flow Duration', 'Total Fwd Packets', 'Bwd Packets/s',
                   'Fwd Packet Length Max', 'Fwd Packet Length Min',
                   'Bwd Packet Length Max', 'Bwd Packet Length Min',
                   'Flow Packets/s', 'Flow Bytes/s']
        self.assertEqual(model.n_features_in_, 9)
        self.assertEqual(list(model.feature_names_in_), columns)
        result = model.predict(pd.DataFrame([[1000000, 1, 0.5, 60, 60, 80, 80, 1, 70]], columns=columns))
        self.assertEqual(result.shape, (1,))
        self.assertIn(result[0], model.classes_)


if __name__ == "__main__":
    unittest.main()
