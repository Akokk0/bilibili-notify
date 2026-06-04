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

from sidecar_process import SidecarConfig, SidecarRuntime, build_sidecar_config, start_sidecar


@pytest.mark.asyncio
async def test_build_sidecar_config_uses_environment_overrides(tmp_path: Path) -> None:
    config = build_sidecar_config(
        tmp_path,
        {
            "BN_NODE_BIN": "uv",
            "BN_SIDECAR_HOST": "127.0.0.1",
            "BN_SIDECAR_PORT": "19876",
            "BN_SIDECAR_READY_FILE": "state/ready.json",
            "BN_SIDECAR_LOG_FILE": "state/sidecar.log",
            "BN_SIDECAR_AI_BACKEND": "own",
            "BN_SIDECAR_AI_PROVIDER_ID": "astrbot-openai",
            "BN_SIDECAR_STARTUP_TIMEOUT_SECONDS": "12.5",
            "BN_SIDECAR_SHUTDOWN_TIMEOUT_SECONDS": "4.5",
        },
        version="v0.1.0",
    )

    expect_ready_file = tmp_path / "state" / "ready.json"
    expect_log_file = tmp_path / "state" / "sidecar.log"
    assert config.node_bin == "uv"
    assert config.host == "127.0.0.1"
    assert config.port == 19876
    assert config.ready_file == expect_ready_file
    assert config.ready_file.is_absolute()
    assert config.log_file == expect_log_file
    assert config.log_file.is_absolute()
    assert config.ai_backend == "own"
    assert config.ai_provider_id == "astrbot-openai"
    assert config.startup_timeout_seconds == 12.5
    assert config.shutdown_timeout_seconds == 4.5
    assert config.version == "v0.1.0"


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
			parser.add_argument("--host", required=True)
			parser.add_argument("--port", type=int, required=True)
			parser.add_argument("--ready-file", required=True)
			parser.add_argument("--ai-backend", required=True)
			parser.add_argument("--ai-provider-id", default="")
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

			with TCPServer((args.host, args.port), Handler) as server:
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
        version="v0.1.0",
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
    observed_env: dict[str, str] | None = None

    async def fake_create_subprocess_exec(*_args, **kwargs):
        nonlocal observed_env
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
    assert observed_env is not None
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
