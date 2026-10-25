/**
 * 零依赖子路径的源文件(各领域文件、`format.ts`)**只许有 type import** —— 这条以前只是
 * 文件头上的一句话。
 *
 * 它们经各自的领域子路径或 `@bilibili-notify/internal/format` **直供浏览器端运行时消费**,所以一条
 * 值级 import 就能把 zod(以及它拽着的整张 schema 图)拉进前端 bundle。症状不是报错,
 * 是**产物悄悄胖一圈**,而门禁全绿。
 *
 * `import type` 编译后整条擦掉,所以它随便写;值级的只许指向名单里别的文件(它们自己也受这条约束)
 * 与同包 `locales/` 里打包时内联的 JSON —— 顺带也就杜绝了「A 只 import 了 B、B 才 import zod」那种
 * 传递路径。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/** 零依赖子路径的源文件。新开一个这样的子路径,就在这里加一行。 */
// `bilibili-guard.ts` 经 `/bilibili-guard` 子路径供面板读 B 站的档位表(㉓e),同一条纪律。
// `live-monitor.ts` 经 `/live-monitor` 子路径供面板与服务端共用「要不要监听直播」的判定(3b-14),同一条纪律。
// `i18n.ts` 经 `/i18n` 子路径供面板与服务端共用字典机制(3b-09,ADR-0037 决策 6),同一条纪律。
// `platform-descriptor.ts` 经 `/platform-descriptor` 子路径供拓展(经门)与宿主共用中性平台描述(3b-40,ADR-0024 决策 4),同一条纪律。
// `template-variables.ts` 经 `/template-variables` 子路径供面板拼提示条、服务端探针取变量名(3b-21),同一条纪律。
// `template-defaults.ts` 经 `/template-defaults` 子路径供面板判「默认文案有更新」,同一条纪律。
// `builtin-texts.ts` 经 `/builtin-texts` 子路径供面板与服务端共用出厂文案(3b-12,ADR-0037 决策 10、11),同一条纪律。
const ZERO_DEP_SOURCES = [
	"constants.ts",
	"result.ts",
	"identity.ts",
	"features.ts",
	"push-target.ts",
	"platform-registry.ts",
	"ai.ts",
	"card-skin.ts",
	"history.ts",
	"link-preview.ts",
	"update.ts",
	"image-ref.ts",
	"source.ts",
	"extension/wire.ts",
	"format.ts",
	"bilibili-guard.ts",
	"live-monitor.ts",
	"i18n.ts",
	"platform-descriptor.ts",
	"template-variables.ts",
	"template-defaults.ts",
	"builtin-texts.ts",
];

/** 值级 import 放行的目标:名单里的别的文件,与 `locales/` 的 JSON。 */
function isZeroDepTarget(line: string): boolean {
	const target = /\bfrom\s+["']\.\/([^"']+)["']/.exec(line)?.[1];
	if (target === undefined) return false;
	if (/^locales\/[\w-]+\.json$/.test(target)) return true;
	return ZERO_DEP_SOURCES.includes(`${target}.ts`);
}

function sourceOf(file: string): string {
	return readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
}

/** 所有从别的模块取东西的语句 —— `import … from`、`export … from`、动态 `import()`。 */
function moduleReferences(source: string): string[] {
	return source
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(line) =>
				/^import\b/.test(line) || /^export\b.*\bfrom\b/.test(line) || /\bimport\s*\(/.test(line),
		);
}

describe("零依赖子路径的 import 纪律", () => {
	it.each(ZERO_DEP_SOURCES)("%s 的值级 import 只许指向零依赖的同伴", (file) => {
		const offenders = moduleReferences(sourceOf(file)).filter(
			(line) =>
				!/^import\s+type\b/.test(line) && !/^export\s+type\b/.test(line) && !isZeroDepTarget(line),
		);
		expect(offenders).toEqual([]);
	});
});
