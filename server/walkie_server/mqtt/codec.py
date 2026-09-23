"""MQTT 3.1.1 wire format: incremental frame reader, packet decoders and encoders."""

from dataclasses import dataclass
from enum import IntEnum


class PacketType(IntEnum):
    """MQTT control packet types (high nibble of the fixed header)."""

    CONNECT = 1
    CONNACK = 2
    PUBLISH = 3
    PUBACK = 4
    PUBREC = 5
    PUBREL = 6
    PUBCOMP = 7
    SUBSCRIBE = 8
    SUBACK = 9
    UNSUBSCRIBE = 10
    UNSUBACK = 11
    PINGREQ = 12
    PINGRESP = 13
    DISCONNECT = 14


class ProtocolError(ValueError):
    """Raised when a peer sends malformed or unsupported MQTT data."""


MAX_REMAINING_LENGTH = 268_435_455


@dataclass(frozen=True, slots=True)
class Frame:
    """
    A raw MQTT control packet split from the byte stream.

    :param PacketType kind: Packet type
    :param int flags: Low nibble of the fixed header
    :param bytes body: Variable header plus payload
    """

    kind: PacketType
    flags: int
    body: bytes


@dataclass(frozen=True, slots=True)
class Will:
    """
    Last Will message registered at CONNECT time.

    :param str topic: Topic the will is published to
    :param bytes payload: Will payload
    :param int qos: Requested QoS
    """

    topic: str
    payload: bytes
    qos: int


@dataclass(frozen=True, slots=True)
class Connect:
    """
    Decoded CONNECT packet.

    :param str client_id: Client identifier (may be empty)
    :param int protocol_level: 4 for MQTT 3.1.1, 3 for MQTT 3.1
    :param bool clean_session: Clean session flag
    :param int keepalive: Keep alive in seconds (0 disables it)
    :param Will | None will: Optional last will
    """

    client_id: str
    protocol_level: int
    clean_session: bool
    keepalive: int
    will: Will | None


@dataclass(frozen=True, slots=True)
class Publish:
    """
    Decoded PUBLISH packet.

    :param str topic: Topic name
    :param bytes payload: Application payload
    :param int qos: QoS level (0, 1 or 2)
    :param int | None packet_id: Packet identifier, present only for QoS > 0
    """

    topic: str
    payload: bytes
    qos: int
    packet_id: int | None


@dataclass(frozen=True, slots=True)
class Subscribe:
    """
    Decoded SUBSCRIBE packet.

    :param int packet_id: Packet identifier
    :param tuple[tuple[str, int], ...] filters: (topic filter, requested QoS) pairs
    """

    packet_id: int
    filters: tuple[tuple[str, int], ...]


@dataclass(frozen=True, slots=True)
class Unsubscribe:
    """
    Decoded UNSUBSCRIBE packet.

    :param int packet_id: Packet identifier
    :param tuple[str, ...] filters: Topic filters to remove
    """

    packet_id: int
    filters: tuple[str, ...]


class FrameReader:
    """Accumulates stream bytes and yields complete MQTT frames."""

    def __init__(self, max_packet_size: int = 1 << 20) -> None:
        """
        Create an empty reader.

        :param int max_packet_size: Largest accepted remaining length in bytes
        """
        self._buffer = bytearray()
        self._max = max_packet_size

    def feed(self, data: bytes) -> list[Frame]:
        """
        Append bytes and return every frame that is now complete.

        :param bytes data: Newly received bytes
        :return: Complete frames in arrival order
        :rtype: list[Frame]
        :raises ProtocolError: On invalid headers or oversized packets
        """
        self._buffer.extend(data)
        frames: list[Frame] = []
        while (frame := self._next_frame()) is not None:
            frames.append(frame)
        return frames

    def _next_frame(self) -> Frame | None:
        buf = self._buffer
        if len(buf) < 2:
            return None
        length, multiplier, pos = 0, 1, 1
        while True:
            if pos >= len(buf):
                return None
            byte = buf[pos]
            length += (byte & 0x7F) * multiplier
            pos += 1
            if not byte & 0x80:
                break
            multiplier *= 128
            if pos > 4:
                raise ProtocolError("remaining length too long")
        if length > self._max:
            raise ProtocolError(f"packet too large ({length} bytes)")
        if len(buf) < pos + length:
            return None
        try:
            kind = PacketType(buf[0] >> 4)
        except ValueError as exc:
            raise ProtocolError(f"unknown packet type {buf[0] >> 4}") from exc
        frame = Frame(kind, buf[0] & 0x0F, bytes(buf[pos : pos + length]))
        del buf[: pos + length]
        return frame


def _read_u16(body: bytes, pos: int) -> tuple[int, int]:
    if pos + 2 > len(body):
        raise ProtocolError("truncated packet")
    return int.from_bytes(body[pos : pos + 2], "big"), pos + 2


def _read_bytes(body: bytes, pos: int) -> tuple[bytes, int]:
    size, pos = _read_u16(body, pos)
    if pos + size > len(body):
        raise ProtocolError("truncated packet")
    return body[pos : pos + size], pos + size


def _read_str(body: bytes, pos: int) -> tuple[str, int]:
    raw, pos = _read_bytes(body, pos)
    try:
        return raw.decode("utf-8"), pos
    except UnicodeDecodeError as exc:
        raise ProtocolError("invalid UTF-8 string") from exc


def decode_connect(body: bytes) -> Connect:
    """
    Decode the body of a CONNECT packet.

    :param bytes body: Variable header and payload
    :return: The decoded packet
    :rtype: Connect
    :raises ProtocolError: If the packet is malformed
    """
    protocol, pos = _read_str(body, 0)
    if protocol not in ("MQTT", "MQIsdp") or pos + 4 > len(body):
        raise ProtocolError(f"unsupported protocol {protocol!r}")
    level, flags = body[pos], body[pos + 1]
    keepalive, pos = _read_u16(body, pos + 2)
    client_id, pos = _read_str(body, pos)
    will = None
    if flags & 0x04:
        will_topic, pos = _read_str(body, pos)
        will_payload, pos = _read_bytes(body, pos)
        will = Will(will_topic, will_payload, (flags >> 3) & 0x03)
    return Connect(client_id, level, bool(flags & 0x02), keepalive, will)


def decode_publish(flags: int, body: bytes) -> Publish:
    """
    Decode the body of a PUBLISH packet.

    :param int flags: Fixed header flags (DUP, QoS, RETAIN)
    :param bytes body: Variable header and payload
    :return: The decoded packet
    :rtype: Publish
    :raises ProtocolError: If the packet is malformed
    """
    qos = (flags >> 1) & 0x03
    if qos == 3:
        raise ProtocolError("invalid QoS 3")
    topic, pos = _read_str(body, 0)
    packet_id = None
    if qos:
        packet_id, pos = _read_u16(body, pos)
    return Publish(topic, body[pos:], qos, packet_id)


def decode_subscribe(body: bytes) -> Subscribe:
    """
    Decode the body of a SUBSCRIBE packet.

    :param bytes body: Variable header and payload
    :return: The decoded packet
    :rtype: Subscribe
    :raises ProtocolError: If the packet is malformed or has no filters
    """
    packet_id, pos = _read_u16(body, 0)
    filters: list[tuple[str, int]] = []
    while pos < len(body):
        topic_filter, pos = _read_str(body, pos)
        if pos >= len(body):
            raise ProtocolError("missing requested QoS")
        filters.append((topic_filter, body[pos] & 0x03))
        pos += 1
    if not filters:
        raise ProtocolError("SUBSCRIBE without filters")
    return Subscribe(packet_id, tuple(filters))


def decode_unsubscribe(body: bytes) -> Unsubscribe:
    """
    Decode the body of an UNSUBSCRIBE packet.

    :param bytes body: Variable header and payload
    :return: The decoded packet
    :rtype: Unsubscribe
    :raises ProtocolError: If the packet is malformed
    """
    packet_id, pos = _read_u16(body, 0)
    filters: list[str] = []
    while pos < len(body):
        topic_filter, pos = _read_str(body, pos)
        filters.append(topic_filter)
    return Unsubscribe(packet_id, tuple(filters))


def _encode_length(length: int) -> bytes:
    out = bytearray()
    while True:
        byte, length = length % 128, length // 128
        out.append(byte | (0x80 if length else 0))
        if not length:
            return bytes(out)


def encode_packet(kind: PacketType, flags: int, body: bytes = b"") -> bytes:
    """
    Build a complete MQTT packet from its parts.

    :param PacketType kind: Packet type
    :param int flags: Low nibble of the fixed header
    :param bytes body: Variable header plus payload
    :return: Wire bytes
    :rtype: bytes
    :raises ProtocolError: If the body exceeds the MQTT size limit
    """
    if len(body) > MAX_REMAINING_LENGTH:
        raise ProtocolError("packet too large")
    return bytes([(kind << 4) | (flags & 0x0F)]) + _encode_length(len(body)) + body


def encode_connack(return_code: int, session_present: bool = False) -> bytes:
    """
    Build a CONNACK packet.

    :param int return_code: 0 for accepted, see MQTT spec for errors
    :param bool session_present: Session present flag
    :return: Wire bytes
    :rtype: bytes
    """
    return encode_packet(PacketType.CONNACK, 0, bytes([int(session_present), return_code]))


def encode_publish(topic: str, payload: bytes) -> bytes:
    """
    Build a QoS 0, non-retained PUBLISH packet.

    :param str topic: Topic name
    :param bytes payload: Application payload
    :return: Wire bytes
    :rtype: bytes
    """
    raw_topic = topic.encode("utf-8")
    return encode_packet(PacketType.PUBLISH, 0, len(raw_topic).to_bytes(2, "big") + raw_topic + payload)


def encode_ack(kind: PacketType, packet_id: int, codes: bytes = b"") -> bytes:
    """
    Build a packet made of a packet identifier plus optional return codes.

    Used for PUBACK, PUBREC, PUBCOMP, SUBACK and UNSUBACK.

    :param PacketType kind: Acknowledgement type
    :param int packet_id: Identifier being acknowledged
    :param bytes codes: SUBACK return codes, empty otherwise
    :return: Wire bytes
    :rtype: bytes
    """
    return encode_packet(kind, 0, packet_id.to_bytes(2, "big") + codes)


PINGRESP = encode_packet(PacketType.PINGRESP, 0)
