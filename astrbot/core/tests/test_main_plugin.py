from __future__ import annotations

import asyncio
import importlib
import sys
import types
from pathlib import Path
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
                "imageUrls": ["https://example.invalid/a.png"],
            }
        ],
    )
    plugin = module.BilibiliNotifyPlugin(context, {})

    await plugin._handle_ai_request(runtime, runtime.ai_requests.pop(0))

    # Q4:model / temperature 交给 AstrBot provider,不再由插件透传。
    # 无 persona_manager → system_prompt 仅为任务指令。
    assert context.llm_requests == [
        {
            "chat_provider_id": "provider-1",
            "prompt": "请总结动态",
            "system_prompt": "你是总结助手",
            "image_urls": ["https://example.invalid/a.png"],
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
    }

    await plugin._handle_ai_request(runtime, request)

    assert context.llm_requests == [
        {
            "prompt": "请总结直播",
            "system_prompt": "你是总结助手",
            "image_urls": None,
        }
    ]
    assert runtime.ai_responses == [("ai-1", "默认 Provider 结果")]


@pytest.mark.asyncio
async def test_ai_pump_prepends_explicit_astrbot_persona(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = import_main_with_fake_astrbot(monkeypatch)
    context = FakeContext(
        persona_manager=FakePersonaManager(personas={"凛子": "你是傲娇的凛子"}),
    )
    runtime = FakeRuntime(
        [],
        ai_requests=[
            {
                "requestId": "ai-1",
                "providerId": "provider-1",
                "prompt": "请总结动态",
                "systemPrompt": "客观总结这条动态",
                "personaId": "凛子",
            }
        ],
    )
    plugin = module.BilibiliNotifyPlugin(context, {})

    await plugin._handle_ai_request(runtime, runtime.ai_requests.pop(0))

    # AstrBot 人格 prompt 注入到任务指令头部
    assert context.llm_requests[0]["system_prompt"] == "你是傲娇的凛子\n\n客观总结这条动态"
    assert runtime.ai_responses == [("ai-1", "AI 生成结果")]


@pytest.mark.asyncio
async def test_ai_pump_falls_back_to_default_persona_when_id_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = import_main_with_fake_astrbot(monkeypatch)
    context = FakeContext(
        persona_manager=FakePersonaManager(
            personas={"凛子": "你是傲娇的凛子"},
            default_prompt="你是温柔的默认人格",
        ),
    )
    runtime = FakeRuntime(
        [],
        ai_requests=[
            {
                "requestId": "ai-1",
                "prompt": "请总结直播",
                "systemPrompt": "客观总结这场直播",
                "personaId": "并不存在的人格",
            }
        ],
    )
    plugin = module.BilibiliNotifyPlugin(context, {})

    await plugin._handle_ai_request(runtime, runtime.ai_requests.pop(0))

    # 显式 id 未命中 → 回退 AstrBot 默认人格(providerId 空 → 默认 provider text_chat)
    assert context.llm_requests[0]["system_prompt"] == "你是温柔的默认人格\n\n客观总结这场直播"


@pytest.mark.asyncio
async def test_page_api_proxy_lists_astrbot_personas(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = import_main_with_fake_astrbot(monkeypatch)
    context = FakeContext(
        persona_manager=FakePersonaManager(personas={"凛子": "p1", "小绫": "p2"}),
    )
    plugin = module.BilibiliNotifyPlugin(context, {})
    # 即便 sidecar 在位,personas 也由 Python 本地查 persona_manager,绝不转发 sidecar
    plugin._runtime = FakeRuntime([])
    monkeypatch.setattr(module, "request", FakeRequest(method="GET", args={}, body=None))

    payload, status = await plugin.page_api_proxy("personas")

    assert status == 200
    assert payload == {
        "personas": [
            {"id": "凛子", "label": "凛子"},
            {"id": "小绫", "label": "小绫"},
        ]
    }
    assert plugin._runtime.proxy_calls == []


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


def test_post_method_override_supports_astrbot_plug_route_tunnel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = import_main_with_fake_astrbot(monkeypatch)

    assert module._effective_proxy_method("POST", {"_method": "PATCH"}) == "PATCH"
    assert module._effective_proxy_method("POST", {"_method": "DELETE"}) == "DELETE"
    assert module._effective_proxy_method("POST", {"_method": "GET"}) == "POST"
    assert module._effective_proxy_method("GET", {"_method": "DELETE"}) == "GET"


@pytest.mark.asyncio
async def test_page_api_proxy_tunnels_bridge_patch_and_delete_envelopes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = import_main_with_fake_astrbot(monkeypatch)
    runtime = FakeRuntime([])
    plugin = module.BilibiliNotifyPlugin(FakeContext(), {})
    plugin._runtime = runtime

    monkeypatch.setattr(
        module,
        "request",
        FakeRequest(
            method="POST",
            args={},
            body={
                "__bn_proxy_method": "PATCH",
                "__bn_proxy_body": {"routing": {"dynamic": ["target-1"]}},
            },
        ),
    )
    patch_payload, patch_status = await plugin.page_api_proxy("subscriptions/sub-1")

    monkeypatch.setattr(
        module,
        "request",
        FakeRequest(method="POST", args={}, body={"__bn_proxy_method": "DELETE"}),
    )
    delete_payload, delete_status = await plugin.page_api_proxy("subscriptions/sub-1")

    assert patch_status == 200
    assert patch_payload == {
        "method": "PATCH",
        "path": "subscriptions/sub-1",
        "body": {"routing": {"dynamic": ["target-1"]}},
    }
    assert (delete_payload, delete_status) == ("", 204)
    assert runtime.proxy_calls == [
        (
            "PATCH",
            "subscriptions/sub-1",
            {"routing": {"dynamic": ["target-1"]}},
            {},
        ),
        ("DELETE", "subscriptions/sub-1", None, {}),
    ]


def test_parse_sidecar_log_line_strips_prefix_and_maps_level(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = import_main_with_fake_astrbot(monkeypatch)
    parse = module._parse_sidecar_log_line
    base = "[2026-06-11T16:31:20.953Z] [astrbot-sidecar]"
    # 标准行:剥掉 [ts] [name] [level] 前缀只留消息体,级别取 token
    assert parse(f"{base} [info] [key] 主密钥加载成功", "stdout") == (
        "info",
        "[key] 主密钥加载成功",
    )
    assert parse(f"{base} [warn] careful", "stdout") == ("warn", "careful")
    assert parse(f"{base} [error] boom", "stderr") == ("error", "boom")
    assert parse(f"{base} [debug] trace", "stdout") == ("debug", "trace")
    # 不匹配的行(裸 stack / console.error)原样转发,级别按流兜底
    assert parse("raw node stack frame", "stderr") == ("error", "raw node stack frame")
    assert parse("plain stdout line", "stdout") == ("info", "plain stdout line")


def test_read_plugin_version_uses_metadata_yaml(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    module = import_main_with_fake_astrbot(monkeypatch)
    meta = tmp_path / "metadata.yaml"
    meta.write_text("name: x\nversion: v9.9.9-test\nauthor: a\n", encoding="utf-8")
    assert module._read_plugin_version(meta) == "v9.9.9-test"
    # 文件缺失 → 回退默认
    assert module._read_plugin_version(tmp_path / "nope.yaml", default="v0.0.0") == "v0.0.0"
    # 模块常量取自真实 metadata.yaml(单一来源,与插件版本保持一致)
    assert module.PLUGIN_VERSION == module._read_plugin_version()


def import_main_with_fake_astrbot(monkeypatch: pytest.MonkeyPatch):
    logger = FakeLogger()
    # types.ModuleType 实例上动态挂属性是 mock 惯用法;标 Any 避开静态检查器
    # (Pylance)对 ModuleType 未知属性的误报。运行期与 ruff 门禁均不受影响。
    api_module: Any = types.ModuleType("astrbot.api")
    api_module.logger = logger

    event_module: Any = types.ModuleType("astrbot.api.event")
    event_module.AstrMessageEvent = object
    event_module.MessageChain = FakeMessageChain
    event_module.filter = FakeFilter()

    star_module: Any = types.ModuleType("astrbot.api.star")
    star_module.Context = FakeContext
    star_module.Star = FakeStar
    star_module.register = fake_register

    components_module: Any = types.ModuleType("astrbot.api.message_components")
    components_module.Plain = FakePlain
    components_module.Image = FakeImage
    components_module.AtAll = FakeAtAll

    quart_module: Any = types.ModuleType("quart")
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


class FakeRequest:
    def __init__(self, *, method: str, args: dict[str, str], body: Any) -> None:
        self.method = method
        self.args = args
        self.body = body

    async def get_json(self, *, silent: bool = False) -> Any:
        _ = silent
        return self.body


class FakeLogger:
    def __init__(self) -> None:
        self.messages: list[tuple[str, str]] = []

    def debug(self, message: str) -> None:
        self.messages.append(("debug", message))

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


class FakePersonaManager:
    """模拟 AstrBot PersonaManager 暴露给插件的最小切面。"""

    def __init__(
        self,
        *,
        personas: dict[str, str] | None = None,
        default_prompt: str = "你是默认助手",
    ) -> None:
        self._personas = personas or {}
        self._default_prompt = default_prompt
        self.personas_v3 = [
            {"name": name, "prompt": prompt} for name, prompt in self._personas.items()
        ]

    def get_persona_v3_by_id(self, persona_id: str | None):
        if not persona_id:
            return None
        prompt = self._personas.get(persona_id)
        if prompt is None:
            return None
        return {"name": persona_id, "prompt": prompt}

    async def get_default_persona_v3(self):
        return {"name": "default", "prompt": self._default_prompt}


class FakeContext:
    def __init__(
        self,
        *,
        fail_first_at_all: bool = False,
        persona_manager: "FakePersonaManager | None" = None,
    ) -> None:
        self.sent: list[tuple[str, FakeMessageChain]] = []
        self.fail_first_at_all = fail_first_at_all
        self.registered = []
        self.llm_requests: list[dict[str, Any]] = []
        if persona_manager is not None:
            self.persona_manager = persona_manager

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
        self.proxy_calls: list[tuple[str, str, Any, dict[str, Any]]] = []
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

    async def proxy_json(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, Any] | None]:
        self.proxy_calls.append((method, path, json_body, dict(params or {})))
        if method == "DELETE":
            return 204, None
        return 200, {"method": method, "path": path, "body": json_body}

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
