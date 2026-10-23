import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { findNodes, listSources, parseSource, ts } from "../source-scan.mjs";

/**
 * 守卫 4:名字唯一的家(docs/1.0/architecture.md「守卫」第 4 行)。
 *
 * 同一件事抄成好几份,几份之间迟早长出分歧 —— 「N 分钟前」四份里一份不带空格,带正负号的
 * 增量负号两种、零三种写法,都是这么来的。点名表里的名字全仓只许在它的家里定义一次;家以外
 * 出现同名定义就红,**不导出的局部函数也算**(首页那份本地 `formatCount` 就没导出)。
 *
 * - 范围:`apps/<应用>/src`、`packages/<包>/src`,不含测试;不扫 `extensions/`(拓展只能从
 *   `@bilibili-notify/extension` 拿东西,自带的同名小函数不算抄本)。
 * - 定义:函数声明、变量声明、类声明、方法(类的与对象字面量的)。调用、import、类型都不算。
 * - 点名表随各项补(1.0 第 2 期 ⑪ 开张,头一批是数字与时间的排版);家里没有定义也红,免得
 *   表跟着代码过期。
 * - 守卫 4 抓不到异名抄本(⑪ 收掉的 `numberToStr`、`relativeTime` 就是这类),那些靠收的那一片
 *   按清单清。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 点名表:名字 → 唯一的家(仓库相对路径)。 */
export const HOMES = {
	formatCount: "packages/internal/src/format.ts",
	formatAgo: "packages/internal/src/format.ts",
	formatDuration: "packages/internal/src/format.ts",
	formatClock: "packages/internal/src/format.ts",
	formatAmount: "packages/internal/src/format.ts",
	formatAxisTick: "apps/web/src/pages/stats/chart-utils.ts",
	postText: "apps/server/src/posts/post-text.ts",
	normalizePost: "packages/internal/src/post.ts",
	// 「这条订阅要不要监听直播」的判定与它的键表、入参(3b-14;ADR-0027 决策 1):服务端与面板共用这一份。
	needsLiveMonitor: "packages/internal/src/live-monitor.ts",
	LIVE_ROOM_CREATOR_KEYS: "packages/internal/src/live-monitor.ts",
	// 多语言字典的核心(3b-09;ADR-0037 决策 6):合字典、语言 store,与两道字典守卫要用的拆键、取占位符;
	// 面板、服务端与拓展共用这一份。取字的 `translate` 不登记:B 站把动态翻成作品的私有函数也叫这个名,是另一件事。
	mergeDict: "packages/internal/src/i18n.ts",
	createI18n: "packages/internal/src/i18n.ts",
	stemOf: "packages/internal/src/i18n.ts",
	placeholdersOf: "packages/internal/src/i18n.ts",
	LOCALES: "packages/internal/src/i18n.ts",
	// 译文键与占位符的判据(3b-43):守卫与宿主共用这一把尺。
	isDictKey: "packages/internal/src/i18n.ts",
	malformedPlaceholders: "packages/internal/src/i18n.ts",
	// 语言与口吻两项设置的取值表与「缺了怎么补」的规则(3b-10):服务端绑定与面板同步共用,默认只写在这一处。
	VOICES: "packages/internal/src/i18n.ts",
	DEFAULT_LOCALE: "packages/internal/src/i18n.ts",
	DEFAULT_VOICE: "packages/internal/src/i18n.ts",
	textSettingsOf: "packages/internal/src/i18n.ts",
	// 没登录时按浏览器语言猜面板的语言(3b-10;ADR-0037 决策 17):规则只住这一处。
	guessLocale: "apps/web/src/i18n/preference.ts",
	// 面板订阅语言 store 的那一个 hook(3b-09):组件一律经它取字,不各写一份 useSyncExternalStore。
	useT: "apps/web/src/i18n/index.ts",
	// 宿主调来源的外壳(3b-22):超时、抛错收口、按来源键串行,搜人与查直播状态共用这一份。
	callSource: "apps/server/src/subscriptions/call-source.ts",
	// 主人可改的文案 → 它能用的变量 → 中立字段(3b-21):面板提示条与服务端可满足性探针共用这一份。
	TEMPLATE_VARIABLES: "packages/internal/src/template-variables.ts",
	// 显示名链与身份标签(3b-24 L1):服务端与面板共用这一份，data-model「显示名只有一条链」。
	subscriptionIdentityLabel: "apps/contract/src/nouns.ts",
	displayNameOf: "apps/contract/src/nouns.ts",
	// 挑叫法(3b-35):一个来源用它自己的、混着用调用方递进来的中性词;中性词给人看的进字典、给模型的住 ai 包。
	sourceNounsOf: "apps/contract/src/nouns.ts",
	PROMPT_NEUTRAL_NOUNS: "packages/ai/src/prompt-nouns.ts",
	// 全局时区的出厂值与两条规矩(3b-11;ADR-0021 决策 43):设置 schema 与服务端切天共用这一份。
	DEFAULT_TIMEZONE: "packages/internal/src/timezone.ts",
	isTimezone: "packages/internal/src/timezone.ts",
	timezoneOffsetMinutes: "packages/internal/src/timezone.ts",
};

/** 一个节点若是一处定义,回它定义的名字。 */
function definedName(node) {
	if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name !== undefined) {
		return node.name.text;
	}
	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
	if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
	return undefined;
}

/**
 * 一份源码里点名表上那些名字的定义。
 *
 * @returns `{ name, line }[]`,按出现顺序
 */
export function namedDefinitions(source, names) {
	const wanted = new Set(names);
	return findNodes(source, (node) => wanted.has(definedName(node) ?? "")).map(({ node, line }) => ({
		name: definedName(node),
		line,
	}));
}

const NAMES = ["formatCount", "formatAgo"];

/** 把一段样例当成一份 `.ts` 源码,返回命中的 `名字:行号`。 */
const hitsIn = (text) =>
	namedDefinitions(parseSource("sample.ts", text), NAMES).map((h) => `${h.name}:${h.line}`);

describe("定义的判据:算", () => {
	it("函数声明,导不导出都算", () => {
		expect(hitsIn(`export function formatCount(n) {}`)).toEqual(["formatCount:1"]);
		expect(hitsIn(`function formatAgo(t) {}`)).toEqual(["formatAgo:1"]);
	});

	it("变量里装的箭头函数,以及类与对象字面量里的方法", () => {
		expect(hitsIn(`const formatCount = (n) => String(n);`)).toEqual(["formatCount:1"]);
		expect(hitsIn(`class F {\n\tformatAgo(t) {}\n}`)).toEqual(["formatAgo:2"]);
		expect(hitsIn(`const fmt = {\n\tformatCount(n) { return ""; },\n};`)).toEqual([
			"formatCount:2",
		]);
	});
});

describe("定义的判据:不算", () => {
	it("调用、import、类型、属性名、表外的名字", () => {
		expect(
			hitsIn(
				[
					`import { formatCount } from "@bilibili-notify/internal/format";`,
					`const text = formatCount(12345);`,
					`type T = typeof formatAgo;`,
					`const opts = { formatCount: formatCount };`,
					`function formatWan(n) {}`,
				].join("\n"),
			),
		).toEqual([]);
	});
});

function scopeRoots() {
	const roots = [];
	for (const group of ["apps", "packages"]) {
		for (const entry of readdirSync(join(REPO_ROOT, group), { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(join(REPO_ROOT, group, entry.name, "src"))) {
				roots.push(`${group}/${entry.name}/src`);
			}
		}
	}
	return roots.sort();
}

/** 真去扫仓库:名字 → 定义它的 `文件:行号`。 */
function scanRepo() {
	const found = {};
	for (const file of listSources(scopeRoots())) {
		for (const { name, line } of namedDefinitions(parseSource(file), Object.keys(HOMES))) {
			found[name] ??= [];
			found[name].push(`${file}:${line}`);
		}
	}
	return found;
}

describe("点名表上的名字都只在家里定义", () => {
	const found = scanRepo();

	it("家以外没有同名定义", () => {
		const strays = Object.entries(found).flatMap(([name, places]) =>
			places.filter((place) => !place.startsWith(`${HOMES[name]}:`)).map((p) => `${name} @ ${p}`),
		);
		expect(strays).toEqual([]);
	});

	it("每个名字在家里都真有定义 —— 表不跟着代码过期", () => {
		const homeless = Object.entries(HOMES)
			.filter(([name, home]) => !(found[name] ?? []).some((place) => place.startsWith(`${home}:`)))
			.map(([name, home]) => `${name} → ${home}`);
		expect(homeless).toEqual([]);
	});
});
