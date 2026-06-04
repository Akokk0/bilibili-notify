from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

import httpx

DEFAULT_STARTUP_TIMEOUT_SECONDS = 30.0
DEFAULT_SHUTDOWN_TIMEOUT_SECONDS = 5.0
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 0
DEFAULT_AI_BACKEND = "astrbot"


@dataclass(slots=True)
class SidecarConfig:
    plugin_root: Path
    node_bin: str
    entrypoint: Path
    ready_file: Path
    log_file: Path
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    startup_timeout_seconds: float = DEFAULT_STARTUP_TIMEOUT_SECONDS
    shutdown_timeout_seconds: float = DEFAULT_SHUTDOWN_TIMEOUT_SECONDS
    ai_backend: str = DEFAULT_AI_BACKEND
    ai_provider_id: str = ""
    version: str = "0.1.0"


@dataclass(slots=True)
class SidecarRuntime:
    config: SidecarConfig
    process: asyncio.subprocess.Process
    snapshot: dict[str, Any]
    log_handle: Any

    @property
    def host(self) -> str:
        return str(self.snapshot["host"])

    @property
    def port(self) -> int:
        return int(self.snapshot["port"])

    @property
    def url(self) -> str:
        return str(self.snapshot["url"])

    @property
    def ai_backend(self) -> str:
        return str(self.snapshot["aiBackend"])

    @property
    def ai_provider_id(self) -> str:
        return str(self.snapshot.get("aiProviderId", ""))

    def describe(self) -> str:
        provider = f" / provider={self.ai_provider_id}" if self.ai_provider_id else ""
        return f"sidecar={self.url} pid={self.process.pid} ai={self.ai_backend}{provider}"

    async def close(self, reason: str = "shutdown") -> None:
        _ = reason
        error: BaseException | None = None
        cleanup_error: Exception | None = None
        log_close_error: Exception | None = None
        try:
            if self.process.returncode is None:
                self.process.terminate()
                try:
                    await asyncio.wait_for(
                        self.process.wait(),
                        timeout=self.config.shutdown_timeout_seconds,
                    )
                except TimeoutError:
                    self.process.kill()
                    await self.process.wait()
        except BaseException as exc:  # noqa: BLE001
            error = exc
            if self.process.returncode is None:
                self.process.kill()
                try:
                    await self.process.wait()
                except BaseException as wait_error:  # noqa: BLE001
                    exc.add_note(f"Failed to wait for sidecar shutdown cleanup: {wait_error}")
            raise
        finally:
            try:
                _remove_ready_file_sync(self.config.ready_file)
            except Exception as exc:  # noqa: BLE001
                cleanup_error = exc
                if error is not None:
                    error.add_note(f"Failed to remove ready file during shutdown cleanup: {exc}")
            try:
                self.log_handle.close()
            except Exception as exc:  # noqa: BLE001
                log_close_error = exc
                if error is not None:
                    error.add_note(
                        f"Failed to close sidecar log handle during shutdown cleanup: {exc}"
                    )
                elif cleanup_error is not None:
                    cleanup_error.add_note(
                        f"Failed to close sidecar log handle during shutdown cleanup: {exc}",
                    )
        if cleanup_error is not None:
            raise cleanup_error
        if log_close_error is not None:
            raise log_close_error


async def start_sidecar(config: SidecarConfig) -> SidecarRuntime:
    if not config.entrypoint.exists():
        raise FileNotFoundError(
            f"Sidecar entrypoint not found: {config.entrypoint}. 请先运行构建脚本生成 AstrBot sidecar 产物。",
        )
    config.ready_file.parent.mkdir(parents=True, exist_ok=True)
    config.log_file.parent.mkdir(parents=True, exist_ok=True)
    await remove_ready_file(config.ready_file)
    log_handle = open(config.log_file, "a", encoding="utf-8", buffering=1)
    process: asyncio.subprocess.Process | None = None
    try:
        env = os.environ.copy()
        env.update(
            {
                "BN_SIDECAR_HOST": config.host,
                "BN_SIDECAR_PORT": str(config.port),
                "BN_SIDECAR_READY_FILE": str(config.ready_file),
                "BN_SIDECAR_AI_BACKEND": config.ai_backend,
                "BN_SIDECAR_AI_PROVIDER_ID": config.ai_provider_id,
                "BN_SIDECAR_PARENT_PID": str(os.getpid()),
                "BN_SIDECAR_VERSION": config.version,
            }
        )
        process = await asyncio.create_subprocess_exec(
            config.node_bin,
            str(config.entrypoint),
            "--host",
            config.host,
            "--port",
            str(config.port),
            "--ready-file",
            str(config.ready_file),
            "--ai-backend",
            config.ai_backend,
            "--ai-provider-id",
            config.ai_provider_id,
            "--version",
            config.version,
            cwd=str(config.plugin_root),
            env=env,
            stdout=log_handle,
            stderr=log_handle,
        )
        snapshot = await wait_for_ready_snapshot(config, process)
        return SidecarRuntime(
            config=config, process=process, snapshot=snapshot, log_handle=log_handle
        )
    except BaseException as exc:  # noqa: BLE001
        if process is not None:
            await _cleanup_startup_process(
                process,
                config.shutdown_timeout_seconds,
                exc,
            )
        try:
            await remove_ready_file(config.ready_file)
        except Exception as cleanup_error:  # noqa: BLE001
            exc.add_note(
                f"Failed to remove ready file during startup cleanup: {cleanup_error}",
            )
        try:
            log_handle.close()
        except Exception as close_error:  # noqa: BLE001
            exc.add_note(
                f"Failed to close sidecar log handle during startup cleanup: {close_error}",
            )
        raise


async def _cleanup_startup_process(
    process: asyncio.subprocess.Process,
    shutdown_timeout_seconds: float,
    error: BaseException,
) -> None:
    if process.returncode is not None:
        return
    try:
        process.terminate()
    except BaseException as cleanup_error:  # noqa: BLE001
        error.add_note(f"Failed to terminate sidecar during startup cleanup: {cleanup_error}")
    if process.returncode is None:
        try:
            await asyncio.wait_for(process.wait(), timeout=shutdown_timeout_seconds)
            return
        except TimeoutError:
            pass
        except BaseException as cleanup_error:  # noqa: BLE001
            error.add_note(f"Failed to wait for sidecar during startup cleanup: {cleanup_error}")
    if process.returncode is not None:
        return
    try:
        process.kill()
    except BaseException as cleanup_error:  # noqa: BLE001
        error.add_note(f"Failed to kill sidecar during startup cleanup: {cleanup_error}")
        return
    try:
        await process.wait()
    except BaseException as cleanup_error:  # noqa: BLE001
        error.add_note(f"Failed to wait for killed sidecar during startup cleanup: {cleanup_error}")


async def wait_for_ready_snapshot(
    config: SidecarConfig,
    process: asyncio.subprocess.Process,
) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + config.startup_timeout_seconds
    last_error: str | None = None
    while asyncio.get_running_loop().time() < deadline:
        if process.returncode is not None:
            raise RuntimeError(
                f"Sidecar exited before ready (code={process.returncode}). 请查看日志: {config.log_file}",
            )
        try:
            snapshot = await read_ready_snapshot(config.ready_file)
            if snapshot and await probe_health(str(snapshot["url"])):
                return snapshot
        except FileNotFoundError:
            last_error = "ready file not found"
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
        await asyncio.sleep(0.1)
    raise TimeoutError(
        f"Timed out waiting for AstrBot sidecar readiness after {config.startup_timeout_seconds:.1f}s. {last_error or ''} 请查看日志: {config.log_file}",
    )


async def probe_health(base_url: str) -> bool:
    async with httpx.AsyncClient(base_url=base_url, timeout=2.0) as client:
        response = await client.get("/api/health")
        if response.status_code != 200:
            return False
        payload = response.json()
        return payload.get("status") == "ready"


async def read_ready_snapshot(path: Path) -> dict[str, Any]:
    return await asyncio.to_thread(_read_ready_snapshot_sync, path)


async def remove_ready_file(path: Path) -> None:
    await asyncio.to_thread(_remove_ready_file_sync, path)


def build_sidecar_config(
    plugin_root: Path,
    env: Mapping[str, str] | None = None,
    version: str = "0.1.0",
) -> SidecarConfig:
    environment = dict(env or os.environ)
    sidecar_root = plugin_root / "sidecar"
    return SidecarConfig(
        plugin_root=plugin_root,
        node_bin=environment.get("BN_NODE_BIN") or "node",
        entrypoint=sidecar_root / "app" / "index.mjs",
        ready_file=_resolve_config_path(
            environment.get("BN_SIDECAR_READY_FILE"),
            base_dir=plugin_root,
            fallback=sidecar_root / "state" / "ready.json",
        ),
        log_file=_resolve_config_path(
            environment.get("BN_SIDECAR_LOG_FILE"),
            base_dir=plugin_root,
            fallback=sidecar_root / "state" / "sidecar.log",
        ),
        host=environment.get("BN_SIDECAR_HOST") or DEFAULT_HOST,
        port=_parse_int(environment.get("BN_SIDECAR_PORT"), DEFAULT_PORT),
        startup_timeout_seconds=_parse_float(
            environment.get("BN_SIDECAR_STARTUP_TIMEOUT_SECONDS"),
            DEFAULT_STARTUP_TIMEOUT_SECONDS,
        ),
        shutdown_timeout_seconds=_parse_float(
            environment.get("BN_SIDECAR_SHUTDOWN_TIMEOUT_SECONDS"),
            DEFAULT_SHUTDOWN_TIMEOUT_SECONDS,
        ),
        ai_backend=environment.get("BN_SIDECAR_AI_BACKEND") or DEFAULT_AI_BACKEND,
        ai_provider_id=environment.get("BN_SIDECAR_AI_PROVIDER_ID", ""),
        version=environment.get("BN_SIDECAR_VERSION") or version,
    )


def _resolve_config_path(
    value: str | None,
    *,
    base_dir: Path,
    fallback: Path,
) -> Path:
    if value is None or value == "":
        return fallback
    path = Path(value)
    if path.is_absolute():
        return path
    return base_dir / path


def _read_ready_snapshot_sync(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    return json.loads(text)


def _remove_ready_file_sync(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return


def _parse_int(value: str | None, fallback: int) -> int:
    if value is None or value == "":
        return fallback
    try:
        port = int(value)
    except ValueError:
        return fallback
    if port < 0 or port > 65_535:
        return fallback
    return port


def _parse_float(value: str | None, fallback: float) -> float:
    if value is None or value == "":
        return fallback
    try:
        return float(value)
    except ValueError:
        return fallback
