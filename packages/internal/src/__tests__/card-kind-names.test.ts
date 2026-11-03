/**
 * 卡种中文名**只许住在 `card-skin.ts` 一处**(㉔f)。
 *
 * 从前五处各写一份(`CARD_KIND_NAMES`、皮肤编辑器顶栏、回落告警、卡片页两张表、测试推送图说),加第八种卡时
 * 总有一边漏掉,漏掉的那边是静默的 —— 类型、测试、构建都绿,面板上就是少一个名字或者名字对不上。
 *
 * 守卫分两半:
 * - 表自己:三张表(全名 / 短名 / 事件名)的键恰好是卡种、名字不撞;
 * - 全仓:别处不许再写一张「卡种键 → 卡种中文名」的表。判据走语法树(注释与字符串里的字样天生不是节点),写成纯函数
 *   + 样例 —— 判据本身也会写错,一条永远判 OK 的规则跟没有一样。
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { findNodes, listSources, parseSource, ts } from "../../../../scripts/source-scan.mjs";
import {
	CARD_KIND_EVENT_NAMES,
	CARD_KIND_NAMES,
	CARD_KIND_SHORT_NAMES,
	CARD_KINDS,
	CARD_SKIN_BUILTIN_BLOCKS,
} from "../card-skin";

const OWNER = "packages/internal/src/card-skin.ts";

/**
 * 不会跟别的概念撞字的名字(全名、事件名:「直播卡」「SC 提醒」)—— 卡种键配上其中任何一个,单独一条就算抄了。
 * 短名(「直播」「动态」「SC」)是日常词,别的表(特性名、颜色表)可能碰巧同字,要凑成一张表才算。
 */
const STRONG_NAMES = new Set<string>([
	...Object.values(CARD_KIND_NAMES),
	...Object.values(CARD_KIND_EVENT_NAMES),
]);
/** 全仓登记过的卡种中文名(三张表的所有值)。 */
const REGISTERED_NAMES = new Set<string>([
	...STRONG_NAMES,
	...Object.values(CARD_KIND_SHORT_NAMES),
]);

/**
 * 一份源码里有几个「卡种键 → 登记过的中文名」的赋值(`live: "直播"`,或 `live: { label: "直播", … }`)。
 * 是否算「又抄了一张表」见 {@link looksLikeKindTable}(特性名表会撞字,不能一刀切)。
 */
export function kindNameEntries(path: string, text?: string, strongOnly = false): string[] {
	const source = parseSource(path, text);
	const keys = new Set<string>(CARD_KINDS);
	const found = new Set<string>();
	const nameOf = (init: ts.Expression): string | undefined => {
		if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) return init.text;
		if (!ts.isObjectLiteralExpression(init)) return undefined;
		for (const prop of init.properties) {
			if (
				ts.isPropertyAssignment(prop) &&
				ts.isIdentifier(prop.name) &&
				prop.name.text === "label" &&
				ts.isStringLiteral(prop.initializer)
			) {
				return prop.initializer.text;
			}
		}
		return undefined;
	};
	for (const hit of findNodes(source, (n) => ts.isPropertyAssignment(n))) {
		const node = hit.node as ts.PropertyAssignment;
		const key = ts.isIdentifier(node.name) ? node.name.text : undefined;
		if (key === undefined || !keys.has(key)) continue;
		const name = nameOf(node.initializer);
		const registered = strongOnly ? STRONG_NAMES : REGISTERED_NAMES;
		if (name !== undefined && registered.has(name)) found.add(key);
	}
	return [...found].sort();
}

/**
 * 特性键(`post` / `membership` / `superchat`……)与卡种键重名、名字也撞(「动态」「上舰」「SC」),所以一张**特性名**表
 * 三个键全中并不是抄了卡种表。只有这四个键是卡种独有的 —— 凑够三个键且里头至少有一个独有的,才算抄了一张卡种表。
 */
const KIND_ONLY_KEYS = new Set<string>(["live", "roastBoard", "roastSolo", "wordcloud"]);
const TABLE_THRESHOLD = 3;

/** 这几个键够不够算「又抄了一张卡种表」。 */
export function looksLikeKindTable(keys: string[]): boolean {
	return keys.length >= TABLE_THRESHOLD && keys.some((k) => KIND_ONLY_KEYS.has(k));
}

describe("卡种中文名的表", () => {
	it("全名与短名:键恰好是七种卡;事件名:恰好是按事件推的四种", () => {
		expect(Object.keys(CARD_KIND_NAMES).sort()).toEqual([...CARD_KINDS].sort());
		expect(Object.keys(CARD_KIND_SHORT_NAMES).sort()).toEqual([...CARD_KINDS].sort());
		expect(Object.keys(CARD_KIND_EVENT_NAMES).sort()).toEqual(
			["live", "membership", "post", "superchat"].sort(),
		);
	});

	it("每张表里名字不重复、不为空;全名都带「卡」字", () => {
		for (const table of [CARD_KIND_NAMES, CARD_KIND_SHORT_NAMES, CARD_KIND_EVENT_NAMES]) {
			const values = Object.values(table);
			expect(values.every((v) => v.length > 0)).toBe(true);
			expect(new Set(values).size).toBe(values.length);
		}
		for (const name of Object.values(CARD_KIND_NAMES)) expect(name.endsWith("卡")).toBe(true);
	});
});

describe("同一个概念同一个名字", () => {
	// 验红:把 card-skin.ts 里直播卡 creatorName 块的 label 改回「主播名」,这条红。
	it("直播卡与动态卡的 creatorName 块都叫「创作者名」(核心里的词是 creator,不是主播)", () => {
		expect(CARD_SKIN_BUILTIN_BLOCKS.live.creatorName?.label).toBe("创作者名");
		expect(CARD_SKIN_BUILTIN_BLOCKS.post.creatorName?.label).toBe("创作者名");
	});
});

describe("判据本身(样例)", () => {
	it("一张抄来的表:短名与对象式 label 两种写法都认", () => {
		const copy = `const A = { live: "直播", post: "作品", superchat: "SC", extra: 1 };`;
		expect(kindNameEntries("sample-a.ts", copy)).toEqual(["live", "post", "superchat"]);
		const labelled = `const B = { live: { label: "直播开播", icon: "x" }, post: { label: "作品发布" }, membership: { label: "会员提醒" } };`;
		expect(kindNameEntries("sample-b.ts", labelled)).toEqual(["live", "membership", "post"]);
	});

	it("单条也算:卡种键配上全名或事件名(不会撞字的名字),哪怕只有一条", () => {
		const single = `const G = { live: { label: "直播开播", tone: "x" }, other: 1 };`;
		expect(kindNameEntries("sample-g.ts", single, true)).toEqual(["live"]);
		const shortOnly = `const H = { live: "直播" };`;
		expect(kindNameEntries("sample-h.ts", shortOnly, true)).toEqual([]);
	});

	it("特性名表不算:三个特性键(post / superchat / membership)撞了同样的字,没有卡种独有的键", () => {
		const features = `const FEATURE_LABELS = { post: "作品", liveStart: "开播", membership: "会员", superchat: "SC" };`;
		const keys = kindNameEntries("sample-f.ts", features);
		expect(keys).toEqual(["membership", "post", "superchat"]);
		expect(looksLikeKindTable(keys)).toBe(false);
		expect(looksLikeKindTable(["live", "post", "superchat"])).toBe(true);
		expect(looksLikeKindTable(["live", "post"])).toBe(false);
	});

	it("别的概念不算:值不是登记过的名字、键不是卡种、字样在注释或字符串里", () => {
		const other = [
			`const D = { live: "开播 / 直播中 / 下播", post: "动态 / 视频投稿", superchat: "醒目留言 SC" };`,
			`const E = { feature: "直播", other: "动态" };`,
			`// live: "直播", post: "作品", superchat: "SC"`,
			'const F = `live: "直播", post: "作品", superchat: "SC"`;',
		].join("\n");
		expect(kindNameEntries("sample-c.ts", other)).toEqual([]);
	});
});

describe("全仓:别处不许再抄一份", () => {
	it("除 card-skin.ts 外,没有哪份源码里再写「卡种键 → 卡种中文名」(成表,或单条用了不撞字的全名 / 事件名)", () => {
		const files = listSources(srcRoots()).filter((f) => f !== OWNER);
		const offenders = files.flatMap((file) => {
			const keys = kindNameEntries(file);
			const strong = kindNameEntries(file, undefined, true);
			return looksLikeKindTable(keys) || strong.length > 0
				? [`${file}: ${[...new Set([...keys, ...strong])].join(" / ")}`]
				: [];
		});
		expect(offenders, "卡种中文名只许写在 card-skin.ts;别处用 CARD_KIND_* 三张表").toEqual([]);
	});

	it("扫得到东西(免得目录写错、一份文件都没扫就绿)", () => {
		const files = listSources(srcRoots());
		expect(files).toContain(OWNER);
		expect(files.some((f) => f.startsWith("apps/web/src/"))).toBe(true);
		expect(files.some((f) => f.startsWith("apps/server/src/"))).toBe(true);
	});
});

/** 仓库里所有有 `src` 的工作区(`apps/*`、`packages/*`、`extensions/*`):从磁盘数,新开一个包不用回来改这里。 */
function srcRoots(): string[] {
	const repo = fileURLToPath(new URL("../../../../", import.meta.url));
	return ["apps", "packages", "extensions"].flatMap((top) =>
		readdirSync(join(repo, top)).flatMap((name) =>
			existsSync(join(repo, top, name, "src")) ? [`${top}/${name}/src`] : [],
		),
	);
}
