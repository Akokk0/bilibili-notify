import {
	OnebotHttpSettingsSchema,
	OnebotWsReverseSettingsSchema,
	OnebotWsSettingsSchema,
} from "../onebot-settings.js";
import { QQOfficialConnectionSettingsSchema } from "../qq-official-settings.js";
import { WebhookConnectionSettingsSchema } from "../webhook-settings.js";

/**
 * 三份连接设置规则里 `secret` 叶子的**字面清单**。
 *
 * 下发打码、备份脱敏、面板的凭据格表读的都是这几个标记。标记丢了一个是静默的:schema 照样过、
 * 连接照样存得下,只是那一格明文下发 / 明文进备份。所以这里把清单写成字面量 —— 加 / 摘一个标记
 * 都得来改这份清单,改的人就得在这儿看见自己在动什么。
 *
 * 面板的 `connection-credentials-schema.test.ts` 拿同样的 schema 对拍面板的凭据格表,两头互相钉。
 */

import { stringLeavesOf } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";

const secretLeavesOf = (schema: unknown): string[] =>
	stringLeavesOf(schema)
		.filter((leaf) => leaf.mark && "secret" in leaf.mark)
		.map((leaf) => leaf.path.join("."))
		.sort();

describe("设置规则里的 secret 叶子", () => {
	it("OneBot 三支都只有 accessToken", () => {
		expect(secretLeavesOf(OnebotHttpSettingsSchema)).toEqual(["accessToken"]);
		expect(secretLeavesOf(OnebotWsSettingsSchema)).toEqual(["accessToken"]);
		expect(secretLeavesOf(OnebotWsReverseSettingsSchema)).toEqual(["accessToken"]);
	});

	it("webhook:url 与 secret(webhook 地址常把 token 放在路径里)", () => {
		expect(secretLeavesOf(WebhookConnectionSettingsSchema)).toEqual(["secret", "url"]);
	});

	it("QQ 官方:appSecret", () => {
		expect(secretLeavesOf(QQOfficialConnectionSettingsSchema)).toEqual(["appSecret"]);
	});
});
