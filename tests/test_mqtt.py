"""Unit and integration tests for the minimal MQTT broker."""

import asyncio
import json
from pathlib import Path

import pytest
from websockets.asyncio.client import ClientConnection, connect

from walkie_server.app import start_server
from walkie_server.mqtt import codec
from walkie_server.mqtt.broker import Broker
from walkie_server.mqtt.codec import PacketType
from walkie_server.mqtt.topics import is_valid_filter, matches
from walkie_server.static import StaticSite, resolve


@pytest.mark.parametrize(
    ("topic_filter", "topic", "expected"),
    [
        ("a/b", "a/b", True),
        ("a/+", "a/b", True),
        ("a/+", "a/b/c", False),
        ("a/#", "a", True),
        ("a/#", "a/b/c", True),
        ("#", "x/y", True),
        ("+/+", "a", False),
        ("#", "$SYS/x", False),
    ],
)
def test_matches(topic_filter: str, topic: str, expected: bool) -> None:
    assert matches(topic_filter, topic) is expected


@pytest.mark.parametrize(("topic_filter", "valid"), [("a/#", True), ("a/#/b", False), ("a+/b", False), ("", False)])
def test_is_valid_filter(topic_filter: str, valid: bool) -> None:
    assert is_valid_filter(topic_filter) is valid


def test_frame_reader_handles_split_and_coalesced_packets() -> None:
    big = codec.encode_publish("t", b"x" * 300)
    stream = big + codec.PINGRESP
    reader = codec.FrameReader()
    assert reader.feed(stream[:2]) == []
    frames = reader.feed(stream[2:])
    assert [f.kind for f in frames] == [PacketType.PUBLISH, PacketType.PINGRESP]
    assert codec.decode_publish(frames[0].flags, frames[0].body).payload == b"x" * 300


def test_resolve_blocks_traversal(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("ok")
    assert resolve(tmp_path, "/") == tmp_path / "index.html"
    assert resolve(tmp_path, "/../../etc/passwd") is None


def _mqtt_string(value: str) -> bytes:
    raw = value.encode()
    return len(raw).to_bytes(2, "big") + raw


def connect_packet(client_id: str, will: tuple[str, bytes] | None = None) -> bytes:
    flags = 0x02 | (0x04 if will else 0)
    body = _mqtt_string("MQTT") + bytes([4, flags]) + (30).to_bytes(2, "big") + _mqtt_string(client_id)
    if will:
        body += _mqtt_string(will[0]) + _mqtt_string(will[1].decode())
    return codec.encode_packet(PacketType.CONNECT, 0, body)


def subscribe_packet(topic_filter: str) -> bytes:
    return codec.encode_packet(PacketType.SUBSCRIBE, 2, (1).to_bytes(2, "big") + _mqtt_string(topic_filter) + b"\x00")


async def next_frame(ws: ClientConnection) -> codec.Frame:
    frames = codec.FrameReader().feed(await asyncio.wait_for(ws.recv(), 2))
    return frames[0]


async def open_client(url: str, client_id: str, will: tuple[str, bytes] | None = None) -> ClientConnection:
    ws = await connect(url, subprotocols=["mqtt"])
    await ws.send(connect_packet(client_id, will))
    assert (await next_frame(ws)).kind is PacketType.CONNACK
    return ws


@pytest.fixture
async def server_url(tmp_path: Path):
    (tmp_path / "index.html").write_text("<h1>hi</h1>")
    server = await start_server(Broker(), StaticSite(tmp_path, "/mqtt"), "127.0.0.1", 0, "/mqtt", None)
    port = next(iter(server.sockets)).getsockname()[1]
    yield f"ws://127.0.0.1:{port}/mqtt"
    server.close()
    await server.wait_closed()


async def test_publish_subscribe_and_will(server_url: str) -> None:
    alice = await open_client(server_url, "alice")
    bob = await open_client(server_url, "bob", will=("room/presence", b"bob-gone"))

    await alice.send(subscribe_packet("room/#"))
    assert (await next_frame(alice)).kind is PacketType.SUBACK

    await bob.send(codec.encode_publish("room/audio/bob", b"\x01\x02\x03"))
    frame = await next_frame(alice)
    assert codec.decode_publish(frame.flags, frame.body).payload == b"\x01\x02\x03"

    await bob.close()  # no DISCONNECT packet → the will must be published
    frame = await next_frame(alice)
    assert codec.decode_publish(frame.flags, frame.body).payload == b"bob-gone"
    await alice.close()


async def test_http_serves_static_and_config(server_url: str) -> None:
    import urllib.request

    base = server_url.replace("ws://", "http://").removesuffix("/mqtt")
    body = await asyncio.to_thread(lambda: urllib.request.urlopen(f"{base}/").read())
    assert body == b"<h1>hi</h1>"
    config = await asyncio.to_thread(lambda: urllib.request.urlopen(f"{base}/config.json").read())
    assert json.loads(config) == {"broker": "same-origin:/mqtt"}
