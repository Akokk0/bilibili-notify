/**
 * `withStoredApiKey` —— AI 试连时「没带密钥的那一格用已存的」。
 *
 * 钉的是指针那一头:草稿的 `activeProfile` 不在表里时原样交回草稿;写成 `constructor` 这类原型名也算
 * 不在表里(下标直读会从原型上摸到内置函数,接着读它的 `vision.apiKey` 就抛了,试连接口回 500)。
 */

import {
	type AISettings,
	AISettingsSchema,
	DEFAULT_AI,
	EMPTY_AI_PROVIDER_PROFILE,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { withStoredApiKey } from "../ai.js";

/** 不拿整份去过 schema:要造的正是 schema 会拒的指针(防的是绕过了 schema 的那一条路)。 */
function settings(over: Partial<AISettings> = {}): AISettings {
	return { ...AISettingsSchema.parse(structuredClone(DEFAULT_AI)), ...over };
}

describe("withStoredApiKey", () => {
	const stored = settings({
		activeProfile: "mine",
		providers: { mine: { ...EMPTY_AI_PROVIDER_PROFILE, provider: "deepseek", apiKey: "sk-saved" } },
	});

	it("草稿没带密钥:补上已存的那一把", () => {
		const draft = settings({
			activeProfile: "mine",
			providers: { mine: { ...EMPTY_AI_PROVIDER_PROFILE, provider: "deepseek" } },
		});
		const got = withStoredApiKey(draft, stored, { providers: { mine: {} } });
		expect(got.providers.mine?.apiKey).toBe("sk-saved");
	});

	it("指针指着表里没有的名字:原样交回草稿", () => {
		const draft = settings({ activeProfile: "nope" });
		expect(withStoredApiKey(draft, stored, {})).toBe(draft);
	});

	it.each(["constructor", "toString", "__proto__"])(
		"指针是原型名 %s:与表里没有的名字一样原样交回,不抛",
		(name) => {
			const draft = settings({ activeProfile: name });
			expect(withStoredApiKey(draft, stored, { providers: { [name]: {} } })).toBe(draft);
		},
	);
});
