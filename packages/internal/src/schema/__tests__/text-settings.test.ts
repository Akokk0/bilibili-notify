/**
 * `locale` / `voice` —— 界面语言与文案口吻两项设置(ADR-0037 决策 2、3、17)。
 *
 * 这里守配置层的两条不变量:
 *
 * ① **两格都可选、不带 schema 默认值** —— 默认只写在 `textSettingsOf` 一处、不落盘:
 *   补成 `maid` 写进盘,第 4 期改口吻默认时「没动过的人」早被随手一次保存钉成了女仆,跟不上;
 *   语言同理,缺 = 「没选过」,与「选了简中」分得开。
 * ② **老配置缺这两格照样能读**(独立端启动时 `GlobalConfigSchema.parse` 失败是直接挂掉的)。
 */

import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_LOCALE, DEFAULT_VOICE, textSettingsOf, VOICES } from "../../i18n";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "../globals";

const withSettings = (extra: Record<string, unknown>) => ({
	...(makeDefaultGlobalConfig() as unknown as Record<string, unknown>),
	...extra,
});

describe("locale / voice 在核心设置里", () => {
	it("老 core.json 没有这两格 → 解析成功,两格保持缺失(不被补出来)", () => {
		const parsed = GlobalConfigSchema.safeParse(
			makeDefaultGlobalConfig() as unknown as Record<string, unknown>,
		);
		expect(parsed.success).toBe(true);
		expect("locale" in (parsed.data ?? {})).toBe(false);
		expect("voice" in (parsed.data ?? {})).toBe(false);
	});

	it("全新安装的出厂设置里没有这两格", () => {
		const fresh = makeDefaultGlobalConfig();
		expect("locale" in fresh).toBe(false);
		expect("voice" in fresh).toBe(false);
	});

	it("合法值原样保留", () => {
		for (const locale of ["zh-CN", "zh-TW", "en", "ja"]) {
			expect(GlobalConfigSchema.parse(withSettings({ locale })).locale).toBe(locale);
		}
		for (const voice of ["maid", "plain"]) {
			expect(GlobalConfigSchema.parse(withSettings({ voice })).voice).toBe(voice);
		}
	});

	it("不认得的值过不了", () => {
		expect(GlobalConfigSchema.safeParse(withSettings({ locale: "fr" })).success).toBe(false);
		expect(GlobalConfigSchema.safeParse(withSettings({ locale: "zh" })).success).toBe(false);
		expect(GlobalConfigSchema.safeParse(withSettings({ voice: "Maid" })).success).toBe(false);
	});
});

describe("textSettingsOf —— 缺的格按一条规则补", () => {
	it("两格都缺 → 简中 + 女仆", () => {
		expect(textSettingsOf({})).toEqual({ locale: "zh-CN", voice: "maid" });
		expect(DEFAULT_LOCALE).toBe("zh-CN");
		expect(DEFAULT_VOICE).toBe("maid");
	});

	it("给了的原样返回,缺的那一格单独补", () => {
		expect(textSettingsOf({ locale: "en", voice: "plain" })).toEqual({
			locale: "en",
			voice: "plain",
		});
		expect(textSettingsOf({ locale: "ja" })).toEqual({ locale: "ja", voice: "maid" });
		expect(textSettingsOf({ voice: "plain" })).toEqual({ locale: "zh-CN", voice: "plain" });
	});

	it("口吻的取值表就是两种", () => {
		expect([...VOICES]).toEqual(["maid", "plain"]);
	});
});
