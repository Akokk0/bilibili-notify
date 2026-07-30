import { describe, expect, it } from "vite-plus/test";
import { CardStylePartialSchema, CardStyleSchema } from "./common";
import { DEFAULT_CARD_STYLE } from "./globals";

describe("CardStyle background / glass knobs", () => {
	it("defaults backgroundImages to [] (gradient) and leaves glassOpacity unset", () => {
		const parsed = CardStyleSchema.parse(DEFAULT_CARD_STYLE);
		expect(parsed.backgroundImages).toEqual([]);
		expect(parsed.glassOpacity).toBeUndefined();
	});

	it("accepts an explicit backgroundImages list (rotation set) and glass opacity", () => {
		const parsed = CardStyleSchema.parse({
			...DEFAULT_CARD_STYLE,
			backgroundImages: ["a.png", "b.png"],
			glassOpacity: 0.5,
		});
		expect(parsed.backgroundImages).toEqual(["a.png", "b.png"]);
		expect(parsed.glassOpacity).toBe(0.5);
	});

	// 旧 globals.json 形态:带单值 `backgroundImage`、没有 `backgroundImages`。
	const { backgroundImages: _omit, ...LEGACY_BASE } = DEFAULT_CARD_STYLE;

	it("migrates a legacy single backgroundImage into the list", () => {
		const parsed = CardStyleSchema.parse({ ...LEGACY_BASE, backgroundImage: "card-bg/abc.png" });
		expect(parsed.backgroundImages).toEqual(["card-bg/abc.png"]);
	});

	it("migrates a legacy empty backgroundImage to []", () => {
		const parsed = CardStyleSchema.parse({ ...LEGACY_BASE, backgroundImage: "" });
		expect(parsed.backgroundImages).toEqual([]);
	});

	it("an explicit backgroundImages list wins over a stale legacy backgroundImage", () => {
		const parsed = CardStyleSchema.parse({
			...LEGACY_BASE,
			backgroundImage: "old.png",
			backgroundImages: ["new.png"],
		});
		expect(parsed.backgroundImages).toEqual(["new.png"]);
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
		// 与 font / backgroundImages 同一条纪律:partial 若保留 `.default()`,
		// per-UP 只改一个颜色也会连带把字体判成「已覆盖」,盖掉全局设的那款。
		const parsed = CardStylePartialSchema.parse({ cardColorStart: "#fff" }) as Record<
			string,
			unknown
		>;
		expect("fontAsset" in parsed).toBe(false);
	});
});

describe("CardStyle data-section show flags", () => {
	it("defaults the three data-section flags to true (replays current behavior)", () => {
		const parsed = CardStyleSchema.parse(DEFAULT_CARD_STYLE);
		expect(parsed.showPopularity).toBe(true);
		expect(parsed.showArea).toBe(true);
		expect(parsed.showFans).toBe(true);
	});

	// 旧 globals.json 形态:带废弃的 hideDesc / hideFollower,且没有新的 show* 字段。
	const { showPopularity: _p, showArea: _a, showFans: _f, ...LEGACY_STYLE } = DEFAULT_CARD_STYLE;

	it("drops the legacy hideDesc / hideFollower flags", () => {
		const parsed = CardStyleSchema.parse({
			...LEGACY_STYLE,
			hideDesc: true,
			hideFollower: false,
		}) as Record<string, unknown>;
		expect(parsed.hideDesc).toBeUndefined();
		expect(parsed.hideFollower).toBeUndefined();
	});

	it("migrates legacy hideFollower=true into showFans=false (preserves hidden intent)", () => {
		const parsed = CardStyleSchema.parse({ ...LEGACY_STYLE, hideFollower: true });
		expect(parsed.showFans).toBe(false);
		// 其它两项不受影响,仍走默认显示
		expect(parsed.showPopularity).toBe(true);
		expect(parsed.showArea).toBe(true);
	});

	it("lets an explicit showFans win over a legacy hideFollower", () => {
		const parsed = CardStyleSchema.parse({
			...LEGACY_STYLE,
			hideFollower: true,
			showFans: true,
		});
		expect(parsed.showFans).toBe(true);
	});
});
