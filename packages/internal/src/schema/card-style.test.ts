import { describe, expect, it } from "vite-plus/test";
import { CardStylePartialSchema, CardStyleSchema } from "./common";
import { DEFAULT_CARD_STYLE } from "./globals";

describe("CardStyle glass knobs", () => {
	// 玻璃退役了(2026-09-14 / 决策 16):**出厂那份一个键都不写**。
	// 从前的理由是「键在不在是开机迁移的判据」,那个迁移已于 2026-09-18 整个退役
	// (ADR-0014 决策 17 的 🔗);这条现在钉的是「退役字段不许靠默认值复活」——
	// 补一个 `.default(...)` 回来,新装的机器就又带上一个谁都不该读的键。
	it("leaves the retired glass / font keys unset on a fresh install", () => {
		const parsed = CardStyleSchema.parse(DEFAULT_CARD_STYLE);
		expect(parsed.font).toBeUndefined();
		expect(parsed.glassOpacity).toBeUndefined();
	});

	it("accepts an explicit glass opacity", () => {
		const parsed = CardStyleSchema.parse({ ...DEFAULT_CARD_STYLE, glassOpacity: 0.5 });
		expect(parsed.glassOpacity).toBe(0.5);
	});

	// 背景图那两个键(列表 `backgroundImages` 与更老的单值 `backgroundImage`)2026-09-20
	// 整条链删掉。schema 不是 `.strict()`,所以存量配置带着它们照样装得进来 —— 键被静静
	// 剥掉,不会 Unrecognized key 整份拒收。这条就是那份保证。
	it("silently drops the retired background image keys from stored configs", () => {
		const parsed = CardStyleSchema.parse({
			...DEFAULT_CARD_STYLE,
			backgroundImage: "old.png",
			backgroundImages: ["a.png", "b.png"],
		}) as Record<string, unknown>;
		expect(parsed.enabled).toBe(true);
		expect("backgroundImage" in parsed).toBe(false);
		expect("backgroundImages" in parsed).toBe(false);
	});

	it("rejects glassOpacity outside 0..1", () => {
		expect(() => CardStyleSchema.parse({ ...DEFAULT_CARD_STYLE, glassOpacity: 1.5 })).toThrow();
	});
});

/**
 * 字体从「手填 font-family」升级成字体选择器:选择器交出来的要么是一个家族名
 * (`font`),要么是一款**上传上来的字体文件**(`fontAsset`,资产 id,与背景图同一套
 * 落盘 + id 引用形态)。
 */
describe("CardStyle 字体资产", () => {
	it("默认不带字体资产 —— 老配置与全新安装都走家族名那条路", () => {
		const parsed = CardStyleSchema.parse(DEFAULT_CARD_STYLE);
		expect(parsed.fontAsset).toBeUndefined();
	});

	it("认得上传上来的字体资产 id", () => {
		const id = `${"a".repeat(32)}.woff2`;
		expect(CardStyleSchema.parse({ ...DEFAULT_CARD_STYLE, fontAsset: id }).fontAsset).toBe(id);
	});

	it("per-UP / per-kind 覆盖维度也能单独换字体 —— 与 font 同进同出", () => {
		const parsed = CardStylePartialSchema.parse({ fontAsset: `${"b".repeat(32)}.ttf` });
		expect(parsed.fontAsset).toBe(`${"b".repeat(32)}.ttf`);
	});

	it("覆盖维度里**不带默认值** —— 注进一个默认就等于「这一项我覆盖了」", () => {
		// 与 font 同一条纪律:partial 若保留 `.default()`,
		// per-UP 只改一项也会连带把字体判成「已覆盖」,盖掉全局设的那款。
		const parsed = CardStylePartialSchema.parse({ glassOpacity: 0.5 }) as Record<string, unknown>;
		expect("fontAsset" in parsed).toBe(false);
	});
});

describe("CardStyle — 更老那两个键照旧剥掉", () => {
	// `hideDesc` / `hideFollower` 是 show* 之前的写法。show* 这一批已随旧版式整个退役
	// (ADR-0014 决策 17 的 2026-09-18 🔗:升级上来的一律用出厂默认皮肤,显不显示哪一件
	// 归皮肤的块序列),但这两个更老的键仍要**剥干净**再交出去 —— 留着会一路漏进别处。
	it("drops the legacy hideDesc / hideFollower flags", () => {
		const parsed = CardStyleSchema.parse({
			...DEFAULT_CARD_STYLE,
			hideDesc: true,
			hideFollower: false,
		}) as Record<string, unknown>;
		expect(parsed.hideDesc).toBeUndefined();
		expect(parsed.hideFollower).toBeUndefined();
	});
});
