from __future__ import annotations

import asyncio
import importlib
import sys
import types
from typing import Any

import pytest


@pytest.mark.asyncio
async def test_delivery_pump_sends_jobs_and_closes_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    module = import_main_with_fake_astrbot(monkeypatch)
    context = FakeContext()
    runtime = FakeRuntime(
        [
            {
                "deliveryId": "delivery-1",
                "session": {"unified_msg_origin": "aiocqhttp:GroupMessage:123456"},
                "payload": {"kind": "text", "text": "hello"},
            }
        ]
    )
    plugin = module.BilibiliNotifyPlugin(context, {})
    plugin._runtime = runtime
    plugin._delivery_pump_task = asyncio.create_task(plugin._run_delivery_pump())

    await asyncio.wait_for(runtime.acked.wait(), timeout=1.0)
    await plugin.terminate()

    assert runtime.acks == ["delivery-1"]
    assert runtime.nacks == []
    assert runtime.closed is True
    assert context.sent[0][0] == "aiocqhttp:GroupMessage:123456"
    assert context.sent[0][1].chain[0].text == "hello"


@pytest.mark.asyncio
async def test_delivery_job_at_all_failure_falls_back_to_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = import_main_with_fake_astrbot(monkeypatch)
    context = FakeContext(fail_first_at_all=True)
    runtime = FakeRuntime([])
    plugin = module.BilibiliNotifyPlugin(context, {})
    job = {
        "deliveryId": "delivery-1",
        "session": {"unified_msg_origin": "aiocqhttp:GroupMessage:123456"},
        "payload": {
            "kind": "composite",
            "segments": [{"type": "at-all"}, {"type": "text", "text": "开播了"}],
        },
    }

    await plugin._handle_delivery_job(runtime, job)

    assert runtime.acks == ["delivery-1"]
    assert runtime.nacks == []
    assert isinstance(context.sent[0][1].chain[0], FakeAtAll)
    assert context.sent[1][1].chain[0].text == "[全体提醒]"
    assert context.sent[1][1].chain[1].text == "开播了"


def import_main_with_fake_astrbot(monkeypatch: pytest.MonkeyPatch):
    logger = FakeLogger()
    api_module = types.ModuleType("astrbot.api")
    api_module.logger = logger

    event_module = types.ModuleType("astrbot.api.event")
    event_module.AstrMessageEvent = object
    event_module.MessageChain = FakeMessageChain
    event_module.filter = FakeFilter()

    star_module = types.ModuleType("astrbot.api.star")
    star_module.Context = FakeContext
    star_module.Star = FakeStar
    star_module.register = fake_register

    components_module = types.ModuleType("astrbot.api.message_components")
    components_module.Plain = FakePlain
    components_module.Image = FakeImage
    components_module.AtAll = FakeAtAll

    quart_module = types.ModuleType("quart")
    quart_module.Response = FakeResponse
    quart_module.jsonify = fake_jsonify
    quart_module.request = object()

    monkeypatch.setitem(sys.modules, "astrbot", types.ModuleType("astrbot"))
    monkeypatch.setitem(sys.modules, "astrbot.api", api_module)
    monkeypatch.setitem(sys.modules, "astrbot.api.event", event_module)
    monkeypatch.setitem(sys.modules, "astrbot.api.star", star_module)
    monkeypatch.setitem(sys.modules, "astrbot.api.message_components", components_module)
    monkeypatch.setitem(sys.modules, "quart", quart_module)
    sys.modules.pop("main", None)
    return importlib.import_module("main")


class FakeResponse:
    def __init__(self, *args, **kwargs) -> None:
        self.args = args
        self.kwargs = kwargs


def fake_jsonify(value):
    return value


class FakeLogger:
    def __init__(self) -> None:
        self.messages: list[tuple[str, str]] = []

    def info(self, message: str) -> None:
        self.messages.append(("info", message))

    def warning(self, message: str) -> None:
        self.messages.append(("warning", message))

    def error(self, message: str) -> None:
        self.messages.append(("error", message))


class FakeFilter:
    def command(self, *_args, **_kwargs):
        def decorator(func):
            return func

        return decorator


class FakeStar:
    def __init__(self, context: Any) -> None:
        self.context = context


def fake_register(*_args, **_kwargs):
    def decorator(cls):
        return cls

    return decorator


class FakePlain:
    def __init__(self, text: str) -> None:
        self.text = text


class FakeImage:
    @staticmethod
    def fromBase64(value: str):
        return ("image-base64", value)

    @staticmethod
    def fromURL(value: str):
        return ("image-url", value)


class FakeAtAll:
    pass


class FakeMessageChain:
    def __init__(self, chain: list[Any]) -> None:
        self.chain = chain


class FakeContext:
    def __init__(self, *, fail_first_at_all: bool = False) -> None:
        self.sent: list[tuple[str, FakeMessageChain]] = []
        self.fail_first_at_all = fail_first_at_all
        self.registered = []

    def register_web_api(self, *args) -> None:
        self.registered.append(args)

    async def send_message(self, unified_msg_origin: str, chain: FakeMessageChain) -> bool:
        self.sent.append((unified_msg_origin, chain))
        if self.fail_first_at_all and any(isinstance(part, FakeAtAll) for part in chain.chain):
            self.fail_first_at_all = False
            raise RuntimeError("at-all unsupported")
        return True


class FakeRuntime:
    def __init__(self, jobs: list[dict[str, Any]]) -> None:
        self.jobs = jobs
        self.acks: list[str] = []
        self.nacks: list[tuple[str, str | None]] = []
        self.acked = asyncio.Event()
        self.closed = False

    async def claim_deliveries(self, limit: int = 5) -> list[dict[str, Any]]:
        _ = limit
        if self.jobs:
            return [self.jobs.pop(0)]
        await asyncio.sleep(0.01)
        return []

    async def ack_delivery(self, delivery_id: str) -> dict[str, Any]:
        self.acks.append(delivery_id)
        self.acked.set()
        return {"deliveryId": delivery_id, "ok": True}

    async def nack_delivery(self, delivery_id: str, error: str | None = None) -> dict[str, Any]:
        self.nacks.append((delivery_id, error))
        return {"deliveryId": delivery_id, "ok": False}

    async def close(self, reason: str = "shutdown") -> None:
        _ = reason
        self.closed = True
