"""In-memory MQTT broker core, independent from the network layer."""

import asyncio
import secrets
from dataclasses import dataclass, field
from typing import Protocol

from loguru import logger

from . import codec
from .codec import Connect, Frame, PacketType, ProtocolError
from .topics import is_valid_filter, is_valid_topic, matches

CONNECT_TIMEOUT_S = 10.0
OUTBOX_LIMIT = 1024


class TransportClosed(Exception):
    """Raised by a transport when the peer has gone away."""


class Transport(Protocol):
    """Bidirectional binary message channel to one client (e.g. a WebSocket)."""

    @property
    def remote(self) -> str:
        """Human readable peer address used for logging."""
        ...

    async def recv(self) -> bytes:
        """
        Wait for the next chunk of bytes.

        :return: Received bytes
        :rtype: bytes
        :raises TransportClosed: When the connection is closed
        """
        ...

    async def send(self, data: bytes) -> None:
        """
        Send one chunk of bytes.

        :param bytes data: Bytes to send
        :raises TransportClosed: When the connection is closed
        """
        ...

    async def close(self) -> None:
        """Close the connection; must be idempotent."""
        ...


@dataclass(eq=False)
class Session:
    """
    State of one connected MQTT client.

    :param str client_id: MQTT client identifier
    :param Transport transport: Underlying connection
    :param Will | None will: Last will to publish on abnormal disconnect
    """

    client_id: str
    transport: Transport
    will: codec.Will | None
    subscriptions: dict[str, int] = field(default_factory=dict)
    outbox: asyncio.Queue[bytes] = field(default_factory=lambda: asyncio.Queue(OUTBOX_LIMIT))

    def wants(self, topic: str) -> bool:
        """
        Tell whether any subscription of this session matches ``topic``.

        :param str topic: Topic name
        :return: True if the message must be delivered to this session
        :rtype: bool
        """
        return any(matches(f, topic) for f in self.subscriptions)


class Broker:
    """Routes PUBLISH messages between sessions (QoS 0 delivery, no retained messages)."""

    def __init__(self, max_packet_size: int = 1 << 20) -> None:
        """
        Create an empty broker.

        :param int max_packet_size: Largest accepted MQTT packet body in bytes
        """
        self._sessions: dict[str, Session] = {}
        self._max_packet_size = max_packet_size

    @property
    def client_count(self) -> int:
        """Number of currently connected clients."""
        return len(self._sessions)

    def publish(self, topic: str, payload: bytes) -> None:
        """
        Deliver a message to every session subscribed to ``topic``.

        :param str topic: Topic name
        :param bytes payload: Message payload
        """
        packet = codec.encode_publish(topic, payload)
        for session in [s for s in self._sessions.values() if s.wants(topic)]:
            self._enqueue(session, packet)

    async def serve(self, transport: Transport) -> None:
        """
        Run the MQTT protocol on ``transport`` until it disconnects.

        :param Transport transport: A freshly accepted client connection
        """
        reader = codec.FrameReader(self._max_packet_size)
        session: Session | None = None
        writer: asyncio.Task[None] | None = None
        graceful = False
        try:
            connect, pending = await self._await_connect(transport, reader)
            session = self._open_session(connect, transport)
            writer = asyncio.create_task(self._drain(session))
            self._enqueue(session, codec.encode_connack(0))
            timeout = connect.keepalive * 1.5 if connect.keepalive else None
            frames = pending
            while True:
                for frame in frames:
                    if not self._dispatch(session, frame):
                        graceful = True
                        return
                frames = reader.feed(await asyncio.wait_for(transport.recv(), timeout))
        except (TransportClosed, TimeoutError):
            pass
        except ProtocolError as exc:
            logger.warning(f"{transport.remote}: protocol error: {exc}")
        finally:
            await self._close_session(session, transport, writer, graceful)

    async def _await_connect(
        self, transport: Transport, reader: codec.FrameReader
    ) -> tuple[Connect, list[Frame]]:
        frames: list[Frame] = []
        async with asyncio.timeout(CONNECT_TIMEOUT_S):
            while not frames:
                frames = reader.feed(await transport.recv())
        first, rest = frames[0], frames[1:]
        if first.kind is not PacketType.CONNECT:
            raise ProtocolError("first packet must be CONNECT")
        connect = codec.decode_connect(first.body)
        if connect.protocol_level not in (3, 4):
            await transport.send(codec.encode_connack(1))
            raise ProtocolError(f"unsupported protocol level {connect.protocol_level}")
        return connect, rest

    def _open_session(self, connect: Connect, transport: Transport) -> Session:
        client_id = connect.client_id or f"anon-{secrets.token_hex(6)}"
        previous = self._sessions.get(client_id)
        if previous is not None:
            logger.info(f"client {client_id} reconnected, dropping previous connection")
            previous.will = None
            asyncio.ensure_future(previous.transport.close())
        session = Session(client_id, transport, connect.will)
        self._sessions[client_id] = session
        logger.info(f"+ {client_id} ({transport.remote}) — clients: {self.client_count}")
        return session

    def _dispatch(self, session: Session, frame: Frame) -> bool:
        """Handle one packet; return False when the client asked to disconnect."""
        match frame.kind:
            case PacketType.PUBLISH:
                msg = codec.decode_publish(frame.flags, frame.body)
                if msg.qos == 2:
                    raise ProtocolError("QoS 2 is not supported")
                if msg.packet_id is not None:
                    self._enqueue(session, codec.encode_ack(PacketType.PUBACK, msg.packet_id))
                if not is_valid_topic(msg.topic):
                    raise ProtocolError(f"invalid topic {msg.topic!r}")
                self.publish(msg.topic, msg.payload)
            case PacketType.SUBSCRIBE:
                sub = codec.decode_subscribe(frame.body)
                codes = bytes(0x00 if is_valid_filter(f) else 0x80 for f, _ in sub.filters)
                session.subscriptions.update({f: 0 for f, _ in sub.filters if is_valid_filter(f)})
                self._enqueue(session, codec.encode_ack(PacketType.SUBACK, sub.packet_id, codes))
            case PacketType.UNSUBSCRIBE:
                unsub = codec.decode_unsubscribe(frame.body)
                for topic_filter in unsub.filters:
                    session.subscriptions.pop(topic_filter, None)
                self._enqueue(session, codec.encode_ack(PacketType.UNSUBACK, unsub.packet_id))
            case PacketType.PINGREQ:
                self._enqueue(session, codec.PINGRESP)
            case PacketType.PUBACK:
                pass
            case PacketType.DISCONNECT:
                return False
            case _:
                raise ProtocolError(f"unexpected packet {frame.kind.name}")
        return True

    def _enqueue(self, session: Session, packet: bytes) -> None:
        try:
            session.outbox.put_nowait(packet)
        except asyncio.QueueFull:
            logger.warning(f"{session.client_id}: too slow, disconnecting")
            asyncio.ensure_future(session.transport.close())

    @staticmethod
    async def _drain(session: Session) -> None:
        try:
            while True:
                await session.transport.send(await session.outbox.get())
        except TransportClosed:
            await session.transport.close()

    async def _close_session(
        self,
        session: Session | None,
        transport: Transport,
        writer: asyncio.Task[None] | None,
        graceful: bool,
    ) -> None:
        if writer is not None:
            writer.cancel()
        await transport.close()
        if session is None:
            return
        if self._sessions.get(session.client_id) is session:
            del self._sessions[session.client_id]
        logger.info(f"- {session.client_id} — clients: {self.client_count}")
        if not graceful and session.will is not None:
            self.publish(session.will.topic, session.will.payload)
