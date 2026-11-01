/**
 * 拓展连接:挑中的 bot → 一条连接(ADR-0012 决策 45),以及拓展交上来的**连接配置项**
 * (决策 33)→ 推送目标页画得出来的那几栏。
 *
 * 连接就是一个 bot:settings 是拓展在候选(`listConnectionCandidates`)里交出来的那份,原样存;平台从候选上抄;
 * 名字没填就用 bot 的。字段表那一半只对「要人填」的拓展有意义(桥的是空表)。
 */

import type { ConnectionCandidatesResponse, SettingsScalarField } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { connectionSettingsFields } from "../connection-fields";
import { connectionFromCandidate, makeConnectionDraft, type NewConnection } from "../domain";

const BOT: ConnectionCandidatesResponse["candidates"][number] = {
	name: "小电视",
	platform: {
		platform: "telegram",
		label: "telegram",
		shortLabel: "telegram",
		color: "#94a3b8",
		targetKind: "session",
		scopes: ["group", "private", "channel"],
		addressNouns: {},
	},
	settings: { link: "link-home", botId: "telegram:7777" },
	selfId: "7777",
	via: "家里那台",
};

const FIELDS: readonly SettingsScalarField[] = [
	{
		type: "enum",
		key: "flavor",
		label: "口味",
		required: true,
		options: [
			{ value: "a", label: "A" },
			{ value: "b", label: "B" },
		],
	},
	{ type: "string", key: "note", label: "备注" },
	{ type: "number", key: "retries", label: "重试", min: 0 },
	{ type: "boolean", key: "loud", label: "吵" },
];

describe("connectionFromCandidate", () => {
	it("挂在那个拓展名下:平台从 bot 上抄,settings 原样,名字没填就用 bot 的", () => {
		const c = connectionFromCandidate("bridge", BOT, "");
		expect(c).toMatchObject({
			adapterKey: "bridge",
			platform: "telegram",
			name: "小电视",
			enabled: true,
			settings: { link: "link-home", botId: "telegram:7777" },
		});
		expect(c.id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("主人填了名字就用主人的", () => {
		expect(connectionFromCandidate("bridge", BOT, "电报那台").name).toBe("电报那台");
	});

	it("还没挑 bot 的草稿:平台空着 —— 空平台存不了,弹窗按它灰掉保存钮", () => {
		const draft = makeConnectionDraft("bridge", "x");
		expect(draft).toMatchObject({ adapterKey: "bridge", platform: "" });
	});
});

describe("connectionSettingsFields", () => {
	const connection: NewConnection = {
		...connectionFromCandidate("demo", BOT, ""),
		settings: { flavor: "a", note: "", retries: 0, loud: false },
	};

	it("字段表一栏翻一栏,身份带着拓展 id —— 与内置平台的字段不撞", () => {
		const fields = connectionSettingsFields(connection, FIELDS);
		expect(fields.map((f) => ("code" in f ? f.code : f.kind))).toEqual([
			"settings.flavor",
			"settings.note",
			"settings.retries",
			"settings.loud",
		]);
	});

	it("改一栏只落自己那一格,别的格原样", () => {
		const [flavor] = connectionSettingsFields(connection, FIELDS);
		if (flavor?.kind !== "select") throw new Error("第一栏该是 select");
		const next = flavor.set("b");
		expect(next.settings).toEqual({ flavor: "b", note: "", retries: 0, loud: false });
		expect(next.platform).toBe("telegram");
	});

	it("settings 里没有这一格时显示字段自己声明的 default —— 不然显示关、存下去拓展补成开", () => {
		// 键缺省时拓展那份 zod 会补成 default:表单要是画成「关」/ 第一项,主人不碰就存,
		// 屏幕上的和实际生效的就是两个值。
		const bare: NewConnection = { ...connection, settings: {} };
		const fields = connectionSettingsFields(bare, [
			{ type: "boolean", key: "loud", label: "吵", default: true },
			{
				type: "enum",
				key: "flavor",
				label: "口味",
				options: [
					{ value: "a", label: "A" },
					{ value: "b", label: "B" },
				],
				default: "b",
			},
			{ type: "string", key: "note", label: "备注", default: "你好" },
			{ type: "number", key: "retries", label: "重试", min: 0, default: 3 },
		]);
		expect(fields.map((f) => ("value" in f ? f.value : undefined))).toEqual([true, "b", "你好", 3]);
	});

	it("没声明 default 的照旧:关 / 第一项 / 空串 / min", () => {
		const bare: NewConnection = { ...connection, settings: {} };
		const fields = connectionSettingsFields(bare, [
			...FIELDS.slice(0, 2),
			{ type: "number", key: "retries", label: "重试", min: 2 },
			FIELDS[3] as SettingsScalarField,
		]);
		expect(fields.map((f) => ("value" in f ? f.value : undefined))).toEqual(["a", "", 2, false]);
	});

	it("存着的值压过 default —— default 只管键缺省", () => {
		const fields = connectionSettingsFields(connection, [
			{ type: "boolean", key: "loud", label: "吵", default: true },
			{
				type: "enum",
				key: "flavor",
				label: "口味",
				options: [
					{ value: "a", label: "A" },
					{ value: "b", label: "B" },
				],
				default: "b",
			},
		]);
		expect(fields.map((f) => ("value" in f ? f.value : undefined))).toEqual([false, "a"]);
	});

	it("空字段表翻出来就是空的 —— 桥那种「挑出来的」连接没有一栏是人填的", () => {
		expect(connectionSettingsFields(connection, [])).toEqual([]);
	});
});

it("按描述显示分支、改写分支草稿、保留凭据,键值表与平台提示不依赖适配器名", () => {
	const connection: NewConnection = {
		id: "c",
		name: "relay",
		enabled: true,
		adapterKey: "unfamiliar",
		platform: "chat",
		settings: { mode: "out", url: "https://old.test", token: "saved", retries: 0 },
	};
	const descriptors = [
		{
			key: "mode",
			type: "enum" as const,
			label: "方式",
			options: [
				{ value: "out", label: "连出" },
				{ value: "in", label: "连入" },
			],
			variants: {
				in: {
					settings: { mode: "in", port: 9000, retries: 3 },
					preserve: [{ key: "token" }, { key: "retries", truthy: true }],
				},
			},
		},
		{
			key: "url",
			type: "string" as const,
			label: "地址",
			when: { key: "mode", value: "out" },
			byPlatform: { chat: { placeholder: "https://chat.test" } },
		},
		{ key: "port", type: "number" as const, label: "端口", when: { key: "mode", value: "in" } },
		{ key: "headers", type: "record" as const, label: "请求头", default: {} },
		{ key: "token", type: "string" as const, label: "令牌", secret: true },
	];
	const fields = connectionSettingsFields(connection, descriptors);
	expect(fields.some((field) => "code" in field && field.code === "settings.port")).toBe(false);
	expect(fields.find((field) => "code" in field && field.code === "settings.url")).toMatchObject({
		placeholder: "https://chat.test",
	});
	expect(
		fields.find((field) => "code" in field && field.code === "settings.headers"),
	).toMatchObject({ kind: "headers", value: {} });
	expect(fields.find((field) => "code" in field && field.code === "settings.token")).toMatchObject({
		credential: true,
	});
	const selector = fields[0];
	if (selector?.kind !== "select" && selector?.kind !== "chips")
		throw new Error("missing selector");
	expect(selector.set("in").settings).toEqual({
		mode: "in",
		port: 9000,
		retries: 3,
		token: "saved",
	});
});
