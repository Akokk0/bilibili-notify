import { describe, expect, it } from "vite-plus/test";
import { CONFIG_SCHEMA_VERSION, detectConfigVersion, migrateConfigSections } from "./migration.js";
import { ConnectionSchema, PushTargetSchema } from "./targets.js";

/**
 * 配置形状迁移 —— 两根轴从「一个字段兼三职」里提上来:连接的 `connector`
 * (原先藏在 OneBot config 的 transport 里)、目标的 `kind`(原先靠
 * `platform === "webhook"` 推)。
 *
 * 判据是**数据形状**而不是版本号:版本文件可能写到一半掉电、也可能被用户手删,
 * 而「这条连接有没有 connector」「这个目标有没有 kind」是自明的。
 * 版本号只用来挡降级(旧载荷读到更新的盘)。
 *
 * 迁移必须**幂等** —— 启动路径与备份恢复路径都会调它,同一份数据可能被走两遍。
 */
const onebotV1 = (over: Record<string, unknown> = {}) => ({
	id: "11111111-1111-4111-8111-111111111111",
	name: "NapCat",
	enabled: true,
	platform: "onebot",
	config: { transport: "ws-reverse", port: 6199, protocolVersion: "v11" },
	...over,
});

const targetV1 = (over: Record<string, unknown> = {}) => ({
	id: "22222222-2222-4222-8222-222222222222",
	name: "测试群",
	adapterId: "11111111-1111-4111-8111-111111111111",
	platform: "onebot",
	scope: "group",
	enabled: true,
	session: { groupId: "114514" },
	...over,
});

describe("detectConfigVersion", () => {
	it("没有 connector 的连接 = 老形状", () => {
		expect(detectConfigVersion({ connections: [onebotV1()] })).toBe(1);
	});

	it("连接迁了但目标没迁 = 还是老形状 —— 上次写到一半掉电就长这样", () => {
		const half = migrateConfigSections({ connections: [onebotV1()] });
		expect(detectConfigVersion({ connections: half.connections, targets: [targetV1()] })).toBe(1);
	});

	it("两边都迁完 = 新形状", () => {
		const out = migrateConfigSections({ connections: [onebotV1()], targets: [targetV1()] });
		expect(detectConfigVersion(out)).toBe(CONFIG_SCHEMA_VERSION);
	});

	it("空表算新形状 —— 全新安装不该被当成待迁移", () => {
		expect(detectConfigVersion({})).toBe(CONFIG_SCHEMA_VERSION);
	});

	it("混着的算老形状 —— 上次迁移写到一半掉电,必须再走一遍", () => {
		const migrated = migrateConfigSections({ connections: [onebotV1()] }).connections[0];
		expect(detectConfigVersion({ connections: [migrated, onebotV1({ id: "x" })] })).toBe(1);
	});
});

describe("migrateConfigSections —— connector 从 config.transport 提上来", () => {
	it.each([
		["ws-reverse", { transport: "ws-reverse", port: 6199 }],
		["ws", { transport: "ws", url: "ws://host" }],
		["http", { transport: "http", baseUrl: "http://host" }],
	])("onebot 的 %s", (connector, config) => {
		const out = migrateConfigSections({ connections: [onebotV1({ config })] });
		expect(out.connections[0]).toMatchObject({ kind: "direct", connector });
	});

	it("onebot 没有 transport 字段的史前条目回落 http —— 与 schema 的 default 同一个答案", () => {
		// OnebotHttpConfigSchema 的 `transport: z.literal("http").default("http")` 就是为这批人留的。
		const out = migrateConfigSections({
			connections: [onebotV1({ config: { baseUrl: "http://host" } })],
		});
		expect(out.connections[0]).toMatchObject({ connector: "http" });
	});

	it("webhook → webhook,qq-official → ws", () => {
		const out = migrateConfigSections({
			connections: [
				onebotV1({ platform: "webhook", config: { url: "https://h/x" } }),
				onebotV1({ platform: "qq-official", config: { appId: "1", appSecret: "s" } }),
			],
		});
		expect(out.connections[0]).toMatchObject({ connector: "webhook" });
		expect(out.connections[1]).toMatchObject({ connector: "ws" });
	});

	it("迁移完的连接能通过 ConnectionSchema —— 否则迁移就是把用户的配置写成了废纸", () => {
		const out = migrateConfigSections({
			connections: [onebotV1({ config: { transport: "ws-reverse", port: 6199 } })],
		});
		const parsed = ConnectionSchema.safeParse(out.connections[0]);
		expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
	});

	it("幂等:再走一遍不变,且不报 changed", () => {
		const once = migrateConfigSections({ connections: [onebotV1()] });
		expect(once.changed.connections).toBe(true);
		const twice = migrateConfigSections({ connections: once.connections });
		expect(twice.changed.connections).toBe(false);
		expect(twice.connections).toEqual(once.connections);
	});

	it("不认识的平台原样放行 —— 已撤下的平台由加载器静默丢弃,不该在这里炸", () => {
		const alien = { id: "a", name: "n", enabled: true, platform: "web-dashboard", config: {} };
		const out = migrateConfigSections({ connections: [alien] });
		expect(out.connections[0]).toEqual(alien);
		expect(out.changed.connections).toBe(false);
	});
});

describe("migrateConfigSections —— webhook 从平台降格成连接器", () => {
	it.each(["feishu", "dingtalk", "wecom", "generic"])(
		"config.provider %s 升格成 platform,并从 config 里摘掉",
		(provider) => {
			const out = migrateConfigSections({
				connections: [onebotV1({ platform: "webhook", config: { url: "https://h/x", provider } })],
			});
			expect(out.connections[0]).toMatchObject({
				platform: provider,
				connector: "webhook",
				kind: "direct",
				config: { url: "https://h/x" },
			});
			expect((out.connections[0] as { config: Record<string, unknown> }).config).not.toHaveProperty(
				"provider",
			);
		},
	);

	it("没有 provider 的老条目落 generic —— 与 schema 那个 default 同一个答案", () => {
		const out = migrateConfigSections({
			connections: [onebotV1({ platform: "webhook", config: { url: "https://h/x" } })],
		});
		expect(out.connections[0]).toMatchObject({ platform: "generic" });
	});

	it("认不出的 provider 也落 generic —— 别把一个不存在的平台名写进盘里", () => {
		const out = migrateConfigSections({
			connections: [
				onebotV1({ platform: "webhook", config: { url: "https://h/x", provider: "wechat" } }),
			],
		});
		expect(out.connections[0]).toMatchObject({ platform: "generic" });
	});

	it("降格完的连接能过 ConnectionSchema", () => {
		const out = migrateConfigSections({
			connections: [
				onebotV1({ platform: "webhook", config: { url: "https://h/x", provider: "feishu" } }),
			],
		});
		const parsed = ConnectionSchema.safeParse(out.connections[0]);
		expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
	});

	it("webhook 目标跟着它那条连接的平台走 —— 目标自己不知道是飞书还是钉钉", () => {
		const connectionId = "11111111-1111-4111-8111-111111111111";
		const out = migrateConfigSections({
			connections: [
				onebotV1({
					id: connectionId,
					platform: "webhook",
					config: { url: "https://h/x", provider: "dingtalk" },
				}),
			],
			targets: [
				targetV1({
					platform: "webhook",
					adapterId: connectionId,
					scope: "channel",
					session: {},
					managedBy: "adapter",
				}),
			],
		});
		expect(out.targets[0]).toMatchObject({ platform: "dingtalk", kind: "endpoint" });
		const parsed = PushTargetSchema.safeParse(out.targets[0]);
		expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
	});

	it("连接找不到的悬空 webhook 目标落 generic —— 加载时托管同步会照连接重算", () => {
		const out = migrateConfigSections({
			targets: [
				targetV1({ platform: "webhook", adapterId: "nope", scope: "channel", session: {} }),
			],
		});
		expect(out.targets[0]).toMatchObject({ platform: "generic", kind: "endpoint" });
	});

	it("幂等:降格过一遍的不再报 changed", () => {
		const raw = {
			connections: [
				onebotV1({ platform: "webhook", config: { url: "https://h/x", provider: "wecom" } }),
			],
			targets: [targetV1({ platform: "webhook", scope: "channel", session: {} })],
		};
		const once = migrateConfigSections(raw);
		expect(once.changed).toEqual({ connections: true, targets: true });
		const twice = migrateConfigSections(once);
		expect(twice.changed).toEqual({ connections: false, targets: false });
		expect(twice.connections).toEqual(once.connections);
		expect(twice.targets).toEqual(once.targets);
	});

	it("只补了 connector、平台还写着 webhook 的半迁移状态仍算老形状", () => {
		// 形状变更是分两片落的,中间那一刻真存在过。判据看得见它,才不会漏迁一半。
		const half = [
			onebotV1({
				platform: "webhook",
				kind: "direct",
				connector: "webhook",
				config: { url: "https://h/x" },
			}),
		];
		expect(detectConfigVersion({ connections: half })).toBe(1);
		expect(migrateConfigSections({ connections: half }).connections[0]).toMatchObject({
			platform: "generic",
		});
	});
});

describe("migrateConfigSections —— 目标的形态提上来成 kind", () => {
	it.each([
		["onebot", "session"],
		["qq-official", "session"],
		["webhook", "endpoint"],
	])("%s 目标 → kind %s", (platform, kind) => {
		const out = migrateConfigSections({ targets: [targetV1({ platform })] });
		expect(out.targets[0]).toMatchObject({ kind });
	});

	it("webhook 目标迁完能过 PushTargetSchema —— 含系统托管那张", () => {
		const out = migrateConfigSections({
			targets: [
				targetV1({ platform: "webhook", scope: "channel", session: {}, managedBy: "adapter" }),
			],
		});
		const parsed = PushTargetSchema.safeParse(out.targets[0]);
		expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
	});

	it("会话目标迁完能过 PushTargetSchema", () => {
		const out = migrateConfigSections({ targets: [targetV1()] });
		const parsed = PushTargetSchema.safeParse(out.targets[0]);
		expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
	});

	it("幂等:再走一遍不变,且不报 changed", () => {
		const once = migrateConfigSections({ targets: [targetV1()] });
		expect(once.changed.targets).toBe(true);
		const twice = migrateConfigSections({ targets: once.targets });
		expect(twice.changed.targets).toBe(false);
		expect(twice.targets).toEqual(once.targets);
	});

	it("不认识的平台原样放行", () => {
		const alien = { id: "t", adapterId: "a", platform: "koishi-bot" };
		const out = migrateConfigSections({ targets: [alien] });
		expect(out.targets[0]).toEqual(alien);
		expect(out.changed.targets).toBe(false);
	});

	it("两个分区各报各的 changed —— 只动了目标就别把连接那份也回写一遍", () => {
		const migratedConnection = migrateConfigSections({ connections: [onebotV1()] }).connections;
		const out = migrateConfigSections({
			connections: migratedConnection,
			targets: [targetV1()],
		});
		expect(out.changed).toEqual({ connections: false, targets: true });
	});
});

describe("migrateConfigSections —— 指向连接的那一格改叫 connectionId", () => {
	it("adapterId 搬成 connectionId,老名字不留在盘上", () => {
		const out = migrateConfigSections({ targets: [targetV1()] });
		expect(out.targets[0]).toMatchObject({
			connectionId: "11111111-1111-4111-8111-111111111111",
		});
		expect(out.targets[0]).not.toHaveProperty("adapterId");
	});

	it("搬完能过 PushTargetSchema —— 新 schema 只认 connectionId,这一格漏搬就整条目标没了", () => {
		const out = migrateConfigSections({ targets: [targetV1()] });
		const parsed = PushTargetSchema.safeParse(out.targets[0]);
		expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
	});

	it("webhook 目标查平台用的是搬完的那一格 —— 顺序搞反就查不到连接、一律落 generic", () => {
		// ①(改名)必须排在 ②(降格)前面。反过来的话 `platformByConnection.get(undefined)`
		// 永远落空,飞书 / 钉钉的托管目标会被静默写成 generic —— 迁移不报错,盘上是错的。
		const connectionId = "11111111-1111-4111-8111-111111111111";
		const out = migrateConfigSections({
			connections: [
				onebotV1({
					id: connectionId,
					platform: "webhook",
					config: { url: "https://h/x", provider: "feishu" },
				}),
			],
			targets: [targetV1({ platform: "webhook", scope: "channel", session: {} })],
		});
		expect(out.targets[0]).toMatchObject({ platform: "feishu" });
	});

	it("两个名字都在的半迁移盘以新的为准", () => {
		const out = migrateConfigSections({
			targets: [targetV1({ connectionId: "new-one" })],
		});
		expect(out.targets[0]).toMatchObject({ connectionId: "new-one" });
	});

	it("老名字还在就算没迁完 —— 判据看得见它", () => {
		const half = [{ ...targetV1(), kind: "session", address: "114514", session: undefined }];
		expect(detectConfigVersion({ targets: half })).toBe(1);
	});

	it("幂等:搬完一遍不再报 changed", () => {
		const once = migrateConfigSections({ targets: [targetV1()] });
		const twice = migrateConfigSections({ targets: once.targets });
		expect(twice.changed.targets).toBe(false);
		expect(twice.targets).toEqual(once.targets);
	});

	it("不认识的平台整条原样放行 —— 连这一格也不动", () => {
		const alien = { id: "t", adapterId: "a", platform: "koishi-bot" };
		const out = migrateConfigSections({ targets: [alien] });
		expect(out.targets[0]).toEqual(alien);
		expect(out.changed.targets).toBe(false);
	});
});

describe("migrateConfigSections —— 托管标记说的是「连接托管」", () => {
	it("托管标记从 adapter 改成 connection —— 托管它的是那条连接", () => {
		const out = migrateConfigSections({
			targets: [
				targetV1({ platform: "webhook", scope: "channel", session: {}, managedBy: "adapter" }),
			],
		});
		expect(out.targets[0]).toMatchObject({ managedBy: "connection" });
	});

	it("没有托管标记的目标不凭空长一个", () => {
		const out = migrateConfigSections({ targets: [targetV1()] });
		expect(out.targets[0]).not.toHaveProperty("managedBy");
	});

	it("老托管标记还在就算没迁完", () => {
		const half = [
			{
				...targetV1(),
				connectionId: "11111111-1111-4111-8111-111111111111",
				adapterId: undefined,
				kind: "endpoint",
				platform: "feishu",
				session: undefined,
				managedBy: "adapter",
			},
		];
		expect(detectConfigVersion({ targets: half })).toBe(1);
	});

	it("老名字还在就算没迁完 —— 判据看得见它", () => {
		const half = [{ ...targetV1(), kind: "session", address: "114514", session: undefined }];
		expect(detectConfigVersion({ targets: half })).toBe(1);
	});

	it("幂等:搬完一遍不再报 changed", () => {
		const once = migrateConfigSections({ targets: [targetV1()] });
		const twice = migrateConfigSections({ targets: once.targets });
		expect(twice.changed.targets).toBe(false);
		expect(twice.targets).toEqual(once.targets);
	});

	it("不认识的平台整条原样放行 —— 连这一格也不动", () => {
		const alien = { id: "t", adapterId: "a", platform: "koishi-bot" };
		const out = migrateConfigSections({ targets: [alien] });
		expect(out.targets[0]).toEqual(alien);
		expect(out.changed.targets).toBe(false);
	});
});

describe("migrateConfigSections —— 每平台一套的 session 收成一格 address", () => {
	it.each([
		["group", { groupId: "114514" }, "114514"],
		["private", { userId: "10001" }, "10001"],
	])("onebot 的 %s 目标取 session 里对应那一格", (scope, session, address) => {
		const out = migrateConfigSections({ targets: [targetV1({ scope, session })] });
		expect(out.targets[0]).toMatchObject({ kind: "session", address });
		expect(out.targets[0]).not.toHaveProperty("session");
	});

	it("onebot 的 scope 决定读哪一格 —— 群目标不许把 userId 当地址", () => {
		// 这正是收成一格要消灭的那个矩阵:老形状里「scope 说 group、填的却是 userId」
		// 在类型上完全合法,只能在发送那一刻才发现。
		const out = migrateConfigSections({
			targets: [targetV1({ scope: "group", session: { userId: "10001" } })],
		});
		expect(out.targets[0]).toMatchObject({ address: "" });
	});

	it.each([
		["group", { groupOpenid: "G1" }, "G1"],
		["private", { userOpenid: "U1" }, "U1"],
	])("官机的 %s 目标取 openid", (scope, session, address) => {
		const out = migrateConfigSections({
			targets: [targetV1({ platform: "qq-official", scope, session })],
		});
		expect(out.targets[0]).toMatchObject({ address });
	});

	it("官机的频道目标:channelId 是地址,guildId 进 parentAddress", () => {
		const out = migrateConfigSections({
			targets: [
				targetV1({
					platform: "qq-official",
					scope: "channel",
					session: { guildId: "g1", channelId: "c1" },
				}),
			],
		});
		expect(out.targets[0]).toMatchObject({ address: "c1", parentAddress: "g1" });
	});

	it("没有 guildId 的频道目标不凭空造一格 parentAddress", () => {
		const out = migrateConfigSections({
			targets: [
				targetV1({ platform: "qq-official", scope: "channel", session: { channelId: "c1" } }),
			],
		});
		expect(out.targets[0]).toMatchObject({ address: "c1" });
		expect(out.targets[0]).not.toHaveProperty("parentAddress");
	});

	it("单向终点连 session 一起摘掉,不长 address", () => {
		const out = migrateConfigSections({
			targets: [targetV1({ platform: "webhook", scope: "channel", session: {} })],
		});
		expect(out.targets[0]).toMatchObject({ kind: "endpoint" });
		expect(out.targets[0]).not.toHaveProperty("session");
		expect(out.targets[0]).not.toHaveProperty("address");
	});

	it("地址没填过的老目标落空串 —— parse 得过,发的时候才报缺地址", () => {
		const out = migrateConfigSections({ targets: [targetV1({ session: {} })] });
		expect(out.targets[0]).toMatchObject({ address: "" });
		const parsed = PushTargetSchema.safeParse(out.targets[0]);
		expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
	});

	it("session 还在就算没迁完 —— 半迁移状态判得出来", () => {
		const half = [{ ...targetV1(), kind: "session" }];
		expect(detectConfigVersion({ targets: half })).toBe(1);
	});

	it("幂等:收完一遍不再报 changed", () => {
		const once = migrateConfigSections({ targets: [targetV1()] });
		const twice = migrateConfigSections({ targets: once.targets });
		expect(twice.changed.targets).toBe(false);
		expect(twice.targets).toEqual(once.targets);
	});
});

/**
 * 拓展连接(`kind: "extension"`)不归这套迁移管:它从来没有 `connector`(怎么连是桥的事),
 * 而 `platform` 是从桥报的 bot 上抄来的开放词表 —— 抄到 `onebot` 时,按「没有 connector
 * = 史前直连」去判就会给它凭空戴上 `kind: "direct"` + `connector: "http"`,改完当场过不了
 * ConnectionSchema,开机直接挂(2026-09-11 主人本地真撞过)。
 */
describe("migrateConfigSections —— 拓展连接原样放行", () => {
	const bridgedBot = (over: Record<string, unknown> = {}) => ({
		id: "33333333-3333-4333-8333-333333333333",
		name: "家里那台 koishi 上的 bot",
		enabled: true,
		kind: "extension",
		extensionId: "bridge",
		platform: "onebot",
		config: { link: "link-home", botId: "onebot:10086" },
		...over,
	});

	it("没有 connector 的拓展连接 = 已经是新形状,不触发迁移回写", () => {
		expect(detectConfigVersion({ connections: [bridgedBot()] })).toBe(CONFIG_SCHEMA_VERSION);
	});

	it("平台抄到 onebot 也不戴 direct/connector —— 戴上就过不了 schema", () => {
		const out = migrateConfigSections({ connections: [bridgedBot()] });
		expect(out.changed.connections).toBe(false);
		expect(out.connections[0]).toEqual(bridgedBot());
		expect(ConnectionSchema.safeParse(out.connections[0]).success).toBe(true);
	});

	it("与史前直连混在一张表里,只迁直连那条", () => {
		const out = migrateConfigSections({ connections: [onebotV1(), bridgedBot()] });
		expect(out.changed.connections).toBe(true);
		expect(out.connections[1]).toEqual(bridgedBot());
	});
});
