import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { auditRatchet } from "../ratchet-audit.mjs";
import {
	findNodes,
	identifierSegments,
	listSources,
	parseSource,
	srcRootsUnder,
	ts,
} from "../source-scan.mjs";

/**
 * B 站替身:核心、面板、contract 里不许再长出「如果是 B 站就……」的写法(docs/1.0/architecture.md 第二层静态扫描
 * 「B 站替身」那一行,ADR-0021)。B 站只是登记表背后的一个来源;核心按来源分叉,就是在登记表外面又认了一遍 B 站。
 *
 * `isBiliSubscription` 删掉以后,最容易换个写法回来:`identity.sourceKey === "bilibili"`、`"@bilibili"` 哨兵、
 * `BILIBILI_*` / `BILI_*` 常量、`biliXxx` / `fromBilibili` 这类局部名。
 *
 * - 范围:`apps/server/src`、`apps/web/src`、`apps/contract/src`、`packages/<包>/src`,不含测试;拓展与桌面壳不算
 *   核心。B 站四包(api / blive / dynamic / live)今天还在 `packages/`,算进来,第 3a 期搬进 `bilibili/` 时自然掉出。
 * - 判据看语法树:
 *   - 字符串字面量(含不带插值的模板)正好是 `"bilibili"` 或 `"@bilibili"`。包名 `@bilibili-notify/…` 不算;
 *     `bilibili.com` 这类 B 站专有词归守卫 11。
 *   - 标识符按驼峰段与下划线段切开,有一段是 `bili` 或 `bilibili`(不分大小写)。`mobility` 这种碰巧含这几个
 *     字母的不算。
 *   - 注释不算。
 * - 白名单:迁移模块整个目录(0.x 的形状只住那里);`compose.ts` 与 `bilibili/` 已加,设置 schema 的组合处建出来以后加。
 *   保留 id 表(`BILIBILI_SOURCE_KEY` 那几行)今天和别的东西同住 `packages/internal/src/constants.ts`,先记在棘轮里,
 *   清零之前拆成单独一个文件再放进白名单。
 * - 棘轮按文件记上限(对账见 `scripts/ratchet-audit.mjs`):多一处就红,上限高于实数也红。⑥d 开张,第 4 期末清零。
 *
 * 判据写成纯函数 + 样例:一条永远判 OK 的规则跟没有一样。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 整个目录放行(仓库相对、带结尾斜杠),写明理由。 */
export const ALLOWED_DIRS = {
	"apps/server/src/migration/": "迁移模块:0.x 的形状(两支订阅、按 uid 的文件名……)只住这里",
	"apps/server/src/bilibili/":
		"B 站自己的代码(设计稿的白名单,architecture.md 守卫表「B 站替身」一行):今天只有它的设置",
};

/** 白名单:整个文件放行,写明理由。 */
export const ALLOWLIST = {
	"apps/server/src/compose.ts":
		"组装根:整个核心只有它登记内置集成(architecture.md「compose.ts 装配」)。今天登记 B 站来源、认领 B 站那组开发场景。只许放登记:出口由入口咽喉守卫(entry-throat.test.mjs)钉着,里面长没长别的逻辑仍靠审查",
};

/**
 * 棘轮表:文件 → 命中的上限(⑥d 开张时的实数:70 个文件 403 处)。只许往下调,第 4 期末清零。大头是 B 站四包与
 * 服务端里接 B 站的那几处(引擎、粉丝轮询、关注、登录、统计的 B 站适配),第 3a 期 B 站搬进 `bilibili/` 时整批掉出;
 * 面板里认 B 站的分支归第 4 期按描述符重画。
 */
export const RATCHET = {
	// 3a-28 建 `compose.ts`(8 → 5):3a-32 为开发场景多出的 3 处(引入工厂、用来源键认领、调工厂)与按来源筛订阅那 1 处搬走;
	// 多 1 处是 `status` 指令读「上次抓取」。3a-29 B 站半:统计的登录读口改读
	// 中立的 `auth.state()`(5 → 3),剩下的是来源键的两处与 `builtins.bilibili`。
	// 3a-40 B(5 → 4):`status` 改读登记表里各来源的 `Source.health()`,`builtins.bilibili.dynamic` 没了。
	// 3a-30(主人 10-11 点头,3 → 5):直播引擎由 `createEngines` 造、早于来源登记,B 站的分层上报器只能经入口递进去
	// (`biliProblems: builtins.bilibili.problems`,对象键与 `bilibili` 各一处,名字如实带 `bili`,不起中立名字躲)。
	// 3b 直播并进来源(来源自己造直播、自己把上报器给它)那一天,这一格与这条递送一起消失,数归 3。
	"apps/server/src/index.ts": 2,
	"apps/server/src/routes/cards.ts": 7,
	"apps/server/src/routes/subscriptions.ts": 5,
	"apps/server/src/stats/bili-source.ts": 7,
	"apps/server/src/stats/recorder.ts": 5,
	// 面板读 B 站档位表的唯一入口(㉓e):3a 由 /api/sources 下发 descriptor.membershipPrograms 之前的替身。
	"apps/web/src/config/membership-programs.ts": 2,
	"apps/web/src/components/ai-chat/index.tsx": 2,
	"apps/web/src/components/header.tsx": 2,
	"apps/web/src/components/onboarding/derive.ts": 2,
	"apps/web/src/components/onboarding/use-onboarding-view.ts": 5,
	"apps/web/src/components/scope-tabs.tsx": 3,
	"apps/web/src/devtools/pick-select.tsx": 2,
	"apps/web/src/devtools/web-scenarios.ts": 1,
	"apps/web/src/pages/Cards.tsx": 2,
	// 3a-38(主人 10-10 点头,4 → 6):日志等级的 `dynamic` / `live` 两个键并成 `bilibili`,读这一格的地方如实显形(动态、直播两行都读它)。
	// 第 4 期系统页与概览页按集成的描述画之后消失。
	"apps/web/src/pages/Dashboard.tsx": 5,
	"apps/web/src/pages/Rules.tsx": 6,
	"apps/web/src/pages/Subs.tsx": 18,
	// 3a-38(主人 10-10 点头,27 → 29):日志等级的 `dynamic` / `live` 两个键并成 `bilibili`,读这一格的地方如实显形(引入常量、模块表里用一次)。
	// 第 4 期系统页按集成的描述画之后消失。
	"apps/web/src/pages/System.tsx": 5,
	"apps/web/src/pages/rules/PerUpEditor.tsx": 6,
	"apps/web/src/pages/rules/sections.tsx": 2,
	"apps/web/src/pages/up/UpCard.tsx": 5,
	"apps/web/src/pages/up/UpDialog.tsx": 10,
	"apps/web/src/pages/up/subscription-source.ts": 2,
	"apps/web/src/types/domain.ts": 2,
	"apps/web/src/utils/up-display.ts": 2,
	// B 站大航海档位表(㉓b):3a 搬进 `bilibili/` 的来源描述符之前,面板、引擎、出图器共读这一份。
	"packages/internal/src/bilibili-guard.ts": 1,
	"packages/internal/src/constants.ts": 4,
	"packages/internal/src/index.ts": 1,
	"packages/push/src/push-router.ts": 2,
};

/** 字符串字面量里算 B 站替身的那两个值。 */
const STAND_IN_STRINGS = new Set(["bilibili", "@bilibili"]);

/** 这个标识符有没有一段是 `bili` / `bilibili`。 */
export function isStandInIdentifier(name) {
	return identifierSegments(name).some((s) => s === "bili" || s === "bilibili");
}

/** 一份源码里的 B 站替身:`{ line, text }[]`,按出现顺序。 */
export function biliStandIns(source) {
	return findNodes(source, (node) => {
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			return STAND_IN_STRINGS.has(node.text);
		}
		return ts.isIdentifier(node) && isStandInIdentifier(node.text);
	}).map(({ line, text }) => ({ line, text }));
}

const sample = (text) => biliStandIns(parseSource("sample.ts", text));

describe("B 站替身的判据:算", () => {
	it('裸的 "bilibili" 与 "@bilibili" 字面量,单引号、模板也算', () => {
		expect(sample('const a = "bilibili";')).toHaveLength(1);
		expect(sample("const a = 'bilibili';")).toHaveLength(1);
		expect(sample("const a = `bilibili`;")).toHaveLength(1);
		expect(sample('if (k === "@bilibili") {}')).toHaveLength(1);
		expect(sample('const o = { "bilibili": 1 };')).toHaveLength(1);
	});

	it("标识符里有一段是 bili / bilibili:前缀、中缀、全大写下划线、小写开头", () => {
		for (const name of [
			"isBiliSubscription",
			"BiliSubscription",
			"BILIBILI_SOURCE_KEY",
			"BILI_ONLY_EXTRAS",
			"biliSubs",
			"fromBilibili",
			"makeBiliPushLike",
		]) {
			expect(isStandInIdentifier(name), name).toBe(true);
		}
	});

	it("引用、属性名、对象键、导入的名字都各算一处", () => {
		expect(sample("x.bilibili;")).toHaveLength(1);
		expect(sample("const o = { bilibili: 1 };")).toHaveLength(1);
		expect(sample('import { BILIBILI_SOURCE_KEY } from "x"; BILIBILI_SOURCE_KEY;')).toHaveLength(2);
	});

	it("命中带行号与那一段源码", () => {
		expect(sample('\nconst k = "bilibili";')).toEqual([{ line: 2, text: '"bilibili"' }]);
	});
});

describe("B 站替身的判据:不算", () => {
	it("包名与带别的字的字符串", () => {
		expect(sample('import { x } from "@bilibili-notify/internal";')).toEqual([]);
		expect(sample('const u = "https://www.bilibili.com";')).toEqual([]);
		expect(sample('const s = "bilibili 的订阅";')).toEqual([]);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: 样例源码里本来就要有模板串
		expect(sample("const t = `bilibili:${id}`;")).toEqual([]);
	});

	it("碰巧含这几个字母的词", () => {
		for (const name of ["mobility", "Bilingual", "abilities", "Nobility"]) {
			expect(isStandInIdentifier(name), name).toBe(false);
		}
	});

	it("注释", () => {
		expect(
			sample('// "bilibili" 与 isBiliSubscription\n/* BILIBILI_SOURCE_KEY */ const a = 1;'),
		).toEqual([]);
	});
});

/** 范围:服务端、面板、contract 与 `packages/<包>/src`,仓库相对路径。 */
function scopeRoots() {
	return srcRootsUnder(["apps", "packages"], { except: ["apps/desktop/src"] });
}

/** 真去扫仓库:文件 → 命中。白名单目录里的与没有命中的文件不出现。 */
export function scanRepo() {
	const found = {};
	for (const file of listSources(scopeRoots())) {
		if (Object.keys(ALLOWED_DIRS).some((dir) => file.startsWith(dir))) continue;
		const hits = biliStandIns(parseSource(file));
		if (hits.length > 0) found[file] = hits;
	}
	return found;
}

/**
 * 🔴 **真去扫仓里的代码。** 上面的样例证明判据没写错;这一条证明表外没有人又写回来。
 */
describe("核心、面板、contract 里不再长出 B 站替身", () => {
	it("范围认得对:服务端、面板、contract 与核心包都在,拓展不在", () => {
		const roots = scopeRoots();
		for (const expected of [
			"apps/server/src",
			"apps/web/src",
			"apps/contract/src",
			"packages/internal/src",
			"packages/ui/src",
		]) {
			expect(roots).toContain(expected);
		}
		expect(roots.some((root) => root.startsWith("extensions/"))).toBe(false);
	});

	it("白名单目录真的存在", () => {
		for (const dir of Object.keys(ALLOWED_DIRS)) {
			expect(existsSync(join(REPO_ROOT, dir)), dir).toBe(true);
		}
	});

	it("表外没有 B 站替身,棘轮表里的文件不多于上限、也不少于上限", () => {
		expect(
			auditRatchet(scanRepo(), { allowlist: ALLOWLIST, ratchet: RATCHET, what: "B 站替身" }),
		).toEqual([]);
	});
});
