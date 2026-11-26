"""Serving a file through the public host's OWN thread budget (`service.PublicThreads`).

Starlette's `FileResponse` reads a file with `anyio.open_file` / `anyio.to_thread` — anyio's
process-wide default thread pool, the one every private chat route also uses. A flood of anonymous
requests for `/assets/...` or `/media/...` could therefore take every default thread and starve the
private chat. `PooledFileResponse` is a `FileResponse` whose file reads (open, seek, read, close)
all run through the public `PublicThreads` limiter instead, and whose headers and behaviour are
otherwise exactly `FileResponse`'s: `Content-Length`, `Last-Modified`, `ETag`, `Accept-Ranges:
bytes`, and single and multiple byte ranges. The caller provides the `os.stat` result (taken
through the same budget), so the response itself never stats the file.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from typing import BinaryIO, Final

import anyio
from starlette.datastructures import MutableHeaders
from starlette.responses import FileResponse
from starlette.types import Send

from wixy_server.adventure_public.service import PublicThreads

CHUNK_SIZE: Final = 256 * 1024


class PooledFileResponse(FileResponse):
    chunk_size = CHUNK_SIZE

    def __init__(
        self,
        path: str | os.PathLike[str],
        *,
        threads: PublicThreads,
        stat_result: os.stat_result,
        media_type: str,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(path, media_type=media_type, headers=headers, stat_result=stat_result)
        self._threads = threads
        self._size = stat_result.st_size

    async def _chunks(self, start: int, end: int) -> AsyncIterator[bytes]:
        """The bytes `[start, end)` of the file, read a chunk at a time on the public threads."""
        handle: BinaryIO = await self._threads.run(open, self.path, "rb")
        try:
            if start:
                await self._threads.run(handle.seek, start)
            remaining = end - start
            while remaining > 0:
                chunk = await self._threads.run(handle.read, min(self.chunk_size, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk
        finally:
            with anyio.CancelScope(shield=True):  # still close the file if the client went away
                await self._threads.run(handle.close)

    async def _send_range(self, send: Send, start: int, end: int, *, more_body: bool) -> None:
        async for chunk in self._chunks(start, end):
            await send({"type": "http.response.body", "body": chunk, "more_body": True})
        if not more_body:
            await send({"type": "http.response.body", "body": b"", "more_body": False})

    async def _handle_simple(self, send: Send, send_header_only: bool, send_pathsend: bool) -> None:
        await send(
            {"type": "http.response.start", "status": self.status_code, "headers": self.raw_headers}
        )
        if send_header_only:
            await send({"type": "http.response.body", "body": b"", "more_body": False})
        elif send_pathsend:
            await send({"type": "http.response.pathsend", "path": str(self.path)})
        else:
            await self._send_range(send, 0, self._size, more_body=False)

    async def _handle_single_range(
        self, send: Send, start: int, end: int, file_size: int, send_header_only: bool
    ) -> None:
        headers = MutableHeaders(raw=list(self.raw_headers))
        headers["content-range"] = f"bytes {start}-{end - 1}/{file_size}"
        headers["content-length"] = str(end - start)
        await send({"type": "http.response.start", "status": 206, "headers": headers.raw})
        if send_header_only:
            await send({"type": "http.response.body", "body": b"", "more_body": False})
        else:
            await self._send_range(send, start, end, more_body=False)

    async def _handle_multiple_ranges(
        self,
        send: Send,
        ranges: list[tuple[int, int]],
        file_size: int,
        send_header_only: bool,
    ) -> None:
        boundary = os.urandom(13).hex()
        content_length, header_generator = self.generate_multipart(
            ranges, boundary, file_size, self.headers["content-type"]
        )
        headers = MutableHeaders(raw=list(self.raw_headers))
        headers["content-type"] = f"multipart/byteranges; boundary={boundary}"
        headers["content-length"] = str(content_length)
        await send({"type": "http.response.start", "status": 206, "headers": headers.raw})
        if send_header_only:
            await send({"type": "http.response.body", "body": b"", "more_body": False})
            return
        for start, end in ranges:
            await send(
                {
                    "type": "http.response.body",
                    "body": header_generator(start, end),
                    "more_body": True,
                }
            )
            await self._send_range(send, start, end, more_body=True)
            await send({"type": "http.response.body", "body": b"\r\n", "more_body": True})
        await send(
            {
                "type": "http.response.body",
                "body": f"--{boundary}--".encode("latin-1"),
                "more_body": False,
            }
        )
