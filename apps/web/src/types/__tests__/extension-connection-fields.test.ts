/**
 * 拓展连接:挑中的 bot → 一条连接(ADR-0012 决策 45),以及拓展交上来的**字段表**
 * (决策 33)→ 推送目标页画得出来的那几栏。
 *
 * 连接就是一个 bot:config 是拓展在 `listBots` 里交出来的那份,原样存;平台从 bot 上抄;
 * 名字没填就用 bot 的。字段表那一半只对「要人填」的拓展有意义(桥的是空表)。
 */

import type { ExtensionBotView, ExtensionConfigField } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { extensionConnectionFields } from "../connection-fields";
import {
	type ExtensionConnection,
	makeEmptyExtensionConnection,
	makeExtensionConnectionDraft,
} from "../domain";

const BOT: ExtensionBotView = {
	config: { link: "link-home", botId: "telegram:7777" },
	platform: "telegram",
	name: "小电视",
	selfId: "7777",
	via: "家里那台",
};

const FIELDS: readonly ExtensionConfigField[] = [
	{
		kind: "select",
		code: "flavor",
		label: "口味",
		required: true,
		options: [
			{ value: "a", label: "A" },
			{ value: "b", label: "B" },
		],
	},
	{ kind: "text", code: "note", label: "备注" },
	{ kind: "number", code: "retries", label: "重试", min: 0 },
	{ kind: "toggle", code: "loud", label: "吵" },
];

describe("makeEmptyExtensionConnection", () => {
	it("挂在那个拓展名下:平台从 bot 上抄,config 原样,名字没填就用 bot 的", () => {
		const c = makeEmptyExtensionConnection("bridge", BOT, "");
		expect(c).toMatchObject({
			kind: "extension",
			extensionId: "bridge",
			platform: "telegram",
			name: "小电视",
			enabled: true,
			config: { link: "link-home", botId: "telegram:7777" },
		});
		expect(c.id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("主人填了名字就用主人的", () => {
		expect(makeEmptyExtensionConnection("bridge", BOT, "电报那台").name).toBe("电报那台");
	});

	it("还没挑 bot 的草稿:平台空着 —— 空平台存不了,弹窗按它灰掉保存钮", () => {
		const draft = makeExtensionConnectionDraft("bridge", "x");
		expect(draft).toMatchObject({ kind: "extension", extensionId: "bridge", platform: "" });
	});
});

describe("extensionConnectionFields", () => {
	const connection: ExtensionConnection = {
		...makeEmptyExtensionConnection("demo", BOT, ""),
		config: { flavor: "a", note: "", retries: 0, loud: false },
	};

	it("字段表一栏翻一栏,身份带着拓展 id —— 与内置平台的字段不撞", () => {
		const fields = extensionConnectionFields(connection, FIELDS);
		expect(fields.map((f) => ("code" in f ? f.code : f.kind))).toEqual([
			"ext.demo.flavor",
			"ext.demo.note",
			"ext.demo.retries",
			"ext.demo.loud",
		]);
	});

	it("改一栏只落自己那一格,别的格原样", () => {
		const [flavor] = extensionConnectionFields(connection, FIELDS);
		if (flavor?.kind !== "select") throw new Error("第一栏该是 select");
		const next = flavor.set("b") as ExtensionConnection;
		expect(next.config).toEqual({ flavor: "b", note: "", retries: 0, loud: false });
		expect(next.platform).toBe("telegram");
	});

	it("空字段表翻出来就是空的 —— 桥那种「挑出来的」连接没有一栏是人填的", () => {
		expect(extensionConnectionFields(connection, [])).toEqual([]);
	});
});
