/**
 * 字段表与 zod schema 对表。
 *
 * 连接的 settings 有哪些格子由 schema 说了算,面板上能不能填由字段表说了算 —— 两边各写
 * 一份,谁也没核对过谁。往 schema 里加一格、忘了往表里加一栏,类型全绿、保存也全绿,
 * 只是主人**永远填不到那一格**(只能改盘上的 JSON 或者打 API)。
 *
 * 这条守卫要求两边逐格对齐;真不打算给的格子必须写进 {@link HIDDEN} 并说明理由 ——
 * 「不给填」可以,「忘了给」不行,差别就在有没有人写下那句话。
 */

import {
	OnebotHttpSettingsSchema,
	OnebotWsReverseSettingsSchema,
	OnebotWsSettingsSchema,
	QQOfficialConnectionSettingsSchema,
	WebhookConnectionSettingsSchema,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { connectionFields } from "../connection-fields";
import {
	makeEmptyConnection,
	type NewConnection,
	type OnebotConnectionSettings,
	type OnebotTransport,
	switchOnebotTransport,
} from "../domain";

/** 只要 `.shape` 这一格 —— web 不依赖 zod,别把它的类型拖进来。 */
type ShapeCarrier = { shape: Record<string, unknown> };

/** 刻意不给主人填的格子 —— 键是 `<用例>.<settings 键>`,值是为什么。 */
const HIDDEN: Record<string, string> = {
	"onebot-http.protocolVersion": "首期固定 v11,留位以便后续扩展 v12;面板不给改",
	"onebot-ws.protocolVersion": "同 onebot-http:固定 v11,面板不给改",
	"onebot-ws-reverse.protocolVersion": "同 onebot-http:固定 v11,面板不给改",
};

function codesOf(connection: NewConnection): string[] {
	return connectionFields(connection)
		.map((f) => (f.kind === "qq-bind" || f.kind === "ws-reverse-address" ? "" : f.code))
		.filter(Boolean)
		.map((code) => code.replace(/^settings\./, ""));
}

function keysOf(schema: ShapeCarrier): string[] {
	return Object.keys(schema.shape);
}

/** 一条走指定连法的 OneBot 连接 —— 初值与面板新建的那条同源。 */
function onebotWith(transport: OnebotTransport): NewConnection {
	const base = makeEmptyConnection("onebot", "ob");
	if (base.adapterKey !== "onebot")
		throw new Error("makeEmptyConnection('onebot') 不再回 onebot 了");
	return {
		...base,
		settings: switchOnebotTransport(base.settings as OnebotConnectionSettings, transport),
	};
}

const CASES: Array<{ name: string; connection: NewConnection; schema: ShapeCarrier }> = [
	{ name: "onebot-http", connection: onebotWith("http"), schema: OnebotHttpSettingsSchema },
	{ name: "onebot-ws", connection: onebotWith("ws"), schema: OnebotWsSettingsSchema },
	{
		name: "onebot-ws-reverse",
		connection: onebotWith("ws-reverse"),
		schema: OnebotWsReverseSettingsSchema,
	},
	{
		name: "qq-official",
		connection: makeEmptyConnection("qq-official", "qq"),
		schema: QQOfficialConnectionSettingsSchema,
	},
	{
		name: "webhook-official",
		connection: makeEmptyConnection("feishu", "fs"),
		schema: WebhookConnectionSettingsSchema,
	},
	{
		name: "webhook-generic",
		connection: makeEmptyConnection("generic", "自建端点"),
		schema: WebhookConnectionSettingsSchema,
	},
];

describe("字段表覆盖 settings schema", () => {
	it.each(CASES)("$name:每一格要么有一栏,要么写明为什么不给", ({ name, connection, schema }) => {
		const shown = new Set(codesOf(connection));
		const missing = keysOf(schema).filter((key) => !shown.has(key) && !HIDDEN[`${name}.${key}`]);
		expect(missing).toEqual([]);
	});

	it.each(CASES)("$name:没有多出来的栏 —— 表里的键 schema 得认得", ({ connection, schema }) => {
		const keys = new Set(keysOf(schema));
		expect(codesOf(connection).filter((code) => !keys.has(code))).toEqual([]);
	});
});

describe("扫码行", () => {
	it("qq-bind 一格带着这条连接的 adapterKey(扫码的路径靠它拼)", () => {
		const connection = makeEmptyConnection("qq-official", "qq");
		const bind = connectionFields(connection).find((f) => f.kind === "qq-bind");
		expect(bind).toMatchObject({ kind: "qq-bind", adapterKey: connection.adapterKey });
		expect(connection.adapterKey).toBeTruthy();
	});
});

describe("HIDDEN 名单本身", () => {
	it("每一条都得写理由,而且真的被用上 —— 不许留过期条目", () => {
		for (const [entry, why] of Object.entries(HIDDEN)) {
			expect(why.length, entry).toBeGreaterThan(4);
		}
		const used = new Set<string>();
		for (const { name, connection, schema } of CASES) {
			const shown = new Set(codesOf(connection));
			for (const key of keysOf(schema)) if (!shown.has(key)) used.add(`${name}.${key}`);
		}
		expect(Object.keys(HIDDEN).filter((entry) => !used.has(entry))).toEqual([]);
	});
});
