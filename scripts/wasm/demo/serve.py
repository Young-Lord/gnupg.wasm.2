#!/usr/bin/env python3

from __future__ import annotations

import argparse
import http.server
import socketserver
from pathlib import Path


class IsolatedHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Serve GnuPG wasm demo with COOP/COEP headers"
    )
    parser.add_argument("--port", type=int, default=8080, help="Port to bind")
    parser.add_argument(
        "--host", default="127.0.0.1", help="Host interface (default: 127.0.0.1)"
    )
    parser.add_argument(
        "--root",
        default=str(Path(__file__).resolve().parents[3]),
        help="Directory to serve (default: repository root)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    root = Path(args.root).resolve()

    if not root.exists() or not root.is_dir():
        raise SystemExit(f"Invalid --root directory: {root}")

    handler = lambda *h_args, **h_kwargs: IsolatedHandler(
        *h_args, directory=str(root), **h_kwargs
    )

    class ReusableTCPServer(socketserver.TCPServer):
        allow_reuse_address = True

    with ReusableTCPServer((args.host, args.port), handler) as httpd:
        print(
            f"[wasm-demo] serving {root} on http://{args.host}:{args.port} "
            f"with COOP/COEP headers"
        )
        httpd.serve_forever()


if __name__ == "__main__":
    main()
