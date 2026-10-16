import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { LOCALES, placeholdersOf, stemOf } from "../../packages/internal/src/i18n.ts";

/**
 * 译文文件的键与占位符(ADR-0037 决策 6):各语言的译文之间、女仆层与平实版之间,
 * 键、占位符、带数量的句子得对得上。类型只把键推成 string,推不出占位符与单复数类别,所以由这一道钉着。
 *
 * - 范围:BN 两端的译文目录(服务端、面板)。拓展的译文(3b-43)以后进同一张表或另起。
 *   「新开的译文目录不许被静默漏查」由 `findLocalesDirs` 那一条钉着:仓里叫 `locales` 的目录必须等于 `DICT_DIRS`。
 * - 读的是 JSON 不是源码,没有「注释被当成代码」的问题。
 * - 简体中文打底(缺的句子运行时拿它补),所以「齐不齐」是**方向**判:别的语言不许有底里没有的句子;
 *   「要求齐的语言」名单今天只有 zh-CN,第 5 期翻完把 en、ja 加进 COMPLETE_LOCALES(不用 skip,免得忘了开);
 *   反方向有棘轮:某种语言已经把打底的每一句都译了、却不在名单里,就红,逼着写进名单。
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
/**
 * 键形如 `段.段…`,可带一个 `#类别`;段由字母数字下划线连字符组成。放这么宽是因为 BN 以后按码出的
 * 失败文案(`not_found`)、平台键(`qq-official`)、内置人格 id(`gentle-maid`)都会进键。
 * 拒掉会碰原型链的几个段(`__proto__` 等)。对拓展公开的键写法这一片不定,留给 3b-43 前问主人。
 */
const KEY_SHAPE = new RegExp(`^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*(#(${CATEGORIES.join("|")}))?$`);
const FORBIDDEN_SEGMENTS = ["__proto__", "constructor", "prototype"];

/** 译文里凡是 `{…}` 的都得是 `{字母数字下划线}`;`{名字}`、`{user-name}`、`{ name }` 运行时不会被填,原样露给用户。 */
const BRACES = /\{[^{}]*\}/g;
const WELL_FORMED_HOLE = /^\{\w+\}$/;

const isPlainObject = (value) =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** 一层译文按句分组:每句记着有没有不带后缀的条、有哪些类别、每个类别的占位符、占位符的并集。 */
function groupBySentence(layer) {
	const groups = new Map();
	for (const [key, text] of Object.entries(layer)) {
		const stem = stemOf(key);
		const group = groups.get(stem) ?? {
			bare: false,
			categories: [],
			byCategory: new Map(),
			placeholders: new Set(),
		};
		const names = placeholdersOf(text);
		if (key === stem) group.bare = true;
		else {
			const category = key.slice(stem.length + 1);
			group.categories.push(category);
			group.byCategory.set(category, new Set(names));
		}
		for (const name of names) group.placeholders.add(name);
		groups.set(stem, group);
	}
	return groups;
}

const placeholderSignature = (group) => [...group.placeholders].sort().join(",");

/** 这种语言的单复数类别,读运行时的,不写死 one / other。 */
function categoriesOf(locale) {
	return new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
}

/** 逐条查一层的形状:键写法、值是字符串且不为空、占位符写法。回有没有问题。 */
function checkShape(dict, report, locale, layer) {
	let ok = true;
	for (const [key, text] of Object.entries(dict)) {
		if (
			!KEY_SHAPE.test(key) ||
			stemOf(key)
				.split(".")
				.some((s) => FORBIDDEN_SEGMENTS.includes(s))
		) {
			report(
				"shape",
				locale,
				layer,
				key,
				"键的写法不对(段.段…,段是字母数字下划线连字符,可带 #类别)",
			);
			ok = false;
		}
		if (typeof text !== "string") {
			report("shape", locale, layer, key, "值不是字符串");
			ok = false;
			continue;
		}
		// 空串会盖掉打底、回一条空白的话
		if (text.trim() === "") {
			report("empty-text", locale, layer, key, "值是空的");
			ok = false;
		}
		for (const hole of text.match(BRACES) ?? []) {
			if (!WELL_FORMED_HOLE.test(hole)) {
				report(
					"bad-placeholder",
					locale,
					layer,
					key,
					`占位符 ${hole} 写法不对,要 {字母数字下划线}`,
				);
				ok = false;
			}
		}
	}
	return ok;
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
			if (!checkShape(dict, report, locale, layer)) continue;
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
				// 同一句里不许既有不带后缀的、又有带类别的。从严不放宽:一句话在各语言里要么都带数量、
				// 要么都不带,混着写译者容易漏(漏了的类别运行时拿到的是另一条的话)
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
					// 占位符按类别核:除 count 以外的占位符每个类别都得有(count 允许某些类别省掉,如 "one item")
					const required = [...group.placeholders].filter((name) => name !== "count");
					for (const [category, names] of group.byCategory) {
						for (const name of required) {
							if (!names.has(name)) {
								report("plural-placeholder", locale, layer, stem, `#${category} 缺 {${name}}`);
							}
						}
					}
				}
				// 女仆层的句子都得在同语言的平实版里
				if (layer === "maid" && !layers.plain?.has(stem)) {
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
				// 带数量与否得与打底一致(同上:从严,混着写译者容易漏)
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
	// 棘轮:已经把打底的每一句都译了、却不在名单里的语言,逼着写进名单(打底是空的就谈不上齐)
	if (base.size > 0) {
		for (const [locale, layers] of Object.entries(grouped)) {
			if (locale === baseLocale || completeLocales.includes(locale)) continue;
			if ([...base.keys()].every((stem) => layers.plain?.has(stem))) {
				report(
					"complete-not-listed",
					locale,
					"plain",
					"",
					"已译完打底的每一句,请加进 COMPLETE_LOCALES",
				);
			}
		}
	}
	return issues;
}

/** 读一个译文目录:文件名 `<语言码>.json` / `<语言码>.maid.json`,点开头的文件跳过,其余的文件名是问题。 */
export function loadDictionaryDir(dir, root = REPO_ROOT) {
	const locales = {};
	const problems = [];
	const absolute = join(root, dir);
	if (!existsSync(absolute)) return { locales, problems: [`${dir} 不存在`] };
	for (const file of readdirSync(absolute).sort()) {
		if (file.startsWith(".")) continue; // .DS_Store 之类
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

/** 找 `roots` 底下所有名叫 `locales` 的目录(仓库相对路径,排好序)。不进点开头的、node_modules、dist、lib、target。 */
export function findLocalesDirs(root, roots = ["apps", "packages"]) {
	const skipped = new Set(["node_modules", "dist", "lib", "target"]);
	const found = [];
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || skipped.has(entry.name)) continue;
			const path = join(directory, entry.name);
			if (entry.name === "locales") found.push(relative(root, path).split("\\").join("/"));
			walk(path);
		}
	};
	for (const top of roots) {
		if (existsSync(join(root, top))) walk(join(root, top));
	}
	return found.sort();
}

// ---------------------------------------------------------------------------
// 判据的样例:每一条各配一个「干净」与一个「坏」
// ---------------------------------------------------------------------------

const GOOD = () => ({
	"zh-CN": {
		plain: {
			"a.greet": "你好 {name}",
			"a.item#other": "{count} 件",
			"a.moved#other": "{up} 发了 {count} 条",
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
		badKey.en.plain["Bad Key"] = "x";
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

	it("键的写法:段可以带下划线与连字符(not_found、qq-official、gentle-maid),拒原型链的段", () => {
		const input = GOOD();
		input["zh-CN"].plain["failure.not_found"] = "没找到";
		input["zh-CN"].plain["platform.qq-official.name"] = "QQ";
		input["zh-CN"].plain["persona.gentle-maid.title"] = "温柔";
		input["zh-CN"].plain["a.Mixed9"] = "x";
		expect(codesOf(input)).toEqual([]);
		for (const bad of [
			"__proto__",
			"a.constructor",
			"prototype.x",
			"a.__proto__.b",
			"a..b",
			".a",
			"a.",
		]) {
			const input = GOOD();
			// 直接赋值 `__proto__` 会走 setter,要像 JSON.parse 那样定义成自有键
			Object.defineProperty(input["zh-CN"].plain, bad, {
				value: "x",
				enumerable: true,
				configurable: true,
				writable: true,
			});
			expect(codesOf(input), bad).toContain("shape");
		}
		// 键里的 #类别 必须是六个之一
		const unknownCategory = GOOD();
		unknownCategory["zh-CN"].plain["a.item#some"] = "x";
		expect(codesOf(unknownCategory)).toContain("shape");
	});

	it("值去掉空白后为空 → empty-text,所有层所有语言都查", () => {
		for (const [locale, layer] of [
			["en", "plain"],
			["zh-CN", "plain"],
			["zh-CN", "maid"],
		]) {
			for (const empty of ["", "   ", "\n\t"]) {
				const input = GOOD();
				input[locale][layer]["a.greet"] = empty;
				expect(codesOf(input), `${locale}.${layer} ${JSON.stringify(empty)}`).toContain(
					"empty-text",
				);
			}
		}
	});

	it("写坏的占位符 → bad-placeholder({名字}、{user-name}、{ name }、{}),所有层都查", () => {
		for (const [locale, layer] of [
			["en", "plain"],
			["zh-CN", "plain"],
			["zh-CN", "maid"],
		]) {
			for (const hole of ["{名字}", "{user-name}", "{ name }", "{}"]) {
				const input = GOOD();
				input[locale][layer]["a.greet"] = `Hi ${hole}`;
				expect(codesOf(input), `${locale}.${layer} ${hole}`).toContain("bad-placeholder");
			}
		}
		// 写对的不报
		const fine = GOOD();
		fine.en.plain["a.greet"] = "Hi {name} and {name_2}";
		expect(codesOf(fine)).not.toContain("bad-placeholder");
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
		expect(strict.map((issue) => issue.code)).toEqual(["missing-sentence", "missing-sentence"]);
		expect(strict[0].subject).toBe("a.greet");
	});

	it("棘轮:已译完打底每一句却不在名单里 → complete-not-listed;进名单就不报;打底是空的不算", () => {
		const input = GOOD();
		input.en.plain["a.moved#one"] = "{up} posted {count}";
		input.en.plain["a.moved#other"] = "{up} posted {count}";
		const issues = checkDictionaries({ locales: input });
		expect(issues.map((issue) => issue.code)).toEqual(["complete-not-listed"]);
		expect(issues[0].locale).toBe("en");
		expect(checkDictionaries({ locales: input, completeLocales: ["zh-CN", "en"] })).toEqual([]);
		const emptyBase = { "zh-CN": { plain: {} }, en: { plain: {} }, ja: { plain: {} } };
		expect(checkDictionaries({ locales: emptyBase })).toEqual([]);
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

	it("占位符按类别核:count 以外的占位符每个类别都得有,count 可以省", () => {
		const input = GOOD();
		input.en.plain["a.moved#one"] = "{up} posted one";
		input.en.plain["a.moved#other"] = "{up} posted {count}";
		expect(codesOf(input)).not.toContain("plural-placeholder");
		const dropped = GOOD();
		dropped.en.plain["a.moved#one"] = "someone posted {count}";
		dropped.en.plain["a.moved#other"] = "{up} posted {count}";
		const issues = checkDictionaries({ locales: dropped });
		expect(issues.filter((issue) => issue.code === "plural-placeholder")).toHaveLength(1);
		expect(issues.find((issue) => issue.code === "plural-placeholder").detail).toContain("#one");
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

describe("读目录的两个函数(临时目录样例)", () => {
	const withTree = (build, run) => {
		const root = mkdtempSync(join(tmpdir(), "i18n-dicts-"));
		try {
			build(root);
			run(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	};
	const put = (root, path, text = "{}") => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	};

	it("loadDictionaryDir:跳过点开头的文件,其余文件名不对的报", () => {
		withTree(
			(root) => {
				for (const locale of LOCALES) put(root, `d/${locale}.json`);
				put(root, "d/.DS_Store", "binary");
			},
			(root) => expect(loadDictionaryDir("d", root).problems).toEqual([]),
		);
		withTree(
			(root) => {
				for (const locale of LOCALES) put(root, `d/${locale}.json`);
				put(root, "d/notes.json");
			},
			(root) => expect(loadDictionaryDir("d", root).problems).toHaveLength(1),
		);
	});

	it("findLocalesDirs:只看 apps 与 packages,不进 node_modules、dist、lib、target 与点开头的目录", () => {
		withTree(
			(root) => {
				put(root, "apps/a/src/i18n/locales/en.json");
				put(root, "packages/b/locales/en.json");
				put(root, "apps/a/node_modules/x/locales/en.json");
				put(root, "apps/a/dist/locales/en.json");
				put(root, "packages/b/lib/locales/en.json");
				put(root, "apps/a/src-tauri/target/locales/en.json");
				put(root, ".claude/worktrees/w/apps/a/locales/en.json");
				put(root, "extensions/e/locales/en.json");
			},
			(root) =>
				expect(findLocalesDirs(root)).toEqual(["apps/a/src/i18n/locales", "packages/b/locales"]),
		);
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

	it("仓里叫 locales 的目录必须等于 DICT_DIRS —— 新开的译文目录不许被静默漏查", () => {
		expect(findLocalesDirs(REPO_ROOT)).toEqual([...DICT_DIRS].sort());
	});

	it("要求齐的名单与有女仆层的名单只写 LOCALES 里的语言", () => {
		for (const locale of [...COMPLETE_LOCALES, ...MAID_LOCALES, BASE_LOCALE]) {
			expect(LOCALES).toContain(locale);
		}
	});
});
