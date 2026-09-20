import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .handler import lambda_handler


class FocusFeedHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self) -> None:
        self.dispatch()

    def do_GET(self) -> None:
        self.dispatch()

    def do_POST(self) -> None:
        self.dispatch()

    def dispatch(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length).decode("utf-8") if length else ""
        event = {
            "rawPath": self.path.split("?", 1)[0],
            "requestContext": {"http": {"method": self.command}},
            "headers": dict(self.headers.items()),
            "body": body,
            "isBase64Encoded": False,
        }
        result = lambda_handler(event, None)
        payload = result.get("body", "")
        if not isinstance(payload, str):
            payload = json.dumps(payload)
        encoded = payload.encode("utf-8")

        self.send_response(result.get("statusCode", 500))
        for name, value in result.get("headers", {}).items():
            self.send_header(name, value)
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, message: str, *args: object) -> None:
        print("[focusfeed-api] " + (message % args))


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 3000), FocusFeedHandler)
    print("FocusFeed classifier API listening on http://127.0.0.1:3000")
    print("Health check: http://127.0.0.1:3000/health")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nFocusFeed classifier API stopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
