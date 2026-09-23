"""Self-signed certificate management for HTTPS on the LAN."""

import datetime as dt
import ipaddress
import ssl
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from loguru import logger


def _certificate_covers(cert_path: Path, ips: tuple[str, ...]) -> bool:
    try:
        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except (OSError, ValueError, x509.ExtensionNotFound):
        return False
    covered = {str(ip) for ip in san.get_values_for_type(x509.IPAddress)}
    not_expired = cert.not_valid_after_utc > dt.datetime.now(dt.UTC) + dt.timedelta(days=1)
    return not_expired and set(ips) <= covered


def _generate(cert_path: Path, key_path: Path, ips: tuple[str, ...]) -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Web Walkie-Talkie (LAN)")])
    now = dt.datetime.now(dt.UTC)
    san = x509.SubjectAlternativeName(
        [x509.DNSName("localhost")] + [x509.IPAddress(ipaddress.ip_address(ip)) for ip in ips]
    )
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=365))
        .add_extension(san, critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    cert_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    key_path.chmod(0o600)
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def build_ssl_context(cert_dir: Path, ips: tuple[str, ...]) -> ssl.SSLContext:
    """
    Load (or create) a self-signed certificate valid for ``ips`` and build a server SSL context.

    :param Path cert_dir: Folder holding ``cert.pem`` and ``key.pem``
    :param tuple[str, ...] ips: IP addresses the certificate must cover
    :return: Server-side SSL context
    :rtype: ssl.SSLContext
    """
    cert_path, key_path = cert_dir / "cert.pem", cert_dir / "key.pem"
    wanted = tuple(dict.fromkeys(("127.0.0.1", *ips)))
    if not (key_path.exists() and _certificate_covers(cert_path, wanted)):
        logger.info(f"Generating self-signed certificate for {', '.join(wanted)}")
        _generate(cert_path, key_path, wanted)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    return context
