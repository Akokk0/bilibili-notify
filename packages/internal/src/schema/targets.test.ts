import { describe, expect, it } from "vitest";
import { OnebotAdapterConfigSchema, PushAdapterSchema, PushTargetSchema } from "./targets";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("PushAdapterSchema (discriminated by platform)", () => {
	it("accepts a valid onebot adapter", () => {
		const r = PushAdapterSchema.safeParse({
			id: UUID_A,
			name: "napcat-main",
			platform: "onebot",
			enabled: true,
			config: { baseUrl: "http://localhost:5700", accessToken: "secret" },
		});
		expect(r.success).toBe(true);
	});

	it("rejects an onebot adapter with webhook config", () => {
		const r = PushAdapterSchema.safeParse({
			id: UUID_A,
			name: "bad",
			platform: "onebot",
			enabled: true,
			config: { url: "https://example.com/hook" },
		});
		expect(r.success).toBe(false);
	});

	it("accepts a valid webhook adapter and defaults provider to generic", () => {
		const r = PushAdapterSchema.safeParse({
			id: UUID_A,
			name: "wh1",
			platform: "webhook",
			enabled: true,
			config: { url: "https://example.com/hook" },
		});
		expect(r.success).toBe(true);
		if (r.success && r.data.platform === "webhook") {
			expect(r.data.config.provider).toBe("generic");
			expect(r.data.config.headers).toEqual({});
		}
	});

	it("accepts supported webhook providers", () => {
		for (const provider of ["generic", "dingtalk", "feishu"] as const) {
			const r = PushAdapterSchema.safeParse({
				id: UUID_A,
				name: `wh-${provider}`,
				platform: "webhook",
				enabled: true,
				config: { provider, url: "https://example.com/hook", secret: "secret" },
			});
			expect(r.success, provider).toBe(true);
			if (r.success && r.data.platform === "webhook") expect(r.data.config.provider).toBe(provider);
		}
	});

	it("rejects unknown webhook provider", () => {
		const r = PushAdapterSchema.safeParse({
			id: UUID_A,
			name: "bad-provider",
			platform: "webhook",
			enabled: true,
			config: { provider: "wechat", url: "https://example.com/hook" },
		});
		expect(r.success).toBe(false);
	});

	it("accepts a valid web-dashboard adapter", () => {
		const r = PushAdapterSchema.safeParse({
			id: UUID_A,
			name: "dashboard",
			platform: "web-dashboard",
			enabled: true,
			config: {},
		});
		expect(r.success).toBe(true);
	});

	it("accepts a valid koishi-bot adapter", () => {
		const r = PushAdapterSchema.safeParse({
			id: UUID_A,
			name: "onebot",
			platform: "koishi-bot",
			enabled: true,
			config: { botPlatform: "onebot" },
		});
		expect(r.success).toBe(true);
	});

	it("rejects koishi-bot adapter without botPlatform", () => {
		const r = PushAdapterSchema.safeParse({
			id: UUID_A,
			name: "bad",
			platform: "koishi-bot",
			enabled: true,
			config: {},
		});
		expect(r.success).toBe(false);
	});

	it("rejects unknown platform", () => {
		const r = PushAdapterSchema.safeParse({
			id: UUID_A,
			name: "bad",
			platform: "koishi-onebot",
			enabled: true,
			config: { botPlatform: "onebot" },
		});
		expect(r.success).toBe(false);
	});

	it("accepts an onebot adapter with ws (正向 WS) config", () => {
		const r = PushAdapterSchema.safeParse({
			id: UUID_A,
			name: "napcat-ws",
			platform: "onebot",
			enabled: true,
			config: { transport: "ws", url: "ws://127.0.0.1:3001" },
		});
		expect(r.success).toBe(true);
	});

	it("accepts an onebot adapter with ws-reverse (反向 WS) config", () => {
		const r = PushAdapterSchema.safeParse({
			id: UUID_A,
			name: "napcat-rev",
			platform: "onebot",
			enabled: true,
			config: { transport: "ws-reverse", port: 6700 },
		});
		expect(r.success).toBe(true);
	});
});

describe("OnebotAdapterConfigSchema (transport discriminatedUnion)", () => {
	// --- 迁移:早期 adapters.json 的 onebot 条目没有 transport 字段 ---
	it("迁移:无 transport 的旧 config(有 baseUrl)→ 视作 http", () => {
		const r = OnebotAdapterConfigSchema.safeParse({
			baseUrl: "http://localhost:5700",
			accessToken: "secret",
		});
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.transport).toBe("http");
	});

	it("迁移:旧 config 缺省字段补 default(protocolVersion / headers / timeoutMs / retry)", () => {
		const r = OnebotAdapterConfigSchema.safeParse({ baseUrl: "http://localhost:5700" });
		expect(r.success).toBe(true);
		if (r.success && r.data.transport === "http") {
			expect(r.data.protocolVersion).toBe("v11");
			expect(r.data.headers).toEqual({});
			expect(r.data.timeoutMs).toBe(15_000);
			expect(r.data.retryTimes).toBe(0);
			expect(r.data.retryIntervalMs).toBe(1_000);
		}
	});

	// --- http branch ---
	it("http branch:显式 transport + baseUrl 合法", () => {
		const r = OnebotAdapterConfigSchema.safeParse({
			transport: "http",
			baseUrl: "http://localhost:5700",
		});
		expect(r.success).toBe(true);
	});

	it("http branch:带 port(strict 拒多余键)→ 失败", () => {
		const r = OnebotAdapterConfigSchema.safeParse({
			transport: "http",
			baseUrl: "http://localhost:5700",
			port: 6700,
		});
		expect(r.success).toBe(false);
	});

	// --- ws branch ---
	it("ws branch:ws:// 与 wss:// 都合法", () => {
		expect(
			OnebotAdapterConfigSchema.safeParse({ transport: "ws", url: "ws://127.0.0.1:3001" }).success,
		).toBe(true);
		expect(
			OnebotAdapterConfigSchema.safeParse({ transport: "ws", url: "wss://napcat.example.com/ws" })
				.success,
		).toBe(true);
	});

	it("ws branch:非 ws/wss 协议(http://)→ 失败", () => {
		const r = OnebotAdapterConfigSchema.safeParse({
			transport: "ws",
			url: "http://127.0.0.1:3001",
		});
		expect(r.success).toBe(false);
	});

	it("ws branch:缺 url → 失败", () => {
		const r = OnebotAdapterConfigSchema.safeParse({ transport: "ws" });
		expect(r.success).toBe(false);
	});

	// --- ws-reverse branch ---
	it("ws-reverse branch:port 合法", () => {
		const r = OnebotAdapterConfigSchema.safeParse({ transport: "ws-reverse", port: 6700 });
		expect(r.success).toBe(true);
	});

	it("ws-reverse branch:port 越界(0 / 70000)→ 失败", () => {
		expect(OnebotAdapterConfigSchema.safeParse({ transport: "ws-reverse", port: 0 }).success).toBe(
			false,
		);
		expect(
			OnebotAdapterConfigSchema.safeParse({ transport: "ws-reverse", port: 70_000 }).success,
		).toBe(false);
	});

	it("ws-reverse branch:缺 port → 失败", () => {
		const r = OnebotAdapterConfigSchema.safeParse({ transport: "ws-reverse" });
		expect(r.success).toBe(false);
	});

	it("ws-reverse branch:带残留 baseUrl(strict 拒多余键)→ 失败", () => {
		const r = OnebotAdapterConfigSchema.safeParse({
			transport: "ws-reverse",
			port: 6700,
			baseUrl: "http://localhost:5700",
		});
		expect(r.success).toBe(false);
	});

	it("非法 transport 值 → 失败", () => {
		const r = OnebotAdapterConfigSchema.safeParse({ transport: "bogus", baseUrl: "http://x" });
		expect(r.success).toBe(false);
	});

	// --- z.union 分支消歧:显式 transport 必须命中对应 branch,不被旁支吞掉 ---
	it("ws config 带残留 baseUrl(strict 拒多余键)→ 失败,不被 http branch 吞", () => {
		// transport:"ws" 的 literal 不匹配 http branch 的 transport:"http",
		// 又因 ws branch .strict() 拒掉 baseUrl → 整体失败(不会静默落到 http)。
		const r = OnebotAdapterConfigSchema.safeParse({
			transport: "ws",
			url: "ws://127.0.0.1:3001",
			baseUrl: "http://localhost:5700",
		});
		expect(r.success).toBe(false);
	});

	it("显式 transport:ws 必定解析为 ws branch(不命中 http default)", () => {
		const r = OnebotAdapterConfigSchema.safeParse({
			transport: "ws",
			url: "ws://127.0.0.1:3001",
		});
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.transport).toBe("ws");
	});

	it("显式 transport:ws-reverse 必定解析为 ws-reverse branch", () => {
		const r = OnebotAdapterConfigSchema.safeParse({ transport: "ws-reverse", port: 6700 });
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.transport).toBe("ws-reverse");
	});

	it("迁移:无 transport 但缺 baseUrl 的损坏旧 config → 失败(不静默成 http)", () => {
		// 没有 transport 字段时只可能命中 http branch,而 http branch 的 baseUrl
		// 是必填 z.url() —— 缺它则迁移失败,而非生成无 endpoint 的僵尸 adapter。
		const r = OnebotAdapterConfigSchema.safeParse({ accessToken: "secret" });
		expect(r.success).toBe(false);
	});
});

describe("PushTargetSchema (discriminated by platform)", () => {
	it("accepts an onebot target", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "ob:111",
			adapterId: UUID_A,
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "111" },
		});
		expect(r.success).toBe(true);
	});

	it("accepts a webhook target with empty session", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "wh:1",
			adapterId: UUID_A,
			platform: "webhook",
			scope: "channel",
			enabled: true,
			session: {},
		});
		expect(r.success).toBe(true);
	});

	it("rejects a webhook target with URL-like session keys", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "wh:1",
			adapterId: UUID_A,
			platform: "webhook",
			scope: "channel",
			enabled: true,
			session: { url: "https://example.com/hook" },
		});
		expect(r.success).toBe(false);
	});

	it("accepts a web-dashboard target with empty session", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "dash",
			adapterId: UUID_A,
			platform: "web-dashboard",
			scope: "channel",
			enabled: true,
			session: {},
		});
		expect(r.success).toBe(true);
	});

	it("rejects a web-dashboard target with unknown session keys", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "dash",
			adapterId: UUID_A,
			platform: "web-dashboard",
			scope: "channel",
			enabled: true,
			session: { dashboardUser: "alice" },
		});
		expect(r.success).toBe(false);
	});

	it("accepts a koishi-bot target with channelId", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "ob:111",
			adapterId: UUID_A,
			platform: "koishi-bot",
			scope: "group",
			enabled: true,
			session: { channelId: "111" },
		});
		expect(r.success).toBe(true);
	});

	it("rejects onebot target missing adapterId", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "bad",
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "111" },
		});
		expect(r.success).toBe(false);
	});

	it("rejects extraneous onebot session keys (P2: .strict() 让配置拼写错保存期暴露)", () => {
		// session.strict() 后,`gruopId` 之类拼写错(多余键)即报错,
		// 不再静默吞掉导致 target 无可投递地址却校验通过。
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "ok",
			adapterId: UUID_A,
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "1", extraneous: "ignored" },
		});
		expect(r.success).toBe(false);
	});
});
