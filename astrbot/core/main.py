from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping
from inspect import isawaitable
from pathlib import Path
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register
from quart import Response, jsonify, request

if __package__:
    from .sidecar_process import (
        SidecarRuntime,
        build_astrbot_message_chain,
        build_sidecar_config,
        payload_contains_at_all,
        sanitize_sensitive_text,
        start_sidecar,
    )
else:
    from sidecar_process import (
        SidecarRuntime,
        build_astrbot_message_chain,
        build_sidecar_config,
        payload_contains_at_all,
        sanitize_sensitive_text,
        start_sidecar,
    )

PLUGIN_NAME = "astrbot_plugin_bilibili_notify"
PLUGIN_VERSION = "v0.1.0"


@register(
    PLUGIN_NAME,
    "Akokko",
    "Bilibili Notify for AstrBot via a Node sidecar",
    PLUGIN_VERSION,
)
class BilibiliNotifyPlugin(Star):
    def __init__(self, context: Context, config: Any | None = None):
        super().__init__(context)
        self._plugin_root = Path(__file__).resolve().parent
        self._startup_config = config
        self._runtime: SidecarRuntime | None = None
        self._delivery_pump_task: asyncio.Task[None] | None = None
        self._ai_pump_task: asyncio.Task[None] | None = None
        self._register_plugin_page_api(context)

    def _register_plugin_page_api(self, context: Context) -> None:
        register_web_api = getattr(context, "register_web_api", None)
        if not callable(register_web_api):
            logger.warning(
                "[bilibili-notify] AstrBot context does not expose register_web_api; Plugin Page API disabled"
            )
            return
        register_web_api(
            f"/{PLUGIN_NAME}/api/<path:path>",
            self.page_api_proxy,
            ["GET", "POST", "PATCH", "DELETE"],
            "Bilibili Notify Dashboard API proxy",
        )

    async def initialize(self):
        """启动 Node sidecar 并等待健康就绪。"""
        if self._runtime is not None:
            return
        config = build_sidecar_config(
            self._plugin_root,
            os.environ,
            version=PLUGIN_VERSION,
            startup_config=self._startup_config,
            plugin_name=getattr(self, "name", PLUGIN_NAME),
        )
        logger.info(f"[bilibili-notify] launching sidecar from {config.entrypoint}")
        self._runtime = await start_sidecar(config)
        self._delivery_pump_task = asyncio.create_task(self._run_delivery_pump())
        if self._runtime.ai_backend == "astrbot":
            self._ai_pump_task = asyncio.create_task(self._run_ai_pump())
        logger.info(f"[bilibili-notify] sidecar ready: {self._runtime.describe()}")

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("bilibili-notify", alias={"bn"})
    async def bilibili_notify(
        self,
        event: AstrMessageEvent,
        action: str = "",
        value: str = "",
    ):
        """最小运维命令入口。"""
        command = action.strip().lower()
        if command in {"", "status"}:
            yield event.plain_result(await self._status_text())
            return
        if command == "bind":
            yield event.plain_result(await self._bind_text(event, value))
            return
        if command == "login":
            yield event.plain_result(await self._login_text())
            return
        if command in {"login-status", "login_status"}:
            yield event.plain_result(await self._login_status_text())
            return
        if command == "test":
            yield event.plain_result(await self._test_text(event, value))
            return
        yield event.plain_result(_usage_text())

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("bilibili-notify-login-status")
    async def login_status(self, event: AstrMessageEvent):
        """查看 B 站登录状态。"""
        yield event.plain_result(await self._login_status_text())

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("bilibili-notify-login")
    async def login(self, event: AstrMessageEvent):
        """发起 B 站二维码登录。"""
        yield event.plain_result(await self._login_text())

    async def _status_text(self) -> str:
        if self._runtime is None:
            return "bilibili-notify sidecar 还没有启动"
        try:
            health, subscriptions = await asyncio.gather(
                self._runtime.get_health(),
                self._runtime.list_subscriptions(),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                f"[bilibili-notify] sidecar status query failed: {_sanitize_error(str(exc))}"
            )
            return f"sidecar 已就绪: {self._runtime.describe()}"
        provider = self._runtime.ai_provider_id
        provider_text = f" / provider={provider}" if provider else ""
        business_text = _format_business_snapshot(health.get("business"))
        return (
            f"sidecar 已就绪: {self._runtime.url} | ai={self._runtime.ai_backend}{provider_text}"
            f" | 订阅={len(subscriptions)}{business_text}"
        )

    async def _login_status_text(self) -> str:
        if self._runtime is None:
            return "bilibili-notify sidecar 还没有启动"
        try:
            login = await self._runtime.get_login_status()
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                f"[bilibili-notify] login status query failed: {_sanitize_error(str(exc))}"
            )
            return f"登录状态读取失败: {_sanitize_error(str(exc))}"
        return f"B 站登录状态: {_format_login_snapshot(login)}"

    async def _login_text(self) -> str:
        if self._runtime is None:
            return "bilibili-notify sidecar 还没有启动"
        try:
            login = await self._runtime.begin_login()
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                f"[bilibili-notify] login qr request failed: {_sanitize_error(str(exc))}"
            )
            return f"二维码登录启动失败: {_sanitize_error(str(exc))}"
        return f"B 站二维码登录: {_format_login_snapshot(login)}"

    async def _bind_text(self, event: AstrMessageEvent, code: str) -> str:
        if self._runtime is None:
            return "bilibili-notify sidecar 还没有启动"
        safe_code = code.strip()
        if not safe_code:
            return "用法: /bilibili-notify bind <配对码>"
        session = _extract_event_session(event)
        if session is None:
            return "绑定失败: 无法读取当前 AstrBot 会话标识"
        try:
            result = await self._runtime.confirm_pairing_code(safe_code, session)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[bilibili-notify] target bind failed: {_sanitize_error(str(exc))}")
            return f"绑定失败: {_sanitize_error(str(exc))}"
        if result is None:
            return "绑定失败: 配对码无效或已过期，请在 Dashboard 重新生成"
        target = result.get("target") if isinstance(result, dict) else {}
        target_name = target.get("name") if isinstance(target, dict) else None
        action = "新建" if result.get("created") is True else "更新"
        return f"推送目标绑定成功: {target_name or '当前会话'}（{action}）"

    async def _test_text(self, event: AstrMessageEvent, text: str) -> str:
        if self._runtime is None:
            return "bilibili-notify sidecar 还没有启动"
        session = _extract_event_session(event)
        if session is None:
            return "测试推送失败: 无法读取当前 AstrBot 会话标识"
        try:
            targets = await self._runtime.list_targets()
            target = _find_target_for_session(targets, session["unified_msg_origin"])
            if target is None:
                return "当前会话尚未绑定，请先在 Dashboard 生成配对码后执行 /bilibili-notify bind <配对码>"
            result = await self._runtime.push_test(
                str(target.get("id") or ""), text.strip() or None
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[bilibili-notify] test push failed: {_sanitize_error(str(exc))}")
            return f"测试推送失败: {_sanitize_error(str(exc))}"
        if result.get("ok") is True:
            return "测试推送已提交"
        return f"测试推送失败: {_sanitize_error(str(result.get('err') or 'unknown error'))}"

    async def page_api_proxy(self, path: str):
        """AstrBot Plugin Page 的白名单 API proxy。"""
        if self._runtime is None:
            return jsonify({"error": "sidecar_not_ready", "message": "sidecar 还没有启动"}), 503
        raw_method = request.method.upper()
        params = _query_params(request.args)
        method = _effective_proxy_method(raw_method, params)
        if method == "GET" and path == "events/stream":
            return Response(
                self._runtime.proxy_sse(path, params=params),
                content_type="text/event-stream; charset=utf-8",
            )
        json_body: Any = None
        if method in {"POST", "PATCH"}:
            json_body = await request.get_json(silent=True)
        try:
            status, payload = await self._runtime.proxy_json(
                method,
                path,
                json_body=json_body,
                params=params,
            )
        except ValueError as exc:
            return jsonify(
                {"error": "proxy_not_allowed", "message": _sanitize_error(str(exc))}
            ), 404
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                f"[bilibili-notify] Plugin Page proxy failed: {_sanitize_error(str(exc))}"
            )
            return jsonify(
                {"error": "proxy_failed", "message": "sidecar proxy request failed"}
            ), 502
        if status == 204:
            return "", 204
        return jsonify(payload if payload is not None else {}), status

    async def _run_delivery_pump(self) -> None:
        while True:
            runtime = self._runtime
            if runtime is None:
                return
            try:
                jobs = await runtime.claim_deliveries(limit=5)
                if not jobs:
                    await asyncio.sleep(1.0)
                    continue
                for job in jobs:
                    await self._handle_delivery_job(runtime, job)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    f"[bilibili-notify] delivery pump failed: {_sanitize_error(str(exc))}"
                )
                await asyncio.sleep(2.0)

    async def _handle_delivery_job(
        self,
        runtime: SidecarRuntime,
        job: Mapping[str, Any],
    ) -> None:
        delivery_id = str(job.get("deliveryId") or "")
        if not delivery_id:
            logger.warning("[bilibili-notify] received delivery job without deliveryId")
            return
        try:
            await self._send_delivery_job(job)
        except Exception as exc:  # noqa: BLE001
            await runtime.nack_delivery(delivery_id, _sanitize_error(str(exc)))
            return
        await runtime.ack_delivery(delivery_id)

    async def _send_delivery_job(self, job: Mapping[str, Any]) -> None:
        session = job.get("session")
        unified_msg_origin = ""
        if isinstance(session, dict):
            unified_msg_origin = str(session.get("unified_msg_origin") or "")
        if not unified_msg_origin:
            raise ValueError("delivery job is missing unified_msg_origin")
        payload = job.get("payload")
        if not isinstance(payload, dict):
            raise ValueError("delivery job payload must be an object")
        try:
            chain = build_astrbot_message_chain(payload)
            ok = await self.context.send_message(unified_msg_origin, chain)
            if ok is False:
                raise RuntimeError("AstrBot send_message returned false")
        except Exception:
            if not payload_contains_at_all(payload):
                raise
            fallback_chain = build_astrbot_message_chain(payload, at_all_as_text=True)
            ok = await self.context.send_message(unified_msg_origin, fallback_chain)
            if ok is False:
                raise RuntimeError("AstrBot send_message returned false after at-all fallback")

    async def _run_ai_pump(self) -> None:
        while True:
            runtime = self._runtime
            if runtime is None:
                return
            try:
                requests = await runtime.claim_ai_requests(limit=1)
                if not requests:
                    await asyncio.sleep(1.0)
                    continue
                for request_item in requests:
                    await self._handle_ai_request(runtime, request_item)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"[bilibili-notify] AI pump failed: {_sanitize_error(str(exc))}")
                await asyncio.sleep(2.0)

    async def _handle_ai_request(
        self,
        runtime: SidecarRuntime,
        request_item: Mapping[str, Any],
    ) -> None:
        request_id = str(request_item.get("requestId") or "")
        if not request_id:
            logger.warning("[bilibili-notify] received AI request without requestId")
            return
        try:
            text = await self._call_astrbot_provider(request_item)
        except Exception as exc:  # noqa: BLE001
            await runtime.fail_ai_request(request_id, _sanitize_error(str(exc)))
            return
        await runtime.respond_ai_request(request_id, text)

    async def _call_astrbot_provider(self, request_item: Mapping[str, Any]) -> str:
        prompt = _mapping_string(request_item, "prompt")
        if not prompt:
            raise RuntimeError("AI request is missing prompt")
        system_prompt = _mapping_string(request_item, "systemPrompt")
        provider_id = _mapping_string(request_item, "providerId")
        model = _mapping_string(request_item, "model")
        image_urls = _string_list(request_item.get("imageUrls"))
        temperature = request_item.get("temperature")
        kwargs: dict[str, Any] = {}
        if model:
            kwargs["model"] = model
        if isinstance(temperature, (int, float)) and not isinstance(temperature, bool):
            kwargs["temperature"] = float(temperature)
        response = await self._request_provider_completion(
            provider_id=provider_id,
            prompt=prompt,
            system_prompt=system_prompt,
            image_urls=image_urls,
            kwargs=kwargs,
        )
        text = _completion_text(response).strip()
        if not text:
            raise RuntimeError("AstrBot AI Provider 返回空内容")
        return text

    async def _request_provider_completion(
        self,
        *,
        provider_id: str,
        prompt: str,
        system_prompt: str,
        image_urls: list[str],
        kwargs: Mapping[str, Any],
    ) -> Any:
        if provider_id:
            llm_generate = getattr(self.context, "llm_generate", None)
            if callable(llm_generate):
                return await llm_generate(
                    chat_provider_id=provider_id,
                    prompt=prompt,
                    system_prompt=system_prompt,
                    image_urls=image_urls or None,
                    **dict(kwargs),
                )
            provider = await _maybe_await(_get_provider_by_id(self.context, provider_id))
            if provider is None:
                raise RuntimeError(f"AstrBot AI Provider 不可用: {provider_id}")
        else:
            provider = await _maybe_await(_get_using_provider(self.context))
            if provider is None:
                raise RuntimeError("AstrBot 默认 AI Provider 不可用")
        text_chat = getattr(provider, "text_chat", None)
        if not callable(text_chat):
            raise RuntimeError("AstrBot AI Provider 不支持 text_chat")
        return await text_chat(
            prompt=prompt,
            system_prompt=system_prompt,
            image_urls=image_urls or None,
            **dict(kwargs),
        )

    async def _stop_ai_pump(self) -> None:
        task = self._ai_pump_task
        if task is None:
            return
        self._ai_pump_task = None
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            return

    async def _stop_delivery_pump(self) -> None:
        task = self._delivery_pump_task
        if task is None:
            return
        self._delivery_pump_task = None
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            return

    async def terminate(self):
        """关闭 sidecar。"""
        await self._stop_ai_pump()
        await self._stop_delivery_pump()
        if self._runtime is None:
            return
        try:
            await self._runtime.close("plugin terminate")
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[bilibili-notify] sidecar shutdown failed: {exc}")
        finally:
            self._runtime = None


async def _maybe_await(value: Any) -> Any:
    if isawaitable(value):
        return await value
    return value


def _get_provider_by_id(context: Context, provider_id: str) -> Any:
    get_provider_by_id = getattr(context, "get_provider_by_id", None)
    if callable(get_provider_by_id):
        return get_provider_by_id(provider_id)
    provider_manager = getattr(context, "provider_manager", None)
    manager_getter = getattr(provider_manager, "get_provider_by_id", None)
    if callable(manager_getter):
        return manager_getter(provider_id)
    return None


def _get_using_provider(context: Context) -> Any:
    get_using_provider = getattr(context, "get_using_provider", None)
    if callable(get_using_provider):
        return get_using_provider()
    return None


def _completion_text(response: Any) -> str:
    if isinstance(response, str):
        return response
    text = getattr(response, "completion_text", "")
    if isinstance(text, str):
        return text
    if callable(text):
        value = text()
        return value if isinstance(value, str) else ""
    result_chain = getattr(response, "result_chain", None)
    get_plain_text = getattr(result_chain, "get_plain_text", None)
    if callable(get_plain_text):
        value = get_plain_text()
        return value if isinstance(value, str) else ""
    return ""


def _mapping_string(value: Mapping[str, Any], key: str) -> str:
    raw = value.get(key)
    return raw.strip() if isinstance(raw, str) else ""


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]


def _query_params(args: Mapping[str, Any]) -> dict[str, str]:
    params: dict[str, str] = {}
    for key in args:
        value = args.get(key)
        if value is None:
            continue
        params[str(key)] = str(value)
    return params


def _effective_proxy_method(raw_method: str, params: Mapping[str, str]) -> str:
    """AstrBot 4.25.x 的 /api/plug 只接收 GET/POST，用 POST + _method 承载资源语义。"""
    if raw_method != "POST":
        return raw_method
    override = str(params.get("_method") or "").upper()
    if override in {"PATCH", "DELETE"}:
        return override
    return raw_method


def _extract_event_session(event: AstrMessageEvent) -> dict[str, str] | None:
    unified_msg_origin = _event_string(event, "unified_msg_origin") or _event_call_string(
        event,
        "get_unified_msg_origin",
    )
    if not unified_msg_origin:
        return None
    inferred_platform, inferred_message_type, inferred_session_id = _split_unified_msg_origin(
        unified_msg_origin
    )
    session: dict[str, str] = {"unified_msg_origin": unified_msg_origin}
    platform = _first_non_empty(
        _event_string(event, "platform"),
        _event_call_string(event, "get_platform_name"),
        inferred_platform,
    )
    message_type = _first_non_empty(
        _event_string(event, "message_type"),
        _event_string(event, "messageType"),
        inferred_message_type,
    )
    session_id = _first_non_empty(
        _event_string(event, "session_id"),
        _event_string(event, "sessionId"),
        _event_call_string(event, "get_session_id"),
        inferred_session_id,
    )
    session_name = _first_non_empty(
        _event_string(event, "session_name"),
        _event_string(event, "sessionName"),
        _event_call_string(event, "get_group_name"),
        _event_call_string(event, "get_sender_name"),
    )
    if platform:
        session["platform"] = platform
    if message_type:
        session["messageType"] = message_type
    if session_id:
        session["sessionId"] = session_id
    if session_name:
        session["sessionName"] = session_name
    return session


def _find_target_for_session(
    targets: list[dict[str, Any]],
    unified_msg_origin: str,
) -> dict[str, Any] | None:
    for target in targets:
        session = target.get("session")
        if isinstance(session, dict) and session.get("unified_msg_origin") == unified_msg_origin:
            return target
    return None


def _usage_text() -> str:
    return "用法: /bilibili-notify [status|bind <配对码>|login|login-status|test [文本]]\n别名: /bn"


def _split_unified_msg_origin(value: str) -> tuple[str, str, str]:
    parts = value.split(":")
    platform = parts[0] if len(parts) >= 1 else ""
    message_type = parts[1] if len(parts) >= 2 else ""
    session_id = parts[2] if len(parts) >= 3 else ""
    return platform, message_type, session_id


def _event_string(event: AstrMessageEvent, name: str) -> str:
    value = getattr(event, name, "")
    return value.strip() if isinstance(value, str) else ""


def _event_call_string(event: AstrMessageEvent, name: str) -> str:
    func = getattr(event, name, None)
    if not callable(func):
        return ""
    try:
        value = func()
    except Exception:  # noqa: BLE001
        return ""
    return value.strip() if isinstance(value, str) else ""


def _first_non_empty(*values: str) -> str:
    for value in values:
        if value:
            return value
    return ""


def _sanitize_error(value: str) -> str:
    return sanitize_sensitive_text(value)


def _format_business_snapshot(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    events = value.get("events")
    event_text = ""
    if isinstance(events, dict) and "size" in events:
        event_text = f" | 待取事件={events['size']}"
    auth_started = value.get("authStarted")
    auth_text = ""
    if isinstance(auth_started, bool):
        auth_text = f" | auth={'已启动' if auth_started else '未启动'}"
    engines = value.get("engines")
    engine_text = ""
    if isinstance(engines, dict):
        dynamic = "开" if engines.get("dynamic") else "关"
        live = "开" if engines.get("live") else "关"
        engine_text = f" | engines=dyn:{dynamic}/live:{live}"
    return f"{event_text}{auth_text}{engine_text}"


def _format_login_snapshot(snapshot: dict[str, Any]) -> str:
    status = snapshot.get("status", "unknown")
    message = snapshot.get("msg")
    data = snapshot.get("data")
    parts = [f"status={status}"]
    if message:
        parts.append(str(message))
    if isinstance(data, str) and data:
        parts.append(data)
    return " | ".join(parts)
