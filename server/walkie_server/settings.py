"""Server configuration (environment variables prefixed with ``WALKIE_`` or CLI flags)."""

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[2]


class ServerSettings(BaseSettings):
    """
    Validated runtime settings of the LAN server.

    :param str host: Interface to bind
    :param int port: TCP port for HTTPS and WSS
    :param bool tls: Serve over HTTPS/WSS (required for the microphone on non-localhost origins)
    :param Path static_dir: Folder with the web client (the same one published on GitHub Pages)
    :param Path cert_dir: Folder where the self-signed certificate is stored
    :param str mqtt_path: URL path of the MQTT-over-WebSocket endpoint
    """

    model_config = SettingsConfigDict(env_prefix="WALKIE_")

    host: str = "0.0.0.0"
    port: int = Field(default=8765, ge=1, le=65535)
    tls: bool = True
    static_dir: Path = PROJECT_ROOT / "docs"
    cert_dir: Path = PROJECT_ROOT / ".certs"
    mqtt_path: str = "/mqtt"
