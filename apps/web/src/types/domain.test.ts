/**
 * 运行时单测 — `types/domain.ts` 的工厂函数。
 *
 * 守护契约:`newId()` 必须产出后端 `z.uuid()` 能通过的合法 RFC 4122 v4 UUID。
 * 回归背景:旧实现优先 `crypto.randomUUID()`,但该 API 仅在 secure context
 * (HTTPS / localhost)可用 —— 独立端 docker 经 `http://<内网IP>:8787` 访问时
 * 它是 undefined,旧 fallback 产出非法格式(4 段任意长 hex),后端 z.uuid()
 * 拒 → 添加订阅 / 适配器 / 目标全部 400。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	KNOWN_PLATFORMS,
	makeEmptyConnection,
	makeEmptyTarget,
	maskWebhookUrl,
	newId,
	switchOnebotTransport,
	webhookSecretHint,
	webhookUrlPlaceholder,
} from "./domain";

/** RFC 4122 v4:版本位固定 `4`,variant 位固定 `[89ab]`。后端 z.uuid() 等价校验。 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("newId", () => {
	it("恒产出合法 RFC 4122 v4 UUID(走 crypto.getRandomValues,不依赖 secure context)", () => {
		// 多跑几轮覆盖随机位:版本 / variant 位被钉死,其余字节随机也必须始终合规。
		for (let i = 0; i < 500; i++) {
			expect(newId()).toMatch(UUID_V4_RE);
		}
	});

	it("不重复(随机性 sanity)", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 1000; i++) seen.add(newId());
		expect(seen.size).toBe(1000);
	});

	/**
	 * 核心回归守护:即使 `crypto.randomUUID` 完全不存在(= 非 secure context,
	 * docker 经 `http://<内网IP>:8787` 访问的真实形态),`newId()` 仍必须产出合法
	 * UUID。旧实现在此场景会落进 4 段任意长 hex 的非法 fallback → 后端 z.uuid()
	 * 拒 → 添加订阅 / 适配器 / 目标全 400。新实现根本不引用 `crypto.randomUUID`,
	 * 这条用例把"不依赖 secure-context-only API"这个契约钉死。
	 *
	 * `crypto.randomUUID` 是 `Crypto.prototype` 上 `configurable: true` 的方法,
	 * 可用 own-property 覆写成 undefined 模拟其缺席;finally 还原以免污染其它用例。
	 */
	it("crypto.randomUUID 缺席(非 secure context)时仍产出合法 v4 UUID", () => {
		const proto = Object.getPrototypeOf(crypto) as object;
		const original = Object.getOwnPropertyDescriptor(proto, "randomUUID");
		// own-property 覆写,遮蔽原型上的方法;模拟非 secure context 下它是 undefined。
		Object.defineProperty(crypto, "randomUUID", {
			value: undefined,
			configurable: true,
			writable: true,
		});
		try {
			expect((crypto as { randomUUID?: unknown }).randomUUID).toBeUndefined();
			for (let i = 0; i < 200; i++) {
				expect(newId()).toMatch(UUID_V4_RE);
			}
		} finally {
			// 删掉 own-property,露出原型上的原方法,还原环境。
			delete (crypto as { randomUUID?: unknown }).randomUUID;
			// 兜底:若运行时 randomUUID 本就是 crypto 实例自有属性,补回原描述符。
			if (original && !Object.getOwnPropertyDescriptor(crypto, "randomUUID")) {
				const onProto = Object.getOwnPropertyDescriptor(proto, "randomUUID");
				if (!onProto) Object.defineProperty(crypto, "randomUUID", original);
			}
		}
		// 还原后 randomUUID 必须重新可用,确认没污染后续用例。
		expect(typeof (crypto as { randomUUID?: unknown }).randomUUID).toBe("function");
	});
});

describe("webhook adapter factories", () => {
	it("makeEmptyConnection(feishu) 走 webhook 连接器并保留 headers", () => {
		const connection = makeEmptyConnection("feishu", "团队 webhook");
		expect(connection.platform).toBe("feishu");
		expect(connection.connector).toBe("webhook");
		expect(connection.config).toMatchObject({
			url: "https://example.com/hook",
			headers: {},
		});
		// provider 已经升格成 platform —— 别在 config 里留一份影子。
		expect(connection.config).not.toHaveProperty("provider");
	});

	it("KNOWN_PLATFORMS 把 webhook 那四家平铺出来,不再有一个叫 webhook 的平台", () => {
		const values = KNOWN_PLATFORMS.map((p) => p.value);
		expect(values).toEqual(["onebot", "qq-official", "feishu", "dingtalk", "wecom", "generic"]);
	});

	it("makeEmptyTarget(webhook 那族) 生成 endpoint 形态、平台跟着连接走", () => {
		const connection = makeEmptyConnection("wecom", "团队 webhook");
		const target = makeEmptyTarget(connection, "团队 webhook");
		expect(target).toMatchObject({
			connectionId: connection.id,
			kind: "endpoint",
			platform: "wecom",
			scope: "channel",
			enabled: true,
		});
		expect(target.managedBy).toBeUndefined();
	});

	it("webhook placeholder / secret hint 随平台切换", () => {
		expect(webhookUrlPlaceholder("generic")).toContain("hooks.example.com");
		expect(webhookSecretHint("generic")).toContain("x-bilibili-notify-secret");
		expect(webhookUrlPlaceholder("dingtalk")).toContain("oapi.dingtalk.com");
		expect(webhookSecretHint("dingtalk")).toContain("timestamp/sign");
		expect(webhookUrlPlaceholder("feishu")).toContain("open.feishu.cn");
		expect(webhookSecretHint("feishu")).toContain("timestamp/sign");
		expect(webhookUrlPlaceholder("wecom")).toContain("qyapi.weixin.qq.com");
		expect(webhookUrlPlaceholder("wecom")).toContain("key=");
		expect(webhookSecretHint("wecom")).toContain("不需要 Secret");
	});

	it("maskWebhookUrl 隐藏 query token 与 path token", () => {
		expect(maskWebhookUrl("https://oapi.dingtalk.com/robot/send?access_token=tok123")).toBe(
			"https://oapi.dingtalk.com/***?…",
		);
		expect(maskWebhookUrl("https://open.feishu.cn/open-apis/bot/v2/hook/token123")).toBe(
			"https://open.feishu.cn/***",
		);
		expect(maskWebhookUrl("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=wx-key")).toBe(
			"https://qyapi.weixin.qq.com/***?…",
		);
		expect(maskWebhookUrl("not a url")).toBe("已配置 webhook URL");
	});
});

describe("qq-official adapter factories", () => {
	it("KNOWN_PLATFORMS 含 qq-official", () => {
		expect(KNOWN_PLATFORMS.map((p) => p.value)).toContain("qq-official");
	});

	it("makeEmptyConnection(qq-official) 默认 public 域 + 非沙箱 + 空凭据", () => {
		const connection = makeEmptyConnection("qq-official", "QQ 官方机器人");
		expect(connection.platform).toBe("qq-official");
		if (connection.platform !== "qq-official") return;
		expect(connection.config).toEqual({
			appId: "",
			appSecret: "",
			sandbox: false,
			botType: "public",
			logReconnects: false,
		});
	});

	it("makeEmptyTarget(qq-official) 默认 group scope + 空地址", () => {
		const connection = makeEmptyConnection("qq-official", "QQ");
		const target = makeEmptyTarget(connection, "测试群");
		expect(target).toMatchObject({
			connectionId: connection.id,
			kind: "session",
			platform: "qq-official",
			scope: "group",
			enabled: true,
			address: "",
		});
	});
});

describe("switchOnebotTransport", () => {
	it("换连接方式时保留共用字段 —— 超时下限不该被悄悄打回默认", () => {
		// strict schema 逼着换 transport 要整体换 config,共用字段得一个个搬过去。
		// 漏搬哪个,主人就会遇到「明明调过、换个连接方式又变回去了」。
		const http = makeEmptyConnection("onebot", "NapCat").config as Parameters<
			typeof switchOnebotTransport
		>[0];
		const tuned = {
			...http,
			timeoutMs: 45_000,
			imageMinTimeoutMs: 0,
			forwardMinTimeoutMs: 90_000,
			retryTimes: 2,
			retryIntervalMs: 500,
		};

		for (const transport of ["ws", "ws-reverse", "http"] as const) {
			const next = switchOnebotTransport(tuned, transport);
			expect(next.transport).toBe(transport);
			expect(next.timeoutMs).toBe(45_000);
			expect(next.imageMinTimeoutMs).toBe(0);
			expect(next.forwardMinTimeoutMs).toBe(90_000);
			expect(next.retryIntervalMs).toBe(500);
		}
	});
});
