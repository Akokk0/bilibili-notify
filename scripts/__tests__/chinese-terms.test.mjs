import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { auditRatchet } from "../ratchet-audit.mjs";
import { findNodes, listSources, parseSource, srcRootsUnder, ts } from "../source-scan.mjs";

/**
 * 中文叫法棘轮:核心与面板的字符串里写死 B 站叫法的地方,只许少、不许多(docs/1.0/architecture.md 第二层静态扫描
 * 「中文叫法棘轮」那一行;第 4 期开张、第 5 期末清零)。守卫 11 只管英文词,中文的叫法(「UP主」「动态」「舰长」)
 * 由这道管 —— 文案、提示词、界面里该说「作者」「作品」「会员」的地方,要么经来源的描述符拿叫法,要么用中性词。
 *
 * - 范围:`apps/server/src`、`apps/web/src`、`apps/contract/src`、`packages/<包>/src`,不含测试、`.d.ts`;
 *   桌面壳与拓展不扫(同写死的中文那道)。**`locales/*.json` 一起扫**:字搬进字典以后源码扫描看不见它们,
 *   JSON 没有语法树,按「值」数,一个值算一处。
 * - 判据看语法树(注释天生不是节点):**一个字符串节点里带上任一个叫法就算一处**。节点与写死的中文那道同四种:
 *   字符串字面量、不带插值的反引号串、带插值的模板(头和各段拼起来算一处)、JSX 文字。日志调用的参数**照算**:
 *   判据没有排除它,日志里写「UP主」同样是核心在点名 B 站。
 * - 叫法:`UP主`(中间可有空格)、`B站`(同)、`哔哩`、`舰长`、`提督`、`总督`、`大航海`、`上舰`、`粉丝牌`、`专栏`、
 *   `房管`、`UID`(只认大写,小写的 uid 归 uid 棘轮)、`动态`。
 * - 整目录不扫:B 站自己(`apps/server/src/bilibili/`)与迁移模块(`apps/server/src/migration/`)。
 * - 按叫法放行:ADR-0021 决策 50「面板与 CSV 里仍叫『投稿』『动态』」—— 统计那几个文件里的「动态」不算,别的叫法照算。
 * - 棘轮按文件记上限(对账见 `scripts/ratchet-audit.mjs`):多一处就红,上限高于实数也红,清零了整行删。
 *   **涨了一律红,调格前问主人**。
 *
 * 抓不到的(靠审查):字符串拼出来的叫法(`"UP" + "主"`)每段各算各的、拼不起来;中文标识符不是字符串节点;
 * 正则字面量里的叫法(认输入用的)不是字符串节点。
 *
 * 判据写成纯函数 + 样例:一条永远判 OK 的规则跟没有一样。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 叫法。按出现的子串认,不分词边界(中文没有词边界);`UID` 区分大小写。 */
export const TERMS = [
	"UP ?主",
	"B ?站",
	"哔哩",
	"舰长",
	"提督",
	"总督",
	"大航海",
	"上舰",
	"粉丝牌",
	"专栏",
	"房管",
	"UID",
	"动态",
];
const TERM_RE = new RegExp(TERMS.join("|"), "g");

/** 整个目录放行(仓库相对、带结尾斜杠),写明理由。 */
export const EXCLUDED_DIRS = {
	"apps/server/src/bilibili/": "B 站自己:叫法本来就是它的",
	"apps/server/src/migration/": "迁移模块:读的是 0.x 的旧数据,叫法照旧数据说",
};

/** 按叫法放行:文件 → 这个文件里不算的叫法与理由。别的叫法照算。 */
export const TERM_ALLOWLIST = {
	"apps/web/src/pages/Stats.tsx": {
		terms: ["动态"],
		reason: "ADR-0021 决策 50:统计的面板与 CSV 里仍叫「投稿」「动态」",
	},
	"apps/web/src/pages/stats/columns.ts": {
		terms: ["动态"],
		reason: "ADR-0021 决策 50:统计的面板与 CSV 里仍叫「投稿」「动态」",
	},
	"apps/web/src/pages/stats/csv.ts": {
		terms: ["动态"],
		reason: "ADR-0021 决策 50:统计的面板与 CSV 里仍叫「投稿」「动态」",
	},
	"apps/web/src/pages/stats/radar.ts": {
		terms: ["动态"],
		reason: "ADR-0021 决策 50:统计的面板与 CSV 里仍叫「投稿」「动态」",
	},
};

/** 主人批准 4-26：统计原例外仅迁到这三个 plain 完整键，其他词仍计数。 */
export const JSON_TERM_ALLOWLIST = {
	"apps/web/src/i18n/locales/zh-CN.json": {
		"sourceUi.pages.Stats.Stats.22": ["动态"],
		"sourceUi.pages.Stats.subtitle.38": ["动态"],
		"sourceUi.pages.Stats.plainPosts": ["动态"],
	},
};

/** 白名单:整个文件放行,写明理由(`auditRatchet` 的口径;今天没有)。 */
export const ALLOWLIST = {};

/** 报错后面带的那句:越界怎么办。 */
export const ADVICE =
	"给人看的叫法经来源的描述符取(`postNoun`、`creatorNoun` 这一类),或改用中性词(作者、作品、会员);确实要留的去问主人,由主人定是加上限、按叫法放行还是改判据,不要自己加,也不要起别的形状躲;数降了就当场把这一格调低,清零了整行删";

/**
 * 棘轮表:文件 → 命中的上限(4-09 开张时的现数:65 个文件 298 处)。只许往下调;第 4 期面板按描述符重画时成片消,第 5 期末清零。
 */
export const RATCHET = {
	"apps/contract/src/skin.ts": 3,
	"apps/server/src/card-skins/ai-css.ts": 1,
	"apps/server/src/devtools/scenarios/capture.ts": 1,
	"apps/server/src/devtools/scenarios/timers.ts": 1,
	// 4-24: 主人2026-10-31批准迁移事实搬字典的精确5处增量，原文不改、判据与白名单不动。
	// 4-27：主人批准来源提示专栏精确1处增量，完整键与命中词由下方断言钉住。
	// 4-28: 主人批准旧档位表七处原文精确迁入,全仓叫法总数不变。
	"apps/server/src/i18n/locales/zh-CN.json": 23,
	"apps/server/src/i18n/locales/zh-CN.maid.json": 1,
	"apps/server/src/live/membership.ts": 3,
	"apps/server/src/live/recap/live-summary-requester.ts": 1,
	"apps/server/src/posts/deliver-post.ts": 6,
	"apps/server/src/routes/targets.ts": 2,
	"apps/server/src/runtime/roots.ts": 1,
	// 4-26：主人批准真实 B 语境 5 plain + 3 maid，精确键与命中词由下方实扫断言钉住。
	"apps/web/src/i18n/locales/zh-CN.json": 6,
	"apps/web/src/i18n/locales/zh-CN.maid.json": 3,
	"apps/web/src/components/header.tsx": 1,

	"apps/web/src/components/onboarding/tour-companion.tsx": 2,
	"apps/web/src/components/onboarding/tour-script.ts": 4,
	"apps/web/src/components/shell-states.tsx": 1,
	"apps/web/src/config/nav.ts": 1,
	"apps/web/src/config/push-features.ts": 4,
	"apps/web/src/devtools/ext-motion.ts": 2,
	"apps/web/src/devtools/web-scenarios.ts": 1,
	"apps/web/src/pages/About.tsx": 1,
	// 4-43：沿4-29持续授权原文搬家，6=1+4+1，归期不改。
	"apps/web/src/pages/System.tsx": 1,
	"apps/web/src/pages/system/account-section.tsx": 4,
	"apps/web/src/pages/backup/BackupExportDialog.tsx": 1,
	"apps/web/src/pages/backup/BackupSection.tsx": 2,
	"apps/web/src/pages/guide/guide-panel.tsx": 1,
	"apps/web/src/pages/rules/MessageLayoutEditor.tsx": 1,
	"apps/web/src/pages/stats/SoloRoastCard.tsx": 1,
	"apps/web/src/pages/stats/charts.tsx": 1,

	"apps/web/src/utils/groupDiffs.ts": 2,
	"packages/ai/src/commentary-generator.ts": 1,
	"packages/ai/src/tools.ts": 1,
	"packages/image/src/image-renderer.ts": 7,
	"packages/image/src/preview/sample-cards.ts": 8,
	"packages/internal/src/card-skin.ts": 7,
	"packages/internal/src/schema/card-skin.ts": 2,
	"packages/storage/src/key-manager.ts": 1,
	"packages/storage/src/key-provider.ts": 2,
};

/** 一段文字里出现的叫法(去掉这个文件放行的那几个);没有就是空数组。 */
export function termsIn(text, allowed = []) {
	return [...text.matchAll(TERM_RE)]
		.map((m) => m[0].replace(/ /g, ""))
		.filter((term) => !allowed.includes(term));
}

/** 字符串节点的文字(四种);不是字符串节点回 `undefined`。模板的头与各段拼在一起判。 */
function textOf(node) {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	if (ts.isTemplateExpression(node)) {
		return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join("");
	}
	return ts.isJsxText(node) ? node.text : undefined;
}

/** 一份源码里写死的叫法:`{ line, text }[]`,按出现顺序,一个节点一处。 */
export function termHits(source, allowed = []) {
	return findNodes(source, (node) => {
		const text = textOf(node);
		return text !== undefined && termsIn(text, allowed).length > 0;
	}).map(({ line, text }) => ({ line, text }));
}

/** 一份字典 JSON 里带叫法的值:`{ line, text }[]`,一个值一处(`line` 记键)。 */
export function jsonTermHits(json, allowed = [], file = "") {
	const hits = [];
	const walk = (value, key) => {
		if (typeof value === "string") {
			if (termsIn(value, [...allowed, ...(JSON_TERM_ALLOWLIST[file]?.[key] ?? [])]).length > 0)
				hits.push({ line: key, text: value });
		} else if (value && typeof value === "object") {
			for (const [k, v] of Object.entries(value)) walk(v, key === "" ? k : `${key}.${k}`);
		}
	};
	walk(JSON.parse(json), "");
	return hits;
}

/** 批准的叫法与同词原节点闭集，词以 termsIn 的规范形式记录。 */
export const JSON_TERM_PINS = {
	"apps/web/src/i18n/locales/zh-CN.json": {
		// 4-53a：主人已持续批准后片原文迁移；系统设置名“减少动态效果”原节点1处移入此完整键，词不扩。
		"skinUi.SkinEditor.64": ["动态"],
		"sourceUi.pages.Dashboard.SystemHealthCard.31": ["B站"],
		"sourceUi.pages.Dashboard.Dashboard.59": ["B站"],
		"sourceUi.config.field.labels.label.1": ["B站"],
		"sourceUi.config.field.labels.hint.8": ["B站"],
		"sourceUi.config.field.labels.hint.12": ["B站"],
	},
	"apps/web/src/i18n/locales/zh-CN.maid.json": {
		"sourceUi.pages.Dashboard.Dashboard.59": ["B站"],
		"sourceUi.config.field.labels.hint.8": ["B站"],
		"sourceUi.config.field.labels.hint.12": ["B站"],
	},
};

export function auditJsonPins(json, file) {
	const actual = Object.fromEntries(
		jsonTermHits(json, [], file).map(({ line, text }) => [line, termsIn(text)]),
	);
	const expected = JSON_TERM_PINS[file];
	return [...new Set([...Object.keys(actual), ...Object.keys(expected)])].flatMap((key) =>
		JSON.stringify(actual[key]) === JSON.stringify(expected[key])
			? []
			: [`${file}:${key}:批准的叫法键或命中词发生变化`],
	);
}

const sample = (text, file = "sample.ts", allowed) =>
	termHits(parseSource(file, text), allowed).length;
/** 样例里的模板插值写成 `@{`,免得 Biome 把字符串里的 `${` 当成写错的模板。 */
const tpl = (text) => text.replaceAll("@{", "${");

describe("中文叫法的判据:算", () => {
	it("十三个叫法各认一处;UP主 / B站 中间带空格也认", () => {
		for (const text of [
			"UP主",
			"UP 主",
			"B站",
			"B 站",
			"哔哩哔哩",
			"舰长",
			"提督",
			"总督",
			"大航海",
			"上舰",
			"粉丝牌",
			"专栏",
			"房管",
			"UID",
			"新动态",
		]) {
			expect(sample(`const a = ${JSON.stringify(text)};`), text).toBe(1);
		}
	});

	it("一个节点里有几个叫法也只算一处;四种节点各算", () => {
		expect(sample('const a = "UP主发了动态";')).toBe(1);
		expect(sample("const a = `UP主`;")).toBe(1);
		expect(sample(tpl("const a = `@{name} 是舰长`;"))).toBe(1);
		expect(sample("const a = <p>舰长来了</p>;", "sample.tsx")).toBe(1);
	});

	it("日志调用的参数照算(判据没排除它)", () => {
		expect(sample('logger.info("UP主开播了");')).toBe(1);
	});
});

describe("中文叫法的判据:不算", () => {
	it("注释、正则字面量、小写的 uid、不带叫法的中文", () => {
		expect(sample("// UP主\n/* 动态 */\nconst a = 1;")).toBe(0);
		expect(sample("const re = /舰长|提督/;")).toBe(0);
		expect(sample('const a = "uid";')).toBe(0);
		expect(sample('const a = "作者发了新作品";')).toBe(0);
	});

	it("按叫法放行的文件:放行的那个不算,别的照算", () => {
		expect(sample('const a = "动态";', "sample.ts", ["动态"])).toBe(0);
		expect(sample('const a = "UP主的动态";', "sample.ts", ["动态"])).toBe(1);
	});

	it("统计字典只在批准的完整键里放行动态，其他叫法与相邻键照算", () => {
		const key = "sourceUi.pages.Stats.plainPosts";
		const file = "apps/web/src/i18n/locales/zh-CN.json";
		expect(jsonTermHits(JSON.stringify({ [key]: "动态" }), [], file)).toEqual([]);
		expect(jsonTermHits(JSON.stringify({ [key]: "B 站动态 UID" }), [], file)).toHaveLength(1);
		expect(jsonTermHits(JSON.stringify({ [`${key}.other`]: "动态" }), [], file)).toHaveLength(1);
		expect(
			jsonTermHits(
				JSON.stringify({ [key]: "动态" }),
				[],
				"apps/web/src/i18n/locales/zh-CN.maid.json",
			),
		).toHaveLength(1);
	});

	it("字典 JSON 按值数,键不算", () => {
		const json = JSON.stringify({ "a.UID": "作者", b: "UP主", c: { d: "舰长", e: "会员" } });
		expect(jsonTermHits(json).map((h) => h.line)).toEqual(["b", "c.d"]);
	});
});

function scopeRoots() {
	return srcRootsUnder(["apps", "packages"], { except: ["apps/desktop/src"] });
}

const excluded = (file) => Object.keys(EXCLUDED_DIRS).some((dir) => file.startsWith(dir));

/** 范围里的字典文件(`locales/*.json`),仓库相对,排好序。 */
function localeFiles() {
	const found = [];
	const walk = (rel) => {
		for (const entry of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
			const child = `${rel}/${entry.name}`;
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules" && entry.name !== "__tests__") walk(child);
			} else if (rel.endsWith("/locales") && entry.name.endsWith(".json")) {
				found.push(child);
			}
		}
	};
	for (const root of scopeRoots()) walk(root);
	return found.filter((file) => !excluded(`${file}`)).sort();
}

/** 真去扫仓库:文件 → 命中。排除目录里的与没有命中的文件不出现。 */
export function scanRepo() {
	const found = {};
	for (const file of listSources(scopeRoots())) {
		if (excluded(file)) continue;
		const hits = termHits(parseSource(file), TERM_ALLOWLIST[file]?.terms);
		if (hits.length > 0) found[file] = hits;
	}
	for (const file of localeFiles()) {
		const hits = jsonTermHits(
			readFileSync(join(REPO_ROOT, file), "utf8"),
			TERM_ALLOWLIST[file]?.terms,
			file,
		);
		if (hits.length > 0) found[file] = hits;
	}
	return found;
}

/**
 * 🔴 **真去扫仓里的代码与字典。** 上面的样例证明判据没写错;这一条证明表外没有人又写进 B 站的叫法。
 */
describe("核心与面板里的 B 站叫法只降不涨", () => {
	it("B 站余量必须保留精确键和命中词，挪位或加词不能拿总额度抵消", () => {
		const file = "apps/web/src/i18n/locales/zh-CN.maid.json";
		const json = readFileSync(join(REPO_ROOT, file), "utf8");
		expect(auditJsonPins(json, file)).toEqual([]);
		expect(
			auditJsonPins(
				json.replace("sourceUi.pages.Dashboard.Dashboard.59", "sourceUi.pages.History.unapproved"),
				file,
			),
		).not.toEqual([]);
		expect(
			auditJsonPins(json.replace("还没有登录 B 站账号", "还没有登录 B 站 UID 账号"), file),
		).not.toEqual([]);
	});
	it("4-27 服务端新增叫法只来自批准的完整来源提示键与专栏一词", () => {
		const file = "apps/server/src/i18n/locales/zh-CN.json";
		const dict = JSON.parse(readFileSync(join(REPO_ROOT, file), "utf8"));
		expect(
			Object.entries(dict)
				.filter(([key]) => key.startsWith("bilibili.source.featureHints."))
				.map(([key, text]) => [key, text, termsIn(text)]),
		).toEqual([
			["bilibili.source.featureHints.post", "投稿 / 转发 / 专栏", ["专栏"]],
			["bilibili.source.featureHints.superchat", "Super Chat 提醒", []],
		]);
	});
	it("4-28 档位原文只迁到批准的七个完整键,不扩大叫法范围", () => {
		const file = "apps/server/src/i18n/locales/zh-CN.json";
		const dict = JSON.parse(readFileSync(join(REPO_ROOT, file), "utf8"));
		expect(
			Object.fromEntries(
				Object.entries(dict)
					.filter(([key]) => key.startsWith("bilibili.guard."))
					.map(([key, text]) => [key, termsIn(text)]),
			),
		).toEqual({
			"bilibili.guard.name": ["大航海"],
			"bilibili.guard.captain.name": ["舰长"],
			"bilibili.guard.commander.name": ["提督"],
			"bilibili.guard.governor.name": ["总督"],
			"bilibili.guard.captain.announcement": ["大航海"],
			"bilibili.guard.commander.announcement": ["大航海", "提督"],
			"bilibili.guard.governor.announcement": ["大航海", "总督"],
		});
	});

	it("两份 web 字典恰好保留批准的完整键与命中词", () => {
		for (const file of Object.keys(JSON_TERM_PINS))
			expect(auditJsonPins(readFileSync(join(REPO_ROOT, file), "utf8"), file)).toEqual([]);
	});

	it("范围认得对:服务端、面板、contract 与各包都在,桌面壳、拓展不在;两份字典都扫到", () => {
		const roots = scopeRoots();
		for (const expected of [
			"apps/server/src",
			"apps/web/src",
			"apps/contract/src",
			"packages/internal/src",
		]) {
			expect(roots).toContain(expected);
		}
		expect(roots).not.toContain("apps/desktop/src");
		const locales = localeFiles();
		expect(locales).toContain("apps/server/src/i18n/locales/zh-CN.json");
		expect(locales).toContain("apps/web/src/i18n/locales/zh-CN.json");
	});

	it("排除的目录与按叫法放行的文件真的存在", () => {
		for (const dir of Object.keys(EXCLUDED_DIRS)) {
			expect(existsSync(join(REPO_ROOT, dir)), dir).toBe(true);
		}
		for (const file of Object.keys(TERM_ALLOWLIST)) {
			expect(existsSync(join(REPO_ROOT, file)), file).toBe(true);
		}
	});

	// 重生成棘轮表用(只打印,不写文件):BN_PRINT_TERMS_RATCHET=1 vp test scripts/__tests__/chinese-terms.test.mjs
	it.skipIf(!process.env.BN_PRINT_TERMS_RATCHET)("打印逐文件的实数,可直接贴进 RATCHET", () => {
		const found = scanRepo();
		const files = Object.keys(found).sort();
		const lines = files.map((file) => `\t${JSON.stringify(file)}: ${found[file].length},`);
		const total = files.reduce((sum, file) => sum + found[file].length, 0);
		console.log(
			`RATCHET-BEGIN\n${lines.join("\n")}\nRATCHET-END files=${files.length} nodes=${total}`,
		);
	});

	it("表外没有写死的 B 站叫法,棘轮表里的文件不多于上限、也不少于上限", () => {
		expect(
			auditRatchet(scanRepo(), {
				allowlist: ALLOWLIST,
				ratchet: RATCHET,
				what: "B 站叫法",
				advice: ADVICE,
			}),
		).toEqual([]);
	});
});
