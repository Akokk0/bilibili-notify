import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LocaleDicts } from "@bilibili-notify/internal/i18n";
import { describe, expect, it } from "vite-plus/test";
import { DICTS as BILI_DICTS } from "../../bilibili/i18n.js";
import { DICTS as MIGRATION_DICTS } from "../../migration/i18n.js";
import { DICTS } from "../index.js";

/**
 * `locales/` 里的每个文件都得接进 `DICTS`(平实层与女仆层都算):新放一个文件却忘了在 `index.ts` 里引,
 * 类型、构建、别的测试全绿,只是那份译文永远不会出现。`toBe` 比的是同一个模块对象,
 * 所以把文件接错了槽位也会红(即使两份都是 `{}`)。
 * 服务端的 tsconfig 没有 vite 的类型,所以不用 `import.meta.glob`,而是读目录再逐个动态引。
 */
const groups = [
	["../locales/", DICTS],
	["../../bilibili/locales/", BILI_DICTS],
	["../../migration/locales/", MIGRATION_DICTS],
] as const;
const names = groups.flatMap(([dir, dicts]) =>
	readdirSync(fileURLToPath(new URL(dir, import.meta.url)))
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => ({ dir, dicts, name })),
);

describe("服务端译文文件都接进了 DICTS", () => {
	it.each([
		["bilibili", BILI_DICTS],
		["migration", MIGRATION_DICTS],
	] as const)("%s：日文和台湾繁体女仆覆盖与简中逐键一致", (_name, dicts) => {
		for (const locale of ["ja", "zh-TW"] as const) {
			expect(Object.keys(dicts[locale].maid).sort()).toEqual(
				Object.keys(dicts["zh-CN"].maid).sort(),
			);
		}
	});

	it("目录里至少有文件(扫空了比没有还糟)", () => {
		expect(names.length).toBeGreaterThan(0);
	});

	it.each(names)("$dir$name", async ({ dir, dicts: catalog, name }) => {
		const match = /^(.+?)(\.maid)?\.json$/.exec(name);
		if (match === null) throw new Error(`认不出的文件名: ${name}`);
		const [, locale, maid] = match;
		const { default: content } = await import(`${dir}${name}`, { with: { type: "json" } });
		const dicts = (catalog as Record<string, LocaleDicts | undefined>)[locale as string];
		expect(dicts, `${locale} 没接进 DICTS`).toBeDefined();
		expect(maid === undefined ? dicts?.plain : dicts?.maid).toBe(content);
	});
});
