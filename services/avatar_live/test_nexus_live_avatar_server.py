from __future__ import annotations

import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from services.avatar_live import nexus_live_avatar_server as server


TOKEN = "test-gateway-token"
WORKER_TOKEN = "test-worker-token"
IDENTITY = {
    "id": "nexus-librarian",
    "revision": "test",
    "referenceSha256": server.LIBRARIAN_REFERENCE_SHA256,
    "rigRevision": "test",
}


class LiveAvatarGatewayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(server.app)
        self.env = patch.multiple(
            server,
            API_TOKEN=TOKEN,
            WORKER_URL="http://127.0.0.1:9874",
            WORKER_TOKEN=WORKER_TOKEN,
            CONTROL_URL_BASE="ws://127.0.0.1:9873",
        )
        self.env.start()
        self.sessions = patch.dict(server._sessions, {}, clear=True)
        self.sessions.start()
        self.worker_request = patch.object(server, "_worker_request")
        self.mock_worker_request = self.worker_request.start()

    def tearDown(self) -> None:
        self.worker_request.stop()
        self.sessions.stop()
        self.env.stop()
        self.client.close()

    def auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {TOKEN}", "Origin": "http://127.0.0.1:5173"}

    def test_health_stays_unavailable_without_a_worker(self) -> None:
        with patch.multiple(server, WORKER_URL="", WORKER_TOKEN=""):
            response = self.client.get("/v1/live/health", headers=self.auth())
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["available"])
        self.assertFalse(response.json()["warm"])
        self.assertEqual(response.json()["status"], "NOT_CONFIGURED")

    def test_gateway_requires_its_server_only_token(self) -> None:
        response = self.client.get("/v1/live/health")
        self.assertEqual(response.status_code, 401)

    def test_session_is_rejected_when_worker_is_not_warm(self) -> None:
        self.mock_worker_request.return_value = server.httpx.Response(
            200,
            json={"available": False, "warm": False, "mode": "batch", "reason": "not warm"},
        )
        response = self.client.post(
            "/v1/live/sessions", headers=self.auth(), json={"identity": IDENTITY}
        )
        self.assertEqual(response.status_code, 503)
        self.mock_worker_request.assert_called_once()

    def test_offer_and_close_are_forwarded_to_the_real_worker(self) -> None:
        def worker_reply(method: str, path: str, **kwargs):
            if path == "/v1/live/health":
                return server.httpx.Response(
                    200,
                    json={
                        "available": True,
                        "warm": True,
                        "mode": "persistent-neural-stream",
                        "provider": "test-worker",
                    },
                )
            if path == "/v1/live/sessions":
                return server.httpx.Response(
                    201,
                    json={
                        "sessionId": "worker-session-1",
                        "controlUrl": "ws://127.0.0.1:9874/control/worker-session-1",
                        "iceServers": [{"urls": ["stun:127.0.0.1:3478"]}],
                    },
                )
            if path.endswith("/offer"):
                self.assertEqual(kwargs["payload"], {"type": "offer", "sdp": "offer-sdp"})
                return server.httpx.Response(200, json={"type": "answer", "sdp": "answer-from-worker"})
            if method == "DELETE":
                return server.httpx.Response(200, json={"ok": True})
            self.fail(f"Unexpected worker request: {method} {path}")

        self.mock_worker_request.side_effect = worker_reply
        created = self.client.post(
            "/v1/live/sessions", headers=self.auth(), json={"identity": IDENTITY}
        )
        self.assertEqual(created.status_code, 201, created.text)
        body = created.json()
        self.assertIn("capability=", body["controlUrl"])
        self.assertEqual(body["iceServers"], [{"urls": ["stun:127.0.0.1:3478"]}])

        offered = self.client.post(
            f"/v1/live/sessions/{body['sessionId']}/offer",
            headers=self.auth(),
            json={"type": "offer", "sdp": "offer-sdp"},
        )
        self.assertEqual(offered.status_code, 200, offered.text)
        self.assertEqual(offered.json(), {"type": "answer", "sdp": "answer-from-worker"})

        closed = self.client.delete(
            f"/v1/live/sessions/{body['sessionId']}", headers=self.auth()
        )
        self.assertEqual(closed.status_code, 200)
        self.assertEqual(closed.json(), {"ok": True})

    def test_offer_is_never_echoed_as_an_answer(self) -> None:
        self.mock_worker_request.side_effect = [
            server.httpx.Response(
                200,
                json={
                    "available": True,
                    "warm": True,
                    "mode": "persistent-neural-stream",
                },
            ),
            server.httpx.Response(
                201,
                json={
                    "sessionId": "worker-session-2",
                    "controlUrl": "ws://127.0.0.1:9874/control",
                    "iceServers": [],
                },
            ),
            server.httpx.Response(200, json={"type": "offer", "sdp": "offer-sdp"}),
        ]
        created = self.client.post(
            "/v1/live/sessions", headers=self.auth(), json={"identity": IDENTITY}
        )
        session_id = created.json()["sessionId"]
        offered = self.client.post(
            f"/v1/live/sessions/{session_id}/offer",
            headers=self.auth(),
            json={"type": "offer", "sdp": "offer-sdp"},
        )
        self.assertEqual(offered.status_code, 502)
        self.assertNotEqual(offered.json().get("sdp"), "offer-sdp")

    def test_control_websocket_relays_events_with_the_session_capability(self) -> None:
        def worker_reply(method: str, path: str, **kwargs):
            if path == "/v1/live/health":
                return server.httpx.Response(
                    200,
                    json={
                        "available": True,
                        "warm": True,
                        "mode": "persistent-neural-stream",
                    },
                )
            return server.httpx.Response(
                201,
                json={
                    "sessionId": "worker-session-3",
                    "controlUrl": "ws://127.0.0.1:9874/control",
                    "iceServers": [],
                },
            )

        self.mock_worker_request.side_effect = worker_reply
        created = self.client.post(
            "/v1/live/sessions", headers=self.auth(), json={"identity": IDENTITY}
        )
        self.assertEqual(created.status_code, 201, created.text)
        control = urlsplit(created.json()["controlUrl"])

        class FakeWorkerSocket:
            def __init__(self) -> None:
                import asyncio
                self.messages: list[str] = []
                self.queue: asyncio.Queue[str] = asyncio.Queue()

            async def send(self, message: str) -> None:
                self.messages.append(message)
                await self.queue.put('{"type":"ACK"}')

            def __aiter__(self):
                return self

            async def __anext__(self) -> str:
                return await self.queue.get()

        worker_socket = FakeWorkerSocket()

        class FakeConnection:
            async def __aenter__(self):
                return worker_socket

            async def __aexit__(self, *_args):
                return False

        with patch.object(server.websockets, "connect", return_value=FakeConnection()):
            with self.client.websocket_connect(
                f"{control.path}?{control.query}",
                headers={"origin": "http://127.0.0.1:5173"},
            ) as socket:
                socket.send_text('{"type":"INTERRUPT","ptsMs":124}')
                self.assertEqual(socket.receive_text(), '{"type":"ACK"}')
        self.assertEqual(worker_socket.messages, ['{"type":"INTERRUPT","ptsMs":124}'])

    def test_control_websocket_rejects_an_invalid_capability(self) -> None:
        with self.assertRaises(WebSocketDisconnect) as raised:
            with self.client.websocket_connect(
                "/v1/live/sessions/not-a-session/control?capability=wrong",
                headers={"origin": "http://127.0.0.1:5173"},
            ):
                self.fail("Invalid control capability was accepted")
        self.assertEqual(raised.exception.code, 1008)


if __name__ == "__main__":
    unittest.main()
