import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { auditRatchet } from "../ratchet-audit.mjs";
import {
	importsOf,
	isInside,
	listSources,
	parseSource,
	resolveSpecifier,
	srcRootsUnder,
	stripExt,
} from "../source-scan.mjs";

/**
 * 守卫 12:核心不读 B 站的设置。
 *
 * B 站的设置住它自己的文件 `config/settings/bilibili.json`,格式与读法都在 `apps/server/src/bilibili/settings.ts`
 * (ADR-0021 决策 42 下 10-01 的 🔗)。核心要拿到它只有一条路 —— import 那个模块,所以这条守卫按 import 判:
 *
 * - 白名单只有组装根 `compose.ts`:它把 B 站的设置段交给运行时(`createAppRuntime` 收的是设置段清单,不认得是谁的)。
 * - 棘轮表是空的:核心里没有别的读者(B 站自己读设置走来源上下文的 `settings(schema)`)。
 * - 不经这个模块、拿键名去捞的写法(`const { bilibili } = …`、`settings["bilibili"]`、`BILIBILI_SOURCE_KEY`)
 *   由 B 站替身棘轮兜底,这里不重复。
 *
 * 范围同 B 站替身:服务端、面板、contract 与 `packages/<包>/src`,不含测试;`bilibili/` 是 B 站自己,不扫。
 * `import type` 也算:核心认得 B 站设置的形状,同样是读了它。对账与出网点名表共用 `scripts/ratchet-audit.mjs`。
 *
 * 判据写成纯函数 + 样例,因为判据本身也会写错:一条永远判 OK 的规则跟没有一样。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** B 站自己的目录:不扫。 */
const BILIBILI_DIR = "apps/server/src/bilibili/";

/** B 站设置所在的模块,仓库相对、不带后缀。 */
const SETTINGS_MODULE = "apps/server/src/bilibili/settings";

/** 白名单:整个文件放行,写明理由。只有组装处。 */
export const ALLOWLIST = {
	"apps/server/src/compose.ts": "组装根:把 B 站的设置段交给运行时,运行时再登记进配置仓",
};

/** 棘轮表:文件 → 引用 B 站设置的上限。只许往下调,3a 随 B 站接线搬进 `bilibili/` 清零。 */
export const RATCHET = {};

/**
 * 一份源码里引用 B 站设置模块的地方。只认相对路径:服务端不是能被别处按包名引用的包。
 * 解析到 `bilibili/settings` 本身(带不带 `.js` / `.ts`)或它底下(哪天拆成目录)都算。
 *
 * @param source `parseSource` 的结果,`path` 是仓库相对路径
 * @returns `{ line, text }[]`,按出现顺序
 */
export function settingsImports(source) {
	const lines = source.text.split("\n");
	const hits = [];
	for (const ref of importsOf(source)) {
		const resolved = resolveSpecifier(source.path, ref.specifier);
		if (resolved === undefined || !isInside(stripExt(resolved), SETTINGS_MODULE)) continue;
		hits.push({ line: ref.line, text: lines[ref.line - 1].trim() });
	}
	return hits;
}

/** 把一段样例当成某个路径上的源码,返回命中的行号。 */
const linesIn = (path, text) => settingsImports(parseSource(path, text)).map((hit) => hit.line);

describe("引用 B 站设置的判据:算", () => {
	it("各个目录爬到 bilibili/settings,带不带后缀都算", () => {
		expect(
			linesIn(
				"apps/server/src/routes/settings.ts",
				`import { settingsOf } from "../bilibili/settings.js";`,
			),
		).toEqual([1]);
		expect(
			linesIn("apps/server/src/index.ts", `import { settingsOf } from "./bilibili/settings";`),
		).toEqual([1]);
		expect(
			linesIn(
				"apps/server/src/config/backup/restore.ts",
				`import { settingsSegment } from "../../bilibili/settings.ts";`,
			),
		).toEqual([1]);
	});

	it("import type、re-export、动态 import 与拆成目录后的子模块都算", () => {
		expect(
			linesIn(
				"apps/server/src/routes/health.ts",
				[
					`import type { BiliSettings } from "../bilibili/settings.js";`,
					`export { settingsOf } from "../bilibili/settings.js";`,
					`const m = await import("../bilibili/settings.js");`,
					`import { x } from "../bilibili/settings/schema.js";`,
				].join("\n"),
			),
		).toEqual([1, 2, 3, 4]);
	});

	it("命中带那一行的源码", () => {
		expect(
			settingsImports(
				parseSource(
					"apps/server/src/index.ts",
					`import { z } from "zod";\nimport { settingsOf } from "./bilibili/settings.js";`,
				),
			),
		).toEqual([{ line: 2, text: `import { settingsOf } from "./bilibili/settings.js";` }]);
	});
});

describe("引用 B 站设置的判据:不算", () => {
	it("别的模块:核心自己的 settings、B 站目录里别的文件、同名的包", () => {
		expect(
			linesIn(
				"apps/server/src/routes/settings.ts",
				[
					`import { x } from "../config/settings.js";`,
					`import { y } from "../bilibili/settings-ui.js";`,
					`import { z } from "../bilibili/other.js";`,
					`import { w } from "bilibili/settings";`,
				].join("\n"),
			),
		).toEqual([]);
	});

	it("相对路径同名、但解析到别处的不算", () => {
		// `apps/web/src/bilibili/settings` 不是服务端那份。
		expect(
			linesIn("apps/web/src/pages/System.tsx", `import { x } from "../bilibili/settings.js";`),
		).toEqual([]);
	});

	it("注释与字符串里的写法", () => {
		expect(
			linesIn(
				"apps/server/src/index.ts",
				[
					`// import { settingsOf } from "./bilibili/settings.js";`,
					`const hint = 'from "./bilibili/settings.js"';`,
				].join("\n"),
			),
		).toEqual([]);
	});
});

/** 范围:服务端、面板、contract 与 `packages/<包>/src`,仓库相对路径。 */
function scopeRoots() {
	return srcRootsUnder(["apps", "packages"], { except: ["apps/desktop/src"] });
}

/** 真去扫仓库:文件 → 命中。`bilibili/` 里的与没有命中的文件不出现。 */
export function scanRepo() {
	const found = {};
	for (const file of listSources(scopeRoots())) {
		if (file.startsWith(BILIBILI_DIR)) continue;
		const hits = settingsImports(parseSource(file));
		if (hits.length > 0) found[file] = hits;
	}
	return found;
}

/**
 * 🔴 **真去扫仓里的代码。** 上面的样例证明判据没写错;这一条证明组装处以外没有人伸手读 B 站的设置。
 */
describe("核心不读 B 站的设置", () => {
	it("范围认得对:服务端、面板、contract 与核心包都在,拓展不在", () => {
		const roots = scopeRoots();
		for (const expected of [
			"apps/server/src",
			"apps/web/src",
			"apps/contract/src",
			"packages/internal/src",
		]) {
			expect(roots).toContain(expected);
		}
		expect(roots.some((root) => root.startsWith("extensions/"))).toBe(false);
	});

	it("B 站设置的模块还在原处(挪走了这条守卫就空转)", () => {
		expect(existsSync(join(REPO_ROOT, `${SETTINGS_MODULE}.ts`))).toBe(true);
	});

	it("白名单里的文件真在引用它(组装处不再登记,白名单就该删)", () => {
		const found = scanRepo();
		for (const file of Object.keys(ALLOWLIST)) {
			expect(found[file], file).toBeDefined();
		}
	});

	it("组装处以外没有引用,棘轮表里的文件不多于上限、也不少于上限", () => {
		expect(
			auditRatchet(scanRepo(), { allowlist: ALLOWLIST, ratchet: RATCHET, what: "引用 B 站的设置" }),
		).toEqual([]);
	});
});
