import { describe, expect, it } from "vite-plus/test";
import { CardStylePartialSchema, CardStyleSchema } from "./common";
import { DEFAULT_CARD_STYLE } from "./globals";

describe("CardStyle background / glass knobs", () => {
	// 背景图与玻璃都退役了(2026-09-14 / 决策 16):**出厂那份一个键都不写**。
	// 键在不在是开机迁移的判据 —— 补一个默认值回来,迁移就永远判不出「搬过没有」。
	it("leaves the retired background / glass keys unset on a fresh install", () => {
		const parsed = CardStyleSchema.parse(DEFAULT_CARD_STYLE);
		expect(parsed.backgroundImages).toBeUndefined();
		expect(parsed.font).toBeUndefined();
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
	// 出厂那份 2026-09-14 起本来就不带背景图那一项(退役成皮肤旋钮),直接拿来当底。
	const LEGACY_BASE = DEFAULT_CARD_STYLE;

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
		// per-UP 只改一项也会连带把字体判成「已覆盖」,盖掉全局设的那款。
		const parsed = CardStylePartialSchema.parse({ glassOpacity: 0.5 }) as Record<string, unknown>;
		expect("fontAsset" in parsed).toBe(false);
	});
});

describe("CardStyle data-section show flags(🪦 已退役,只为装得进老配置)", () => {
	it("新装的机器一个 show 键都不写 —— 写了开机迁移就判不出「搬过没有」", () => {
		const parsed = CardStyleSchema.parse(DEFAULT_CARD_STYLE) as Record<string, unknown>;
		// 验红:把三个字段改回 `.default(true)`,这条红。
		expect("showPopularity" in parsed).toBe(false);
		expect("showArea" in parsed).toBe(false);
		expect("showFans" in parsed).toBe(false);
	});

	it("存量配置里的 show 键照旧收得下 —— 开机迁移要照它折块序列", () => {
		const parsed = CardStyleSchema.parse({
			...DEFAULT_CARD_STYLE,
			showPopularity: false,
			showArea: true,
			showFans: false,
		});
		expect(parsed.showPopularity).toBe(false);
		expect(parsed.showArea).toBe(true);
		expect(parsed.showFans).toBe(false);
	});

	// 旧 globals.json 形态:带废弃的 hideDesc / hideFollower,且没有新的 show* 字段。
	const LEGACY_STYLE = DEFAULT_CARD_STYLE;

	it("drops the legacy hideDesc / hideFollower flags", () => {
		const parsed = CardStyleSchema.parse({
			...LEGACY_STYLE,
			hideDesc: true,
			hideFollower: false,
		}) as Record<string, unknown>;
		expect(parsed.hideDesc).toBeUndefined();
		expect(parsed.hideFollower).toBeUndefined();
	});

	// `hideFollower` → `showFans` 这条链**退役之后仍然要留着**:老用户「藏起粉丝数据」
	// 的意图先落成 `showFans=false`,再由开机迁移折成「皮肤里没有 fans 块」。断在哪一段
	// 都等于替他把那一件重新显示出来。
	it("migrates legacy hideFollower=true into showFans=false (preserves hidden intent)", () => {
		const parsed = CardStyleSchema.parse({ ...LEGACY_STYLE, hideFollower: true });
		expect(parsed.showFans).toBe(false);
		// 其它两项没设过就仍然没有键(显不显示归皮肤的块序列)。
		expect(parsed.showPopularity).toBeUndefined();
		expect(parsed.showArea).toBeUndefined();
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
