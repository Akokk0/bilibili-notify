import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { describe, expect, it } from "vite-plus/test";

/**
 * koishi 插件必须能在 **Node 20.12.2** 上加载 —— 那是 Koishi Desktop 自带的 Node
 * (v1.1.2 起没再升过),用户换不了它;门槛抬过去等于把整批桌面用户锁在门外。
 *
 * 2026-08-28 升 jsdom 30 就中过一次:jsdom 27+ 经 html-encoding-sniffer / whatwg-url 拉进
 * ESM-only 的 @exodus/bytes,而 CJS 里 `require()` 一个 ESM 包要 Node 20.19 / 22.12 以后才行。
 * 门禁全绿(本机 Node 24),只有 Koishi Desktop 用户装完插件看到 `ERR_REQUIRE_ESM`(5.2.0)。
 *
 * 这里对着**装在盘上的真实依赖树**走 koishi 的运行时闭包(外置的 `dependencies` 整条链 +
 * 内联进 bundle 的 `inlinedDependencies`),每个包的 `engines.node` 都得放得进 20.12.2;
 * 外置链里还不许出现 ESM-only 的包。engines 只是声明,真起不起得来靠本机装了 Node 20 时
 * 的那条真加载用例(装了才跑,CI 上没有就跳过)。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KOISHI_DIR = join(ROOT, "koishi");
const KOISHI_DESKTOP_NODE = "20.12.2";

/**
 * 内联依赖里 engines 声明放不进 20.12.2、但**真机验过**能跑的包。加一条必须写清验法与日期 ——
 * 这张表是「我们替用户担的责任」,不是消音器。
 */
const VERIFIED_ON_NODE20 = {
	openai:
		"engines 写 >=22 只是声明。2026-09-03 用 Node 20.12.2 对本地假 API 跑过非流式 / 流式(SSE)/ 工具调用三条路,全通。",
};

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const koishiPkg = readJson(join(KOISHI_DIR, "package.json"));

/** Node 的目录向上查找(不看 exports 映射 —— 很多包不导出 package.json)。 */
function locate(name, fromDir) {
	let dir = fromDir;
	for (;;) {
		const candidate = join(dir, "node_modules", name, "package.json");
		if (existsSync(candidate)) return { dir: dirname(candidate), pkg: readJson(candidate) };
		const parent = dirname(dir);
		if (parent === dir || !dir.startsWith(ROOT)) return null;
		dir = parent;
	}
}

/** `type: module` 且没有任何 require / .cjs 出口 → CJS 里 require 不到。 */
function isEsmOnly(pkg) {
	if (pkg.type !== "module") return false;
	if (pkg.exports === undefined)
		return !(typeof pkg.main === "string" && pkg.main.endsWith(".cjs"));
	return !/"require"|\.cjs"/.test(JSON.stringify(pkg.exports));
}

/** 从 koishi 的外置 dependencies 出发,按盘上真实解析走完整条运行时闭包。 */
function externalClosure() {
	const out = [];
	const seen = new Set();
	const walk = (name, fromDir, via) => {
		const found = locate(name, fromDir);
		if (!found) {
			// 可选依赖没装是正常的;必选的装不到就是 install 坏了,让它在别处红。
			return;
		}
		if (seen.has(found.dir)) return;
		seen.add(found.dir);
		out.push({
			name,
			version: found.pkg.version,
			engines: found.pkg.engines?.node,
			esmOnly: isEsmOnly(found.pkg),
			via,
		});
		const deps = { ...(found.pkg.dependencies ?? {}), ...(found.pkg.optionalDependencies ?? {}) };
		for (const dep of Object.keys(deps))
			walk(dep, found.dir, `${via} > ${name}@${found.pkg.version}`);
	};
	for (const name of Object.keys(koishiPkg.dependencies ?? {})) walk(name, KOISHI_DIR, "koishi");
	return out;
}

const fits = (range) => semver.satisfies(KOISHI_DESKTOP_NODE, range, { includePrerelease: true });
const describeOffender = (p) =>
	`${p.name}@${p.version} engines.node=${JSON.stringify(p.engines)} (${p.via})`;

describe(`koishi 插件必须放得进 Koishi Desktop 的 Node ${KOISHI_DESKTOP_NODE}`, () => {
	it("package.json 的 engines 本身放得进去 —— 这是对用户的承诺", () => {
		expect(fits(koishiPkg.engines.node)).toBe(true);
	});

	it("外置依赖(用户 npm 现装的那条链)每个包的 engines 都放得进去", () => {
		const closure = externalClosure();
		expect(closure.length).toBeGreaterThan(0);
		const offenders = closure.filter((p) => p.engines && !fits(p.engines)).map(describeOffender);
		expect(offenders).toEqual([]);
	});

	it("外置依赖链里没有 ESM-only 的包 —— CJS 里 require 它就是 ERR_REQUIRE_ESM", () => {
		const offenders = externalClosure()
			.filter((p) => p.esmOnly)
			.map((p) => `${p.name}@${p.version} (${p.via})`);
		expect(offenders).toEqual([]);
	});

	it("内联进 bundle 的依赖 engines 也放得进去,例外必须有真机验过的理由", () => {
		const inlined = Object.keys(koishiPkg.inlinedDependencies ?? {});
		expect(inlined.length).toBeGreaterThan(0);
		const offenders = [];
		for (const name of inlined) {
			const found = locate(name, KOISHI_DIR);
			if (!found) continue;
			const range = found.pkg.engines?.node;
			if (!range || fits(range)) continue;
			if (VERIFIED_ON_NODE20[name]) continue;
			offenders.push(`${name}@${found.pkg.version} engines.node=${JSON.stringify(range)}`);
		}
		expect(offenders).toEqual([]);
	});

	it("例外表里的每一条都还是例外 —— 声明放得进去了就把它从表里删掉", () => {
		const stale = Object.keys(VERIFIED_ON_NODE20).filter((name) => {
			const found = locate(name, KOISHI_DIR);
			const range = found?.pkg.engines?.node;
			return !range || fits(range);
		});
		expect(stale).toEqual([]);
	});

	// 真加载:本机装了 Node 20.12.2(`vp env install 20.12.2`)且 koishi 已构建才跑。
	const node20 =
		process.env.BN_NODE20 ??
		join(homedir(), ".vite-plus", "js_runtime", "node", KOISHI_DESKTOP_NODE, "bin", "node");
	const bundle = join(KOISHI_DIR, "lib", "index.cjs");
	it.skipIf(!existsSync(node20) || !existsSync(bundle))(
		`构建产物在真 Node ${KOISHI_DESKTOP_NODE} 上 require 得起来`,
		() => {
			const run = spawnSync(node20, ["-e", "require(process.argv[1])", bundle], {
				cwd: KOISHI_DIR,
				encoding: "utf8",
				timeout: 60_000,
			});
			expect(run.stderr, run.stderr).toBe("");
			expect(run.status).toBe(0);
		},
	);
});
