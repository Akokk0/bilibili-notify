import { describe, expect, it } from "vite-plus/test";
import { OnebotConnectionSettingsSchema } from "../onebot-settings.js";
import { WEBHOOK_PLATFORMS } from "../platform-descriptors.js";
import { QQOfficialConnectionSettingsSchema } from "../qq-official-settings.js";
import { WebhookConnectionSettingsSchema } from "../webhook-settings.js";

describe("WebhookConnectionSettingsSchema", () => {
	it("accepts a valid webhook settings and defaults headers to empty", () => {
		const r = WebhookConnectionSettingsSchema.safeParse({ url: "https://example.com/hook" });
		expect(r.success).toBe(true);
		expect(r.data?.headers).toEqual({});
	});

	it.each(WEBHOOK_PLATFORMS)("the %s webhook platform shares the same settings shape", () => {
		const r = WebhookConnectionSettingsSchema.safeParse({
			url: "https://example.com/hook",
			secret: "secret",
		});
		expect(r.success).toBe(true);
	});

	it("rejects an onebot-shaped settings (缺 url)", () => {
		expect(WebhookConnectionSettingsSchema.safeParse({ baseUrl: "http://x" }).success).toBe(false);
	});
});

describe("OnebotConnectionSettingsSchema (transport discriminatedUnion)", () => {
	// --- 迁移(40)把没写 transport 的旧条目写成显式值;schema 不再替旧数据兜底 ---
	it("transport 必填:没写 transport 的 settings → 失败(不再默认当 http)", () => {
		const r = OnebotConnectionSettingsSchema.safeParse({
			baseUrl: "http://localhost:5700",
			accessToken: "secret",
		});
		expect(r.success).toBe(false);
	});

	it("http 缺省字段补 default(protocolVersion / headers / timeoutMs / retry)", () => {
		const r = OnebotConnectionSettingsSchema.safeParse({
			transport: "http",
			baseUrl: "http://localhost:5700",
		});
		expect(r.success).toBe(true);
		if (r.success && r.data.transport === "http") {
			expect(r.data.protocolVersion).toBe("v11");
			expect(r.data.headers).toEqual({});
			expect(r.data.timeoutMs).toBe(15_000);
			expect(r.data.maxRetries).toBe(0);
			expect(r.data.retryIntervalMs).toBe(1_000);
		}
	});

	it("旧名 retryTimes 不再收(strict 拒多余键)—— 迁移已改名成 maxRetries", () => {
		const r = OnebotConnectionSettingsSchema.safeParse({
			transport: "http",
			baseUrl: "http://localhost:5700",
			retryTimes: 2,
		});
		expect(r.success).toBe(false);
	});

	// --- 超时下限(带图 / 合并转发) ---
	it("超时下限:缺省补 default(带图 30s / 合并转发 60s),三种 transport 共用", () => {
		const http = OnebotConnectionSettingsSchema.safeParse({
			transport: "http",
			baseUrl: "http://localhost:5700",
		});
		expect(http.success).toBe(true);
		if (http.success && http.data.transport === "http") {
			expect(http.data.imageMinTimeoutMs).toBe(30_000);
			expect(http.data.mergeForwardMinTimeoutMs).toBe(60_000);
		}
		const rev = OnebotConnectionSettingsSchema.safeParse({ transport: "ws-reverse", port: 6700 });
		expect(rev.success).toBe(true);
		if (rev.success && rev.data.transport === "ws-reverse") {
			expect(rev.data.imageMinTimeoutMs).toBe(30_000);
			expect(rev.data.mergeForwardMinTimeoutMs).toBe(60_000);
		}
	});

	it("超时下限:显式 0 合法 —— 想「严格按我配的超时走」得关得掉", () => {
		const r = OnebotConnectionSettingsSchema.safeParse({
			transport: "http",
			baseUrl: "http://localhost:5700",
			imageMinTimeoutMs: 0,
			mergeForwardMinTimeoutMs: 0,
		});
		expect(r.success).toBe(true);
		if (r.success && r.data.transport === "http") {
			expect(r.data.imageMinTimeoutMs).toBe(0);
			expect(r.data.mergeForwardMinTimeoutMs).toBe(0);
		}
	});

	it("超时下限:负数拒绝", () => {
		expect(
			OnebotConnectionSettingsSchema.safeParse({
				transport: "http",
				baseUrl: "http://localhost:5700",
				imageMinTimeoutMs: -1,
			}).success,
		).toBe(false);
		expect(
			OnebotConnectionSettingsSchema.safeParse({
				transport: "http",
				baseUrl: "http://localhost:5700",
				mergeForwardMinTimeoutMs: -1,
			}).success,
		).toBe(false);
	});

	// --- http branch ---
	it("http branch:显式 transport + baseUrl 合法", () => {
		const r = OnebotConnectionSettingsSchema.safeParse({
			transport: "http",
			baseUrl: "http://localhost:5700",
		});
		expect(r.success).toBe(true);
	});

	it("http branch:带 port(strict 拒多余键)→ 失败", () => {
		const r = OnebotConnectionSettingsSchema.safeParse({
			transport: "http",
			baseUrl: "http://localhost:5700",
			port: 6700,
		});
		expect(r.success).toBe(false);
	});

	// --- ws branch ---
	it("ws branch:ws:// 与 wss:// 都合法", () => {
		expect(
			OnebotConnectionSettingsSchema.safeParse({ transport: "ws", url: "ws://127.0.0.1:3001" })
				.success,
		).toBe(true);
		expect(
			OnebotConnectionSettingsSchema.safeParse({
				transport: "ws",
				url: "wss://napcat.example.com/ws",
			}).success,
		).toBe(true);
	});

	it("ws branch:非 ws/wss 协议(http://)→ 失败", () => {
		const r = OnebotConnectionSettingsSchema.safeParse({
			transport: "ws",
			url: "http://127.0.0.1:3001",
		});
		expect(r.success).toBe(false);
	});

	it("ws branch:缺 url → 失败", () => {
		const r = OnebotConnectionSettingsSchema.safeParse({ transport: "ws" });
		expect(r.success).toBe(false);
	});

	// --- ws-reverse branch ---
	it("ws-reverse branch:port 合法", () => {
		const r = OnebotConnectionSettingsSchema.safeParse({ transport: "ws-reverse", port: 6700 });
		expect(r.success).toBe(true);
	});

	it("ws-reverse branch:port 越界(0 / 70000)→ 失败", () => {
		expect(
			OnebotConnectionSettingsSchema.safeParse({ transport: "ws-reverse", port: 0 }).success,
		).toBe(false);
		expect(
			OnebotConnectionSettingsSchema.safeParse({ transport: "ws-reverse", port: 70_000 }).success,
		).toBe(false);
	});

	it("ws-reverse branch:缺 port → 失败", () => {
		const r = OnebotConnectionSettingsSchema.safeParse({ transport: "ws-reverse" });
		expect(r.success).toBe(false);
	});

	it("ws-reverse branch:带残留 baseUrl(strict 拒多余键)→ 失败", () => {
		const r = OnebotConnectionSettingsSchema.safeParse({
			transport: "ws-reverse",
			port: 6700,
			baseUrl: "http://localhost:5700",
		});
		expect(r.success).toBe(false);
	});

	it("非法 transport 值 → 失败", () => {
		const r = OnebotConnectionSettingsSchema.safeParse({ transport: "bogus", baseUrl: "http://x" });
		expect(r.success).toBe(false);
	});

	// --- 判别联合:显式 transport 必须命中对应 branch,不被旁支吞掉 ---
	it("ws config 带残留 baseUrl(strict 拒多余键)→ 失败,不被 http branch 吞", () => {
		// transport:"ws" 的 literal 不匹配 http branch 的 transport:"http",
		// 又因 ws branch .strict() 拒掉 baseUrl → 整体失败(不会静默落到 http)。
		const r = OnebotConnectionSettingsSchema.safeParse({
			transport: "ws",
			url: "ws://127.0.0.1:3001",
			baseUrl: "http://localhost:5700",
		});
		expect(r.success).toBe(false);
	});

	it("显式 transport:ws 必定解析为 ws branch", () => {
		const r = OnebotConnectionSettingsSchema.safeParse({
			transport: "ws",
			url: "ws://127.0.0.1:3001",
		});
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.transport).toBe("ws");
	});

	it("显式 transport:ws-reverse 必定解析为 ws-reverse branch", () => {
		const r = OnebotConnectionSettingsSchema.safeParse({ transport: "ws-reverse", port: 6700 });
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.transport).toBe("ws-reverse");
	});

	it("没有 transport 也没有别的字段 → 失败(判别键缺失)", () => {
		const r = OnebotConnectionSettingsSchema.safeParse({ accessToken: "secret" });
		expect(r.success).toBe(false);
	});
});

describe("QQOfficial connection settings schema", () => {
	it("accepts a minimal qq-official settings and defaults sandbox/botType", () => {
		const r = QQOfficialConnectionSettingsSchema.safeParse({
			appId: "102000000",
			appSecret: "secret",
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.sandbox).toBe(false);
			expect(r.data.botType).toBe("public");
		}
	});

	it("requires appId and appSecret", () => {
		expect(QQOfficialConnectionSettingsSchema.safeParse({ appSecret: "s" }).success).toBe(false);
		expect(QQOfficialConnectionSettingsSchema.safeParse({ appId: "1" }).success).toBe(false);
	});

	it("is strict — rejects unknown key (如误填 onebot 的 baseUrl)", () => {
		const r = QQOfficialConnectionSettingsSchema.safeParse({
			appId: "1",
			appSecret: "s",
			baseUrl: "http://x",
		});
		expect(r.success).toBe(false);
	});
});
