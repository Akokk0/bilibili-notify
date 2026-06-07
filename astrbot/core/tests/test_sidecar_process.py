from __future__ import annotations

import asyncio
import json
import os
import sys
import textwrap
from pathlib import Path
from typing import cast

import httpx
import pytest

from sidecar_process import (
    AT_ALL_FALLBACK_TEXT,
    SidecarClient,
    SidecarConfig,
    SidecarRuntime,
    build_astrbot_message_chain_with,
    build_proxy_api_path,
    build_sidecar_config,
    parse_node_major_version,
    payload_contains_at_all,
    sanitize_proxy_payload,
    start_sidecar,
)


@pytest.mark.asyncio
async def test_build_sidecar_config_uses_native_config_and_fixed_plugin_data_dir(
    tmp_path: Path,
) -> None:
    data_root = tmp_path / "astrbot-data"
    config = build_sidecar_config(
        tmp_path,
        {
            "ASTRBOT_DATA_PATH": str(data_root),
            "BN_NODE_BIN": "env-node",
            "BN_SIDECAR_HOST": "0.0.0.0",
            "BN_SIDECAR_PORT": "19090",
            "BN_SIDECAR_READY_FILE": "runtime/ready.json",
            "BN_SIDECAR_LOG_FILE": "logs/sidecar.log",
            "BN_SIDECAR_AI_BACKEND": "own",
            "BN_SIDECAR_AI_PROVIDER_ID": "env-provider",
            "BN_SIDECAR_LOG_LEVEL": "warn",
            "BN_SIDECAR_TOKEN": "test-token",
            "BN_SIDECAR_STARTUP_TIMEOUT_SECONDS": "12.5",
            "BN_SIDECAR_SHUTDOWN_TIMEOUT_SECONDS": "4.5",
        },
        version="v0.1.0",
        startup_config={
            "nodePath": "configured-node",
            "fixedPort": 19876,
            "logLevel": "debug",
            "startupTimeoutSeconds": 22.5,
            "shutdownTimeoutSeconds": 6.5,
            "aiProviderId": "astrbot-openai",
        },
    )

    plugin_data_dir = data_root / "plugin_data" / "astrbot_plugin_bilibili_notify"
    assert config.node_bin == "configured-node"
    assert config.host == "127.0.0.1"
    assert config.port == 19876
    assert config.ready_file == plugin_data_dir / "runtime" / "ready.json"
    assert config.ready_file.is_absolute()
    assert config.log_file == plugin_data_dir / "logs" / "sidecar.log"
    assert config.log_file.is_absolute()
    assert config.data_dir == plugin_data_dir / "sidecar"
    assert config.token == "test-token"
    assert config.ai_backend == "own"
    assert config.ai_provider_id == "astrbot-openai"
    assert config.log_level == "debug"
    assert config.startup_timeout_seconds == 22.5
    assert config.shutdown_timeout_seconds == 6.5
    assert config.version == "v0.1.0"


def test_parse_node_major_version() -> None:
    assert parse_node_major_version("v24.1.0") == 24
    assert parse_node_major_version("node v25.0.0") == 25
    assert parse_node_major_version("Python 3.13.0") is None
    assert parse_node_major_version("") is None


@pytest.mark.asyncio
async def test_sidecar_client_calls_control_plane_endpoints() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer client-token"
        if request.method == "GET" and request.url.path == "/api/health":
            return httpx.Response(200, json={"status": "ready"})
        if request.method == "GET" and request.url.path == "/api/meta":
            return httpx.Response(200, json={"version": "v0.1.0"})
        if request.method == "GET" and request.url.path == "/api/events":
            assert request.url.params["after"] == "7"
            return httpx.Response(200, json=[{"id": 8, "type": "auth-lost"}])
        if request.method == "GET" and request.url.path == "/api/deliveries":
            assert request.url.params["limit"] == "2"
            return httpx.Response(
                200,
                json=[
                    {
                        "deliveryId": "delivery-1",
                        "targetId": "target-1",
                        "payload": {"kind": "text", "text": "hello"},
                    }
                ],
            )
        if request.method == "POST" and request.url.path == "/api/deliveries/delivery-1/ack":
            return httpx.Response(200, json={"deliveryId": "delivery-1", "ok": True})
        if request.method == "POST" and request.url.path == "/api/deliveries/delivery-1/nack":
            body = json.loads(request.content.decode("utf-8"))
            return httpx.Response(200, json={"deliveryId": "delivery-1", "error": body["error"]})
        if request.method == "GET" and request.url.path == "/api/ai/requests":
            assert request.url.params["limit"] == "1"
            return httpx.Response(
                200,
                json=[
                    {
                        "requestId": "ai-1",
                        "providerId": "provider-1",
                        "prompt": "请总结动态",
                    }
                ],
            )
        if request.method == "POST" and request.url.path == "/api/ai/requests/ai-1/respond":
            body = json.loads(request.content.decode("utf-8"))
            return httpx.Response(200, json={"requestId": "ai-1", "text": body["text"]})
        if request.method == "POST" and request.url.path == "/api/ai/requests/ai-1/fail":
            body = json.loads(request.content.decode("utf-8"))
            return httpx.Response(200, json={"requestId": "ai-1", "error": body["error"]})
        if request.method == "GET" and request.url.path == "/api/subscriptions":
            return httpx.Response(200, json=[{"id": "sub-1", "uid": "123456"}])
        if request.method == "POST" and request.url.path == "/api/subscriptions":
            body = json.loads(request.content.decode("utf-8"))
            return httpx.Response(200, json=[body])
        if request.method == "DELETE" and request.url.path == "/api/subscriptions/sub-1":
            return httpx.Response(204)
        if request.method == "DELETE" and request.url.path == "/api/subscriptions/missing":
            return httpx.Response(404, json={"error": "not_found"})
        if request.method == "GET" and request.url.path == "/api/targets":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": "target-1",
                        "session": {"unified_msg_origin": "aiocqhttp:GroupMessage:123456"},
                    }
                ],
            )
        if request.method == "POST" and request.url.path == "/api/targets/pairing-codes":
            return httpx.Response(
                200,
                json={"code": "ABCD1234", "expiresAt": "2026-06-03T00:10:00.000Z"},
            )
        if (
            request.method == "POST"
            and request.url.path == "/api/targets/pairing-codes/ABCD1234/confirm"
        ):
            body = json.loads(request.content.decode("utf-8"))
            return httpx.Response(200, json={"target": {"session": body}, "created": True})
        if (
            request.method == "POST"
            and request.url.path == "/api/targets/pairing-codes/missing/confirm"
        ):
            return httpx.Response(404, json={"error": "pairing_code_not_found"})
        if request.method == "GET" and request.url.path == "/api/login/status":
            return httpx.Response(200, json={"status": 0, "msg": "未登录"})
        if request.method == "POST" and request.url.path == "/api/login/qr":
            return httpx.Response(200, json={"status": 1, "data": "data:image/png;base64,QR"})
        if request.method == "GET" and request.url.path == "/api/bootstrap":
            assert "cookie" not in request.headers
            return httpx.Response(200, json={"globals": {}, "targets": []})
        if request.method == "PATCH" and request.url.path == "/api/globals":
            body = json.loads(request.content.decode("utf-8"))
            return httpx.Response(200, json=body)
        if request.method == "POST" and request.url.path == "/api/push/test":
            body = json.loads(request.content.decode("utf-8"))
            return httpx.Response(200, json={"ok": True, "text": body["text"]})
        if request.method == "DELETE" and request.url.path == "/api/targets/target-1":
            return httpx.Response(204)
        if request.method == "GET" and request.url.path == "/api/events/stream":
            return httpx.Response(200, content=b"event: hydrate\ndata: {}\n\n")
        return httpx.Response(404, json={"error": "not_found"})

    client = SidecarClient(
        "http://127.0.0.1:19090",
        transport=httpx.MockTransport(handler),
        token="client-token",
    )

    assert await client.get_health() == {"status": "ready"}
    assert await client.get_meta() == {"version": "v0.1.0"}
    assert await client.drain_events(after=7) == [{"id": 8, "type": "auth-lost"}]
    assert await client.claim_deliveries(limit=2) == [
        {
            "deliveryId": "delivery-1",
            "targetId": "target-1",
            "payload": {"kind": "text", "text": "hello"},
        }
    ]
    assert await client.ack_delivery("delivery-1") == {"deliveryId": "delivery-1", "ok": True}
    assert await client.nack_delivery("delivery-1", "failed token=abc") == {
        "deliveryId": "delivery-1",
        "error": "failed token=[REDACTED]",
    }
    assert await client.claim_ai_requests(limit=1) == [
        {"requestId": "ai-1", "providerId": "provider-1", "prompt": "请总结动态"}
    ]
    assert await client.respond_ai_request("ai-1", "AI 总结") == {
        "requestId": "ai-1",
        "text": "AI 总结",
    }
    assert await client.fail_ai_request("ai-1", "Bearer secret-token") == {
        "requestId": "ai-1",
        "error": "Bearer [REDACTED]",
    }
    assert await client.list_subscriptions() == [{"id": "sub-1", "uid": "123456"}]
    assert await client.create_subscription(
        uid="123456",
        name="测试 UP 主",
        dynamic=False,
        live=True,
    ) == [
        {
            "uid": "123456",
            "name": "测试 UP 主",
            "dynamic": False,
            "live": True,
        }
    ]
    assert await client.upsert_subscription({"uid": "654321"}) == [{"uid": "654321"}]
    assert await client.delete_subscription("sub-1") is True
    assert await client.delete_subscription("missing") is False
    assert await client.list_targets() == [
        {
            "id": "target-1",
            "session": {"unified_msg_origin": "aiocqhttp:GroupMessage:123456"},
        }
    ]
    assert await client.create_pairing_code() == {
        "code": "ABCD1234",
        "expiresAt": "2026-06-03T00:10:00.000Z",
    }
    assert await client.confirm_pairing_code(
        "ABCD1234",
        {"unified_msg_origin": "aiocqhttp:GroupMessage:123456"},
    ) == {
        "target": {"session": {"unified_msg_origin": "aiocqhttp:GroupMessage:123456"}},
        "created": True,
    }
    assert await client.confirm_pairing_code("missing", {"unified_msg_origin": "x"}) is None
    assert await client.push_test("target-1", "hello") == {"ok": True, "text": "hello"}
    assert await client.get_login_status() == {"status": 0, "msg": "未登录"}
    assert await client.begin_login() == {"status": 1, "data": "data:image/png;base64,QR"}
    assert await client.proxy_json("GET", "bootstrap") == (200, {"globals": {}, "targets": []})
    assert await client.proxy_json(
        "PATCH", "globals", json_body={"app": {"logLevel": "debug"}}
    ) == (
        200,
        {"app": {"logLevel": "debug"}},
    )
    assert await client.proxy_json(
        "POST",
        "push/test",
        json_body={"targetId": "target-1", "text": "hello"},
    ) == (200, {"ok": True, "text": "hello"})
    assert await client.proxy_json("DELETE", "targets/target-1") == (204, None)
    assert b"event: hydrate" in b"".join(
        [chunk async for chunk in client.proxy_sse("events/stream")]
    )


@pytest.mark.asyncio
async def test_sidecar_client_rejects_unexpected_response_shapes() -> None:
    client = SidecarClient(
        "http://127.0.0.1:19090",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={"id": 1})),
    )

    with pytest.raises(TypeError, match="events response must be a JSON array"):
        await client.drain_events()


@pytest.mark.parametrize(
    ("method", "path", "expected"),
    [
        ("GET", "globals", "/api/globals"),
        ("PATCH", "subscriptions/sub-1", "/api/subscriptions/sub-1"),
        ("POST", "targets/pairing-codes", "/api/targets/pairing-codes"),
        ("POST", "danger/clear-targets", "/api/danger/clear-targets"),
        ("DELETE", "targets/target-1", "/api/targets/target-1"),
    ],
)
def test_build_proxy_api_path_allows_only_dashboard_whitelist(
    method: str,
    path: str,
    expected: str,
) -> None:
    assert build_proxy_api_path(method, path) == expected


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/globals"),
        ("GET", "../globals"),
        ("GET", "https://example.invalid/globals"),
        ("POST", "import"),
        ("POST", "targets/pairing-codes/ABCD1234/confirm"),
        ("DELETE", "adapters/adapter-1"),
    ],
)
def test_build_proxy_api_path_rejects_unsafe_or_non_whitelisted_paths(
    method: str,
    path: str,
) -> None:
    with pytest.raises(ValueError):
        build_proxy_api_path(method, path)


def test_sanitize_proxy_payload_redacts_sensitive_error_details() -> None:
    assert sanitize_proxy_payload(
        {
            "message": "Bearer secret-token token=abc cookie=SESSDATA=oops",
            "url": "https://example.invalid/callback?token=abc",
            "upper_url": "HTTPS://example.invalid/callback?token=abc",
        }
    ) == {
        "message": "Bearer [REDACTED] token=[REDACTED] cookie=[REDACTED]",
        "url": "[REDACTED_URL]",
        "upper_url": "[REDACTED_URL]",
    }


def test_build_astrbot_message_chain_converts_rich_payload_and_at_all_fallback() -> None:
    class FakePlain:
        def __init__(self, text):
            self.text = text

    class FakeImage:
        @staticmethod
        def fromBase64(value):
            return ("image-base64", value)

        @staticmethod
        def fromURL(value):
            return ("image-url", value)

    class FakeAtAll:
        pass

    class FakeComponents:
        Plain = FakePlain
        Image = FakeImage
        AtAll = FakeAtAll

    class FakeChain:
        def __init__(self, chain):
            self.chain = chain

    payload = {
        "kind": "composite",
        "segments": [
            {"type": "at-all"},
            {"type": "text", "text": "hello"},
            {"type": "image", "base64": "aW1hZ2U="},
            {"type": "link", "title": "详情", "href": "https://example.invalid"},
        ],
    }

    chain = build_astrbot_message_chain_with(payload, FakeChain, FakeComponents)
    fallback = build_astrbot_message_chain_with(
        payload,
        FakeChain,
        FakeComponents,
        at_all_as_text=True,
    )

    assert payload_contains_at_all(payload) is True
    assert isinstance(chain.chain[0], FakeAtAll)
    assert chain.chain[1].text == "hello"
    assert chain.chain[2] == ("image-base64", "aW1hZ2U=")
    assert chain.chain[3].text == "详情\nhttps://example.invalid"
    assert fallback.chain[0].text == AT_ALL_FALLBACK_TEXT


@pytest.mark.asyncio
async def test_start_sidecar_waits_for_health_and_closes_cleanly(tmp_path: Path) -> None:
    entrypoint = tmp_path / "fake-sidecar.py"
    entrypoint.write_text(
        textwrap.dedent(
            """
			from __future__ import annotations

			import argparse
			import json
			import os
			from http.server import BaseHTTPRequestHandler
			from pathlib import Path
			from socketserver import TCPServer

			parser = argparse.ArgumentParser()
			parser.add_argument("--port", type=int, required=True)
			parser.add_argument("--ready-file", required=True)
			parser.add_argument("--data-dir", required=True)
			parser.add_argument("--ai-backend", required=True)
			parser.add_argument("--ai-provider-id", default="")
			parser.add_argument("--log-level", default="info")
			parser.add_argument("--token", default="")
			parser.add_argument("--version", required=True)
			args = parser.parse_args()

			ready_file = Path(args.ready_file)
			ready_file.parent.mkdir(parents=True, exist_ok=True)

			class Handler(BaseHTTPRequestHandler):
				def do_GET(self):
					if self.path != "/api/health":
						self.send_response(404)
						self.end_headers()
						return
					payload = json.dumps(
						{
							"status": "ready",
							"version": args.version,
							"pid": os.getpid(),
							"host": self.server.server_address[0],
							"port": self.server.server_address[1],
							"url": f"http://{self.server.server_address[0]}:{self.server.server_address[1]}",
							"startedAt": "2026-06-03T00:00:00.000Z",
							"readyAt": "2026-06-03T00:00:01.000Z",
							"aiBackend": args.ai_backend,
							"aiProviderId": args.ai_provider_id,
						}
					).encode()
					self.send_response(200)
					self.send_header("content-type", "application/json; charset=utf-8")
					self.send_header("content-length", str(len(payload)))
					self.end_headers()
					self.wfile.write(payload)

				def log_message(self, format, *args):
					return

			with TCPServer(("127.0.0.1", args.port), Handler) as server:
				ready = {
					"status": "ready",
					"version": args.version,
					"pid": os.getpid(),
					"host": server.server_address[0],
					"port": server.server_address[1],
					"url": f"http://{server.server_address[0]}:{server.server_address[1]}",
					"startedAt": "2026-06-03T00:00:00.000Z",
					"readyAt": "2026-06-03T00:00:01.000Z",
					"aiBackend": args.ai_backend,
					"aiProviderId": args.ai_provider_id,
				}
				ready_file.write_text(json.dumps(ready), encoding="utf-8")
				server.serve_forever(poll_interval=0.1)
			"""
        ),
        encoding="utf-8",
    )

    ready_file = tmp_path / "state" / "ready.json"
    log_file = tmp_path / "state" / "sidecar.log"
    config = SidecarConfig(
        plugin_root=tmp_path,
        node_bin=sys.executable,
        entrypoint=entrypoint,
        ready_file=ready_file,
        log_file=log_file,
        host="127.0.0.1",
        port=0,
        startup_timeout_seconds=10.0,
        shutdown_timeout_seconds=3.0,
        ai_backend="own",
        ai_provider_id="astrbot-openai",
        version="v0.1.0",
        node_min_major=0,
    )

    runtime = await start_sidecar(config)
    try:
        assert runtime.url.startswith("http://127.0.0.1:")
        assert runtime.ai_backend == "own"
        assert runtime.ai_provider_id == "astrbot-openai"
        assert runtime.snapshot["status"] == "ready"
        assert ready_file.exists()

        async with httpx.AsyncClient(base_url=runtime.url, timeout=2.0) as client:
            response = await client.get("/api/health")
            assert response.status_code == 200
            payload = response.json()
            assert payload["status"] == "ready"
            assert payload["aiBackend"] == "own"
            assert payload["aiProviderId"] == "astrbot-openai"
    finally:
        await runtime.close("test complete")

    assert runtime.process.returncode is not None
    assert not ready_file.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "raise_on_log_close", [False, True], ids=["normal-log-close", "failing-log-close"]
)
async def test_sidecar_runtime_close_cleans_up_when_cancelled(
    tmp_path: Path,
    raise_on_log_close: bool,
) -> None:
    ready_file = tmp_path / "state" / "ready.json"
    ready_file.parent.mkdir(parents=True, exist_ok=True)
    ready_file.write_text("{}\n", encoding="utf-8")

    class FakeProcess:
        def __init__(self) -> None:
            self.returncode = None
            self.pid = 9876
            self.terminated = False
            self.killed = False
            self.wait_calls = 0

        def terminate(self) -> None:
            self.terminated = True

        def kill(self) -> None:
            self.killed = True
            self.returncode = -9

        async def wait(self) -> int:
            self.wait_calls += 1
            if self.wait_calls == 1:
                raise asyncio.CancelledError()
            self.returncode = 0
            return 0

    class FakeLogHandle:
        def __init__(self) -> None:
            self.closed = False

        def close(self) -> None:
            self.closed = True
            if raise_on_log_close:
                raise OSError("log close failed")

    fake_process = FakeProcess()
    fake_log_handle = FakeLogHandle()
    runtime = SidecarRuntime(
        config=SidecarConfig(
            plugin_root=tmp_path,
            node_bin=sys.executable,
            entrypoint=tmp_path / "fake-sidecar.py",
            ready_file=ready_file,
            log_file=tmp_path / "state" / "sidecar.log",
            host="127.0.0.1",
            port=19090,
            startup_timeout_seconds=10.0,
            shutdown_timeout_seconds=1.0,
            ai_backend="own",
            ai_provider_id="astrbot-openai",
            version="v0.1.0",
            node_min_major=0,
        ),
        process=cast(asyncio.subprocess.Process, fake_process),
        snapshot={
            "status": "ready",
            "version": "v0.1.0",
            "pid": 9876,
            "host": "127.0.0.1",
            "port": 19090,
            "startedAt": "2026-06-03T00:00:00.000Z",
            "readyAt": "2026-06-03T00:00:01.000Z",
            "aiBackend": "own",
            "aiProviderId": "astrbot-openai",
            "url": "http://127.0.0.1:19090",
            "uptimeMs": 1_000,
        },
        log_handle=fake_log_handle,
    )

    with pytest.raises(asyncio.CancelledError) as exc_info:
        await runtime.close("cancelled")

    assert fake_process.terminated is True
    assert fake_process.killed is True
    assert fake_process.wait_calls == 2
    assert fake_log_handle.closed is True
    assert not ready_file.exists()
    if raise_on_log_close:
        notes = getattr(exc_info.value, "__notes__", [])
        assert any("Failed to close sidecar log handle" in note for note in notes)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("startup_error_type", "startup_error_args"),
    [
        (RuntimeError, ("startup failed",)),
        (asyncio.CancelledError, ()),
    ],
    ids=["runtime-error", "cancelled-error"],
)
async def test_start_sidecar_uses_configured_shutdown_timeout_on_startup_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    startup_error_type: type[BaseException],
    startup_error_args: tuple[object, ...],
) -> None:
    entrypoint = tmp_path / "fake-sidecar.py"
    entrypoint.write_text("print('unused')\n", encoding="utf-8")

    ready_file = tmp_path / "state" / "ready.json"
    log_file = tmp_path / "state" / "sidecar.log"
    config = SidecarConfig(
        plugin_root=tmp_path,
        node_bin=sys.executable,
        entrypoint=entrypoint,
        ready_file=ready_file,
        log_file=log_file,
        host="127.0.0.1",
        port=0,
        startup_timeout_seconds=10.0,
        shutdown_timeout_seconds=7.25,
        ai_backend="own",
        ai_provider_id="astrbot-openai",
        token="secret-token",
        version="v0.1.0",
        node_min_major=0,
    )

    class FakeProcess:
        def __init__(self) -> None:
            self.returncode = None
            self.pid = 4321
            self.terminated = False
            self.killed = False
            self.wait_calls = 0

        def terminate(self) -> None:
            self.terminated = True

        def kill(self) -> None:
            self.killed = True

        async def wait(self) -> int:
            self.wait_calls += 1
            self.returncode = 0
            return 0

    fake_process = FakeProcess()
    observed_timeouts: list[float] = []
    observed_args: tuple[object, ...] | None = None
    observed_env: dict[str, str] | None = None

    async def fake_create_subprocess_exec(*args, **kwargs):
        nonlocal observed_args, observed_env
        observed_args = args
        observed_env = kwargs["env"]
        return fake_process

    async def fake_wait_for_ready_snapshot(config_arg, process_arg):
        assert config_arg is config
        assert process_arg is fake_process
        ready_file.write_text(
            json.dumps({"status": "ready", "pid": fake_process.pid}),
            encoding="utf-8",
        )
        raise startup_error_type(*startup_error_args)

    async def fake_wait_for(awaitable, timeout):
        observed_timeouts.append(timeout)
        return await awaitable

    monkeypatch.setattr(
        "sidecar_process.asyncio.create_subprocess_exec", fake_create_subprocess_exec
    )
    monkeypatch.setattr("sidecar_process.wait_for_ready_snapshot", fake_wait_for_ready_snapshot)
    monkeypatch.setattr("sidecar_process.asyncio.wait_for", fake_wait_for)

    with pytest.raises(startup_error_type):
        await start_sidecar(config)

    assert observed_timeouts == [config.shutdown_timeout_seconds]
    assert observed_args is not None
    assert "secret-token" not in [str(arg) for arg in observed_args]
    assert observed_env is not None
    assert observed_env["BN_SIDECAR_TOKEN"] == "secret-token"
    assert observed_env["BN_SIDECAR_PARENT_PID"] == str(os.getpid())
    assert fake_process.terminated is True
    assert fake_process.killed is False
    assert fake_process.wait_calls == 1
    assert not ready_file.exists()


@pytest.mark.asyncio
async def test_start_sidecar_preserves_startup_error_when_log_close_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entrypoint = tmp_path / "fake-sidecar.py"
    entrypoint.write_text("print('unused')\n", encoding="utf-8")

    ready_file = tmp_path / "state" / "ready.json"
    log_file = tmp_path / "state" / "sidecar.log"
    config = SidecarConfig(
        plugin_root=tmp_path,
        node_bin=sys.executable,
        entrypoint=entrypoint,
        ready_file=ready_file,
        log_file=log_file,
        host="127.0.0.1",
        port=0,
        startup_timeout_seconds=10.0,
        shutdown_timeout_seconds=1.0,
        ai_backend="own",
        ai_provider_id="astrbot-openai",
        version="v0.1.0",
        node_min_major=0,
    )

    class FakeProcess:
        def __init__(self) -> None:
            self.returncode = None
            self.pid = 4321
            self.terminated = False
            self.wait_calls = 0

        def terminate(self) -> None:
            self.terminated = True

        def kill(self) -> None:
            raise AssertionError("kill should not be called")

        async def wait(self) -> int:
            self.wait_calls += 1
            self.returncode = 0
            return 0

    class FakeLogHandle:
        def __init__(self) -> None:
            self.closed = False

        def close(self) -> None:
            self.closed = True
            raise OSError("log close failed")

    fake_process = FakeProcess()
    fake_log_handle = FakeLogHandle()

    def fake_open(*_args, **_kwargs):
        return fake_log_handle

    async def fake_create_subprocess_exec(*_args, **_kwargs):
        return fake_process

    async def fake_wait_for_ready_snapshot(config_arg, process_arg):
        assert config_arg is config
        assert process_arg is fake_process
        ready_file.parent.mkdir(parents=True, exist_ok=True)
        ready_file.write_text(json.dumps({"status": "ready"}), encoding="utf-8")
        raise RuntimeError("startup failed")

    async def fake_wait_for(awaitable, timeout):
        assert timeout == config.shutdown_timeout_seconds
        return await awaitable

    monkeypatch.setattr("sidecar_process.open", fake_open, raising=False)
    monkeypatch.setattr(
        "sidecar_process.asyncio.create_subprocess_exec", fake_create_subprocess_exec
    )
    monkeypatch.setattr("sidecar_process.wait_for_ready_snapshot", fake_wait_for_ready_snapshot)
    monkeypatch.setattr("sidecar_process.asyncio.wait_for", fake_wait_for)

    with pytest.raises(RuntimeError, match="startup failed") as exc_info:
        await start_sidecar(config)

    assert fake_process.terminated is True
    assert fake_process.wait_calls == 1
    assert fake_log_handle.closed is True
    assert not ready_file.exists()
    notes = getattr(exc_info.value, "__notes__", [])
    assert any(
        "Failed to close sidecar log handle during startup cleanup" in note for note in notes
    )


@pytest.mark.asyncio
async def test_start_sidecar_reports_process_cleanup_errors_without_masking_startup_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entrypoint = tmp_path / "fake-sidecar.py"
    entrypoint.write_text("print('unused')\n", encoding="utf-8")

    ready_file = tmp_path / "state" / "ready.json"
    log_file = tmp_path / "state" / "sidecar.log"
    config = SidecarConfig(
        plugin_root=tmp_path,
        node_bin=sys.executable,
        entrypoint=entrypoint,
        ready_file=ready_file,
        log_file=log_file,
        host="127.0.0.1",
        port=0,
        startup_timeout_seconds=10.0,
        shutdown_timeout_seconds=1.0,
        ai_backend="own",
        ai_provider_id="astrbot-openai",
        version="v0.1.0",
        node_min_major=0,
    )

    class FakeProcess:
        def __init__(self) -> None:
            self.returncode = None
            self.pid = 4321
            self.terminated = False
            self.wait_calls = 0
            self.killed = False

        def terminate(self) -> None:
            self.terminated = True
            raise ProcessLookupError("already exited")

        def kill(self) -> None:
            self.killed = True
            self.returncode = -9

        async def wait(self) -> int:
            self.wait_calls += 1
            self.returncode = 0
            return 0

    class FakeLogHandle:
        def __init__(self) -> None:
            self.closed = False

        def close(self) -> None:
            self.closed = True

    fake_process = FakeProcess()
    fake_log_handle = FakeLogHandle()

    def fake_open(*_args, **_kwargs):
        return fake_log_handle

    async def fake_create_subprocess_exec(*_args, **_kwargs):
        return fake_process

    async def fake_wait_for_ready_snapshot(config_arg, process_arg):
        assert config_arg is config
        assert process_arg is fake_process
        ready_file.parent.mkdir(parents=True, exist_ok=True)
        ready_file.write_text(json.dumps({"status": "ready"}), encoding="utf-8")
        raise RuntimeError("startup failed")

    async def fake_wait_for(awaitable, timeout):
        assert timeout == config.shutdown_timeout_seconds
        return await awaitable

    monkeypatch.setattr("sidecar_process.open", fake_open, raising=False)
    monkeypatch.setattr(
        "sidecar_process.asyncio.create_subprocess_exec", fake_create_subprocess_exec
    )
    monkeypatch.setattr("sidecar_process.wait_for_ready_snapshot", fake_wait_for_ready_snapshot)
    monkeypatch.setattr("sidecar_process.asyncio.wait_for", fake_wait_for)

    with pytest.raises(RuntimeError, match="startup failed") as exc_info:
        await start_sidecar(config)

    assert fake_process.terminated is True
    assert fake_process.wait_calls == 1
    assert fake_process.killed is False
    assert fake_log_handle.closed is True
    assert not ready_file.exists()
    notes = getattr(exc_info.value, "__notes__", [])
    assert any("Failed to terminate sidecar during startup cleanup" in note for note in notes)
