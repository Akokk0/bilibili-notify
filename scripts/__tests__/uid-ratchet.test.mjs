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
 * uid 棘轮:核心里不许再长出 `uid`(docs/1.0/architecture.md 第二层静态扫描「uid」那一行,ADR-0021)。
 * 订阅与事件的身份是中立的 `externalId` / 订阅 id;`uid` 是 B 站自己的叫法,出现在核心里,就是核心又认了一遍 B 站。
 *
 * - 范围:`apps/server/src`、`apps/contract/src`、`packages/<包>/src`,不含测试。面板与桌面壳不扫(主人 10-12 定:
 *   uid 在面板是表单字段与显示,第 4 期整页重画时成片消失;面板上的「UID」字样归第 4 期的中文叫法棘轮);拓展不算核心。
 * - 判据看语法树(不再用正则扫代码,注释天生不是节点):
 *   - 标识符按驼峰段与下划线段切开,有一段是 `uid` 或 `uids`(不分大小写):`uid`、`colorFromUid`、`idsByUid`、
 *     `BILI_UID_PARAM`、`followTargetUids`。`guid`、`uuid`、`fluid` 这种碰巧含这几个字母的不算。
 *   - 字符串字面量(含不带插值的模板)整个**正好是** `uid` / `uids`(不分大小写):`o["uid"]`、`required: ["uid"]`。
 *     带别的字的(日志的 `"uid=" + x`、提示词里的「按 UID 查」)不算:那是日志与文案,不是「拿 uid 当身份」。
 *   - 一个节点一处。
 * - 整目录不扫:`bilibili/`(B 站自己的 uid)、`migration/`(0.x 的形状:按 uid 的文件名)。`platforms/` 不豁免。
 * - 白名单:空。`compose.ts` 不进(开发场景的订阅视图里把 `externalId` 叫成 `uid`,记棘轮,有数比没数好)。
 * - 棘轮按文件记上限(对账见 `scripts/ratchet-audit.mjs`):多一处就红,上限高于实数也红。主人 10-12 定:清零期是 3b 末,
 *   清不了的几格照记,清零期的字面先不改,3b 收尾时再问。
 *
 * 抓不到的(靠审查与别的守卫):
 * - 换了名字的同一个东西(`mid`、`userId`、`bid`)。
 * - 模板、日志、提示词文字里的 `uid`(上面说了,故意不算)。
 * - `bilibili/` 里的 uid 经类型推断流进核心、而核心这头没写出 `uid` 三个字的。
 * - 类型上是 B 站 uid、却叫 `externalId` 以外别的中立名的(对拍与事件载荷守卫的事)。
 * - 字符串拼出来的键(`"u" + "id"`)、`["ui", "d"].join("")`。
 * - 面板里的 `uid`(上面说了,不扫)。
 * - 切段的边界(都验过不红):数字粘在后面的 `uid2`、`userUid1`(`uid2` 是一整段);大写连写切歪的 `liveUIDs`
 *   (切成 `live` `ui` `ds`)、`uID`(切成 `u` `id`);`#uid` 这种 `#` 私有名(这道只认普通标识符,推送守卫②认 `#` 私有名,口径不一)。
 *   算的是 `UID`、`uids`、`Uids`、`UIDS`、`upUID`、`upUid`、`uidList`。
 *

 * 判据写成纯函数 + 样例:一条永远判 OK 的规则跟没有一样。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 整个目录放行(仓库相对、带结尾斜杠),写明理由。 */
export const ALLOWED_DIRS = {
	"apps/server/src/bilibili/": "B 站自己的代码:它的 uid 就叫 uid",
	"apps/server/src/migration/": "迁移模块:0.x 的形状(按 uid 的文件名、两支订阅……)只住这里",
};

/** 白名单:整个文件放行,写明理由。今天没有。 */
export const ALLOWLIST = {};

/** 报错后面带的那句:越界怎么办。 */
export const ADVICE =
	"若是越界(核心里不许出现 uid):改成中立的身份(externalId / 订阅 id),不要起别的名字躲;若确是同名不同物、或这道守卫的判据打不准(这道没有排除表,只有整目录放行和棘轮上限):去问主人,由主人定是加上限还是改判据,不要自己加;数降了就当场把这一格调低";

/**
 * 棘轮表:文件 → 命中的上限(开张时的现数:15 个文件 212 处)。只许往下调。
 * 行内注释只如实写这一格是什么,不写清零期。
 */
export const RATCHET = {
	"apps/server/src/compose.ts": 3, // 开发场景的订阅视图里把 `externalId` 叫成 `uid`
	"apps/server/src/routes/cards.ts": 33,
	"apps/server/src/routes/subscriptions.ts": 15,
	"apps/server/src/runtime/engines.ts": 9,
	"apps/server/src/runtime/fans-poller.ts": 20,
	"apps/server/src/runtime/follow-sync.ts": 13,
	"packages/ai/src/tools.ts": 20,
	"packages/internal/src/constants.ts": 4, // `upColor` 入参 `UpColorIdentity` 上的 `uid` 键(声明、解构、取用、调用处各一)
	"packages/internal/src/platform.ts": 1, // `FansRefreshEntry.uid`
};

/** 字符串字面量里算 uid 的那几个值(不分大小写)。 */
const UID_STRINGS = new Set(["uid", "uids"]);

/** 这个标识符有没有一段是 `uid` / `uids`。 */
export function isUidIdentifier(name) {
	return identifierSegments(name).some((s) => s === "uid" || s === "uids");
}

/** 一份源码里的 uid:`{ line, text }[]`,按出现顺序。 */
export function uidHits(source) {
	return findNodes(source, (node) => {
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			return UID_STRINGS.has(node.text.toLowerCase());
		}
		return ts.isIdentifier(node) && isUidIdentifier(node.text);
	}).map(({ line, text }) => ({ line, text }));
}

const sample = (text) => uidHits(parseSource("sample.ts", text));

describe("uid 的判据:算", () => {
	it("裸的 uid:引用、属性读、解构、对象键、类型成员", () => {
		expect(sample("uid;")).toHaveLength(1);
		expect(sample("x.uid;")).toHaveLength(1);
		expect(sample("const { uid } = x;")).toHaveLength(1);
		expect(sample("const o = { uid: 1 };")).toHaveLength(1);
		expect(sample("const o = { uid };")).toHaveLength(1);
		expect(sample("interface A { uid: string }")).toHaveLength(1);
	});

	it("标识符里有一段是 uid / uids:驼峰、全大写下划线、复数", () => {
		for (const name of [
			"colorFromUid",
			"idsByUid",
			"BILI_UID_PARAM",
			"followTargetUids",
			"liveUids",
			"uidOf",
			"resolveRoomIdFromUid",
			"notBiliUidNote",
			"uids",
		]) {
			expect(isUidIdentifier(name), name).toBe(true);
		}
	});

	it("字符串字面量整个正好是 uid:下标读、必填列表、单引号、模板、大小写", () => {
		expect(sample('o["uid"];')).toHaveLength(1);
		expect(sample('const s = { required: ["uid"] };')).toHaveLength(1);
		expect(sample("const s = 'uid';")).toHaveLength(1);
		expect(sample("const s = `uid`;")).toHaveLength(1);
		expect(sample('const s = "UID";')).toHaveLength(1);
		expect(sample('const s = "uids";')).toHaveLength(1);
	});

	it("命中带行号与那一段源码", () => {
		expect(sample("\nconst k = uid;")).toEqual([{ line: 2, text: "uid" }]);
	});
});

describe("uid 的判据:不算", () => {
	it("碰巧含这几个字母的词(段是一整个别的词)", () => {
		for (const name of ["guid", "uuid", "fluid", "druid", "squid", "liquidity", "UUID_RE"]) {
			expect(isUidIdentifier(name), name).toBe(false);
		}
	});

	it("切段的边界(钉住现状,写进文件头的「抓不到」):数字粘在后面、大写连写切歪、`#` 私有名", () => {
		for (const name of ["uid2", "userUid1", "liveUIDs", "uID"]) {
			expect(isUidIdentifier(name), name).toBe(false);
		}
		expect(sample("class C { #uid = 1 }")).toEqual([]);
		// 同一类写法里算的
		for (const name of ["UID", "uids", "Uids", "UIDS", "upUID", "upUid", "uidList"]) {
			expect(isUidIdentifier(name), name).toBe(true);
		}
	});

	it("带别的字的字符串:日志、提示词、模板", () => {
		expect(sample('const s = "uid=" + x;')).toEqual([]);
		expect(sample(["const t = `uid ", "$", "{x}`;"].join(""))).toEqual([]);
		expect(sample('const s = "按 UID 查";')).toEqual([]);
		expect(sample('const s = "uid ";')).toEqual([]);
	});

	it("注释", () => {
		expect(sample("// uid 与 colorFromUid\n/* const uid = 1 */ const a = 1;")).toEqual([]);
	});
});

/** 范围:服务端、contract 与 `packages/<包>/src`,仓库相对路径。 */
function scopeRoots() {
	return srcRootsUnder(["apps", "packages"], { except: ["apps/desktop/src", "apps/web/src"] });
}

/** 真去扫仓库:文件 → 命中。白名单目录里的与没有命中的文件不出现。 */
export function scanRepo() {
	const found = {};
	for (const file of listSources(scopeRoots())) {
		if (Object.keys(ALLOWED_DIRS).some((dir) => file.startsWith(dir))) continue;
		const hits = uidHits(parseSource(file));
		if (hits.length > 0) found[file] = hits;
	}
	return found;
}

/**
 * 🔴 **真去扫仓里的代码。** 上面的样例证明判据没写错;这一条证明表外没有人又写回来。
 */
describe("核心里不再长出 uid", () => {
	it("范围认得对:服务端、contract 与核心包都在,面板、桌面壳、拓展不在", () => {
		const roots = scopeRoots();
		for (const expected of [
			"apps/server/src",
			"apps/contract/src",
			"packages/internal/src",
			"packages/ai/src",
		]) {
			expect(roots).toContain(expected);
		}
		expect(roots).not.toContain("apps/web/src");
		expect(roots).not.toContain("apps/desktop/src");
		expect(roots.some((root) => root.startsWith("extensions/"))).toBe(false);
	});

	it("整目录不扫的目录真的存在", () => {
		for (const dir of Object.keys(ALLOWED_DIRS)) {
			expect(existsSync(join(REPO_ROOT, dir)), dir).toBe(true);
		}
	});

	it("表外没有 uid,棘轮表里的文件不多于上限、也不少于上限", () => {
		expect(
			auditRatchet(scanRepo(), {
				allowlist: ALLOWLIST,
				ratchet: RATCHET,
				what: "uid",
				advice: ADVICE,
			}),
		).toEqual([]);
	});
});
