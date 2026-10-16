import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { LOCALES, placeholdersOf, stemOf } from "../../packages/internal/src/i18n.ts";

/**
 * 译文文件的键与占位符(ADR-0037 决策 6):各语言的译文之间、女仆层与平实版之间,
 * 键、占位符、带数量的句子得对得上。类型只把键推成 string,推不出占位符与单复数类别,所以由这一道钉着。
 *
 * - 范围:BN 两端的译文目录(服务端、面板)。拓展的译文(3b-43)以后进同一张表或另起。
 * - 读的是 JSON 不是源码,没有「注释被当成代码」的问题。
 * - 简体中文打底(缺的句子运行时拿它补),所以「齐不齐」是**方向**判:别的语言不许有底里没有的句子;
 *   「要求齐的语言」名单今天只有 zh-CN,第 5 期翻完把 en、ja 加进 COMPLETE_LOCALES(不用 skip,免得忘了开)。
 * - 判据写成纯函数 + 样例(`checkDictionaries`),因为判据本身也会写错。
 * - 「取占位符」「拆单复数后缀」直接用核心导出的 `placeholdersOf` / `stemOf`,不在这里另抄一份。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** BN 自己放译文的目录。目录叫 `locales/`,拓展同名(ADR-0037 决策 14 下的 🔗)。 */
export const DICT_DIRS = ["apps/server/src/i18n/locales", "apps/web/src/i18n/locales"];

/** 打底的语言:别的语言的句子都得是它句子的子集。 */
export const BASE_LOCALE = "zh-CN";

/** 要求句子齐全的语言。今天只有打底语言,第 5 期翻完把 en、ja 加进来。 */
export const COMPLETE_LOCALES = ["zh-CN"];

/** 有女仆层的语言(ADR-0037 决策 4):今天 zh-CN,ja 第 5 期。其余语言出现女仆层文件就是错。 */
export const MAID_LOCALES = ["zh-CN"];

const CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
/** 键形如 `段.段…`,可带一个 `#类别`;段首小写字母,其后字母数字。 */
const KEY_SHAPE = new RegExp(
	`^[a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*)*(#(${CATEGORIES.join("|")}))?$`,
);

const isPlainObject = (value) =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** 一层译文按句分组:每句记着有没有不带后缀的条、有哪些类别、占位符的并集。 */
function groupBySentence(layer) {
	const groups = new Map();
	for (const [key, text] of Object.entries(layer)) {
		const stem = stemOf(key);
		const group = groups.get(stem) ?? { bare: false, categories: [], placeholders: new Set() };
		if (key === stem) group.bare = true;
		else group.categories.push(key.slice(stem.length + 1));
		for (const name of placeholdersOf(text)) group.placeholders.add(name);
		groups.set(stem, group);
	}
	return groups;
}

const placeholderSignature = (group) => [...group.placeholders].sort().join(",");

/** 这种语言的单复数类别,读运行时的,不写死 one / other。 */
function categoriesOf(locale) {
	return new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
}

/**
 * 查一组译文,回问题清单(空 = 干净)。`locales`:语言码 → `{ plain, maid? }`(已解析的 JSON 对象)。
 * 每条问题 `{ code, locale, layer, subject, detail }`。
 */
export function checkDictionaries({
	locales,
	baseLocale = BASE_LOCALE,
	completeLocales = COMPLETE_LOCALES,
	maidLocales = MAID_LOCALES,
}) {
	const issues = [];
	const report = (code, locale, layer, subject, detail) =>
		issues.push({ code, locale, layer, subject, detail });

	// 先把每一层读成分组;形状不对的层只报形状,不往下比
	const grouped = {};
	for (const [locale, layers] of Object.entries(locales)) {
		for (const layer of ["plain", "maid"]) {
			const dict = layers[layer];
			if (dict === undefined) continue;
			if (layer === "maid" && !maidLocales.includes(locale)) {
				report("maid-not-allowed", locale, layer, "", "这种语言没有女仆层,不该有女仆层文件");
				continue;
			}
			if (!isPlainObject(dict)) {
				report("shape", locale, layer, "", "不是平铺的对象");
				continue;
			}
			let shapeOk = true;
			for (const [key, text] of Object.entries(dict)) {
				if (typeof text !== "string") {
					report("shape", locale, layer, key, "值不是字符串");
					shapeOk = false;
				}
				if (!KEY_SHAPE.test(key)) {
					report("shape", locale, layer, key, "键的写法不对(段.段…,可带 #类别)");
					shapeOk = false;
				}
			}
			if (!shapeOk) continue;
			grouped[locale] ??= {};
			grouped[locale][layer] = groupBySentence(dict);
		}
	}

	const base = grouped[baseLocale]?.plain;
	if (base === undefined) {
		report("base-missing", baseLocale, "plain", "", "打底语言的平实版读不到");
		return issues;
	}

	for (const [locale, layers] of Object.entries(grouped)) {
		const expected = categoriesOf(locale);
		for (const layer of ["plain", "maid"]) {
			const sentences = layers[layer];
			if (sentences === undefined) continue;
			for (const [stem, group] of sentences) {
				// 同一句里不许既有不带后缀的、又有带类别的
				if (group.bare && group.categories.length > 0) {
					report("plural-mixed", locale, layer, stem, "同一句既有不带后缀的条、又有 #类别 的条");
				}
				// 带数量的句子:类别齐全、没有这种语言用不到的类别
				if (group.categories.length > 0) {
					for (const category of expected) {
						if (!group.categories.includes(category)) {
							report("plural-missing-category", locale, layer, stem, `缺 #${category}`);
						}
					}
					for (const category of group.categories) {
						if (!expected.includes(category)) {
							report("plural-extra-category", locale, layer, stem, `${locale} 用不到 #${category}`);
						}
					}
				}
				// 女仆层的句子都得在同语言的平实版里
				const plain = layers.plain;
				if (layer === "maid" && !plain?.has(stem)) {
					report("maid-orphan", locale, layer, stem, "女仆层的句子在同语言的平实版里没有");
				}
				// 非打底语言的句子都得在打底里
				const inBase = base.get(stem);
				if (locale !== baseLocale && layer === "plain" && inBase === undefined) {
					report("unknown-sentence", locale, layer, stem, `${baseLocale} 里没有这一句`);
				}
				if (inBase === undefined) continue;
				if (locale === baseLocale && layer === "plain") continue;
				// 占位符:同一句各类别合起来,与打底的一致
				if (placeholderSignature(group) !== placeholderSignature(inBase)) {
					report(
						"placeholders",
						locale,
						layer,
						stem,
						`占位符 {${placeholderSignature(group)}} 与 ${baseLocale} 的 {${placeholderSignature(inBase)}} 不同`,
					);
				}
				// 带数量与否得与打底一致
				const baseIsPlural = inBase.categories.length > 0;
				const isPlural = group.categories.length > 0;
				if (baseIsPlural !== isPlural) {
					report(
						"plural-mismatch",
						locale,
						layer,
						stem,
						baseIsPlural
							? `${baseLocale} 带数量,这里没写 #类别`
							: `${baseLocale} 不带数量,这里写了 #类别`,
					);
				}
			}
		}
	}

	// 要求齐的语言:打底里每一句它都得有
	for (const locale of completeLocales) {
		const plain = grouped[locale]?.plain;
		for (const stem of base.keys()) {
			if (!plain?.has(stem)) report("missing-sentence", locale, "plain", stem, "这一句还没翻");
		}
	}
	return issues;
}

/** 读一个译文目录:文件名 `<语言码>.json` / `<语言码>.maid.json`,其余的文件名是问题。 */
export function loadDictionaryDir(dir) {
	const locales = {};
	const problems = [];
	const absolute = join(REPO_ROOT, dir);
	if (!existsSync(absolute)) return { locales, problems: [`${dir} 不存在`] };
	for (const file of readdirSync(absolute).sort()) {
		const match = /^(.+?)(\.maid)?\.json$/.exec(file);
		if (match === null || !LOCALES.includes(match[1])) {
			problems.push(`${dir}/${file} 的文件名不是 <语言码>.json 或 <语言码>.maid.json`);
			continue;
		}
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(join(absolute, file), "utf8"));
		} catch (error) {
			problems.push(`${dir}/${file} 解析失败: ${error.message}`);
			continue;
		}
		locales[match[1]] ??= {};
		locales[match[1]][match[2] === undefined ? "plain" : "maid"] = parsed;
	}
	for (const locale of LOCALES) {
		if (locales[locale]?.plain === undefined) problems.push(`${dir} 缺 ${locale}.json`);
	}
	return { locales, problems };
}

// ---------------------------------------------------------------------------
// 判据的样例:每一条各配一个「干净」与一个「坏」
// ---------------------------------------------------------------------------

const GOOD = () => ({
	"zh-CN": {
		plain: {
			"a.greet": "你好 {name}",
			"a.item#other": "{count} 件",
		},
		maid: { "a.greet": "主人好 {name}～" },
	},
	en: {
		plain: {
			"a.greet": "Hello {name}",
			"a.item#one": "{count} item",
			"a.item#other": "{count} items",
		},
	},
	ja: { plain: {} },
});

const codesOf = (input) => checkDictionaries({ locales: input }).map((issue) => issue.code);

describe("checkDictionaries 的判据(样例)", () => {
	it("干净的一组不报;空字典(面板眼下的样子)也不报", () => {
		expect(checkDictionaries({ locales: GOOD() })).toEqual([]);
		expect(
			checkDictionaries({
				locales: { "zh-CN": { plain: {}, maid: {} }, en: { plain: {} }, ja: { plain: {} } },
			}),
		).toEqual([]);
	});

	it("形状:键写法不对、值不是字符串、整份不是对象", () => {
		const badKey = GOOD();
		badKey.en.plain.BadKey = "x";
		expect(codesOf(badKey)).toContain("shape");
		const badValue = GOOD();
		badValue.en.plain["a.greet"] = 3;
		expect(codesOf(badValue)).toContain("shape");
		const notObject = GOOD();
		notObject.ja.plain = ["x"];
		expect(codesOf(notObject)).toContain("shape");
		const nested = GOOD();
		nested.ja.plain = { a: { b: "x" } };
		expect(codesOf(nested)).toContain("shape");
	});

	it("非打底语言有打底里没有的句子 → unknown-sentence", () => {
		const input = GOOD();
		input.en.plain["a.extra"] = "extra";
		expect(codesOf(input)).toEqual(["unknown-sentence"]);
	});

	it("打底里有、别的语言缺的句子:默认放过,进了要求齐的名单才报 missing-sentence", () => {
		const input = GOOD();
		delete input.en.plain["a.greet"];
		expect(checkDictionaries({ locales: input })).toEqual([]);
		const strict = checkDictionaries({ locales: input, completeLocales: ["zh-CN", "en"] });
		expect(strict.map((issue) => issue.code)).toEqual(["missing-sentence"]);
		expect(strict[0].subject).toBe("a.greet");
	});

	it("同一句占位符不一样(含改错字母、多一个、少一个)→ placeholders", () => {
		const typo = GOOD();
		typo.en.plain["a.greet"] = "Hello {nmae}";
		expect(codesOf(typo)).toEqual(["placeholders"]);
		const fewer = GOOD();
		fewer.en.plain["a.greet"] = "Hello";
		expect(codesOf(fewer)).toEqual(["placeholders"]);
		const more = GOOD();
		more.en.plain["a.greet"] = "Hello {name} {extra}";
		expect(codesOf(more)).toEqual(["placeholders"]);
		// 同一句各类别合起来比:某个类别不写 {count} 不算错
		const spelled = GOOD();
		spelled.en.plain["a.item#one"] = "one item";
		expect(codesOf(spelled)).toEqual([]);
	});

	it("女仆层的占位符也与底里一致", () => {
		const input = GOOD();
		input["zh-CN"].maid["a.greet"] = "主人好 {nmae}～";
		expect(codesOf(input)).toEqual(["placeholders"]);
	});

	it("带数量的句子:缺类别、多出这种语言用不到的类别 → plural-missing-category / plural-extra-category", () => {
		const missing = GOOD();
		delete missing.en.plain["a.item#one"];
		expect(codesOf(missing)).toEqual(["plural-missing-category"]);
		const extra = GOOD();
		extra["zh-CN"].plain["a.item#one"] = "{count} 件";
		expect(codesOf(extra)).toEqual(["plural-extra-category"]);
	});

	it("带数量与否得与打底一致,同一句不许既有不带后缀的、又有 #类别 → plural-mismatch / plural-mixed", () => {
		const flat = GOOD();
		delete flat.en.plain["a.item#one"];
		delete flat.en.plain["a.item#other"];
		flat.en.plain["a.item"] = "{count} items";
		expect(codesOf(flat)).toEqual(["plural-mismatch"]);
		const sentenceBecamePlural = GOOD();
		delete sentenceBecamePlural.en.plain["a.greet"];
		sentenceBecamePlural.en.plain["a.greet#one"] = "Hello {name}";
		sentenceBecamePlural.en.plain["a.greet#other"] = "Hello {name}";
		expect(codesOf(sentenceBecamePlural)).toEqual(["plural-mismatch"]);
		const mixed = GOOD();
		mixed.en.plain["a.item"] = "{count} items";
		expect(codesOf(mixed)).toContain("plural-mixed");
	});

	it("女仆层的句子不在同语言的平实版里 → maid-orphan", () => {
		const input = GOOD();
		input["zh-CN"].maid["a.nope"] = "主人～";
		expect(codesOf(input)).toContain("maid-orphan");
	});

	it("没有女仆层的语言出现女仆层 → maid-not-allowed", () => {
		const input = GOOD();
		input.en.maid = {};
		expect(codesOf(input)).toEqual(["maid-not-allowed"]);
	});

	it("打底语言读不到 → base-missing(不让后面的比对悄悄空转)", () => {
		expect(codesOf({ en: { plain: {} } })).toEqual(["base-missing"]);
	});
});

// ---------------------------------------------------------------------------
// 扫全仓
// ---------------------------------------------------------------------------

describe("BN 的译文目录", () => {
	it.each(DICT_DIRS)("%s:目录在、文件名对、每种语言有平实版", (dir) => {
		const { problems } = loadDictionaryDir(dir);
		expect(problems).toEqual([]);
	});

	it("服务端打底语言不是空的(扫空了比没有还糟)", () => {
		const { locales } = loadDictionaryDir("apps/server/src/i18n/locales");
		expect(Object.keys(locales[BASE_LOCALE].plain).length).toBeGreaterThan(0);
	});

	it.each(DICT_DIRS)("%s:键、占位符、单复数、女仆层都对得上", (dir) => {
		const { locales } = loadDictionaryDir(dir);
		expect(checkDictionaries({ locales })).toEqual([]);
	});

	it("要求齐的名单与有女仆层的名单只写 LOCALES 里的语言", () => {
		for (const locale of [...COMPLETE_LOCALES, ...MAID_LOCALES, BASE_LOCALE]) {
			expect(LOCALES).toContain(locale);
		}
	});
});
