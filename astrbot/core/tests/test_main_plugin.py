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


@pytest.mark.asyncio
async def test_ai_pump_calls_selected_astrbot_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = import_main_with_fake_astrbot(monkeypatch)
    context = FakeContext()
    runtime = FakeRuntime(
        [],
        ai_requests=[
            {
                "requestId": "ai-1",
                "providerId": "provider-1",
                "prompt": "请总结动态",
                "systemPrompt": "你是总结助手",
                "model": "gpt-4o-mini",
                "temperature": 0.7,
                "imageUrls": ["https://example.invalid/a.png"],
            }
        ],
    )
    plugin = module.BilibiliNotifyPlugin(context, {})

    await plugin._handle_ai_request(runtime, runtime.ai_requests.pop(0))

    assert context.llm_requests == [
        {
            "chat_provider_id": "provider-1",
            "prompt": "请总结动态",
            "system_prompt": "你是总结助手",
            "image_urls": ["https://example.invalid/a.png"],
            "model": "gpt-4o-mini",
            "temperature": 0.7,
        }
    ]
    assert runtime.ai_responses == [("ai-1", "AI 生成结果")]
    assert runtime.ai_failures == []


@pytest.mark.asyncio
async def test_ai_pump_uses_default_provider_when_provider_id_is_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = import_main_with_fake_astrbot(monkeypatch)
    context = FakeContext()
    runtime = FakeRuntime([])
    plugin = module.BilibiliNotifyPlugin(context, {})
    request = {
        "requestId": "ai-1",
        "prompt": "请总结直播",
        "systemPrompt": "你是总结助手",
        "model": "gpt-4o-mini",
    }

    await plugin._handle_ai_request(runtime, request)

    assert context.llm_requests == [
        {
            "prompt": "请总结直播",
            "system_prompt": "你是总结助手",
            "image_urls": None,
            "model": "gpt-4o-mini",
        }
    ]
    assert runtime.ai_responses == [("ai-1", "默认 Provider 结果")]


@pytest.mark.asyncio
async def test_bind_command_confirms_current_astrbot_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = import_main_with_fake_astrbot(monkeypatch)
    context = FakeContext()
    runtime = FakeRuntime([])
    plugin = module.BilibiliNotifyPlugin(context, {})
    plugin._runtime = runtime
    event = FakeEvent()

    results = [item async for item in plugin.bilibili_notify(event, "bind", "ABCD1234")]

    assert results == ["推送目标绑定成功: 测试群聊（新建）"]
    assert runtime.confirmed_pairings == [
        (
            "ABCD1234",
            {
                "unified_msg_origin": "aiocqhttp:GroupMessage:123456",
                "platform": "aiocqhttp",
                "messageType": "GroupMessage",
                "sessionId": "123456",
                "sessionName": "测试群聊",
            },
        )
    ]


@pytest.mark.asyncio
async def test_test_command_uses_bound_current_session_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = import_main_with_fake_astrbot(monkeypatch)
    context = FakeContext()
    runtime = FakeRuntime(
        [],
        targets=[
            {
                "id": "target-1",
                "session": {"unified_msg_origin": "aiocqhttp:GroupMessage:123456"},
            }
        ],
    )
    plugin = module.BilibiliNotifyPlugin(context, {})
    plugin._runtime = runtime
    event = FakeEvent()

    results = [item async for item in plugin.bilibili_notify(event, "test", "hello")]

    assert results == ["测试推送已提交"]
    assert runtime.push_tests == [("target-1", "hello")]


def test_minimal_ops_commands_are_admin_only(monkeypatch: pytest.MonkeyPatch) -> None:
    module = import_main_with_fake_astrbot(monkeypatch)

    assert module.BilibiliNotifyPlugin.bilibili_notify.permission_type == FakePermissionType.ADMIN
    assert module.BilibiliNotifyPlugin.login_status.permission_type == FakePermissionType.ADMIN
    assert module.BilibiliNotifyPlugin.login.permission_type == FakePermissionType.ADMIN


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


class FakePermissionType:
    ADMIN = "admin"


class FakeFilter:
    PermissionType = FakePermissionType

    def command(self, *_args, **_kwargs):
        def decorator(func):
            return func

        return decorator

    def permission_type(self, permission_type):
        def decorator(func):
            func.permission_type = permission_type
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
        self.llm_requests: list[dict[str, Any]] = []

    def register_web_api(self, *args) -> None:
        self.registered.append(args)

    async def llm_generate(self, **kwargs) -> "FakeLLMResponse":
        self.llm_requests.append(dict(kwargs))
        return FakeLLMResponse("AI 生成结果")

    def get_using_provider(self):
        return FakeProvider(self.llm_requests)

    async def send_message(self, unified_msg_origin: str, chain: FakeMessageChain) -> bool:
        self.sent.append((unified_msg_origin, chain))
        if self.fail_first_at_all and any(isinstance(part, FakeAtAll) for part in chain.chain):
            self.fail_first_at_all = False
            raise RuntimeError("at-all unsupported")
        return True


class FakeProvider:
    def __init__(self, requests: list[dict[str, Any]]) -> None:
        self.requests = requests

    async def text_chat(self, **kwargs) -> "FakeLLMResponse":
        self.requests.append(dict(kwargs))
        return FakeLLMResponse("默认 Provider 结果")


class FakeLLMResponse:
    def __init__(self, completion_text: str) -> None:
        self.completion_text = completion_text


class FakeEvent:
    unified_msg_origin = "aiocqhttp:GroupMessage:123456"
    session_name = "测试群聊"

    def plain_result(self, text: str) -> str:
        return text


class FakeRuntime:
    def __init__(
        self,
        jobs: list[dict[str, Any]],
        *,
        targets: list[dict[str, Any]] | None = None,
        ai_requests: list[dict[str, Any]] | None = None,
    ) -> None:
        self.jobs = jobs
        self.ai_requests = ai_requests or []
        self.targets = targets or []
        self.acks: list[str] = []
        self.nacks: list[tuple[str, str | None]] = []
        self.ai_responses: list[tuple[str, str]] = []
        self.ai_failures: list[tuple[str, str | None]] = []
        self.confirmed_pairings: list[tuple[str, dict[str, Any]]] = []
        self.push_tests: list[tuple[str, str | None]] = []
        self.acked = asyncio.Event()
        self.closed = False
        self.url = "http://127.0.0.1:19090"
        self.ai_backend = "astrbot"
        self.ai_provider_id = ""

    def describe(self) -> str:
        return "sidecar=http://127.0.0.1:19090 pid=1234 ai=astrbot"

    async def get_health(self) -> dict[str, Any]:
        return {"business": {"events": {"size": 0}, "authStarted": False}}

    async def list_subscriptions(self) -> list[dict[str, Any]]:
        return []

    async def get_login_status(self) -> dict[str, Any]:
        return {"status": 0, "msg": "未登录"}

    async def begin_login(self) -> dict[str, Any]:
        return {"status": 1, "data": "data:image/png;base64,QR"}

    async def list_targets(self) -> list[dict[str, Any]]:
        return self.targets

    async def confirm_pairing_code(
        self,
        code: str,
        session: dict[str, Any],
    ) -> dict[str, Any] | None:
        self.confirmed_pairings.append((code, dict(session)))
        return {
            "target": {
                "id": "target-1",
                "name": session.get("sessionName", "AstrBot 会话"),
                "session": session,
            },
            "created": True,
        }

    async def push_test(self, target_id: str, text: str | None = None) -> dict[str, Any]:
        self.push_tests.append((target_id, text))
        return {"ok": True}

    async def claim_ai_requests(self, limit: int = 1) -> list[dict[str, Any]]:
        _ = limit
        if self.ai_requests:
            return [self.ai_requests.pop(0)]
        await asyncio.sleep(0.01)
        return []

    async def respond_ai_request(self, request_id: str, text: str) -> dict[str, Any]:
        self.ai_responses.append((request_id, text))
        return {"requestId": request_id, "ok": True}

    async def fail_ai_request(self, request_id: str, error: str | None = None) -> dict[str, Any]:
        self.ai_failures.append((request_id, error))
        return {"requestId": request_id, "ok": False}

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
