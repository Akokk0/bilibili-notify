/**
 * 拓展市场的索引(`marketplace.json`,ADR-0013)。
 *
 * 一份索引 = 一个源;官方源的这份走签名信封(签名与新鲜度在 server 那头验),第三方源的
 * 就是这份 JSON 本身。**同一个 schema**,差别只在两条规矩:官方源的条目 id 没有命名空间、
 * 必须带 `issuedAt`;第三方源必须声明 `namespace`,列的每个 id 都得在它自己的命名空间里 ——
 * 一个源想冒充官方拓展(列一个 `bridge`),或者冒用别人的命名空间,在这一步就被拒。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	checkMarketplaceIndex,
	isMarketplaceRevoked,
	MarketplaceIndexSchema,
} from "./extension-marketplace";

function entry(over: Record<string, unknown> = {}) {
	return {
		id: "bridge",
		name: "机器人框架桥接",
		description: "把 koishi / AstrBot 里配好的机器人借给 BN 用。",
		version: "0.0.2",
		apiVersion: 1,
		package: {
			url: "https://github.com/Akokk0/bilibili-notify/releases/download/extension%2Fbridge%400.0.2/bridge-0.0.2.zip",
			sha256: "a".repeat(64),
			size: 123456,
		},
		releaseUrl: "https://github.com/Akokk0/bilibili-notify/releases/tag/extension%2Fbridge%400.0.2",
		notes: "第一版。",
		...over,
	};
}

function index(over: Record<string, unknown> = {}) {
	return { name: "BN 官方拓展", issuedAt: 1_760_000_000, extensions: [entry()], ...over };
}

/** 一份只换 `extensions` 的官方索引,过 schema 再过资格检查。 */
const check = (extensions: unknown[]) =>
	checkMarketplaceIndex(MarketplaceIndexSchema.parse(index({ extensions })), { official: true });

describe("MarketplaceIndexSchema", () => {
	it("官方那份解析得过;description / notes / prerelease / revoked 可缺", () => {
		const parsed = MarketplaceIndexSchema.parse(
			index({ extensions: [entry({ description: undefined, notes: undefined })] }),
		);
		expect(parsed.extensions[0]?.description).toBe("");
		expect(parsed.extensions[0]?.prerelease).toBeUndefined();
	});

	it("包地址只收 https;sha256 只收 64 位小写 hex;size 必须是正整数", () => {
		const bad = [
			entry({ package: { url: "http://x/y.zip", sha256: "a".repeat(64), size: 1 } }),
			entry({ package: { url: "https://x/y.zip", sha256: "A".repeat(64), size: 1 } }),
			entry({ package: { url: "https://x/y.zip", sha256: "a".repeat(63), size: 1 } }),
			entry({ package: { url: "https://x/y.zip", sha256: "a".repeat(64), size: 0 } }),
		];
		for (const e of bad) {
			expect(MarketplaceIndexSchema.safeParse(index({ extensions: [e] })).success).toBe(false);
		}
	});

	it("版本必须是真 semver,id 走拓展 id 的规则", () => {
		expect(
			MarketplaceIndexSchema.safeParse(index({ extensions: [entry({ version: "latest" })] }))
				.success,
		).toBe(false);
		expect(
			MarketplaceIndexSchema.safeParse(index({ extensions: [entry({ id: "Bad Id" })] })).success,
		).toBe(false);
	});

	it("不认识的字段丢掉不拒 —— 老客户端读得了带新字段的索引", () => {
		const parsed = MarketplaceIndexSchema.parse(index({ future: 1 }));
		expect("future" in parsed).toBe(false);
	});
});

describe("checkMarketplaceIndex —— 官方源与第三方源各自的规矩", () => {
	it("官方:条目 id 不能带命名空间,且必须有 issuedAt", () => {
		expect(
			checkMarketplaceIndex(MarketplaceIndexSchema.parse(index()), { official: true }),
		).toEqual({
			ok: true,
		});
		expect(
			checkMarketplaceIndex(
				MarketplaceIndexSchema.parse(index({ extensions: [entry({ id: "alice.bridge" })] })),
				{ official: true },
			),
		).toMatchObject({ ok: false, err: expect.stringContaining("alice.bridge") });
		expect(
			checkMarketplaceIndex(MarketplaceIndexSchema.parse(index({ issuedAt: undefined })), {
				official: true,
			}),
		).toMatchObject({ ok: false, err: expect.stringContaining("issuedAt") });
	});

	it("第三方:必须声明 namespace,每个条目都得在自己的命名空间里", () => {
		const third = index({ name: "alice 的拓展", namespace: "alice" });
		expect(
			checkMarketplaceIndex(
				MarketplaceIndexSchema.parse({ ...third, extensions: [entry({ id: "alice.douyin" })] }),
				{ official: false },
			),
		).toEqual({ ok: true });
		// 没声明命名空间
		expect(
			checkMarketplaceIndex(
				MarketplaceIndexSchema.parse({
					...third,
					namespace: undefined,
					extensions: [entry({ id: "alice.douyin" })],
				}),
				{ official: false },
			),
		).toMatchObject({ ok: false, err: expect.stringContaining("namespace") });
		// 冒充官方
		expect(
			checkMarketplaceIndex(MarketplaceIndexSchema.parse(third), { official: false }),
		).toMatchObject({ ok: false, err: expect.stringContaining("bridge") });
		// 冒用别人的命名空间
		expect(
			checkMarketplaceIndex(
				MarketplaceIndexSchema.parse({ ...third, extensions: [entry({ id: "bob.douyin" })] }),
				{ official: false },
			),
		).toMatchObject({ ok: false, err: expect.stringContaining("bob.douyin") });
	});

	it("同一个 id 一条正式 + 一条预发布 → 放行(两个渠道各留最新那一版)", () => {
		expect(check([entry(), entry({ version: "0.1.0-alpha.1", prerelease: true })])).toEqual({
			ok: true,
		});
	});

	it("同一个 id 同一档列两遍 → 拒(那一档的「最新版」就没法唯一)", () => {
		const twice = { ok: false, err: expect.stringContaining("列了两遍") };
		expect(check([entry(), entry({ version: "0.0.3" })])).toMatchObject(twice);
		// `prerelease: false` 与不写是同一档 —— 按字段的真假分档,不是按「写没写」。
		expect(check([entry(), entry({ version: "0.0.3", prerelease: false })])).toMatchObject(twice);
		expect(
			check([
				entry({ version: "0.1.0-alpha.1", prerelease: true }),
				entry({ version: "0.1.0-alpha.2", prerelease: true }),
			]),
		).toMatchObject(twice);
	});

	it("prerelease 旗标与版本号对不上 → 拒(第三方源写 alpha 却不标,稳定渠道会看见它)", () => {
		const mismatch = { ok: false, err: expect.stringContaining("对不上") };
		expect(check([entry({ version: "0.1.0-alpha.1" })])).toMatchObject(mismatch);
		expect(check([entry({ version: "0.1.0", prerelease: true })])).toMatchObject(mismatch);
	});
});

describe("isMarketplaceRevoked", () => {
	it("按 id@version 查,没有 revoked 段就是没撤", () => {
		const parsed = MarketplaceIndexSchema.parse(index({ revoked: ["bridge@0.0.1"] }));
		expect(isMarketplaceRevoked(parsed, "bridge", "0.0.1")).toBe(true);
		expect(isMarketplaceRevoked(parsed, "bridge", "0.0.2")).toBe(false);
		expect(isMarketplaceRevoked(MarketplaceIndexSchema.parse(index()), "bridge", "0.0.1")).toBe(
			false,
		);
	});
});
