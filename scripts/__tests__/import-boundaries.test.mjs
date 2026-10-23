import { describe, expect, it } from "vite-plus/test";
import { auditRatchet } from "../ratchet-audit.mjs";
import {
	importsOf,
	isInside,
	listSources,
	parseSource,
	resolveSpecifier,
	stripExt,
} from "../source-scan.mjs";

/**
 * 守卫:谁不许 import 谁(推送守卫①、守卫 1)。
 *
 * 一张表,每行一条边界:扫哪些目录、不许解析到哪个目标、哪些文件是例外、为什么。判据按**解析后的路径**
 * 判(相对说明符对着 importer 所在目录算出仓库相对路径,再看落没落进目标),不按字符串里有没有那个目录名:
 * 注释、字符串里的字样天生不是 import 节点(`source-scan` 走语法树);`import type`、`export … from`、
 * 动态 `import()` 都算 —— 类型 import 同样把核心和某个具体平台绑在一起。
 *
 * 不扫测试(测试要造具体平台的真壳,见 `source-scan` 默认)。
 * 有历史欠账的边界另带一张**按文件的计数上限**(`ratchet`):这个文件越界的 import 语句条数不得超过上限,
 * 表里没有的文件上限是 0;**上限比实际多也算红**(只降不涨要两头钉:清掉一条当场调低,清零了整行删掉)。
 * 对账与出网点名表等守卫共用 `scripts/ratchet-audit.mjs`。
 *
 * 判据写成纯函数 + 样例,因为判据本身也会写错:一条永远判 OK 的规则跟没有一样。
 */

/**
 * @typedef {object} Boundary
 * @property {string} id
 * @property {string[]} roots 扫哪些目录(仓库相对)
 * @property {string} target 不许解析进去的目录(仓库相对)
 * @property {string[]} skipUnder 目标自己的内部不受限(目录前缀)
 * @property {string[]} allowed 例外文件(仓库相对);每个都必须真的在 import 目标
 * @property {Record<string, number>} [ratchet] 文件 → 越界 import 语句条数的上限(仓库相对);不写 = 没有欠账
 * @property {string} reason
 */

/** @type {Boundary[]} */
export const BOUNDARIES = [
	{
		id: "核心不许 import platforms/",
		roots: ["apps/server/src"],
		target: "apps/server/src/platforms",
		skipUnder: ["apps/server/src/platforms"],
		allowed: ["apps/server/src/compose.ts"],
		reason:
			"内置平台适配器只在组装根 compose.ts 里造;核心(推送、引擎、路由、入口)只认 PlatformAdapter 接口,不认具体平台",
	},
	{
		id: "核心不许 import 服务端的 bilibili/",
		roots: ["apps/server/src"],
		target: "apps/server/src/bilibili",
		skipUnder: ["apps/server/src/bilibili"],
		allowed: ["apps/server/src/compose.ts"],
		// 3a-40 的实数(10 个文件 19 条;设置登记已进 `compose.ts`)。中立小件(直播装配 / 文案 / 监听判定 /
		// 内容构造口 / 链接卡配色 / 抓图类型)已搬进核心的 `live/`、`posts/`;剩下的都在等新接口:入口登录装配(index)、
		// 直播引擎宿主(engines 的 `Api` / `LiveEngine` 两条,3b)、关注同步与粉丝轮询
		// (3b,随来源 `fetchProfile`)、卡片真实预览与
		// 旧搜人两口(cards、subscriptions、app,第 4 期)。只降不涨,3b 末清零。
		// 3b-25:关注同步搬进 B 站来源,`runtime/follow-sync.ts` 与 `routes/subscriptions.ts`(新建时当场关注)两行清零删掉。
		ratchet: {
			"apps/server/src/app.ts": 1,
			"apps/server/src/index.ts": 1,
			"apps/server/src/routes/cards.ts": 4,
			"apps/server/src/runtime/engines.ts": 1,
		},
		reason:
			"B 站只是登记表背后的一个来源,核心(推送、引擎、路由、入口)只认中立接口;只有组装根 compose.ts 能把 B 站的东西作登记的参数。历史欠账按文件记上限,只降不涨,3b 末清零",
	},
];

/**
 * 一份源码里违反某条边界的 import。
 *
 * @returns `{ line, specifier }[]`
 */
export function violationsOf(file, source, boundary) {
	if (boundary.skipUnder.some((dir) => isInside(file, dir))) return [];
	return importsOf(source)
		.filter((ref) => {
			const resolved = resolveSpecifier(file, ref.specifier);
			return resolved !== undefined && isInside(stripExt(resolved), boundary.target);
		})
		.map((ref) => ({ line: ref.line, specifier: ref.specifier }));
}

/**
 * 一条边界对一批源码的对账:例外文件整份放行,别的文件按 `ratchet` 记账(表外 = 上限 0,两头都钉)。
 *
 * @param {Boundary} boundary
 * @param {Record<string, import("../source-scan.mjs").Source>} sources 文件 → 解析过的源码
 * @returns {string[]} 人话描述的问题清单;空数组 = 通过
 */
export function auditBoundary(boundary, sources) {
	const found = {};
	for (const [file, source] of Object.entries(sources)) {
		const hits = violationsOf(file, source, boundary).map((hit) => ({
			line: hit.line,
			text: hit.specifier,
		}));
		if (hits.length > 0) found[file] = hits;
	}
	return auditRatchet(found, {
		allowlist: Object.fromEntries(boundary.allowed.map((file) => [file, "例外"])),
		ratchet: boundary.ratchet ?? {},
		what: `越界 import(${boundary.id})`,
	});
}

const sample = (file, text) => violationsOf(file, parseSource(file, text), BOUNDARIES[0]);

describe("越界判据:算", () => {
	it("静态 import、import type、export from、动态 import、side-effect import 都算", () => {
		expect(
			sample(
				"apps/server/src/index.ts",
				[
					`import { a } from "./platforms/onebot.js";`,
					`import type { B } from "./platforms/qq-official.js";`,
					`export { c } from "./platforms/webhook.js";`,
					`const d = await import("./platforms/onebot.js");`,
					`import "./platforms/webhook.js";`,
				].join("\n"),
			).map((hit) => hit.line),
		).toEqual([1, 2, 3, 4, 5]);
	});

	it("按解析后的路径判:从深层目录绕回来的相对路径也算", () => {
		expect(
			sample(
				"apps/server/src/push/deep/file.ts",
				`import { a } from "../../platforms/onebot.js";\nimport { b } from "../../push/../platforms/x.js";`,
			).map((hit) => hit.line),
		).toEqual([1, 2]);
	});

	it("目录自己的入口(没有文件名)也算", () => {
		expect(sample("apps/server/src/index.ts", `import { a } from "./platforms";`)).toHaveLength(1);
	});
});

describe("越界判据:不算", () => {
	it("注释与字符串里的字样", () => {
		expect(
			sample(
				"apps/server/src/migration/zero-platforms.ts",
				[
					`// import { a } from "./platforms/onebot.js";`,
					`/** 也不 import \`platforms/\` */`,
					`const hint = 'import x from "./platforms/onebot.js"';`,
				].join("\n"),
			),
		).toEqual([]);
	});

	it("名字里带 platforms 但解析不到目标目录的", () => {
		expect(
			sample(
				"apps/server/src/index.ts",
				[
					`import { a } from "./migration/zero-platforms.js";`,
					`import { b } from "./platforms-extra/x.js";`,
					`import { c } from "@bilibili-notify/platforms/x";`,
				].join("\n"),
			),
		).toEqual([]);
	});

	it("目标目录自己的内部互相 import", () => {
		expect(
			sample("apps/server/src/platforms/onebot.ts", `import { a } from "./onebot-inbound.js";`),
		).toEqual([]);
	});
});

describe("计数上限(ratchet):按文件记越界 import 的条数", () => {
	/** 两条越界的 import 加一条不越界的:`a.ts` 实数 2。 */
	const TWO = [
		`import { x } from "./bilibili/api/index.js";`,
		`import type { Y } from "./bilibili/live/index.js";`,
		`import { z } from "./util/z.js";`,
	].join("\n");
	const boundary = {
		id: "样例边界",
		roots: ["apps/server/src"],
		target: "apps/server/src/bilibili",
		skipUnder: ["apps/server/src/bilibili"],
		allowed: ["apps/server/src/compose.ts"],
		reason: "样例",
	};
	const withRatchet = (ratchet) => ({ ...boundary, ratchet });
	const sources = (files) =>
		Object.fromEntries(
			Object.entries(files).map(([file, text]) => [file, parseSource(file, text)]),
		);

	it("实数等于上限:通过", () => {
		expect(
			auditBoundary(
				withRatchet({ "apps/server/src/a.ts": 2 }),
				sources({ "apps/server/src/a.ts": TWO }),
			),
		).toEqual([]);
	});

	it("实数多于上限:红,点名每一条", () => {
		const problems = auditBoundary(
			withRatchet({ "apps/server/src/a.ts": 1 }),
			sources({ "apps/server/src/a.ts": TWO }),
		);
		expect(problems[0]).toContain("2 处,超过棘轮上限 1");
		expect(problems.join("\n")).toContain("apps/server/src/a.ts:2: ./bilibili/live/index.js");
	});

	it("实数少于上限:也红(只降不涨要两头钉),提示调低到几", () => {
		expect(
			auditBoundary(
				withRatchet({ "apps/server/src/a.ts": 3 }),
				sources({ "apps/server/src/a.ts": TWO }),
			),
		).toEqual(["apps/server/src/a.ts: 实数 2,上限还写着 3 —— 把上限调低到 2"]);
	});

	it("表外的文件有越界:红(上限是 0);没写 ratchet 的边界等于全表外", () => {
		const problems = auditBoundary(
			withRatchet({ "apps/server/src/a.ts": 2 }),
			sources({ "apps/server/src/a.ts": TWO, "apps/server/src/b.ts": TWO }),
		);
		expect(problems).toHaveLength(2);
		expect(problems.join("\n")).toContain("apps/server/src/b.ts:1: ./bilibili/api/index.js");
		expect(auditBoundary(boundary, sources({ "apps/server/src/b.ts": TWO }))).toHaveLength(2);
	});

	it("表里的文件已经没有越界了:红,提示把这一行删掉", () => {
		expect(
			auditBoundary(
				withRatchet({ "apps/server/src/a.ts": 2 }),
				sources({ "apps/server/src/a.ts": `import { z } from "./util/z.js";` }),
			),
		).toEqual(["apps/server/src/a.ts: 实数 0,上限还写着 2 —— 把这一行从棘轮表里删掉"]);
	});

	it("例外文件不记账;目标目录自己不算", () => {
		expect(
			auditBoundary(
				withRatchet({}),
				sources({
					"apps/server/src/compose.ts": TWO,
					"apps/server/src/bilibili/live/index.ts": `import { a } from "../api/index.js";`,
				}),
			),
		).toEqual([]);
	});
});

describe.each(BOUNDARIES)("边界:$id", (boundary) => {
	const files = listSources(boundary.roots);

	it("扫到了源码(扫空了等于没有这道守卫)", () => {
		expect(files.length).toBeGreaterThan(0);
		expect(files.some((file) => isInside(file, boundary.target))).toBe(true);
	});

	it("除例外外一处都没有;有计数上限的文件,实数与上限一致", () => {
		const sources = Object.fromEntries(files.map((file) => [file, parseSource(file)]));
		expect(auditBoundary(boundary, sources), boundary.reason).toEqual([]);
	});

	it("例外名单里的文件真的在 import 目标(名单不留没用的例外)", () => {
		for (const file of boundary.allowed) {
			expect(files, `${file} 不在扫描范围里`).toContain(file);
			expect(
				violationsOf(file, parseSource(file), boundary),
				`${file} 没有在 import 目标`,
			).not.toEqual([]);
		}
	});
});
