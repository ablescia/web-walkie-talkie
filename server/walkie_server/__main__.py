"""Command line entry point: ``uv run walkie-server``."""

import argparse
import asyncio
import sys

from loguru import logger

from .app import run_forever, start_server
from .mqtt.broker import Broker
from .netinfo import local_ipv4_addresses
from .settings import ServerSettings
from .static import StaticSite
from .tls import build_ssl_context


def parse_settings(argv: list[str]) -> ServerSettings:
    """
    Build settings from environment variables, overridden by CLI flags.

    :param list[str] argv: Command line arguments (without program name)
    :return: Validated settings
    :rtype: ServerSettings
    """
    parser = argparse.ArgumentParser(prog="walkie-server", description="Web Walkie-Talkie LAN server")
    parser.add_argument("--host", help="interfaccia di ascolto (default 0.0.0.0)")
    parser.add_argument("--port", type=int, help="porta HTTPS/WSS (default 8765)")
    parser.add_argument("--no-tls", dest="tls", action="store_false", default=None,
                        help="usa HTTP/WS in chiaro (il microfono funzionerà solo su localhost)")
    args = parser.parse_args(argv)
    overrides = {k: v for k, v in vars(args).items() if v is not None}
    return ServerSettings(**overrides)


async def amain(settings: ServerSettings) -> None:
    """
    Start the server and print the URLs to open.

    :param ServerSettings settings: Runtime settings
    """
    ips = local_ipv4_addresses()
    ssl_context = build_ssl_context(settings.cert_dir, ips) if settings.tls else None
    server = await start_server(
        Broker(),
        StaticSite(settings.static_dir, settings.mqtt_path),
        settings.host,
        settings.port,
        settings.mqtt_path,
        ssl_context,
    )
    scheme = "https" if settings.tls else "http"
    urls = [f"{scheme}://{ip}:{settings.port}/" for ip in ips] or [f"{scheme}://localhost:{settings.port}/"]
    logger.info(f"Walkie-Talkie in ascolto su {settings.host}:{settings.port}")
    for url in urls:
        logger.info(f"  apri → {url}")
    if settings.tls:
        logger.info("Certificato autofirmato: al primo accesso accetta l'avviso di sicurezza del browser.")
    await run_forever(server)


def main() -> None:
    """Run the server until Ctrl+C."""
    logger.remove()
    logger.add(sys.stderr, format="<green>{time:HH:mm:ss}</green> <level>{level: <7}</level> {message}")
    settings = parse_settings(sys.argv[1:])
    try:
        asyncio.run(amain(settings))
    except KeyboardInterrupt:
        pass
    except OSError as exc:
        logger.error(f"Impossibile avviare il server: {exc}")
        logger.error(f"La porta {settings.port} è occupata? Riprova con --port <numero>.")
        sys.exit(1)


if __name__ == "__main__":
    main()
