#!/usr/bin/env python3
"""Serve Booktokki's working tree without browser caching."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parent


class NoCacheHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        # Development always returns the file body. This also avoids a stale
        # 304 when index.html changes more than once inside one timestamp tick.
        for header in ("If-Modified-Since", "If-None-Match"):
            if header in self.headers:
                del self.headers[header]
        return super().send_head()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description="Run the Booktokki local development server.")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    handler = partial(NoCacheHandler, directory=str(PROJECT_DIR))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"Booktokki: http://localhost:{args.port}/", flush=True)
    print(f"Serving: {PROJECT_DIR}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
