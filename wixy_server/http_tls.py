"""One TLS context for every outbound HTTP client in the process (decisions/00217).

httpx builds a fresh `ssl.SSLContext` for every client it constructs, and building one re-reads the
whole certificate bundle: `create_app` made five such clients (more per request in the picture
painter), which on a loaded box was most of an app's start-up cost. `shared_ssl_context()` builds
the SAME context httpx's default `verify=True` would (the `SSL_CERT_FILE` / `SSL_CERT_DIR`
overrides, else certifi's bundle) once, and every client passes it as `verify=`; certificate
checking is unchanged. An `SSLContext` is safe to share between clients and threads once
configured, and nothing here configures it after creation.
"""

from __future__ import annotations

import functools
import os
import ssl

import certifi


@functools.cache
def shared_ssl_context() -> ssl.SSLContext:
    if cert_file := os.environ.get("SSL_CERT_FILE"):
        return ssl.create_default_context(cafile=cert_file)
    if cert_dir := os.environ.get("SSL_CERT_DIR"):
        return ssl.create_default_context(capath=cert_dir)
    return ssl.create_default_context(cafile=certifi.where())
