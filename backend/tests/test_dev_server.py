import io
import unittest
from unittest.mock import Mock, patch

from backend.dev_server import FocusFeedHandler


class ClientSocket:
    def __init__(self, failure=None, fail_at=0):
        self.failure = failure
        self.fail_at = fail_at
        self.writes = []

    def makefile(self, mode, buffering):
        return io.BytesIO(
            b"POST /classify HTTP/1.1\r\nHost: localhost\r\n"
            b"Content-Length: 2\r\n\r\n{}"
        )

    def sendall(self, data):
        if self.failure and len(self.writes) == self.fail_at:
            raise self.failure
        self.writes.append(bytes(data))


class DevServerTests(unittest.TestCase):
    def handle_request(self, client):
        with patch("backend.dev_server.lambda_handler", return_value={
            "statusCode": 200, "headers": {"content-type": "application/json"},
            "body": '{"ok": true}',
        }), patch.object(FocusFeedHandler, "log_message"):
            return FocusFeedHandler(client, ("127.0.0.1", 39794), Mock())

    def test_connected_client_receives_response(self):
        client = ClientSocket()
        self.handle_request(client)
        self.assertIn(b"200 OK\r\n", client.writes[0])
        self.assertIn(b"content-length: 12\r\n", client.writes[0])
        self.assertEqual(client.writes[1], b'{"ok": true}')

    def test_disconnected_client_closes_cleanly_during_headers_or_body(self):
        for failure in (BrokenPipeError("client left"), ConnectionResetError("client reset")):
            for fail_at in (0, 1):
                with self.subTest(error=type(failure).__name__, fail_at=fail_at):
                    client = ClientSocket(failure, fail_at)
                    handler = self.handle_request(client)
                    self.assertTrue(handler.close_connection)
                    self.assertEqual(len(client.writes), fail_at)

    def test_unrelated_write_errors_are_not_suppressed(self):
        with self.assertRaisesRegex(OSError, "unexpected write failure"):
            self.handle_request(ClientSocket(OSError("unexpected write failure")))

    def test_classifier_errors_are_not_suppressed(self):
        with patch("backend.dev_server.lambda_handler", side_effect=RuntimeError("classifier bug")):
            with self.assertRaisesRegex(RuntimeError, "classifier bug"):
                FocusFeedHandler(ClientSocket(), ("127.0.0.1", 39794), Mock())
