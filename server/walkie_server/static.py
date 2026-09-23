"""Read-only static file resolution for the web client."""

import json
import mimetypes
from dataclasses import dataclass
from pathlib import Path

EXTRA_TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json",
}


@dataclass(frozen=True, slots=True)
class StaticFile:
    """
    A file ready to be sent over HTTP.

    :param bytes body: File content
    :param str content_type: MIME type for the Content-Type header
    """

    body: bytes
    content_type: str


def content_type_for(path: Path) -> str:
    """
    Guess the Content-Type of ``path``.

    :param Path path: File path
    :return: MIME type
    :rtype: str
    """
    suffix = path.suffix.lower()
    return EXTRA_TYPES.get(suffix) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def resolve(root: Path, url_path: str) -> Path | None:
    """
    Map a URL path to a file inside ``root``, refusing anything outside of it.

    :param Path root: Static root folder
    :param str url_path: Request path, query string excluded
    :return: The file path, or None if it does not exist or escapes ``root``
    :rtype: Path | None
    """
    root = root.resolve()
    relative = url_path.lstrip("/")
    candidate = (root / relative).resolve()
    if candidate.is_dir():
        candidate = candidate / "index.html"
    if not candidate.is_relative_to(root) or not candidate.is_file():
        return None
    return candidate


class StaticSite:
    """Serves the web client, overriding ``config.json`` so it uses this server's broker."""

    def __init__(self, root: Path, mqtt_path: str) -> None:
        """
        Create the site.

        :param Path root: Folder containing ``index.html``
        :param str mqtt_path: Path of the local MQTT WebSocket endpoint
        """
        self._root = root
        self._config = StaticFile(
            json.dumps({"broker": f"same-origin:{mqtt_path}"}).encode(),
            EXTRA_TYPES[".json"],
        )

    def get(self, url_path: str) -> StaticFile | None:
        """
        Return the file for ``url_path``.

        :param str url_path: Request path, query string excluded
        :return: The file, or None when not found
        :rtype: StaticFile | None
        """
        if url_path == "/config.json":
            return self._config
        path = resolve(self._root, url_path)
        return StaticFile(path.read_bytes(), content_type_for(path)) if path else None
