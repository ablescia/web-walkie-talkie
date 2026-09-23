"""Discovery of the machine's LAN addresses."""

import ipaddress
import socket


def primary_lan_ip() -> str | None:
    """
    Return the IPv4 address used for the default route, without sending any packet.

    :return: The address, or None when the machine is offline
    :rtype: str | None
    """
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        try:
            sock.connect(("192.0.2.1", 9))
            return sock.getsockname()[0]
        except OSError:
            return None


def local_ipv4_addresses() -> tuple[str, ...]:
    """
    Return the non-loopback IPv4 addresses of this host, primary one first.

    :return: Unique addresses
    :rtype: tuple[str, ...]
    """
    try:
        resolved = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
        candidates = [str(info[4][0]) for info in resolved]
    except OSError:
        candidates = []
    primary = primary_lan_ip()
    ordered = ([primary] if primary else []) + candidates
    unique = dict.fromkeys(ip for ip in ordered if not ipaddress.ip_address(ip).is_loopback)
    return tuple(unique)
