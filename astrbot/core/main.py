from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register

if __package__:
    from .sidecar_process import SidecarRuntime, build_sidecar_config, start_sidecar
else:
    from sidecar_process import SidecarRuntime, build_sidecar_config, start_sidecar

PLUGIN_VERSION = "v0.1.0"


@register(
    "astrbot_plugin_bilibili_notify",
    "Akokko",
    "Bilibili Notify for AstrBot via a Node sidecar",
    PLUGIN_VERSION,
)
class BilibiliNotifyPlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        self._plugin_root = Path(__file__).resolve().parent
        self._runtime: SidecarRuntime | None = None

    async def initialize(self):
        """启动 Node sidecar 并等待健康就绪。"""
        if self._runtime is not None:
            return
        config = build_sidecar_config(self._plugin_root, os.environ, version=PLUGIN_VERSION)
        logger.info(f"[bilibili-notify] launching sidecar from {config.entrypoint}")
        self._runtime = await start_sidecar(config)
        logger.info(f"[bilibili-notify] sidecar ready: {self._runtime.describe()}")

    @filter.command("bilibili-notify")
    async def status(self, event: AstrMessageEvent):
        """查看 sidecar 当前状态。"""
        if self._runtime is None:
            yield event.plain_result("bilibili-notify sidecar 还没有启动")
            return
        try:
            health, subscriptions = await asyncio.gather(
                self._runtime.get_health(),
                self._runtime.list_subscriptions(),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[bilibili-notify] sidecar status query failed: {exc}")
            yield event.plain_result(f"sidecar 已就绪: {self._runtime.describe()}")
            return
        provider = self._runtime.ai_provider_id
        provider_text = f" / provider={provider}" if provider else ""
        business_text = _format_business_snapshot(health.get("business"))
        yield event.plain_result(
            f"sidecar 已就绪: {self._runtime.url} | ai={self._runtime.ai_backend}{provider_text}"
            f" | 订阅={len(subscriptions)}{business_text}",
        )

    @filter.command("bilibili-notify-login-status")
    async def login_status(self, event: AstrMessageEvent):
        """查看 B 站登录状态。"""
        if self._runtime is None:
            yield event.plain_result("bilibili-notify sidecar 还没有启动")
            return
        try:
            login = await self._runtime.get_login_status()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[bilibili-notify] login status query failed: {exc}")
            yield event.plain_result(f"登录状态读取失败: {exc}")
            return
        yield event.plain_result(f"B 站登录状态: {_format_login_snapshot(login)}")

    @filter.command("bilibili-notify-login")
    async def login(self, event: AstrMessageEvent):
        """发起 B 站二维码登录。"""
        if self._runtime is None:
            yield event.plain_result("bilibili-notify sidecar 还没有启动")
            return
        try:
            login = await self._runtime.begin_login()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[bilibili-notify] login qr request failed: {exc}")
            yield event.plain_result(f"二维码登录启动失败: {exc}")
            return
        yield event.plain_result(f"B 站二维码登录: {_format_login_snapshot(login)}")

    async def terminate(self):
        """关闭 sidecar。"""
        if self._runtime is None:
            return
        try:
            await self._runtime.close("plugin terminate")
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[bilibili-notify] sidecar shutdown failed: {exc}")
        finally:
            self._runtime = None


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
