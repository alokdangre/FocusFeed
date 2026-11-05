import json
import ipaddress
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
            "_focusfeed_local_request": ipaddress.ip_address(self.client_address[0]).is_loopback,
            "rawPath": self.path.split("?", 1)[0],
            "requestContext": {"http": {"method": self.command}},
            "headers": dict(self.headers.items()),
            "body": body,
            "isBase64Encoded": False,
        }
        if event["rawPath"].startswith("/billing/"):
            from .billing import lambda_handler as billing_handler
            result = billing_handler(event, None)
        else:
            result = lambda_handler(event, None)
        payload = result.get("body", "")
        if not isinstance(payload, str):
            payload = json.dumps(payload)
        encoded = payload.encode("utf-8")

        try:
            self.send_response(result.get("statusCode", 500))
            for name, value in result.get("headers", {}).items():
                self.send_header(name, value)
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            # A cancelled/timed-out client cannot receive this response.
            self.close_connection = True
            self.log_message("Client disconnected before response was delivered (%s %s)", self.command, self.path)

    def log_message(self, message: str, *args: object) -> None:
        print("[focusfeed-api] " + (message % args))

    def log_request(self, code="-", size="-") -> None:
        # Provider return URLs may contain an email/payment query string.
        self.log_message('"%s %s" %s %s', self.command, self.path.split("?", 1)[0], code, size)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 3000), FocusFeedHandler)
    print("OwnFeed classifier API listening on http://127.0.0.1:3000")
    print("Health check: http://127.0.0.1:3000/health")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nOwnFeed classifier API stopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
