import {
	makeEmptyConnection,
	switchOnebotTransport,
	webhookSecretHint,
	webhookUrlPlaceholder,
} from "./connection-fixtures";
/**
 * 运行时单测 — `types/domain.ts` 的工厂函数。
 *
 * 守护契约:`newId()` 必须产出后端 `z.uuid()` 能通过的合法 RFC 4122 v4 UUID。
 * 回归背景:旧实现优先 `crypto.randomUUID()`,但该 API 仅在 secure context
 * (HTTPS / localhost)可用 —— 独立端 docker 经 `http://<内网IP>:8787` 访问时
 * 它是 undefined,旧 fallback 产出非法格式(4 段任意长 hex),后端 z.uuid()
 * 拒 → 添加订阅 / 连接 / 目标全部 400。
 */

import { describe, expect, it } from "vite-plus/test";
import { snapshotFor } from "../../__tests__/platform-snapshot";
import { isEndpointConnection, makeEmptyTarget, newId } from "../domain";

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
	 * 拒 → 添加订阅 / 连接 / 目标全 400。新实现根本不引用 `crypto.randomUUID`,
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
	it("makeEmptyConnection(feishu) 走 webhook 适配器并保留 headers", () => {
		const connection = makeEmptyConnection("feishu", "团队 webhook");
		expect(connection.platform).toBe("feishu");
		expect(connection.adapterKey).toBe("webhook");
		expect(connection.settings).toMatchObject({
			url: "https://example.com/hook",
			headers: {},
		});
		// provider 已经升格成 platform —— 别在 settings 里留一份影子。
		expect(connection.settings).not.toHaveProperty("provider");
		// 平台快照由服务端按适配器的候选填,草稿里没有。
		expect(connection.platformSnapshot.targetKind).toBe("endpoint");
	});

	it("makeEmptyTarget(webhook 那族) 生成 endpoint 形态、平台跟着连接走", () => {
		const connection = {
			...makeEmptyConnection("wecom", "团队 webhook"),
			platformSnapshot: snapshotFor("wecom"),
		};
		const target = makeEmptyTarget(connection, "团队 webhook");
		expect(target).toMatchObject({
			connectionId: connection.id,
			kind: "endpoint",
			enabled: true,
		});
		expect(target.managedBy).toBeUndefined();
		// 目标不再自带平台,端点目标也没有 scope。
		expect(target).not.toHaveProperty("platform");
		expect(target).not.toHaveProperty("scope");
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
});

describe("qq-official adapter factories", () => {
	it("makeEmptyConnection(qq-official) 默认 public 域 + 非沙箱 + 空凭据", () => {
		const connection = makeEmptyConnection("qq-official", "QQ 官方机器人");
		expect(connection.platform).toBe("qq-official");
		expect(connection.adapterKey).toBe("qq-official");
		expect(connection.settings).toEqual({
			appId: "",
			appSecret: "",
			sandbox: false,
			botType: "public",
			logReconnects: false,
		});
	});

	it("makeEmptyTarget(qq-official) 默认 group scope + 空地址", () => {
		const connection = {
			...makeEmptyConnection("qq-official", "QQ"),
			platformSnapshot: snapshotFor("qq-official"),
		};
		const target = makeEmptyTarget(connection, "测试群");
		expect(target).toMatchObject({
			connectionId: connection.id,
			kind: "session",
			scope: "group",
			enabled: true,
			address: "",
		});
		expect(target).not.toHaveProperty("platform");
	});
});

describe("switchOnebotTransport", () => {
	it("换连接方式时保留共用字段 —— 超时下限不该被悄悄打回默认", () => {
		// strict schema 逼着换 transport 要整体换 settings,共用字段得一个个搬过去。
		// 漏搬哪个,主人就会遇到「明明调过、换个连接方式又变回去了」。
		const http = makeEmptyConnection("onebot", "NapCat").settings as Parameters<
			typeof switchOnebotTransport
		>[0];
		const tuned = {
			...http,
			timeoutMs: 45_000,
			imageMinTimeoutMs: 0,
			mergeForwardMinTimeoutMs: 90_000,
			maxRetries: 2,
			retryIntervalMs: 500,
		};

		for (const transport of ["ws", "ws-reverse", "http"] as const) {
			const next = switchOnebotTransport(tuned, transport);
			expect(next.transport).toBe(transport);
			expect(next.timeoutMs).toBe(45_000);
			expect(next.imageMinTimeoutMs).toBe(0);
			expect(next.mergeForwardMinTimeoutMs).toBe(90_000);
			expect(next.retryIntervalMs).toBe(500);
		}
	});
});

describe("isEndpointConnection —— 读的是连接上存的快照,不是平台名也不是适配器键", () => {
	it("快照说是 endpoint 就算:哪怕适配器键是拓展 id、平台名是面板不认得的", () => {
		const connection = {
			id: newId(),
			name: "拓展提供的单向终点",
			enabled: true,
			adapterKey: "some-extension",
			platform: "mystery-hook",
			settings: {},
			platformSnapshot: { ...snapshotFor("mystery-hook"), targetKind: "endpoint" as const },
		};
		expect(isEndpointConnection(connection)).toBe(true);
		// 同一条换成会话快照就不是了 —— 判据只在快照上。
		expect(
			isEndpointConnection({
				platformSnapshot: { ...connection.platformSnapshot, targetKind: "session" },
			}),
		).toBe(false);
	});

	it("内置那几家的快照与它们该有的一致:webhook 一族是 endpoint,OneBot / 官机不是", () => {
		for (const platform of ["feishu", "dingtalk", "wecom", "generic"]) {
			expect(isEndpointConnection({ platformSnapshot: snapshotFor(platform) })).toBe(true);
		}
		for (const platform of ["onebot", "qq-official"]) {
			expect(isEndpointConnection({ platformSnapshot: snapshotFor(platform) })).toBe(false);
		}
	});
});
