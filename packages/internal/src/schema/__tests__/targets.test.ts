import { describe, expect, it } from "vite-plus/test";

import {
	CONNECTION_PROBE_STATUSES,
	ConnectionSchema,
	ConnectionShellSchema,
	NewConnectionSchema,
	neutralPlatformSnapshot,
	PlatformSnapshotSchema,
	PushTargetSchema,
	TargetReachabilitySchema,
} from "../targets";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

const snapshot = {
	label: "OneBot v11",
	shortLabel: "OneBot",
	color: "#3b82f6",
	icon: "qq",
	targetKind: "session",
	scopes: ["group", "private"],
	addressNouns: { group: "群", private: "用户" },
} as const;

const shell = {
	id: UUID_A,
	name: "napcat-main",
	enabled: true,
	adapterKey: "onebot",
	platform: "onebot",
} as const;

describe("ConnectionShellSchema —— 外壳四格,坏了才挡开机", () => {
	it("四格齐全就过;`settings` 与宿主独写的两格不在外壳里", () => {
		const r = ConnectionShellSchema.safeParse({ ...shell, settings: 1, platformSnapshot: 2 });
		expect(r.success).toBe(true);
		expect(r.data).toEqual(shell);
	});

	it.each([
		["id", { id: "not-a-uuid" }],
		["name", { name: "" }],
		["enabled", { enabled: "yes" }],
		["adapterKey", { adapterKey: "" }],
		["platform", { platform: "" }],
	])("%s 坏了就拒,报错路径指到这一格", (key, patch) => {
		const r = ConnectionShellSchema.safeParse({ ...shell, ...patch });
		expect(r.success).toBe(false);
		expect(r.success ? [] : r.error.issues.map((i) => i.path.join("."))).toContain(key);
	});

	it.each(["id", "name", "enabled", "adapterKey", "platform"] as const)("缺 %s 就拒", (key) => {
		const { [key]: _dropped, ...rest } = shell;
		expect(ConnectionShellSchema.safeParse(rest).success).toBe(false);
	});
});

describe("ConnectionSchema —— 外壳 + settings + platformSnapshot + probeState", () => {
	const connection = { ...shell, settings: { baseUrl: "http://x" }, platformSnapshot: snapshot };

	it("`settings` 任意值都过 —— 形状归适配器的 settingsSchema,核心不认识", () => {
		for (const settings of [undefined, null, 1, "x", [], { any: { thing: true } }]) {
			const r = ConnectionSchema.safeParse({ ...connection, settings });
			expect(r.success, JSON.stringify(settings)).toBe(true);
		}
	});

	it("开放词表:拓展的 adapterKey 与任意 platform 都存得下", () => {
		const r = ConnectionSchema.safeParse({
			...connection,
			adapterKey: "demo-ext",
			platform: "telegram",
			platformSnapshot: neutralPlatformSnapshot("telegram"),
		});
		expect(r.success).toBe(true);
	});

	it("平台快照缺格或格坏了就拒", () => {
		const { label: _label, ...noLabel } = snapshot;
		expect(ConnectionSchema.safeParse({ ...connection, platformSnapshot: noLabel }).success).toBe(
			false,
		);
		expect(
			ConnectionSchema.safeParse({
				...connection,
				platformSnapshot: { ...snapshot, targetKind: "bogus" },
			}).success,
		).toBe(false);
		expect(
			ConnectionSchema.safeParse({
				...connection,
				platformSnapshot: { ...snapshot, scopes: ["group", "nope"] },
			}).success,
		).toBe(false);
		expect(ConnectionSchema.safeParse({ ...connection, platformSnapshot: undefined }).success).toBe(
			false,
		);
	});

	it("平台快照里 icon 可缺、addressNouns 可空", () => {
		const { icon: _icon, ...noIcon } = snapshot;
		expect(
			ConnectionSchema.safeParse({
				...connection,
				platformSnapshot: { ...noIcon, addressNouns: {} },
			}).success,
		).toBe(true);
	});

	it("probeState 可缺(= 还没探过);三态 status 之外的拒", () => {
		expect(ConnectionSchema.safeParse(connection).success).toBe(true);
		for (const status of CONNECTION_PROBE_STATUSES) {
			const r = ConnectionSchema.safeParse({
				...connection,
				probeState: { status, lastCheckedAt: "2026-10-10T00:00:00.000Z" },
			});
			expect(r.success, status).toBe(true);
		}
		const bad = ConnectionSchema.safeParse({
			...connection,
			probeState: { status: "ok", lastCheckedAt: "2026-10-10T00:00:00.000Z" },
		});
		expect(bad.success).toBe(false);
	});

	it("probeState 的 latencyMs / message 可选,lastCheckedAt 必填", () => {
		expect(
			ConnectionSchema.safeParse({
				...connection,
				probeState: { status: "reachable", lastCheckedAt: "t", latencyMs: 12 },
			}).success,
		).toBe(true);
		expect(
			ConnectionSchema.safeParse({
				...connection,
				probeState: { status: "unreachable", lastCheckedAt: "t", message: "拒绝连接" },
			}).success,
		).toBe(true);
		expect(
			ConnectionSchema.safeParse({ ...connection, probeState: { status: "reachable" } }).success,
		).toBe(false);
	});

	it("旧形状(kind / connector / config / extensionId)不再是连接 —— 没有 adapterKey", () => {
		const r = ConnectionSchema.safeParse({
			id: UUID_A,
			name: "老形状",
			platform: "onebot",
			enabled: true,
			kind: "direct",
			connector: "http",
			config: { baseUrl: "http://x" },
		});
		expect(r.success).toBe(false);
	});
});

describe("NewConnectionSchema —— POST 收的那一份", () => {
	it("收外壳 + settings", () => {
		const r = NewConnectionSchema.safeParse({ ...shell, settings: { baseUrl: "http://x" } });
		expect(r.success).toBe(true);
	});

	it("不收宿主独写的 platformSnapshot / probeState —— 带来的被剥掉", () => {
		const r = NewConnectionSchema.safeParse({
			...shell,
			settings: {},
			platformSnapshot: snapshot,
			probeState: { status: "reachable", lastCheckedAt: "t" },
		});
		expect(r.success).toBe(true);
		expect(r.data).not.toHaveProperty("platformSnapshot");
		expect(r.data).not.toHaveProperty("probeState");
	});

	it("外壳坏了也拒", () => {
		expect(NewConnectionSchema.safeParse({ ...shell, adapterKey: "", settings: {} }).success).toBe(
			false,
		);
	});
});

describe("neutralPlatformSnapshot", () => {
	it("名字取平台名、过得了快照的 schema、给全三档", () => {
		const snap = neutralPlatformSnapshot("telegram");
		expect(PlatformSnapshotSchema.safeParse(snap).success).toBe(true);
		expect(snap.label).toBe("telegram");
		expect(snap.shortLabel).toBe("telegram");
		expect(snap.scopes).toEqual(["group", "private", "channel"]);
		expect(snap.targetKind).toBe("session");
	});
});

describe("TargetReachabilitySchema", () => {
	it("只有 reachable / unreachable 两态,changedAt 必填", () => {
		expect(
			TargetReachabilitySchema.safeParse({ status: "reachable", changedAt: "t", latencyMs: 3 })
				.success,
		).toBe(true);
		expect(
			TargetReachabilitySchema.safeParse({ status: "unreachable", changedAt: "t", message: "x" })
				.success,
		).toBe(true);
		expect(
			TargetReachabilitySchema.safeParse({ status: "unsupported", changedAt: "t" }).success,
		).toBe(false);
		expect(TargetReachabilitySchema.safeParse({ status: "reachable" }).success).toBe(false);
	});

	it("目标上的 reachability 可缺;老的 testStatus 被剥掉", () => {
		const base = {
			id: UUID_B,
			name: "群",
			connectionId: UUID_A,
			kind: "session",
			scope: "group",
			enabled: true,
			address: "1",
		};
		const withNew = PushTargetSchema.safeParse({
			...base,
			reachability: { status: "reachable", changedAt: "t" },
		});
		expect(withNew.success).toBe(true);
		expect(withNew.data).toHaveProperty("reachability");
		const withOld = PushTargetSchema.safeParse({
			...base,
			testStatus: { ok: true, lastCheckedAt: "t" },
		});
		expect(withOld.success).toBe(true);
		expect(withOld.data).not.toHaveProperty("testStatus");
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

	it("目标上遗留的 platform 被静默剥掉,不拒收 —— 平台只在连接上", () => {
		// 盘上 / 请求体里的老形状还带着 platform:schema 不是 strict,parse 成功但结果里没有这一格
		// (连空串、认不得的平台名也一样,不再有人校验它)。
		for (const platform of ["onebot", "telegram", ""]) {
			const r = PushTargetSchema.safeParse({
				id: UUID_B,
				name: "老形状",
				connectionId: UUID_A,
				kind: "session",
				platform,
				scope: "group",
				enabled: true,
				address: "111",
			});
			expect(r.success).toBe(true);
			expect(r.success && "platform" in r.data).toBe(false);
		}
		const endpoint = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "wh",
			connectionId: UUID_A,
			kind: "endpoint",
			platform: "feishu",
			scope: "channel",
			enabled: true,
		});
		expect(endpoint.success).toBe(true);
		expect(endpoint.success && "platform" in endpoint.data).toBe(false);
	});

	it("端点目标没有 scope:带进来的被剥掉;会话目标的 scope 仍必填", () => {
		const endpoint = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "wh",
			connectionId: UUID_A,
			kind: "endpoint",
			scope: "channel",
			enabled: true,
		});
		expect(endpoint.success).toBe(true);
		expect(endpoint.success && "scope" in endpoint.data).toBe(false);
		const noScope = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "群",
			connectionId: UUID_A,
			kind: "session",
			enabled: true,
			address: "1",
		});
		expect(noScope.success).toBe(false);
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

/**
 * 拓展提供的连接(ADR-0012 决策 27 / 45)—— **一个借来的 bot**。
 *
 * 与内置的是同一个形状:`adapterKey` 是拓展 id、`platform` 是开放词表(一个 bot 就是一个平台)、
 * `settings` 不由核心定形状(归拓展自己那份 zod)。
 */
describe("拓展连接", () => {
	const base = {
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		name: "阿库娅",
		enabled: true,
		adapterKey: "demo-ext",
		platform: "telegram",
		settings: { link: "l1", botId: "telegram:42" },
		platformSnapshot: neutralPlatformSnapshot("telegram"),
	};

	it("存得下:开放词表的 platform,settings 原样", () => {
		const r = ConnectionSchema.safeParse(base);
		expect(r.success).toBe(true);
		expect(r.data).toHaveProperty("platform", "telegram");
		expect(r.data).toHaveProperty("settings", base.settings);
		expect(r.data).not.toHaveProperty("connector");
		expect(r.data).not.toHaveProperty("kind");
	});

	it("没有 platform 存不下 —— 一个 bot 必然在某个平台上", () => {
		const { platform: _dropped, ...withoutPlatform } = base;
		expect(ConnectionSchema.safeParse(withoutPlatform).success).toBe(false);
		expect(ConnectionSchema.safeParse({ ...base, platform: "" }).success).toBe(false);
	});

	it("没有 adapterKey 存不下 —— 谁来处理它得说得出", () => {
		const { adapterKey: _dropped, ...without } = base;
		expect(ConnectionSchema.safeParse(without).success).toBe(false);
	});
});
