import { describe, expect, it } from "vite-plus/test";
import { CONFIG_SCHEMA_VERSION, detectConfigVersion, migrateConfigSections } from "./migration.js";
import { ConnectionSchema } from "./targets.js";

/**
 * 配置形状迁移 —— 「怎么连」从 config 里那个 transport 提上来,成为连接自己的一根轴。
 *
 * 判据是**数据形状**而不是版本号:版本文件可能写到一半掉电、也可能被用户手删,
 * 而「这条连接有没有 connector」是自明的。版本号只用来挡降级(旧载荷读到更新的盘)。
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

describe("detectConfigVersion", () => {
	it("没有 connector 的连接 = 老形状", () => {
		expect(detectConfigVersion([onebotV1()])).toBe(1);
	});

	it("每条都有 connector = 新形状", () => {
		expect(
			detectConfigVersion(migrateConfigSections({ connections: [onebotV1()] }).connections),
		).toBe(CONFIG_SCHEMA_VERSION);
	});

	it("空表算新形状 —— 全新安装不该被当成待迁移", () => {
		expect(detectConfigVersion([])).toBe(CONFIG_SCHEMA_VERSION);
	});

	it("混着的算老形状 —— 上次迁移写到一半掉电,必须再走一遍", () => {
		const migrated = migrateConfigSections({ connections: [onebotV1()] }).connections[0];
		expect(detectConfigVersion([migrated, onebotV1({ id: "x" })])).toBe(1);
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
		expect(once.changed).toBe(true);
		const twice = migrateConfigSections({ connections: once.connections });
		expect(twice.changed).toBe(false);
		expect(twice.connections).toEqual(once.connections);
	});

	it("不认识的平台原样放行 —— 已撤下的平台由加载器静默丢弃,不该在这里炸", () => {
		const alien = { id: "a", name: "n", enabled: true, platform: "web-dashboard", config: {} };
		const out = migrateConfigSections({ connections: [alien] });
		expect(out.connections[0]).toEqual(alien);
	});

	it("targets 这一版不动 —— 只有连接侧长出了新轴", () => {
		const targets = [{ id: "t", adapterId: "a", platform: "onebot" }];
		const out = migrateConfigSections({ connections: [], targets });
		expect(out.targets).toEqual(targets);
	});
});
