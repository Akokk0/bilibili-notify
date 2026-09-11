import { type Connection, ConnectionSchema } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { redactBackupSections, redactSecretKeys, SECRET_KEYS } from "../backup/sanitize.js";

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
		expect(out.adapters[0]?.platform).toBe("onebot");
		// url 早已不算「无辜的兄弟字段」了 —— 整条抹掉,见下面那条用例
		expect(out.adapters[0]?.config.url).toBe("ws://redacted.invalid/");
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

	it("整条抹掉网络 URL,只留 scheme —— 凭据可以藏在 query、userinfo,也可以就是路径本身", () => {
		// 主人拍板(2026-09-08):飞书 / 钉钉的 webhook 「路径即令牌」,只剥 query 是半个补丁。
		// 保留 scheme 是为了脱敏档还能导入 —— webhook 的 `z.url()` 与 OneBot 的
		// `/^wss?:\/\//` 都得过。`.invalid` 是 RFC 2606 保留域,永远解析不了:
		// 忘了重填就当场 DNS 失败,不会悄悄打到别的真实主机上。
		const input = {
			adapters: [
				{ config: { url: "https://open.feishu.cn/open-apis/bot/v2/hook/PATH-SECRET?t=Q-SECRET" } },
				{ config: { baseUrl: "http://bob:pw-SECRET@10.0.0.9:5700/" } },
				{ config: { url: "wss://napcat.example.com:6199/ws" } },
			],
		};
		const out = redactSecretKeys(input);
		const json = JSON.stringify(out);
		for (const leaked of [
			"PATH-SECRET",
			"Q-SECRET",
			"pw-SECRET",
			"10.0.0.9",
			"napcat.example.com",
		]) {
			expect(json).not.toContain(leaked);
		}
		expect(out.adapters[0]?.config.url).toBe("https://redacted.invalid/");
		expect(out.adapters[1]?.config.baseUrl).toBe("http://redacted.invalid/");
		expect(out.adapters[2]?.config.url).toBe("wss://redacted.invalid/");
	});

	it("不是网络 URL 的值原样留着 —— 空串默认值、相对路径、data: 都不该被改成占位符", () => {
		// AI 的 baseUrl 是 `z.string().default("")`,抹成占位符会把「没配」变成「配错了」。
		const out = redactSecretKeys({
			baseUrl: "",
			url: "/relative/path",
			other: { url: "data:image/png;base64,AAAA" },
		}) as { baseUrl: string; url: string; other: { url: string } };
		expect(out.baseUrl).toBe("");
		expect(out.url).toBe("/relative/path");
		expect(out.other.url).toBe("data:image/png;base64,AAAA");
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
				kind: "direct",
				connector: "http",
				config: {
					transport: "http",
					baseUrl: "http://bob:pw@127.0.0.1:5700/",
					accessToken: "tok",
					headers: { Authorization: "Bearer x" },
				},
			}),
		],
		[
			"generic",
			conn({
				...base,
				id: "00000000-0000-4000-8000-000000000002",
				platform: "generic",
				kind: "direct",
				connector: "webhook",
				config: {
					url: "https://example.com/hook?access_token=t",
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
				kind: "direct",
				connector: "ws",
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

/**
 * 拓展的密钥字段 —— **靠声明,不靠猜名字**(ADR-0012 决策 33)。
 *
 * 上面那份键名黑名单能覆盖 `token` / `accessToken` 这些约定俗成的名字,但拓展的 config
 * 形状归拓展自己定:它把密钥叫 `botKey`,黑名单**结构性地看不见**,于是原样进备份文件。
 * 而备份是主人会发出去求助的东西 —— 漏出去就收不回来了。
 *
 * 所以字段表里那格 `secret: true` 同时当脱敏的依据:声明了就抹。
 */
describe("拓展声明的密钥字段", () => {
	const sections = () => ({
		globals: {
			extensions: {
				bridge: { enabled: true, settings: { links: [{ name: "家里那台", botKey: "s3cret" }] } },
				other: { enabled: false, settings: { botKey: "别人的" } },
			},
		},
		connections: [
			{
				id: "c1",
				name: "阿库娅",
				kind: "extension",
				extensionId: "bridge",
				config: { botKey: "s3cret", note: "家里那台" },
			},
			{
				id: "c2",
				name: "NapCat",
				kind: "direct",
				platform: "onebot",
				config: { botKey: "不是拓展的", note: "直连" },
			},
		],
		targets: [{ id: "t1", name: "测试群", connectionId: "c1" }],
	});

	it("拓展说了它是密钥 → 抹平;没说的原样留着", () => {
		const out = redactBackupSections(sections(), { bridge: ["botKey"] });
		expect(out.connections[0]?.config.botKey).toBe("");
		expect(out.connections[0]?.config.note).toBe("家里那台");
	});

	/**
	 * 🔴 拓展声明的键**只对它自己那两格生效**。
	 *
	 * 并进全局键名集合的话,一个拓展把 `name` 声明成密钥,备份里**每一条**连接与目标的
	 * `name` 全成空串 —— 而 `name` 是 `min(1)`,恢复时整份被拒。「一个拓展能把整份备份
	 * 弄报废」不是任何人做过的决定。
	 */
	it("声明的键不外溢:别的连接、目标、别的拓展都不受影响", () => {
		const out = redactBackupSections(sections(), { bridge: ["name"] });
		// 它自己那一格照抹。
		expect(out.globals.extensions.bridge.settings.links[0]?.name).toBe("");
		// 旁边这些一个都不许动。
		expect(out.connections[0]?.name).toBe("阿库娅");
		expect(out.connections[1]?.config.botKey).toBe("不是拓展的");
		expect(out.targets[0]?.name).toBe("测试群");
	});

	/**
	 * 🔴 **不在表里 = 那个拓展没跑起来**(开关拨掉 / 清单坏了 / 连败停用)。字段表是代码
	 * 交上来的、清单里没有,所以问不出来 —— 问不出来就整片当密钥。此前是「问不出来就
	 * 什么都不抹」,于是**关掉一个拓展就把它连接里的密钥漏进备份文件**。
	 */
	it("拓展没跑起来 → 它的 config 与 settings 整片抹平", () => {
		const out = redactBackupSections(sections(), {});
		expect(out.connections[0]?.config).toEqual({ botKey: "", note: "" });
		expect(out.globals.extensions.bridge.settings.links[0]).toEqual({ name: "", botKey: "" });
		// 开关不是设置,不许跟着抹掉。
		expect(out.globals.extensions.bridge.enabled).toBe(true);
		// 直连那条与拓展无关,照旧只吃基础黑名单。
		expect(out.connections[1]?.config.note).toBe("直连");
	});

	it("跑起来但一格都没声明(字段表是空表)→ 只吃基础黑名单", () => {
		const out = redactBackupSections(sections(), { bridge: [], other: [] });
		expect(out.connections[0]?.config).toEqual({ botKey: "s3cret", note: "家里那台" });
	});

	it("**基础黑名单靠猜名字就是不行** —— 这条钉的正是为什么要声明", () => {
		expect(redactSecretKeys(sections()).connections[0]?.config.botKey).toBe("s3cret");
	});
});
