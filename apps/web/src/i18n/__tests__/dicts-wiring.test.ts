import type { LocaleDicts } from "@bilibili-notify/internal/i18n";
import { describe, expect, it } from "vite-plus/test";
import { DICTS } from "../index";

/**
 * `locales/` 里的每个文件都得接进 `DICTS`(平实层与女仆层都算),说明见服务端同名测试。
 * 单独一个文件,不受 `use-t.test.tsx` 里 `vi.mock` 的影响。
 */
const files = import.meta.glob("../locales/*.json", { eager: true, import: "default" });

describe("面板译文文件都接进了 DICTS", () => {
	it("已交付分区的日文和繁体女仆覆盖与简中逐键一致", () => {
		const prefixes = [
			"forms.",
			"system.master.",
			"preferences.",
			"credentials.",
			"integrationSettings.",
			"invalidSettings.",
			"startup.",
			"lifecycle.",
			"accounts.",
			"healthCard.",
			"dashboard.live.",
			"statsSwitch.",
			"stats.roast.",
			"stats.push.",
			"problems.",
			"history.repush.",
			"library.",
			"maidSkills.",
			"aiSettings.",
			"aiWriting.",
			"aiPage.",
			"aiChat.",
			"subs.",
			"sourceUi.pages.up.",
			"sourceUi.components.scope.",
			"sourceUi.pages.rules.",
			"sources.",
			"sourceUi.config.field.labels.",
			"sourceUi.pages.Dashboard.",
			"sourceUi.pages.Stats.",
			"sourceUi.pages.History.",
			"targets.",
			"targetDisplay.",
			"addressCandidates.",
			"linkPreview.",
			"connectionAuth.",
			"extensions.",
			"extensionSettings.",
			"sourceUi.pages.extensions.",
		];
		const expected = Object.keys(DICTS["zh-CN"].maid)
			.filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))
			.sort();
		for (const locale of ["ja", "zh-TW"] as const) {
			expect(Object.keys(DICTS[locale].maid).sort()).toEqual(expected);
		}
	});

	it("目录里至少有文件(扫空了比没有还糟)", () => {
		expect(Object.keys(files).length).toBeGreaterThan(0);
	});

	it.each(Object.entries(files))("%s", (path, content) => {
		const match = /\/([^/]+?)(\.maid)?\.json$/.exec(path);
		if (match === null) throw new Error(`认不出的文件名: ${path}`);
		const [, locale, maid] = match;
		const dicts = (DICTS as Record<string, LocaleDicts | undefined>)[locale as string];
		expect(dicts, `${locale} 没接进 DICTS`).toBeDefined();
		expect(maid === undefined ? dicts?.plain : dicts?.maid).toBe(content);
	});
});
