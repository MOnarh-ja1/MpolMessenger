"""Regression: live friend requests and persisted friend state.

Runs only against a temporary local SQLite database. Does not touch production users.
"""
import os
import sys
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient


def run():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        os.environ["MPOL_DATABASE_URL"] = "sqlite:///" + str(root / "friends-test.db")
        os.environ["MPOL_UPLOAD_DIR"] = str(root / "uploads")
        os.environ.pop("MPOL_REQUIRE_PERSISTENT_DB", None)
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
        from app import app, engine

        with TestClient(app) as client:
            def register(login):
                r = client.post("/api/auth/register", json={
                    "nick": login.title(), "login": login,
                    "password": "an-independent-test-password",
                })
                assert r.status_code == 200, r.text
                info = r.json()
                return info["user"]["id"], info["token"], {
                    "Authorization": "Bearer " + info["token"]
                }

            alice_id, alice_token, alice_headers = register("alice_realtime")
            bob_id, bob_token, bob_headers = register("bob_realtime")
            assert alice_id.startswith("MP") and bob_id.startswith("MP")
            assert client.get("/api/me", headers=bob_headers).json()["id"] == bob_id
            assert client.get("/api/friends/requests", headers=bob_headers).json() == []

            with client.websocket_connect("/ws") as bob_socket:
                bob_socket.send_json({"type": "auth", "token": bob_token})
                assert bob_socket.receive_json()["type"] == "authenticated"

                created = client.post("/api/friends/request", headers=alice_headers,
                                      json={"target_id": bob_id})
                assert created.status_code == 200, created.text
                assert created.json()["state"] == "pending"

                # The recipient should receive an event BEFORE reloading or signing in again.
                event = bob_socket.receive_json()
                assert event["type"] == "friend_request", event
                assert event["user"]["id"] == alice_id
                assert isinstance(event["request_id"], int)

                pending = client.get("/api/friends/requests", headers=bob_headers)
                assert pending.status_code == 200
                assert len(pending.json()) == 1
                assert pending.json()[0]["request_id"] == event["request_id"]

                accepted = client.post(
                    "/api/friends/requests/" + str(event["request_id"]),
                    headers=bob_headers, json={"accept": True}
                )
                assert accepted.status_code == 200, accepted.text
                assert bob_socket.receive_json()["type"] == "friends_changed"

            assert [x["id"] for x in client.get("/api/friends", headers=alice_headers).json()] == [bob_id]
            assert [x["id"] for x in client.get("/api/friends", headers=bob_headers).json()] == [alice_id]
            assert client.get("/api/friends/requests", headers=bob_headers).json() == []
            chat = client.post('/api/dm/' + bob_id, headers=alice_headers).json()['id']
            sent = client.post('/api/chats/' + chat + '/messages', headers=alice_headers,
                               json={'body': 'Message retained across reconnect'})
            assert sent.status_code == 200, sent.text
            message_id = sent.json()['id']
            print("PASS: friend request delivered over WebSocket without re-login; accepted friendship persisted.")
        # Windows keeps the SQLite file locked while SQLAlchemy connections remain pooled.
        engine.dispose()
        with TestClient(app) as restarted:
            assert restarted.get('/api/me', headers=bob_headers).json()['id'] == bob_id
            assert restarted.get('/api/friends', headers=bob_headers).json()[0]['id'] == alice_id
            history = restarted.get('/api/chats/' + chat + '/messages', headers=bob_headers)
            assert history.status_code == 200, history.text
            assert history.json()[0]['id'] == message_id
            assert restarted.get('/').status_code == 200
            assert restarted.get('/app.js').status_code == 200
        engine.dispose()
        print('PASS: sessions, friendship and message history survive database connection disposal and app lifespan restart; UI is served.')


if __name__ == "__main__":
    run()
