import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { createI18n, type Locale, type LocaleDicts } from "../../i18n";
import { PACKAGE_DICTS, withPackageDicts } from "..";

/** 一端自己的字典:简中带女仆层,英文只有平实版,繁体与日文空着。 */
const END = {
	"zh-CN": { plain: { "web.hi": "你好" }, maid: { "web.hi": "主人好" } },
	"zh-TW": { plain: {} },
	en: { plain: { "web.hi": "Hi" } },
	ja: { plain: {} },
};

describe("withPackageDicts", () => {
	it("两端的字典过它之后,本端的句子与包里的句子在每种语言下都取得到", () => {
		const i18n = createI18n<string, Locale>({
			dicts: withPackageDicts(END),
			fallback: "zh-CN",
			locale: "zh-CN",
			voice: "maid",
		});
		expect(i18n.t("web.hi")).toBe("主人好");
		expect(i18n.t("internal.commands.prefixBlank")).toBe("前缀不能是纯空白");
		i18n.set({ locale: "en", voice: "plain" });
		expect(i18n.t("web.hi")).toBe("Hi");
		// 英文的包字典还空着:拿简体打底
		expect(i18n.t("internal.commands.prefixBlank")).toBe("前缀不能是纯空白");
	});

	it("包的女仆层垫在女仆层底下:本端这种语言没写女仆层,包有,这种语言也出女仆口吻", () => {
		const packages = {
			"zh-CN": { plain: { "ui.ok": "确定" }, maid: { "ui.ok": "好哒" } },
			"zh-TW": { plain: {} },
			en: { plain: {} },
			ja: { plain: {} },
		};
		const end = { ...END, "zh-CN": { plain: { "web.hi": "你好" } } };
		const merged = withPackageDicts(end, packages);
		expect(merged["zh-CN"]).toEqual({
			plain: { "ui.ok": "确定", "web.hi": "你好" },
			maid: { "ui.ok": "好哒" },
		});
		const i18n = createI18n<string, Locale>({
			dicts: merged,
			fallback: "zh-CN",
			locale: "zh-CN",
			voice: "maid",
		});
		expect(i18n.t("ui.ok")).toBe("好哒");
		expect(i18n.state().voice).toBe("maid");
	});

	it("本端与包都没有女仆层的语言照旧没有女仆层(口吻那一项在这种语言下不出现)", () => {
		expect(withPackageDicts(END)["zh-TW"]).toEqual({ plain: {} });
		expect("maid" in withPackageDicts(END).en).toBe(false);
	});
});

/**
 * `locales/` 里的每个文件都得接进 `PACKAGE_DICTS`(平实层与女仆层都算),同两端的
 * `dicts-wiring` 测试:新放一个文件却忘了在 `index.ts` 里引,别的全绿,那份译文却永远不出现。
 */
describe("包字典的译文文件都接进了 PACKAGE_DICTS", () => {
	const localesDir = fileURLToPath(new URL("../locales/", import.meta.url));
	const names = readdirSync(localesDir)
		.filter((name) => name.endsWith(".json"))
		.sort();

	it("目录里至少有文件(扫空了比没有还糟)", () => {
		expect(names.length).toBeGreaterThan(0);
	});

	it.each(names)("%s", async (name) => {
		const match = /^(.+?)(\.maid)?\.json$/.exec(name);
		if (match === null) throw new Error(`认不出的文件名: ${name}`);
		const [, locale, maid] = match;
		const { default: content } = await import(`../locales/${name}`);
		const dicts = (PACKAGE_DICTS as Record<string, LocaleDicts | undefined>)[locale as string];
		expect(dicts, `${locale} 没接进 PACKAGE_DICTS`).toBeDefined();
		expect(maid === undefined ? dicts?.plain : dicts?.maid).toBe(content);
	});
});
