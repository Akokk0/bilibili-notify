from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import quote

import httpx

DEFAULT_STARTUP_TIMEOUT_SECONDS = 30.0
DEFAULT_SHUTDOWN_TIMEOUT_SECONDS = 5.0
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 0
DEFAULT_AI_BACKEND = "astrbot"
DEFAULT_LOG_LEVEL = "info"
MIN_NODE_MAJOR_VERSION = 24
PLUGIN_DATA_DIR_NAME = "plugin_data"
AT_ALL_FALLBACK_TEXT = "[全体提醒]"
EMPTY_MESSAGE_TEXT = "[空消息]"

# sidecar 子进程日志旁路回调:签名 (stream_name, line)。stream_name ∈ {"stdout","stderr"},
# line 已去掉行尾换行符。注入式设计让本模块保持与 AstrBot 解耦,便于独立测试。
LogForwarder = Callable[[str, str], None]
PROXY_ALLOWED_COLLECTION_PATHS = {
    "health",
    "meta",
    "bootstrap",
    "globals",
    "subscriptions",
    "subs",
    "subscriptions/lookup",
    "subs/lookup",
    "subscriptions/search",
    "subs/search",
    "adapters",
    "targets",
    "events",
    "events/stream",
    "login/status",
    "auth/status",
}
PROXY_ALLOWED_POST_PATHS = {
    "subscriptions",
    "subs",
    "targets",
    "targets/pairing-codes",
    "push/test",
    "login/qr",
    "auth/qr",
    "login/logout",
    "auth/logout",
    "danger/reset-globals",
    "danger/clear-subscriptions",
    "danger/clear-targets",
    "danger/clear-overrides",
}
PROXY_ALLOWED_ID_PREFIXES = {"subscriptions", "subs", "targets"}
SENSITIVE_KEY_CORE = r"token|secret|key|cookie|sessdata|bili_jct|dedeuserid"
SENSITIVE_PATTERN = re.compile(
    r"(Bearer\s+[A-Za-z0-9._~+\-/]+=*)|"
    rf"(\"\w*(?:{SENSITIVE_KEY_CORE})\w*\"\s*:\s*)\"(?:[^\"\\]|\\.)*\"|"
    rf"((?:{SENSITIVE_KEY_CORE})=([^\s;&]+))|"
    r"(https?://[^\s\"']*(?:token|secret|key|cookie)[^\s\"']*)",
    re.IGNORECASE,
)


@dataclass(slots=True)
class SidecarConfig:
    plugin_root: Path
    node_bin: str
    entrypoint: Path
    ready_file: Path
    log_file: Path
    data_dir: Path | None = None
    token: str = ""
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    startup_timeout_seconds: float = DEFAULT_STARTUP_TIMEOUT_SECONDS
    shutdown_timeout_seconds: float = DEFAULT_SHUTDOWN_TIMEOUT_SECONDS
    ai_backend: str = DEFAULT_AI_BACKEND
    ai_provider_id: str = ""
    ai_persona_id: str = ""
    chrome_path: str = ""
    log_level: str = DEFAULT_LOG_LEVEL
    version: str = "0.1.0"
    node_min_major: int = MIN_NODE_MAJOR_VERSION


@dataclass(slots=True)
class SidecarClient:
    base_url: str
    timeout_seconds: float = 5.0
    transport: httpx.AsyncBaseTransport | None = None
    token: str = ""

    async def get_health(self) -> dict[str, Any]:
        payload = await self._request_json("GET", "/api/health")
        return _ensure_mapping(payload, "health response")

    async def get_meta(self) -> dict[str, Any]:
        payload = await self._request_json("GET", "/api/meta")
        return _ensure_mapping(payload, "meta response")

    async def drain_events(self, after: int = 0) -> list[dict[str, Any]]:
        payload = await self._request_json("GET", "/api/events", params={"after": str(after)})
        return _ensure_mapping_list(payload, "events response")

    async def claim_deliveries(self, limit: int = 5) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit), 50))
        payload = await self._request_json(
            "GET",
            "/api/deliveries",
            params={"limit": str(safe_limit)},
        )
        return _ensure_mapping_list(payload, "deliveries response")

    async def claim_ai_requests(self, limit: int = 1) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit), 10))
        payload = await self._request_json(
            "GET",
            "/api/ai/requests",
            params={"limit": str(safe_limit)},
        )
        return _ensure_mapping_list(payload, "AI requests response")

    async def respond_ai_request(self, request_id: str, text: str) -> dict[str, Any]:
        payload = await self._request_json(
            "POST",
            f"/api/ai/requests/{quote(request_id, safe='')}/respond",
            json_body={"text": text},
        )
        return _ensure_mapping(payload, "AI request response receipt")

    async def fail_ai_request(self, request_id: str, error: str | None = None) -> dict[str, Any]:
        body = {"error": sanitize_sensitive_text(error)} if error else None
        payload = await self._request_json(
            "POST",
            f"/api/ai/requests/{quote(request_id, safe='')}/fail",
            json_body=body,
        )
        return _ensure_mapping(payload, "AI request failure receipt")

    async def ack_delivery(self, delivery_id: str) -> dict[str, Any]:
        payload = await self._request_json("POST", f"/api/deliveries/{delivery_id}/ack")
        return _ensure_mapping(payload, "delivery ack response")

    async def nack_delivery(self, delivery_id: str, error: str | None = None) -> dict[str, Any]:
        body = {"error": sanitize_sensitive_text(error)} if error else None
        payload = await self._request_json(
            "POST",
            f"/api/deliveries/{delivery_id}/nack",
            json_body=body,
        )
        return _ensure_mapping(payload, "delivery nack response")

    async def list_subscriptions(self) -> list[dict[str, Any]]:
        payload = await self._request_json("GET", "/api/subscriptions")
        return _ensure_mapping_list(payload, "subscriptions response")

    async def upsert_subscription(self, payload: Mapping[str, Any]) -> list[dict[str, Any]]:
        response = await self._request_json(
            "POST",
            "/api/subscriptions",
            json_body=dict(payload),
        )
        return _ensure_mapping_list(response, "subscriptions response")

    async def create_subscription(
        self,
        *,
        uid: str,
        name: str | None = None,
        enabled: bool | None = None,
        dynamic: bool | None = None,
        live: bool | None = None,
    ) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {"uid": uid}
        if name is not None:
            payload["name"] = name
        if enabled is not None:
            payload["enabled"] = enabled
        if dynamic is not None:
            payload["dynamic"] = dynamic
        if live is not None:
            payload["live"] = live
        return await self.upsert_subscription(payload)

    async def delete_subscription(self, subscription_id: str) -> bool:
        async with self._client() as client:
            response = await client.delete(f"/api/subscriptions/{subscription_id}")
        if response.status_code == 404:
            return False
        response.raise_for_status()
        return response.status_code == 204

    async def list_targets(self) -> list[dict[str, Any]]:
        payload = await self._request_json("GET", "/api/targets")
        return _ensure_mapping_list(payload, "targets response")

    async def create_pairing_code(self) -> dict[str, Any]:
        payload = await self._request_json("POST", "/api/targets/pairing-codes")
        return _ensure_mapping(payload, "target pairing response")

    async def confirm_pairing_code(
        self,
        code: str,
        session: Mapping[str, Any],
    ) -> dict[str, Any] | None:
        async with self._client() as client:
            response = await client.post(
                f"/api/targets/pairing-codes/{quote(code, safe='')}/confirm",
                json=dict(session),
            )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return _ensure_mapping(response.json(), "target pairing confirm response")

    async def push_test(self, target_id: str, text: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"targetId": target_id}
        if text:
            payload["text"] = text
        response = await self._request_json("POST", "/api/push/test", json_body=payload)
        return _ensure_mapping(response, "push test response")

    async def get_login_status(self) -> dict[str, Any]:
        payload = await self._request_json("GET", "/api/login/status")
        return _ensure_mapping(payload, "login status response")

    async def begin_login(self) -> dict[str, Any]:
        payload = await self._request_json("POST", "/api/login/qr")
        return _ensure_mapping(payload, "login qr response")

    async def proxy_json(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: Mapping[str, str] | None = None,
    ) -> tuple[int, Any]:
        api_path = build_proxy_api_path(method, path)
        request_kwargs: dict[str, Any] = {}
        if json_body is not None:
            request_kwargs["json"] = json_body
        if params is not None:
            request_kwargs["params"] = dict(params)
        async with self._client() as client:
            response = await client.request(method.upper(), api_path, **request_kwargs)
        if not response.content:
            return response.status_code, None
        try:
            return response.status_code, sanitize_proxy_payload(response.json())
        except ValueError:
            return response.status_code, {"message": sanitize_sensitive_text(response.text)}

    async def proxy_sse(
        self,
        path: str,
        *,
        params: Mapping[str, str] | None = None,
    ) -> AsyncIterator[bytes]:
        api_path = build_proxy_api_path("GET", path)
        if api_path != "/api/events/stream":
            raise ValueError("only events/stream is allowed for SSE proxy")
        async with self._client(stream=True) as client:
            try:
                async with client.stream("GET", api_path, params=dict(params or {})) as response:
                    response.raise_for_status()
                    async for chunk in response.aiter_bytes():
                        yield chunk
            except httpx.RemoteProtocolError:
                return

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: Mapping[str, str] | None = None,
    ) -> Any:
        request_kwargs: dict[str, Any] = {}
        if json_body is not None:
            request_kwargs["json"] = json_body
        if params is not None:
            request_kwargs["params"] = dict(params)
        async with self._client() as client:
            response = await client.request(method, path, **request_kwargs)
        response.raise_for_status()
        return response.json()

    def _client(self, *, stream: bool = False) -> httpx.AsyncClient:
        headers = {"authorization": f"Bearer {self.token}"} if self.token else None
        timeout: float | httpx.Timeout = self.timeout_seconds
        if stream:
            timeout = httpx.Timeout(self.timeout_seconds, read=None)
        return httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
            transport=self.transport,
            headers=headers,
        )


@dataclass(slots=True)
class SidecarRuntime:
    config: SidecarConfig
    process: asyncio.subprocess.Process
    snapshot: dict[str, Any]
    log_handle: Any
    log_pumps: list[asyncio.Task[Any]] = field(default_factory=list)

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

    @property
    def client(self) -> SidecarClient:
        return SidecarClient(self.url, token=self.config.token)

    def describe(self) -> str:
        provider = f" / provider={self.ai_provider_id}" if self.ai_provider_id else ""
        return f"sidecar={self.url} pid={self.process.pid} ai={self.ai_backend}{provider}"

    async def get_health(self) -> dict[str, Any]:
        self.snapshot = await self.client.get_health()
        return self.snapshot

    async def get_meta(self) -> dict[str, Any]:
        return await self.client.get_meta()

    async def drain_events(self, after: int = 0) -> list[dict[str, Any]]:
        return await self.client.drain_events(after)

    async def claim_deliveries(self, limit: int = 5) -> list[dict[str, Any]]:
        return await self.client.claim_deliveries(limit)

    async def claim_ai_requests(self, limit: int = 1) -> list[dict[str, Any]]:
        return await self.client.claim_ai_requests(limit)

    async def respond_ai_request(self, request_id: str, text: str) -> dict[str, Any]:
        return await self.client.respond_ai_request(request_id, text)

    async def fail_ai_request(self, request_id: str, error: str | None = None) -> dict[str, Any]:
        return await self.client.fail_ai_request(request_id, error)

    async def ack_delivery(self, delivery_id: str) -> dict[str, Any]:
        return await self.client.ack_delivery(delivery_id)

    async def nack_delivery(self, delivery_id: str, error: str | None = None) -> dict[str, Any]:
        return await self.client.nack_delivery(delivery_id, error)

    async def list_subscriptions(self) -> list[dict[str, Any]]:
        return await self.client.list_subscriptions()

    async def upsert_subscription(self, payload: Mapping[str, Any]) -> list[dict[str, Any]]:
        return await self.client.upsert_subscription(payload)

    async def create_subscription(
        self,
        *,
        uid: str,
        name: str | None = None,
        enabled: bool | None = None,
        dynamic: bool | None = None,
        live: bool | None = None,
    ) -> list[dict[str, Any]]:
        return await self.client.create_subscription(
            uid=uid,
            name=name,
            enabled=enabled,
            dynamic=dynamic,
            live=live,
        )

    async def delete_subscription(self, subscription_id: str) -> bool:
        return await self.client.delete_subscription(subscription_id)

    async def list_targets(self) -> list[dict[str, Any]]:
        return await self.client.list_targets()

    async def create_pairing_code(self) -> dict[str, Any]:
        return await self.client.create_pairing_code()

    async def confirm_pairing_code(
        self,
        code: str,
        session: Mapping[str, Any],
    ) -> dict[str, Any] | None:
        return await self.client.confirm_pairing_code(code, session)

    async def push_test(self, target_id: str, text: str | None = None) -> dict[str, Any]:
        return await self.client.push_test(target_id, text)

    async def get_login_status(self) -> dict[str, Any]:
        return await self.client.get_login_status()

    async def begin_login(self) -> dict[str, Any]:
        return await self.client.begin_login()

    async def proxy_json(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: Mapping[str, str] | None = None,
    ) -> tuple[int, Any]:
        return await self.client.proxy_json(method, path, json_body=json_body, params=params)

    def proxy_sse(
        self,
        path: str,
        *,
        params: Mapping[str, str] | None = None,
    ) -> AsyncIterator[bytes]:
        return self.client.proxy_sse(path, params=params)

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
            await _drain_log_pumps(self.log_pumps, self.config.shutdown_timeout_seconds, error)
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


async def ensure_node_runtime(config: SidecarConfig) -> None:
    """验证 Node sidecar 运行时满足首版最低版本要求。"""
    if config.node_min_major <= 0:
        return
    try:
        process = await asyncio.create_subprocess_exec(
            config.node_bin,
            "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"Node executable not found: {config.node_bin}. 请安装 Node >= {config.node_min_major} 或在插件配置中设置 nodePath。",
        ) from exc
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=5.0)
    except TimeoutError as exc:
        process.kill()
        await process.wait()
        raise RuntimeError(f"Node version check timed out: {config.node_bin}") from exc
    output = (stdout or stderr).decode("utf-8", errors="replace").strip()
    major = parse_node_major_version(output)
    if process.returncode != 0 or major is None:
        raise RuntimeError(
            f"Unable to read Node version from {config.node_bin!r}: {output or 'empty output'}",
        )
    if major < config.node_min_major:
        raise RuntimeError(
            f"Node >= {config.node_min_major} is required, but {config.node_bin!r} reported {output}. 请升级 Node 或设置 nodePath。",
        )


def parse_node_major_version(output: str) -> int | None:
    match = re.search(r"^(?:node\s+)?v(\d+)\.", output.strip())
    if not match:
        return None
    return int(match.group(1))


async def start_sidecar(
    config: SidecarConfig,
    *,
    log_forwarder: LogForwarder | None = None,
) -> SidecarRuntime:
    if not config.entrypoint.exists():
        raise FileNotFoundError(
            f"Sidecar entrypoint not found: {config.entrypoint}. 请先运行构建脚本生成 AstrBot sidecar 产物。",
        )
    await ensure_node_runtime(config)
    config.ready_file.parent.mkdir(parents=True, exist_ok=True)
    config.log_file.parent.mkdir(parents=True, exist_ok=True)
    await remove_ready_file(config.ready_file)
    log_handle = open(config.log_file, "a", encoding="utf-8", buffering=1)
    process: asyncio.subprocess.Process | None = None
    log_pumps: list[asyncio.Task[Any]] = []
    try:
        env = os.environ.copy()
        data_dir = config.data_dir or config.ready_file.parent
        env.update(
            {
                "BN_SIDECAR_PORT": str(config.port),
                "BN_SIDECAR_READY_FILE": str(config.ready_file),
                "BN_SIDECAR_DATA_DIR": str(data_dir),
                "BN_SIDECAR_AI_BACKEND": config.ai_backend,
                "BN_SIDECAR_AI_PROVIDER_ID": config.ai_provider_id,
                "BN_SIDECAR_AI_PERSONA_ID": config.ai_persona_id,
                "BN_SIDECAR_LOG_LEVEL": config.log_level,
                "BN_SIDECAR_PARENT_PID": str(os.getpid()),
                "BN_SIDECAR_VERSION": config.version,
            }
        )
        args = [
            config.node_bin,
            str(config.entrypoint),
            "--port",
            str(config.port),
            "--ready-file",
            str(config.ready_file),
            "--data-dir",
            str(data_dir),
            "--ai-backend",
            config.ai_backend,
            "--ai-provider-id",
            config.ai_provider_id,
            "--ai-persona-id",
            config.ai_persona_id,
            "--log-level",
            config.log_level,
            "--version",
            config.version,
        ]
        if config.token:
            env["BN_SIDECAR_TOKEN"] = config.token
        # chromePath 非密钥(本机浏览器路径),经 env 与 argv 双通道下发;缺省则不注入,
        # 由 Node sidecar 侧按 OS 探测。
        if config.chrome_path:
            env["BN_SIDECAR_CHROME_PATH"] = config.chrome_path
            args.extend(["--chrome-path", config.chrome_path])
        # 有 forwarder 时改用 PIPE,由 pump 协程逐行 tee(写日志文件 + 转发);无 forwarder
        # 时维持原行为,让 OS 直接把 stdout/stderr 写进日志文件,旧调用路径零改动。
        stdio_target = asyncio.subprocess.PIPE if log_forwarder is not None else log_handle
        process = await asyncio.create_subprocess_exec(
            *args,
            cwd=str(config.plugin_root),
            env=env,
            stdout=stdio_target,
            stderr=stdio_target,
        )
        if log_forwarder is not None:
            # 紧跟 spawn 启动 pump,使启动期(就绪前)的日志也能转发——这正是排查
            # 启动失败最需要看到的部分。
            log_pumps = [
                asyncio.create_task(
                    _pump_stream(process.stdout, "stdout", log_handle, log_forwarder)
                ),
                asyncio.create_task(
                    _pump_stream(process.stderr, "stderr", log_handle, log_forwarder)
                ),
            ]
        snapshot = await wait_for_ready_snapshot(config, process)
        return SidecarRuntime(
            config=config,
            process=process,
            snapshot=snapshot,
            log_handle=log_handle,
            log_pumps=log_pumps,
        )
    except BaseException as exc:  # noqa: BLE001
        if process is not None:
            await _cleanup_startup_process(
                process,
                config.shutdown_timeout_seconds,
                exc,
            )
        await _drain_log_pumps(log_pumps, config.shutdown_timeout_seconds, exc)
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


async def _pump_stream(
    stream: asyncio.StreamReader | None,
    name: str,
    log_handle: Any,
    forwarder: LogForwarder,
) -> None:
    """逐行读取 sidecar 的某个输出流,tee 到日志文件并转发给 forwarder。

    日志旁路绝不能影响 sidecar 生命周期:写文件 / 转发的异常都被吞掉;只有取消
    (CancelledError)向上传播,以便收尾阶段能干净地停掉 pump。
    """
    if stream is None:
        return
    while True:
        try:
            raw = await stream.readline()
        except ValueError:
            # 单行长度越过 StreamReader 缓冲上限;缓冲已被清空,跳过这段继续读。
            continue
        if not raw:
            break
        text = raw.decode("utf-8", errors="replace")
        try:
            log_handle.write(text)
        except Exception:  # noqa: BLE001
            pass
        line = text.rstrip("\r\n")
        if not line:
            continue
        try:
            forwarder(name, line)
        except Exception:  # noqa: BLE001
            pass


async def _drain_log_pumps(
    pumps: list[asyncio.Task[Any]],
    timeout: float,
    error: BaseException | None = None,
) -> None:
    """停掉日志 pump:先给被 EOF 唤醒的 pump 一点时间自然收尾,超时则取消。

    必须在关闭 log_handle 之前调用——pump 仍可能向其写入残余行。
    """
    if not pumps:
        return
    pending = [task for task in pumps if not task.done()]
    if pending:
        _done, still_pending = await asyncio.wait(pending, timeout=max(timeout, 0.1))
        for task in still_pending:
            task.cancel()
        if still_pending:
            await asyncio.gather(*still_pending, return_exceptions=True)
    if error is not None:
        for task in pumps:
            if task.cancelled() or not task.done():
                continue
            exc = task.exception()
            if exc is not None and not isinstance(exc, asyncio.CancelledError):
                error.add_note(f"sidecar log pump failed during cleanup: {exc}")
    pumps.clear()


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
            if snapshot and await probe_health(str(snapshot["url"]), token=config.token):
                return snapshot
        except FileNotFoundError:
            last_error = "ready file not found"
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
        await asyncio.sleep(0.1)
    raise TimeoutError(
        f"Timed out waiting for AstrBot sidecar readiness after {config.startup_timeout_seconds:.1f}s. {last_error or ''} 请查看日志: {config.log_file}",
    )


async def probe_health(base_url: str, token: str = "") -> bool:
    headers = {"authorization": f"Bearer {token}"} if token else None
    async with httpx.AsyncClient(base_url=base_url, timeout=2.0, headers=headers) as client:
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
    startup_config: Mapping[str, Any] | None = None,
    plugin_name: str = "astrbot_plugin_bilibili_notify",
) -> SidecarConfig:
    environment = dict(env or os.environ)
    native_config = dict(startup_config or {})
    sidecar_root = plugin_root / "sidecar"
    plugin_data_dir = resolve_plugin_data_dir(plugin_root, environment, plugin_name)
    data_dir = plugin_data_dir / "sidecar"
    node_bin = _config_string(native_config, "nodePath") or environment.get("BN_NODE_BIN") or "node"
    port = _parse_config_int(
        native_config.get("fixedPort"),
        _parse_int(environment.get("BN_SIDECAR_PORT"), DEFAULT_PORT),
    )
    return SidecarConfig(
        plugin_root=plugin_root,
        node_bin=node_bin,
        entrypoint=sidecar_root / "app" / "index.mjs",
        ready_file=_resolve_config_path(
            environment.get("BN_SIDECAR_READY_FILE"),
            base_dir=plugin_data_dir,
            fallback=plugin_data_dir / "runtime" / "ready.json",
        ),
        log_file=_resolve_config_path(
            environment.get("BN_SIDECAR_LOG_FILE"),
            base_dir=plugin_data_dir,
            fallback=plugin_data_dir / "logs" / "sidecar.log",
        ),
        data_dir=data_dir,
        token=environment.get("BN_SIDECAR_TOKEN") or secrets.token_urlsafe(32),
        host=DEFAULT_HOST,
        port=port,
        startup_timeout_seconds=_parse_config_float(
            native_config.get("startupTimeoutSeconds"),
            _parse_float(
                environment.get("BN_SIDECAR_STARTUP_TIMEOUT_SECONDS"),
                DEFAULT_STARTUP_TIMEOUT_SECONDS,
            ),
        ),
        shutdown_timeout_seconds=_parse_config_float(
            native_config.get("shutdownTimeoutSeconds"),
            _parse_float(
                environment.get("BN_SIDECAR_SHUTDOWN_TIMEOUT_SECONDS"),
                DEFAULT_SHUTDOWN_TIMEOUT_SECONDS,
            ),
        ),
        ai_backend=environment.get("BN_SIDECAR_AI_BACKEND") or DEFAULT_AI_BACKEND,
        ai_provider_id=_config_string(native_config, "aiProviderId")
        or environment.get("BN_SIDECAR_AI_PROVIDER_ID", ""),
        ai_persona_id=_config_string(native_config, "aiPersonaId")
        or environment.get("BN_SIDECAR_AI_PERSONA_ID", ""),
        chrome_path=_config_string(native_config, "chromePath")
        or environment.get("BN_SIDECAR_CHROME_PATH", ""),
        log_level=_parse_log_level(
            _config_string(native_config, "logLevel") or environment.get("BN_SIDECAR_LOG_LEVEL"),
            DEFAULT_LOG_LEVEL,
        ),
        version=environment.get("BN_SIDECAR_VERSION") or version,
    )


def resolve_plugin_data_dir(
    plugin_root: Path,
    env: Mapping[str, str],
    plugin_name: str,
) -> Path:
    data_root_override = env.get("ASTRBOT_DATA_PATH") or env.get("BN_ASTRBOT_DATA_PATH")
    if data_root_override:
        data_root = Path(data_root_override)
    else:
        data_root = _get_astrbot_data_root(plugin_root)
    return data_root / PLUGIN_DATA_DIR_NAME / plugin_name


def _get_astrbot_data_root(plugin_root: Path) -> Path:
    try:
        from astrbot.core.utils.astrbot_path import get_astrbot_data_path
    except Exception:  # noqa: BLE001
        return plugin_root.parent / "data"
    return Path(get_astrbot_data_path())


def _config_string(config: Mapping[str, Any], key: str) -> str:
    value = config.get(key)
    if value is None:
        return ""
    return str(value).strip()


def _parse_config_int(value: Any, fallback: int) -> int:
    if value is None or value == "":
        return fallback
    if isinstance(value, bool):
        return fallback
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    if parsed < 0 or parsed > 65_535:
        return fallback
    return parsed


def _parse_config_float(value: Any, fallback: float) -> float:
    if value is None or value == "":
        return fallback
    if isinstance(value, bool):
        return fallback
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def _parse_log_level(value: str | None, fallback: str) -> str:
    if value in {"debug", "info", "warn", "error"}:
        return value
    return fallback


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


def build_astrbot_message_chain(payload: Mapping[str, Any], *, at_all_as_text: bool = False) -> Any:
    import astrbot.api.message_components as components
    from astrbot.api.event import MessageChain

    return build_astrbot_message_chain_with(
        payload,
        MessageChain,
        components,
        at_all_as_text=at_all_as_text,
    )


def build_astrbot_message_chain_with(
    payload: Mapping[str, Any],
    message_chain_cls: Any,
    components: Any,
    *,
    at_all_as_text: bool = False,
) -> Any:
    parts: list[Any] = []
    _append_payload_parts(parts, payload, components, at_all_as_text=at_all_as_text)
    if not parts:
        _append_plain(parts, components, EMPTY_MESSAGE_TEXT)
    return message_chain_cls(chain=parts)


def payload_contains_at_all(payload: Mapping[str, Any]) -> bool:
    if payload.get("kind") != "composite":
        return False
    segments = payload.get("segments")
    if not isinstance(segments, list):
        return False
    return any(
        isinstance(segment, dict) and segment.get("type") == "at-all" for segment in segments
    )


def build_proxy_api_path(method: str, path: str) -> str:
    normalized = _normalize_proxy_path(path)
    upper_method = method.upper()
    if not _is_allowed_proxy_path(upper_method, normalized):
        raise ValueError(f"proxy path is not allowed: {upper_method} {normalized}")
    return f"/api/{normalized}"


def sanitize_proxy_payload(value: Any) -> Any:
    if isinstance(value, str):
        return sanitize_sensitive_text(value)
    if isinstance(value, list):
        return [sanitize_proxy_payload(item) for item in value]
    if isinstance(value, dict):
        return {str(key): sanitize_proxy_payload(item) for key, item in value.items()}
    return value


def sanitize_sensitive_text(value: str) -> str:
    return SENSITIVE_PATTERN.sub(_sensitive_replacement, value)


def _append_payload_parts(
    parts: list[Any],
    payload: Mapping[str, Any],
    components: Any,
    *,
    at_all_as_text: bool,
) -> None:
    kind = payload.get("kind")
    if kind == "text":
        _append_plain(parts, components, _string_value(payload.get("text")))
        return
    if kind == "image":
        _append_image(parts, components, _image_base64(payload.get("image")))
        caption = _string_value(payload.get("caption"))
        if caption:
            _append_plain(parts, components, caption)
        return
    if kind == "forward-images":
        urls = payload.get("urls")
        if isinstance(urls, list):
            for url in urls:
                _append_image_url(parts, components, _string_value(url))
        return
    if kind == "composite":
        segments = payload.get("segments")
        if isinstance(segments, list):
            for segment in segments:
                if isinstance(segment, dict):
                    _append_segment(parts, segment, components, at_all_as_text=at_all_as_text)
        return
    _append_plain(parts, components, json.dumps(payload, ensure_ascii=False, default=str))


def _append_segment(
    parts: list[Any],
    segment: Mapping[str, Any],
    components: Any,
    *,
    at_all_as_text: bool,
) -> None:
    segment_type = segment.get("type")
    if segment_type == "text":
        _append_plain(parts, components, _string_value(segment.get("text")))
        return
    if segment_type == "image":
        _append_image(parts, components, _string_value(segment.get("base64")))
        return
    if segment_type == "link":
        href = _string_value(segment.get("href"))
        title = _string_value(segment.get("title"))
        _append_plain(parts, components, f"{title}\n{href}" if title and href else title or href)
        return
    if segment_type == "at-all":
        _append_at_all(parts, components, at_all_as_text=at_all_as_text)
        return
    _append_plain(parts, components, json.dumps(segment, ensure_ascii=False, default=str))


def _append_plain(parts: list[Any], components: Any, text: str) -> None:
    if text:
        parts.append(components.Plain(text))


def _append_image(parts: list[Any], components: Any, base64_value: str) -> None:
    if not base64_value:
        _append_plain(parts, components, "[图片]")
        return
    image = getattr(components, "Image", None)
    from_base64 = getattr(image, "fromBase64", None)
    if callable(from_base64):
        parts.append(from_base64(base64_value))
    else:
        _append_plain(parts, components, "[图片]")


def _append_image_url(parts: list[Any], components: Any, url: str) -> None:
    if not url:
        return
    image = getattr(components, "Image", None)
    from_url = getattr(image, "fromURL", None)
    if callable(from_url) and url.startswith(("http://", "https://")):
        parts.append(from_url(url))
    else:
        _append_plain(parts, components, url)


def _append_at_all(parts: list[Any], components: Any, *, at_all_as_text: bool) -> None:
    if at_all_as_text:
        _append_plain(parts, components, AT_ALL_FALLBACK_TEXT)
        return
    at_all = getattr(components, "AtAll", None)
    if callable(at_all):
        parts.append(at_all())
        return
    _append_plain(parts, components, AT_ALL_FALLBACK_TEXT)


def _image_base64(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    return _string_value(value.get("base64"))


def _string_value(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _normalize_proxy_path(path: str) -> str:
    value = path.strip()
    if not value or value.startswith("/") or "://" in value or "?" in value or "#" in value:
        raise ValueError("proxy endpoint must be a relative plugin path")
    segments = [segment for segment in value.split("/") if segment]
    if not segments or any(segment in {".", ".."} for segment in segments):
        raise ValueError("proxy endpoint contains an invalid path segment")
    return "/".join(segments)


def _is_allowed_proxy_path(method: str, path: str) -> bool:
    if method == "GET":
        return path in PROXY_ALLOWED_COLLECTION_PATHS
    if method == "POST":
        return path in PROXY_ALLOWED_POST_PATHS
    if method == "PATCH":
        return path == "globals" or _matches_id_path(path)
    if method == "DELETE":
        return _matches_id_path(path)
    return False


def _matches_id_path(path: str) -> bool:
    parts = path.split("/")
    if len(parts) != 2:
        return False
    prefix, item_id = parts
    return prefix in PROXY_ALLOWED_ID_PREFIXES and bool(item_id) and item_id not in {".", ".."}


def _sensitive_replacement(match: re.Match[str]) -> str:
    text = match.group(0)
    lower_text = text.lower()
    if lower_text.startswith("bearer "):
        return "Bearer [REDACTED]"
    if text.startswith('"'):
        # JSON field form: "key": "value" -> keep the key + separator, redact value.
        prefix = match.group(2)
        return f'{prefix}"[REDACTED]"'
    if lower_text.startswith(("http://", "https://")):
        return "[REDACTED_URL]"
    key = text.split("=", 1)[0]
    return f"{key}=[REDACTED]"


def _ensure_mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TypeError(f"{label} must be a JSON object")
    return value


def _ensure_mapping_list(value: Any, label: str) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise TypeError(f"{label} must be a JSON array")
    result: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            raise TypeError(f"{label} items must be JSON objects")
        result.append(item)
    return result


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
