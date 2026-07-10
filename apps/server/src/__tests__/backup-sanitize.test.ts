import { describe, expect, it } from "vite-plus/test";
import { redactSecretKeys, SECRET_KEYS } from "../backup/sanitize.js";

/**
 * redactSecretKeys 是脱敏档的安全核心:平台无关地按密钥名深度抹除机密值,
 * 从结构上保证「逐平台字段清单漏一个就泄密」不会发生。断言以「原样种入的机密
 * 哨兵串不得在序列化输出里幸存」为准 —— 比逐字段断言更抗回归。
 */
describe("redactSecretKeys", () => {
	it("blanks secret-named leaf values anywhere in the tree, keeps non-secret siblings", () => {
		const input = {
			defaults: { ai: { apiKey: "sk-SECRET", model: "gpt-x" } },
			adapters: [
				{ id: "a1", platform: "onebot", config: { url: "ws://host", accessToken: "tok-SECRET" } },
			],
			targets: [{ id: "t1", session: { group: "123", token: "sess-SECRET" } }],
			nested: {
				deep: {
					appSecret: "app-SECRET",
					secret: "wh-SECRET",
					password: "pw-SECRET",
					refreshToken: "rt-SECRET",
				},
			},
		};

		const out = redactSecretKeys(input);
		const json = JSON.stringify(out);
		for (const leaked of [
			"sk-SECRET",
			"tok-SECRET",
			"sess-SECRET",
			"app-SECRET",
			"wh-SECRET",
			"pw-SECRET",
			"rt-SECRET",
		]) {
			expect(json).not.toContain(leaked);
		}

		// non-secret siblings survive untouched
		expect(out.defaults.ai.model).toBe("gpt-x");
		expect(out.adapters[0]?.config.url).toBe("ws://host");
		expect(out.targets[0]?.session.group).toBe("123");
	});

	it("does not mutate the input", () => {
		const input = { a: { apiKey: "sk-SECRET" } };
		redactSecretKeys(input);
		expect(input.a.apiKey).toBe("sk-SECRET");
	});

	it("blanks to empty string so the key stays present (schema shape preserved)", () => {
		const out = redactSecretKeys({ apiKey: "x" }) as { apiKey: string };
		expect(out.apiKey).toBe("");
	});

	it("exposes the secret-key denylist for cross-checking", () => {
		expect(SECRET_KEYS).toContain("apiKey");
		expect(SECRET_KEYS).toContain("accessToken");
		expect(SECRET_KEYS).toContain("appSecret");
	});
});
