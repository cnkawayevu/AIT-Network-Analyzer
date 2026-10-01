"""
interface_selector.py
---------------------
Resolves the best active Wi-Fi or Ethernet interface for scapy packet capture.

Uses Windows `netsh interface ipv4 show addresses` exclusively — no scapy or
Npcap calls, so it never contends with the driver that sniff() is using.

The returned name matches the Windows adapter name that scapy recognises on
Windows (e.g. "Wi-Fi", "Ethernet", "Local Area Connection").

Usage:
    from interface_selector import get_active_interface
    iface_name = get_active_interface()   # e.g. "Wi-Fi" or "Ethernet"
"""

import socket
import subprocess


# ---------------------------------------------------------------------------
# Filter constants
# ---------------------------------------------------------------------------

# Adapter name substrings that identify physical Wi-Fi or Ethernet NICs
PREFERRED_KEYWORDS = (
    "wi-fi", "wifi", "wireless",
    "ethernet", "local area connection", "lan",
)

# Adapter name substrings for adapters to skip entirely
EXCLUDE_KEYWORDS = (
    "loopback", "virtual", "vmware", "vbox", "virtualbox",
    "hyper-v", "bluetooth", "tunnel", "teredo", "isatap",
    "6to4", "pseudo", "miniport", "wan miniport", "vpn", "tap",
    "npcap",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_real_ipv4(ip: str) -> bool:
    """Return True for a non-loopback, non-APIPA IPv4 address."""
    try:
        socket.inet_pton(socket.AF_INET, ip)
        return not ip.startswith("127.") and not ip.startswith("169.254.")
    except (OSError, AttributeError):
        return False


def _score(name: str) -> int:
    """Priority score: Wi-Fi (10) > Ethernet (8) > other (1)."""
    name_lower = name.lower()
    if any(k in name_lower for k in ("wi-fi", "wifi", "wireless")):
        return 10
    if any(k in name_lower for k in ("ethernet", "local area connection", "lan")):
        return 8
    return 1


# ---------------------------------------------------------------------------
# netsh-based interface discovery
# ---------------------------------------------------------------------------

def _query_netsh_addresses() -> list[dict]:
    """
    Run `netsh interface ipv4 show addresses` and parse the output.
    Returns a list of dicts: {"name": str, "ip": str, "score": int}
    """
    try:
        result = subprocess.run(
            ["netsh", "interface", "ipv4", "show", "addresses"],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        lines = result.stdout.splitlines()
    except Exception as exc:
        print(f"[interface_selector] netsh query failed: {exc}")
        return []

    adapters = []
    current_name = None

    for line in lines:
        stripped = line.strip()

        # Header: 'Configuration for interface "Wi-Fi"'
        lower = stripped.lower()
        if lower.startswith("configuration for interface"):
            parts = stripped.split('"')
            current_name = parts[1] if len(parts) >= 3 else None
            continue

        # IP Address line: 'IP Address:  192.168.1.10'
        if current_name and "ip address" in lower and ":" in stripped:
            ip_part = stripped.split(":", 1)[-1].strip()
            if _is_real_ipv4(ip_part):
                name_lower = current_name.lower()
                if any(excl in name_lower for excl in EXCLUDE_KEYWORDS):
                    continue
                adapters.append({
                    "name":  current_name,
                    "ip":    ip_part,
                    "score": _score(current_name),
                })
                print(
                    f"[interface_selector] Found: '{current_name}' | "
                    f"IP: {ip_part} | Score: {_score(current_name)}"
                )

    return adapters


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_active_interface() -> str | None:
    """
    Detect the best active Wi-Fi or Ethernet interface for scapy sniff().

    Queries Windows `netsh` to enumerate adapters that are currently UP and
    carrying real IPv4 traffic. Prefers Wi-Fi over Ethernet by score.

    Returns:
        str   : Windows adapter name for sniff(iface=...), e.g. "Wi-Fi".
        None  : No suitable interface found; caller falls back to all ifaces.
    """
    print("[interface_selector] Resolving active network interface via netsh ...")

    adapters = _query_netsh_addresses()

    if not adapters:
        print(
            "[interface_selector] WARNING: No active IPv4 interface found. "
            "scapy will capture on all interfaces (fallback mode)."
        )
        return None

    # Filter to preferred physical types if any exist; else keep all
    preferred = [a for a in adapters if any(
        k in a["name"].lower() for k in PREFERRED_KEYWORDS
    )]
    pool = preferred if preferred else adapters

    # Sort by score descending
    pool.sort(key=lambda a: a["score"], reverse=True)
    best = pool[0]

    print(
        f"[interface_selector] Selected interface: '{best['name']}' "
        f"(IP: {best['ip']})"
    )
    return best["name"]

def get_active_ip() -> str | None:
    adapters = _query_netsh_addresses()
    if not adapters:
        return None
    preferred = [a for a in adapters if any(k in a["name"].lower() for k in PREFERRED_KEYWORDS)]
    pool = preferred if preferred else adapters
    pool.sort(key=lambda a: a["score"], reverse=True)
    return pool[0]["ip"]
