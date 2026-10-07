import {
	type Connection,
	OnebotHttpConfigSchema,
	OnebotWsConfigSchema,
	OnebotWsReverseConfigSchema,
	QQOfficialConnectionConfigSchema,
	stringLeavesOf,
	WebhookConnectionConfigSchema,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { credentialCellsOf } from "../connection-credentials";

/**
 * 面板那张「哪条连接哪几个键是凭据」的表(`connection-credentials.ts`)与 schema 上的 `secret` 标记对拍。
 *
 * 表是手写的,错一格的后果是静默的:漏一格 → 编辑时那一格的遮挡被当成普通值,或没动的凭据被发出去;
 * 多一格 → 普通字段被当成「已存着的凭据」画成胶囊。两边必须一致。
 *
 * 按**分支**逐个比,不取并集:OneBot ws 的 `url` 不是凭据(`backupOnly`)、webhook 的 `url` 是 ——
 * 同名不同义正是这条要钉住的地方。`backupOnly` 那档(地址、请求头的值)不进面板的表。
 * 拓展连接那一支(`config: z.unknown()`)不在表里:它的密钥由拓展清单声明,本片不覆盖。
 */
const base = { id: "11111111-1111-4111-8111-111111111111", name: "n", enabled: true } as const;

/** 只有 kind / connector / platform 决定面板表的取法,其余格对这条测试无关。 */
const direct = (platform: string, connector: string) =>
	({ ...base, kind: "direct", platform, connector, config: {} }) as unknown as Connection;

const VARIANTS: Array<[string, Connection, Parameters<typeof stringLeavesOf>[0]]> = [
	["OneBot http", direct("onebot", "http"), OnebotHttpConfigSchema],
	["OneBot ws", direct("onebot", "ws"), OnebotWsConfigSchema],
	["OneBot ws-reverse", direct("onebot", "ws-reverse"), OnebotWsReverseConfigSchema],
	["webhook", direct("dingtalk", "webhook"), WebhookConnectionConfigSchema],
	["QQ 官方", direct("qq-official", "ws"), QQOfficialConnectionConfigSchema],
];

describe("面板凭据格表 ≡ schema 的 secret 标记", () => {
	it.each(VARIANTS)("%s", (_name, connection, configSchema) => {
		const secretLeaves = stringLeavesOf(configSchema).filter(
			(leaf) => leaf.mark !== undefined && "secret" in leaf.mark,
		);
		// 凭据都是 config 下的单层叶子;嵌套的(headers 的值)是 backupOnly,不会落到这里。
		expect(secretLeaves.every((leaf) => leaf.path.length === 1)).toBe(true);
		const fromSchema = secretLeaves.map((leaf) => leaf.path[0]).sort();
		const fromTable = credentialCellsOf(connection)
			.map((cell) => cell.key)
			.sort();
		expect(fromTable).toEqual(fromSchema);
	});

	it("同名不同义的反例:ws 的 url 不在表里,webhook 的 url 在", () => {
		expect(credentialCellsOf(direct("onebot", "ws")).map((c) => c.key)).not.toContain("url");
		expect(credentialCellsOf(direct("dingtalk", "webhook")).map((c) => c.key)).toContain("url");
	});

	it("拓展连接不在表里(密钥由拓展清单声明,本片不覆盖)", () => {
		const ext = { ...base, kind: "extension", extensionId: "bridge", platform: "qq", config: {} };
		expect(credentialCellsOf(ext as unknown as Connection)).toEqual([]);
	});
});
