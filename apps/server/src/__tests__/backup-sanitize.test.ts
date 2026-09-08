import { type Connection, ConnectionSchema } from "@bilibili-notify/internal";
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

	it("blanks every leaf under a `keys` container —— 搜索 key 的叶子键名是后端名,白名单认不出", () => {
		// 真实泄漏案:ai.search.keys 的叶子键叫 bocha/tavily(后端枚举,不是 apiKey),
		// 按键名的白名单永远追不上新后端 —— 容器名 `keys` 本身就是「里面全是凭据」。
		const input = {
			defaults: {
				ai: {
					search: { backend: "bocha", keys: { bocha: "sk-BOCHA-SECRET", tavily: "tvly-SECRET" } },
				},
			},
		};
		const json = JSON.stringify(redactSecretKeys(input));
		expect(json).not.toContain("sk-BOCHA-SECRET");
		expect(json).not.toContain("tvly-SECRET");
		// 形状保留:键还在,值抹空
		expect(redactSecretKeys(input).defaults.ai.search.keys).toEqual({ bocha: "", tavily: "" });
		// backend 不是凭据,不许误伤
		expect(redactSecretKeys(input).defaults.ai.search.backend).toBe("bocha");
	});

	it("blanks every header value —— 自定义鉴权头的键名是用户自己起的,白名单认不出", () => {
		// onebot 与 webhook 的 config 都有 `headers`,schema 注释自己写着「例如
		// 自定义鉴权头 / Authorization」。键名由用户随手起(Authorization / X-Token /
		// 公司自定义),按键名的白名单永远追不上 —— 容器名 `headers` 才是稳定信号。
		const input = {
			adapters: [
				{
					config: {
						transport: "ws",
						url: "ws://host",
						headers: { Authorization: "Bearer hdr-SECRET", "X-Company-Key": "xck-SECRET" },
					},
				},
			],
		};
		const json = JSON.stringify(redactSecretKeys(input));
		expect(json).not.toContain("hdr-SECRET");
		expect(json).not.toContain("xck-SECRET");
		// 形状保留:头名还在(用户才知道要重填哪几个),只有值被抹空
		expect(redactSecretKeys(input).adapters[0]?.config.headers).toEqual({
			Authorization: "",
			"X-Company-Key": "",
		});
	});

	it("strips credentials carried inside a URL —— ?access_token= 与 user:pass@ 都不是叶子", () => {
		// webhook 的 url 常自带凭据(`?access_token=`),onebot 的 baseUrl 也可能带
		// userinfo。它们不是「某个叫 token 的叶子」,深走键名的白名单根本看不见。
		const input = {
			adapters: [
				{ config: { url: "https://example.com/hook?access_token=url-SECRET&a=1" } },
				{ config: { baseUrl: "http://bob:pw-SECRET@127.0.0.1:5700/" } },
			],
		};
		const out = redactSecretKeys(input);
		const json = JSON.stringify(out);
		expect(json).not.toContain("url-SECRET");
		expect(json).not.toContain("pw-SECRET");
		// 端点本身留着 —— 脱敏档还得能看出这条连接原本指向哪
		expect(out.adapters[0]?.config.url).toBe("https://example.com/hook");
		expect(out.adapters[1]?.config.baseUrl).toBe("http://127.0.0.1:5700/");
	});

	it("leaves a URL without credentials byte-identical", () => {
		const out = redactSecretKeys({ url: "ws://127.0.0.1:6199/", baseUrl: "http://h:5700" }) as {
			url: string;
			baseUrl: string;
		};
		expect(out.url).toBe("ws://127.0.0.1:6199/");
		expect(out.baseUrl).toBe("http://h:5700");
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

/**
 * 脱敏档能被**恢复**,靠的是一条不变式:抹掉机密后的对象仍然通过 schema。
 * sanitize.ts 的注释一直这么宣称 —— 但从没有测试拿真 schema 校验过,于是
 * `appSecret: z.string().min(1)` 悄悄把它证伪了:qq-official 的脱敏备份一导入就
 * `ConfigValidationError(scope=adapters)`,整个脱敏档对该平台用户直接报废。
 *
 * 所以这里逐平台钉死不变式。往后任何平台再给机密字段加非空约束,红在这里,
 * 而不是红在用户的恢复按钮上。
 */
describe("脱敏后的 adapter 仍能通过 ConnectionSchema", () => {
	const base = { name: "n", enabled: true } as const;
	// 走真 schema 造夹具而不是 `as Connection` 硬转:带 default 的字段(protocolVersion /
	// 各种超时)由 parse 补齐,夹具就是运行时真正会落盘的那个形状。
	const conn = (v: unknown) => ConnectionSchema.parse(v);
	const adapters: Array<[string, Connection]> = [
		[
			"onebot",
			conn({
				...base,
				id: "00000000-0000-4000-8000-000000000001",
				platform: "onebot",
				config: {
					transport: "http",
					baseUrl: "http://bob:pw@127.0.0.1:5700/",
					accessToken: "tok",
					headers: { Authorization: "Bearer x" },
				},
			}),
		],
		[
			"webhook",
			conn({
				...base,
				id: "00000000-0000-4000-8000-000000000002",
				platform: "webhook",
				config: {
					url: "https://example.com/hook?access_token=t",
					provider: "generic",
					secret: "wh",
					headers: { "X-Token": "x" },
				},
			}),
		],
		[
			"qq-official",
			conn({
				...base,
				id: "00000000-0000-4000-8000-000000000005",
				platform: "qq-official",
				config: { appId: "102000000", appSecret: "app-secret" },
			}),
		],
	];

	it.each(adapters)("%s", (_platform, adapter) => {
		const parsed = ConnectionSchema.safeParse(redactSecretKeys(adapter));

		// 失败时把 zod 的 issue 打出来,别只看到一句 "expected true"。
		expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
	});
});
