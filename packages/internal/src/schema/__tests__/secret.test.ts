import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { AIProviderProfileSchema } from "../common";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "../globals";
import {
	mapMarked,
	markBackupOnly,
	markSecret,
	maskCell,
	maskSecret,
	secretMarkOf,
	stringLeavesOf,
} from "../secret";
import { ConnectionSchema } from "../targets";

/** 标记是 zod 的 `.meta()`:包装函数只是入口。读标记的遍历器要穿得过 optional / default / 联合 / record / pipe。 */
describe("secretMarkOf — 标记穿过各种包裹", () => {
	it("markSecret / markBackupOnly 各自读得回,没标的读不到", () => {
		expect(secretMarkOf(markSecret(z.string()))).toMatchObject({ secret: true });
		expect(secretMarkOf(markBackupOnly(z.string()))).toMatchObject({ backupOnly: true });
		expect(secretMarkOf(z.string())).toBeUndefined();
	});

	it("标记打在最里层,外面套 optional / default 也读得到", () => {
		expect(secretMarkOf(markSecret(z.string()).optional())).toMatchObject({ secret: true });
		expect(secretMarkOf(markSecret(z.string()).default(""))).toMatchObject({ secret: true });
	});
});

describe("mapMarked — 按值走 schema", () => {
	const blank = (value: unknown) => (typeof value === "string" ? "" : value);
	const run = (schema: z.ZodType, value: unknown) =>
		mapMarked(schema, value, { onMark: blank, onUntyped: (v) => v });

	it("optional / default / record 值 / 数组项里的标记都被命中", () => {
		const schema = z.object({
			a: markSecret(z.string()).optional(),
			b: markSecret(z.string()).default(""),
			rec: z.record(z.string(), markBackupOnly(z.string())),
			list: z.array(z.object({ k: markSecret(z.string()), n: z.string() })),
		});
		const out = run(schema, {
			a: "x",
			b: "y",
			rec: { h1: "v1", h2: "v2" },
			list: [{ k: "s", n: "keep" }],
		});
		expect(out).toEqual({ a: "", b: "", rec: { h1: "", h2: "" }, list: [{ k: "", n: "keep" }] });
	});

	it("preprocess 包着的对象:走输出侧", () => {
		const schema = z.preprocess((v) => v, z.object({ k: markSecret(z.string()) }));
		expect(run(schema, { k: "x" })).toEqual({ k: "" });
	});

	it("联合按值选支:同名的 url,只有被标的那一支被抹", () => {
		const schema = z.union([
			z.object({ kind: z.literal("a"), url: markSecret(z.string()) }),
			z.object({ kind: z.literal("b"), url: z.string() }),
		]);
		expect(run(schema, { kind: "a", url: "u" })).toEqual({ kind: "a", url: "" });
		expect(run(schema, { kind: "b", url: "u" })).toEqual({ kind: "b", url: "u" });
	});

	it("没标记的未知键与 unknown 子树交给 onUntyped;值对不上任何一支时整片交过去", () => {
		const seen: unknown[] = [];
		const keys: Array<string | undefined> = [];
		const schema = z.object({ k: markSecret(z.string()), blob: z.unknown() });
		const out = mapMarked(
			schema,
			{ k: "x", blob: { t: 1 }, extra: "e" },
			{
				onMark: blank,
				onUntyped: (v, key) => {
					seen.push(v);
					keys.push(key);
					return "U";
				},
			},
		);
		expect(out).toEqual({ k: "", blob: "U", extra: "U" });
		expect(seen).toEqual([{ t: 1 }, "e"]);
		// 没声明的键把键名带过去(`blob` 是声明过的 unknown,不算)。
		expect(keys).toEqual(["blob", "extra"]);

		const u = z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]);
		expect(mapMarked(u, { zzz: 1 }, { onMark: blank, onUntyped: () => "WHOLE" })).toBe("WHOLE");
	});

	it("不改传进来的那份", () => {
		const input = { k: "x" };
		run(z.object({ k: markSecret(z.string()) }), input);
		expect(input).toEqual({ k: "x" });
	});
});

describe("真 schema 上的标记", () => {
	const ID = "11111111-1111-4111-8111-111111111111";
	const base = { id: ID, name: "n", enabled: true, kind: "direct" } as const;
	const marked = (schema: z.ZodType, value: unknown) => {
		const out: Array<{ mark: string; value: unknown }> = [];
		mapMarked(schema, value, {
			onMark: (value, mark) => {
				out.push({ mark: "secret" in mark ? "secret" : "backupOnly", value });
				return value;
			},
			onUntyped: (v) => v,
		});
		return out;
	};

	it("OneBot ws 的 url 只算「仅备份」,webhook 的 url 算 secret(同名不同义的反例)", () => {
		const ws = ConnectionSchema.parse({
			...base,
			platform: "onebot",
			connector: "ws",
			config: { transport: "ws", url: "ws://bot:3001", accessToken: "tok", headers: { A: "1" } },
		});
		expect(marked(ConnectionSchema, ws)).toEqual([
			{ mark: "backupOnly", value: "ws://bot:3001" },
			{ mark: "backupOnly", value: "1" },
			{ mark: "secret", value: "tok" },
		]);
		const hook = ConnectionSchema.parse({
			...base,
			platform: "generic",
			connector: "webhook",
			config: { url: "https://h.example/x", secret: "s", headers: {} },
		});
		expect(marked(ConnectionSchema, hook)).toEqual([
			{ mark: "secret", value: "https://h.example/x" },
			{ mark: "secret", value: "s" },
		]);
	});

	it("QQ 官机的 appSecret 是 secret", () => {
		const qq = ConnectionSchema.parse({
			...base,
			platform: "qq-official",
			connector: "ws",
			config: { appId: "1", appSecret: "sec" },
		});
		expect(marked(ConnectionSchema, qq)).toEqual([{ mark: "secret", value: "sec" }]);
	});

	it("AI 的两把 key 与搜索 key 是 secret,两处 baseUrl 与市场源 url 是仅备份", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.ai.providers.ds = AIProviderProfileSchema.parse({
			provider: "deepseek",
			apiKey: "k-main",
			baseUrl: "https://api.example/v1",
			vision: { apiKey: "k-vision", baseUrl: "https://v.example/v1" },
		});
		g.defaults.ai.search.keys = { bocha: "k-bocha", tavily: "k-tavily" };
		g.marketplace = { sources: [{ id: "s1", url: "https://m.example/index.json" }] };
		const got = marked(GlobalConfigSchema, g);
		expect(got).toEqual(
			expect.arrayContaining([
				{ mark: "secret", value: "k-main" },
				{ mark: "backupOnly", value: "https://api.example/v1" },
				{ mark: "secret", value: "k-vision" },
				{ mark: "backupOnly", value: "https://v.example/v1" },
				{ mark: "secret", value: "k-bocha" },
				{ mark: "secret", value: "k-tavily" },
				{ mark: "backupOnly", value: "https://m.example/index.json" },
			]),
		);
		expect(got).toHaveLength(7);
	});
});

describe("maskSecret / maskCell", () => {
	it("不到 24 位整段打点,固定 8 个点", () => {
		expect(maskSecret("short")).toBe("••••••••");
		expect(maskSecret("a".repeat(23))).toBe("••••••••");
	});
	it("24 位及以上露头尾各 4 位,按字符数切", () => {
		expect(maskSecret(`abcd${"x".repeat(16)}wxyz`)).toBe("abcd••••••••wxyz");
		expect(maskSecret(`你好吗呀${"x".repeat(16)}再见了呢`)).toBe("你好吗呀••••••••再见了呢");
	});
	it("空值原样,不是字符串的也遮", () => {
		expect(maskCell("")).toBe("");
		expect(maskCell(undefined)).toBeUndefined();
		expect(maskCell(null)).toBeNull();
		expect(maskCell("tok")).toEqual({ masked: "••••••••" });
		expect(maskCell(12345)).toEqual({ masked: "••••••••" });
	});
});

describe("stringLeavesOf", () => {
	it("列出每个字符串叶子的路径(record 与数组用 *),连没标的也列", () => {
		const leaves = stringLeavesOf(
			z.object({
				a: markSecret(z.string()),
				b: z.string().optional(),
				r: z.record(z.string(), markBackupOnly(z.string())),
				l: z.array(z.object({ c: z.string() })),
			}),
		);
		expect(leaves.map((l) => [l.path.join("."), l.mark !== undefined])).toEqual([
			["a", true],
			["b", false],
			["r.*", true],
			["l.*.c", false],
		]);
	});
});
