from __future__ import annotations

import os
from pathlib import Path

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
        provider = self._runtime.ai_provider_id
        provider_text = f" / provider={provider}" if provider else ""
        yield event.plain_result(
            f"sidecar 已就绪: {self._runtime.url} | ai={self._runtime.ai_backend}{provider_text}",
        )

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
