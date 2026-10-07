import {
	AIProviderProfileSchema,
	ConnectionSchema,
	GlobalConfigSchema,
	makeDefaultGlobalConfig,
	stringLeavesOf,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import {
	collectRedactions,
	redactBackupSections,
	redactSecretKeys,
	SECRET_KEYS,
} from "../backup/sanitize.js";

/**
 * 备份脱敏的判据从「键名黑名单」换成「schema 上的标记」(ADR-0021 决策 44)。换判据不许改结果:
 * 被抹的叶子集合改前改后必须**逐叶子相同** —— 缩水 = 完整档恢复后那格是占位符且没人报警,
 * 多抹 = 脱敏档恢复不回来。
 *
 * 两道钉子:
 * 1. 一份覆盖每种连接形状与每个 AI / 市场源密钥位的夹具,被抹的叶子路径与**字面清单**对上
 *    (清单是换判据之前从旧实现录下来的);
 * 2. 同一份夹具,新判据的整份输出与旧的键名黑名单(`redactSecretKeys`,留作参照与守卫)逐字节相等。
 */

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = { name: "n", enabled: true, kind: "direct" } as const;

function sections() {
	const globals = makeDefaultGlobalConfig();
	globals.defaults.ai.providers.ds = AIProviderProfileSchema.parse({
		provider: "deepseek",
		apiKey: "k-main",
		baseUrl: "https://api.example/v1",
		vision: { apiKey: "k-vision", baseUrl: "https://v.example/v1" },
	});
	globals.defaults.ai.providers.other = AIProviderProfileSchema.parse({ provider: "custom" });
	globals.defaults.ai.search.keys = { bocha: "k-bocha", tavily: "" };
	globals.bootstrap = {
		server: { host: "0.0.0.0", port: 8787 },
		dataDir: "data",
		cookieEncryptionKey: "0123456789abcdef",
		dashboardAuth: { username: "u", password: "dash-pw" },
	};
	globals.marketplace = { sources: [{ id: "s1", url: "https://m.example/index.json" }] };
	const connections = [
		{
			...base,
			id: ID(1),
			platform: "onebot",
			connector: "http",
			config: {
				transport: "http",
				baseUrl: "http://bob:pw@127.0.0.1:5700/",
				accessToken: "tok",
				headers: { Authorization: "Bearer x" },
			},
		},
		{
			...base,
			id: ID(2),
			platform: "onebot",
			connector: "ws",
			config: { transport: "ws", url: "ws://bot:3001", headers: { A: "1" } },
		},
		{
			...base,
			id: ID(3),
			platform: "onebot",
			connector: "ws-reverse",
			config: { transport: "ws-reverse", port: 6700, accessToken: "rev" },
		},
		{
			...base,
			id: ID(4),
			platform: "generic",
			connector: "webhook",
			config: {
				url: "https://example.com/hook?access_token=t",
				secret: "wh",
				headers: { "X-Token": "x" },
			},
		},
		{
			...base,
			id: ID(5),
			platform: "feishu",
			connector: "webhook",
			config: { url: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" },
		},
		{
			...base,
			id: ID(6),
			platform: "qq-official",
			connector: "ws",
			config: { appId: "102000000", appSecret: "app-secret" },
		},
	].map((c) => ConnectionSchema.parse(c));
	const extensionConnection = {
		id: ID(7),
		name: "桥",
		enabled: true,
		kind: "extension",
		extensionId: "bridge",
		platform: "qq",
		config: { token: "ext-token", botKey: "bk", note: "家里" },
	};
	return {
		globals,
		integrations: { bilibili: { token: "i-tok", cron: "0 * * * *" } },
		extensionSettings: { bridge: { token: "es-tok", links: [{ name: "a", password: "p" }] } },
		subscriptions: [{ id: "s", name: "UP", note: "token 在这里只是文字" }],
		connections: [...connections, extensionConnection],
		targets: [{ id: "t", name: "群", connectionId: ID(1) }],
	};
}

const EXPECTED_ERASED_PATHS = [
	"connections.0.config.accessToken",
	"connections.0.config.baseUrl",
	"connections.0.config.headers.Authorization",
	"connections.1.config.headers.A",
	"connections.1.config.url",
	"connections.2.config.accessToken",
	"connections.3.config.headers.X-Token",
	"connections.3.config.secret",
	"connections.3.config.url",
	"connections.4.config.url",
	"connections.5.config.appSecret",
	"connections.6.config.token",
	"extensionSettings.bridge.links.0.password",
	"extensionSettings.bridge.token",
	"globals.bootstrap.dashboardAuth.password",
	"globals.defaults.ai.providers.ds.apiKey",
	"globals.defaults.ai.providers.ds.baseUrl",
	"globals.defaults.ai.providers.ds.vision.apiKey",
	"globals.defaults.ai.providers.ds.vision.baseUrl",
	"globals.marketplace.sources.0.url",
	"integrations.bilibili.token",
].sort();

// 搜索 key 里 tavily 本来就是空串(抹不抹结果一样,不进叶子清单),bocha 在。
const EXPECTED_WITH_SEARCH = [
	...EXPECTED_ERASED_PATHS,
	"globals.defaults.ai.search.keys.bocha",
].sort();

const NO_CODES = new Map([["bridge", [] as string[]]]);

describe("备份脱敏换判据:被抹的叶子逐叶子不变", () => {
	it("被抹的叶子路径与换判据之前录下的字面清单一致", () => {
		const input = sections();
		const out = redactBackupSections(input, NO_CODES);
		const paths = collectRedactions(input, out)
			.map((leaf) => leaf.path.join("."))
			.sort();
		expect(paths).toEqual(EXPECTED_WITH_SEARCH);
	});

	it("整份输出与旧的键名黑名单逐字节相等", () => {
		const input = sections();
		expect(redactBackupSections(input, NO_CODES)).toEqual(redactSecretKeys(input));
	});
});

/**
 * 黑名单退役成守卫:键名在旧黑名单里的字符串叶子必须带标记 —— 新加的 schema 字段叫 `token`
 * 却忘了标,备份就静默漏一个密钥。
 */
describe("守卫:键名像密钥的字符串叶子必须带标记", () => {
	const NAMES = new Set([...SECRET_KEYS, "url", "baseUrl"]);
	const schemas: Array<[string, unknown]> = [
		["GlobalConfig", GlobalConfigSchema],
		["Connection", ConnectionSchema],
	];

	it.each(schemas)("%s", (_name, schema) => {
		const unmarked = stringLeavesOf(schema)
			.filter((leaf) => leaf.mark === undefined)
			.filter((leaf) => {
				const last = leaf.path.at(-1) ?? "";
				// 路径上有 `keys` / `headers` 容器的,里面的叶子键名随便起 —— 容器本身就是信号。
				return NAMES.has(last) || leaf.path.some((s) => s === "keys" || s === "headers");
			})
			.map((leaf) => leaf.path.join("."));
		expect(unmarked).toEqual([]);
	});
});
