"""Network wiring: one port serving the static client over HTTP(S) and the MQTT broker over WS(S)."""

import asyncio
import http
import logging
import ssl
from email.utils import formatdate

from loguru import logger
from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response

from .mqtt.broker import Broker, TransportClosed
from .static import StaticSite


class WebSocketTransport:
    """Adapts a ``websockets`` connection to the broker ``Transport`` protocol."""

    def __init__(self, connection: ServerConnection) -> None:
        """
        Wrap a connection.

        :param ServerConnection connection: Accepted WebSocket connection
        """
        self._conn = connection

    @property
    def remote(self) -> str:
        """Peer address as ``host:port``."""
        address = self._conn.remote_address
        return f"{address[0]}:{address[1]}" if address else "?"

    async def recv(self) -> bytes:
        """
        Receive the next binary message.

        :return: Message bytes
        :rtype: bytes
        :raises TransportClosed: When the WebSocket is closed
        """
        try:
            message = await self._conn.recv()
        except ConnectionClosed as exc:
            raise TransportClosed from exc
        return message if isinstance(message, bytes) else message.encode()

    async def send(self, data: bytes) -> None:
        """
        Send one binary message.

        :param bytes data: Message bytes
        :raises TransportClosed: When the WebSocket is closed
        """
        try:
            await self._conn.send(data)
        except ConnectionClosed as exc:
            raise TransportClosed from exc

    async def close(self) -> None:
        """Close the WebSocket."""
        await self._conn.close()


def _response(status: http.HTTPStatus, body: bytes, content_type: str) -> Response:
    headers = Headers(
        [
            ("Date", formatdate(usegmt=True)),
            ("Content-Type", content_type),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-cache"),
            ("Connection", "close"),
        ]
    )
    return Response(status.value, status.phrase, headers, body)


def make_request_handler(site: StaticSite, mqtt_path: str):
    """
    Build the ``process_request`` hook that serves static files for non-WebSocket requests.

    :param StaticSite site: Static web client
    :param str mqtt_path: Path reserved for the WebSocket upgrade
    :return: Hook compatible with ``websockets.asyncio.server.serve``
    :rtype: Callable[[ServerConnection, Request], Response | None]
    """

    def process_request(connection: ServerConnection, request: Request) -> Response | None:
        path = request.path.split("?", 1)[0]
        is_upgrade = "websocket" in request.headers.get("Upgrade", "").lower()
        if path == mqtt_path and is_upgrade:
            return None
        file = site.get(path)
        if file is None:
            return _response(http.HTTPStatus.NOT_FOUND, b"Not found\n", "text/plain")
        return _response(http.HTTPStatus.OK, file.body, file.content_type)

    return process_request


async def start_server(
    broker: Broker,
    site: StaticSite,
    host: str,
    port: int,
    mqtt_path: str,
    ssl_context: ssl.SSLContext | None,
) -> Server:
    """
    Start listening; the returned server runs until closed.

    :param Broker broker: MQTT broker handling WebSocket clients
    :param StaticSite site: Static web client
    :param str host: Interface to bind
    :param int port: TCP port (0 picks a free one)
    :param str mqtt_path: URL path of the WebSocket endpoint
    :param ssl.SSLContext | None ssl_context: TLS context, None for plain HTTP/WS
    :return: The running server
    :rtype: Server
    """
    logging.getLogger("websockets").setLevel(logging.CRITICAL)

    async def handler(connection: ServerConnection) -> None:
        await broker.serve(WebSocketTransport(connection))

    return await serve(
        handler,
        host,
        port,
        ssl=ssl_context,
        subprotocols=["mqtt"],
        process_request=make_request_handler(site, mqtt_path),
        compression=None,
        max_size=1 << 20,
        ping_interval=20,
        ping_timeout=20,
    )


async def run_forever(server: Server) -> None:
    """
    Keep ``server`` running until cancelled.

    :param Server server: A started server
    """
    try:
        await asyncio.Future()
    finally:
        server.close()
        await server.wait_closed()
        logger.info("Server stopped")
