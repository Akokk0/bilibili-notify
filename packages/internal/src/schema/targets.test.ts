import { describe, expect, it } from "vite-plus/test";
import { WEBHOOK_PLATFORMS } from "../constants";
import { ConnectionSchema, OnebotConnectionConfigSchema, PushTargetSchema } from "./targets";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("ConnectionSchema (discriminated by platform)", () => {
	it("accepts a valid onebot connection", () => {
		const r = ConnectionSchema.safeParse({
			id: UUID_A,
			name: "napcat-main",
			platform: "onebot",
			enabled: true,
			kind: "direct",
			connector: "http",
			config: { baseUrl: "http://localhost:5700", accessToken: "secret" },
		});
		expect(r.success).toBe(true);
	});

	it("connector 与 config.transport 漂了就拒 —— 面板显示 ws、实际按 http 连是最坏的一种绿", () => {
		// 这一版 `connector` 与 OneBot 的 `config.transport` 是同一件事的两份(前者是新轴,
		// 后者是它今天的住处)。两份就会漂,所以 schema 把它钉死。等 transport 那份删掉时
		// 这条 refine 一并退休。
		const r = ConnectionSchema.safeParse({
			id: UUID_A,
			name: "drift",
			platform: "onebot",
			enabled: true,
			kind: "direct",
			connector: "ws",
			config: { transport: "http", baseUrl: "http://localhost:5700" },
		});
		expect(r.success).toBe(false);
		expect(r.success ? [] : r.error.issues.map((i) => i.path.join("."))).toContain("connector");
	});

	it("webhook / qq-official 的 connector 是常量,写别的就拒", () => {
		const wh = ConnectionSchema.safeParse({
			id: UUID_A,
			name: "wh",
			platform: "webhook",
			enabled: true,
			kind: "direct",
			connector: "http",
			config: { url: "https://example.com/hook" },
		});
		const qq = ConnectionSchema.safeParse({
			id: UUID_A,
			name: "qq",
			platform: "qq-official",
			enabled: true,
			kind: "direct",
			connector: "webhook",
			config: { appId: "1", appSecret: "s" },
		});
		expect(wh.success).toBe(false);
		expect(qq.success).toBe(false);
	});

	it("rejects an onebot connection with webhook config", () => {
		const r = ConnectionSchema.safeParse({
			id: UUID_A,
			name: "bad",
			platform: "onebot",
			enabled: true,
			kind: "direct",
			connector: "http",
			config: { url: "https://example.com/hook" },
		});
		expect(r.success).toBe(false);
	});

	it("accepts a valid webhook connection and defaults headers to empty", () => {
		const r = ConnectionSchema.safeParse({
			id: UUID_A,
			name: "wh1",
			platform: "generic",
			enabled: true,
			kind: "direct",
			connector: "webhook",
			config: { url: "https://example.com/hook" },
		});
		expect(r.success).toBe(true);
		if (r.success && r.data.kind === "direct" && r.data.platform === "generic") {
			expect(r.data.config.headers).toEqual({});
		}
	});

	it.each(WEBHOOK_PLATFORMS)("accepts the %s webhook platform", (platform) => {
		const r = ConnectionSchema.safeParse({
			id: UUID_A,
			name: `wh-${platform}`,
			platform,
			enabled: true,
			kind: "direct",
			connector: "webhook",
			config: { url: "https://example.com/hook", secret: "secret" },
		});
		expect(r.success, platform).toBe(true);
	});

	it("rejects the demoted `webhook` platform —— 它现在是连接器,不是平台", () => {
		const r = ConnectionSchema.safeParse({
			id: UUID_A,
			name: "old-shape",
			platform: "webhook",
			enabled: true,
			kind: "direct",
			connector: "webhook",
			config: { url: "https://example.com/hook" },
		});
		expect(r.success).toBe(false);
	});

	it("rejects a webhook platform connected some other way", () => {
		// 飞书只有一条路 —— 往 URL POST。写成 ws 就是配置错了,存下来只会在发送时才炸。
		const r = ConnectionSchema.safeParse({
			id: UUID_A,
			name: "feishu-ws",
			platform: "feishu",
			enabled: true,
			kind: "direct",
			connector: "ws",
			config: { url: "https://example.com/hook" },
		});
		expect(r.success).toBe(false);
	});

	it("rejects the removed web-dashboard connection platform", () => {
		const r = ConnectionSchema.safeParse({
			id: UUID_A,
			name: "dashboard",
			platform: "web-dashboard",
			enabled: true,
			config: {},
		});
		expect(r.success).toBe(false);
	});

	it("rejects unknown platform", () => {
		const r = ConnectionSchema.safeParse({
			id: UUID_A,
			name: "bad",
			platform: "koishi-onebot",
			enabled: true,
			config: { botPlatform: "onebot" },
		});
		expect(r.success).toBe(false);
	});

	it("accepts an onebot connection with ws (正向 WS) config", () => {
		const r = ConnectionSchema.safeParse({
			id: UUID_A,
			name: "napcat-ws",
			platform: "onebot",
			enabled: true,
			kind: "direct",
			connector: "ws",
			config: { transport: "ws", url: "ws://127.0.0.1:3001" },
		});
		expect(r.success).toBe(true);
	});

	it("accepts an onebot connection with ws-reverse (反向 WS) config", () => {
		const r = ConnectionSchema.safeParse({
			id: UUID_A,
			name: "napcat-rev",
			platform: "onebot",
			enabled: true,
			kind: "direct",
			connector: "ws-reverse",
			config: { transport: "ws-reverse", port: 6700 },
		});
		expect(r.success).toBe(true);
	});
});

describe("OnebotConnectionConfigSchema (transport discriminatedUnion)", () => {
	// --- 迁移:早期 adapters.json 的 onebot 条目没有 transport 字段 ---
	it("迁移:无 transport 的旧 config(有 baseUrl)→ 视作 http", () => {
		const r = OnebotConnectionConfigSchema.safeParse({
			baseUrl: "http://localhost:5700",
			accessToken: "secret",
		});
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.transport).toBe("http");
	});

	it("迁移:旧 config 缺省字段补 default(protocolVersion / headers / timeoutMs / retry)", () => {
		const r = OnebotConnectionConfigSchema.safeParse({ baseUrl: "http://localhost:5700" });
		expect(r.success).toBe(true);
		if (r.success && r.data.transport === "http") {
			expect(r.data.protocolVersion).toBe("v11");
			expect(r.data.headers).toEqual({});
			expect(r.data.timeoutMs).toBe(15_000);
			expect(r.data.retryTimes).toBe(0);
			expect(r.data.retryIntervalMs).toBe(1_000);
		}
	});

	// --- 超时下限(带图 / 合并转发) ---
	it("超时下限:缺省补 default(带图 30s / 合并转发 60s),三种 transport 共用", () => {
		const http = OnebotConnectionConfigSchema.safeParse({ baseUrl: "http://localhost:5700" });
		expect(http.success).toBe(true);
		if (http.success && http.data.transport === "http") {
			expect(http.data.imageMinTimeoutMs).toBe(30_000);
			expect(http.data.forwardMinTimeoutMs).toBe(60_000);
		}
		const rev = OnebotConnectionConfigSchema.safeParse({ transport: "ws-reverse", port: 6700 });
		expect(rev.success).toBe(true);
		if (rev.success && rev.data.transport === "ws-reverse") {
			expect(rev.data.imageMinTimeoutMs).toBe(30_000);
			expect(rev.data.forwardMinTimeoutMs).toBe(60_000);
		}
	});

	it("超时下限:显式 0 合法 —— 想「严格按我配的超时走」得关得掉", () => {
		const r = OnebotConnectionConfigSchema.safeParse({
			baseUrl: "http://localhost:5700",
			imageMinTimeoutMs: 0,
			forwardMinTimeoutMs: 0,
		});
		expect(r.success).toBe(true);
		if (r.success && r.data.transport === "http") {
			expect(r.data.imageMinTimeoutMs).toBe(0);
			expect(r.data.forwardMinTimeoutMs).toBe(0);
		}
	});

	it("超时下限:负数拒绝", () => {
		expect(
			OnebotConnectionConfigSchema.safeParse({
				baseUrl: "http://localhost:5700",
				imageMinTimeoutMs: -1,
			}).success,
		).toBe(false);
		expect(
			OnebotConnectionConfigSchema.safeParse({
				baseUrl: "http://localhost:5700",
				forwardMinTimeoutMs: -1,
			}).success,
		).toBe(false);
	});

	// --- http branch ---
	it("http branch:显式 transport + baseUrl 合法", () => {
		const r = OnebotConnectionConfigSchema.safeParse({
			transport: "http",
			baseUrl: "http://localhost:5700",
		});
		expect(r.success).toBe(true);
	});

	it("http branch:带 port(strict 拒多余键)→ 失败", () => {
		const r = OnebotConnectionConfigSchema.safeParse({
			transport: "http",
			baseUrl: "http://localhost:5700",
			port: 6700,
		});
		expect(r.success).toBe(false);
	});

	// --- ws branch ---
	it("ws branch:ws:// 与 wss:// 都合法", () => {
		expect(
			OnebotConnectionConfigSchema.safeParse({ transport: "ws", url: "ws://127.0.0.1:3001" })
				.success,
		).toBe(true);
		expect(
			OnebotConnectionConfigSchema.safeParse({
				transport: "ws",
				url: "wss://napcat.example.com/ws",
			}).success,
		).toBe(true);
	});

	it("ws branch:非 ws/wss 协议(http://)→ 失败", () => {
		const r = OnebotConnectionConfigSchema.safeParse({
			transport: "ws",
			url: "http://127.0.0.1:3001",
		});
		expect(r.success).toBe(false);
	});

	it("ws branch:缺 url → 失败", () => {
		const r = OnebotConnectionConfigSchema.safeParse({ transport: "ws" });
		expect(r.success).toBe(false);
	});

	// --- ws-reverse branch ---
	it("ws-reverse branch:port 合法", () => {
		const r = OnebotConnectionConfigSchema.safeParse({ transport: "ws-reverse", port: 6700 });
		expect(r.success).toBe(true);
	});

	it("ws-reverse branch:port 越界(0 / 70000)→ 失败", () => {
		expect(
			OnebotConnectionConfigSchema.safeParse({ transport: "ws-reverse", port: 0 }).success,
		).toBe(false);
		expect(
			OnebotConnectionConfigSchema.safeParse({ transport: "ws-reverse", port: 70_000 }).success,
		).toBe(false);
	});

	it("ws-reverse branch:缺 port → 失败", () => {
		const r = OnebotConnectionConfigSchema.safeParse({ transport: "ws-reverse" });
		expect(r.success).toBe(false);
	});

	it("ws-reverse branch:带残留 baseUrl(strict 拒多余键)→ 失败", () => {
		const r = OnebotConnectionConfigSchema.safeParse({
			transport: "ws-reverse",
			port: 6700,
			baseUrl: "http://localhost:5700",
		});
		expect(r.success).toBe(false);
	});

	it("非法 transport 值 → 失败", () => {
		const r = OnebotConnectionConfigSchema.safeParse({ transport: "bogus", baseUrl: "http://x" });
		expect(r.success).toBe(false);
	});

	// --- z.union 分支消歧:显式 transport 必须命中对应 branch,不被旁支吞掉 ---
	it("ws config 带残留 baseUrl(strict 拒多余键)→ 失败,不被 http branch 吞", () => {
		// transport:"ws" 的 literal 不匹配 http branch 的 transport:"http",
		// 又因 ws branch .strict() 拒掉 baseUrl → 整体失败(不会静默落到 http)。
		const r = OnebotConnectionConfigSchema.safeParse({
			transport: "ws",
			url: "ws://127.0.0.1:3001",
			baseUrl: "http://localhost:5700",
		});
		expect(r.success).toBe(false);
	});

	it("显式 transport:ws 必定解析为 ws branch(不命中 http default)", () => {
		const r = OnebotConnectionConfigSchema.safeParse({
			transport: "ws",
			url: "ws://127.0.0.1:3001",
		});
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.transport).toBe("ws");
	});

	it("显式 transport:ws-reverse 必定解析为 ws-reverse branch", () => {
		const r = OnebotConnectionConfigSchema.safeParse({ transport: "ws-reverse", port: 6700 });
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.transport).toBe("ws-reverse");
	});

	it("迁移:无 transport 但缺 baseUrl 的损坏旧 config → 失败(不静默成 http)", () => {
		// 没有 transport 字段时只可能命中 http branch,而 http branch 的 baseUrl
		// 是必填 z.url() —— 缺它则迁移失败,而非生成无 endpoint 的僵尸连接。
		const r = OnebotConnectionConfigSchema.safeParse({ accessToken: "secret" });
		expect(r.success).toBe(false);
	});
});

describe("PushTargetSchema (discriminated by platform)", () => {
	it("accepts an onebot session target", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "ob:111",
			connectionId: UUID_A,
			kind: "session",
			platform: "onebot",
			scope: "group",
			enabled: true,
			address: "111",
		});
		expect(r.success).toBe(true);
	});

	it("accepts a webhook endpoint target —— 单向终点没有地址这一格", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "wh:1",
			connectionId: UUID_A,
			kind: "endpoint",
			platform: "feishu",
			scope: "channel",
			enabled: true,
		});
		expect(r.success).toBe(true);
	});

	it("accepts a connection-managed endpoint target", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "wh:managed",
			connectionId: UUID_A,
			kind: "endpoint",
			platform: "feishu",
			scope: "channel",
			enabled: true,
			managedBy: "connection",
		});
		expect(r.success).toBe(true);
	});

	it("rejects unsupported managedBy values", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "wh:bad-managed",
			connectionId: UUID_A,
			kind: "endpoint",
			platform: "feishu",
			scope: "channel",
			enabled: true,
			managedBy: "user",
		});
		expect(r.success).toBe(false);
	});

	it("rejects managedBy on session targets", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "onebot:managed",
			connectionId: UUID_A,
			kind: "session",
			platform: "onebot",
			scope: "group",
			enabled: true,
			managedBy: "connection",
			address: "111",
		});
		expect(r.success).toBe(false);
	});

	it("目标的平台是开放词表 —— 桥驮来的平台不用先改词表就收得下", () => {
		// 连接那一侧仍是闭集(见上面的 ConnectionSchema 用例)。这一侧开着是因为桥接的
		// 平台清单是运行时才知道的;拦「已撤下的平台」那件事挪去了加载器,判据换成
		// 「认不得的平台又 parse 不过」,见 config-store 那边的用例。
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "桥上的 telegram 群",
			connectionId: UUID_A,
			kind: "session",
			platform: "telegram",
			scope: "group",
			enabled: true,
			address: "-1001234567890",
			parentAddress: "42",
		});
		expect(r.success).toBe(true);
	});

	it("平台名不许是空串 —— 开放不等于什么都收", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "没平台",
			connectionId: UUID_A,
			kind: "session",
			platform: "",
			scope: "group",
			enabled: true,
			address: "1",
		});
		expect(r.success).toBe(false);
	});

	it("rejects onebot target missing connectionId", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "bad",
			kind: "session",
			platform: "onebot",
			scope: "group",
			enabled: true,
			address: "111",
		});
		expect(r.success).toBe(false);
	});

	it("会话目标缺 address 就是缺 —— 老 session 形状不会被静默放过", () => {
		// 收成一格之前,这道保护是 session 上的 `.strict()`:`gruopId` 之类拼写错会
		// 被多余键规则拦下。收成一格之后**保护换了个来源**:`address` 是必填键,
		// 拼错也好、迁移漏了也好,少的就是它,parse 当场失败,不会存成一个没有
		// 投递地址却「校验通过」的目标。
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "老形状",
			connectionId: UUID_A,
			kind: "session",
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "111" },
		});
		expect(r.success).toBe(false);
	});

	it("address 可以是空串 —— 先建个壳、回头再填群号是正常用法", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "待填",
			connectionId: UUID_A,
			kind: "session",
			platform: "onebot",
			scope: "group",
			enabled: true,
			address: "",
		});
		expect(r.success).toBe(true);
	});
});

describe("QQOfficial connection schema", () => {
	it("accepts a minimal qq-official connection and defaults sandbox/botType", () => {
		const r = ConnectionSchema.safeParse({
			id: UUID_A,
			name: "qq-bot",
			platform: "qq-official",
			enabled: true,
			kind: "direct",
			connector: "ws",
			config: { appId: "102000000", appSecret: "secret" },
		});
		expect(r.success).toBe(true);
		if (r.success && r.data.kind === "direct" && r.data.platform === "qq-official") {
			expect(r.data.config.sandbox).toBe(false);
			expect(r.data.config.botType).toBe("public");
		}
	});

	it("requires appId and appSecret", () => {
		const base = { id: UUID_A, name: "x", platform: "qq-official", enabled: true } as const;
		expect(ConnectionSchema.safeParse({ ...base, config: { appSecret: "s" } }).success).toBe(false);
		expect(ConnectionSchema.safeParse({ ...base, config: { appId: "1" } }).success).toBe(false);
	});

	it("config is strict — rejects unknown key (如误填 onebot 的 baseUrl)", () => {
		const r = ConnectionSchema.safeParse({
			id: UUID_A,
			name: "qq-bot",
			platform: "qq-official",
			enabled: true,
			kind: "direct",
			connector: "ws",
			config: { appId: "1", appSecret: "s", baseUrl: "http://x" },
		});
		expect(r.success).toBe(false);
	});
});

describe("QQOfficial target schema", () => {
	it("accepts a channel target (address = channelId, parentAddress = guildId)", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "qq:频道",
			connectionId: UUID_A,
			kind: "session",
			platform: "qq-official",
			scope: "channel",
			enabled: true,
			address: "c1",
			parentAddress: "g1",
		});
		expect(r.success).toBe(true);
	});

	it("accepts a group target (address = groupOpenid)", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "qq:群",
			connectionId: UUID_A,
			kind: "session",
			platform: "qq-official",
			scope: "group",
			enabled: true,
			address: "ABCDEF0123456789ABCDEF0123456789",
		});
		expect(r.success).toBe(true);
	});

	it("accepts a private (C2C) target (address = userOpenid)", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "qq:私聊",
			connectionId: UUID_A,
			kind: "session",
			platform: "qq-official",
			scope: "private",
			enabled: true,
			address: "0123456789ABCDEF0123456789ABCDEF",
		});
		expect(r.success).toBe(true);
	});

	it("老的 openid session 形状不再收 —— 缺 address 当场失败", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "qq:老形状",
			connectionId: UUID_A,
			kind: "session",
			platform: "qq-official",
			scope: "group",
			enabled: true,
			session: { groupOpenid: "ABCDEF" },
		});
		expect(r.success).toBe(false);
	});
});
