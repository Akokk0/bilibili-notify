// koishi 插件的 npm 发布入口。CI(push main)与本地 `vp run release` 共用。
//
// changesets 已弃用。它当初的价值是替九个互相依赖的内部包算版本号联动 —— 而那些
// 包现在全部 private、被内联进插件产物,registry 上只剩 `koishi-plugin-bilibili-notify`
// 一个包要发。一个包不需要版本编排工具:改 koishi/package.json 的 version,合进
// main,就发出去了。
//
// 于是这里要自己接住 changesets 原本兜着的两件事:
//
// 1. **dist-tag**。每次发布都得挂到某个 tag,缺省是 latest,npm 不会因为版本号里
//    有 -alpha 就自动改。以前从 .changeset/pre.json 读,现在直接**从版本号推导**
//    (5.0.0-alpha.9 → alpha;5.0.0 → latest),与独立端 v<VERSION> tag 同一套心智。
//
// 2. **幂等**。publish 挂在 push main 上,而 main 会因为任何合并而动 —— 版本号没变
//    时必须安静跳过,否则 npm 的「版本已存在」会把 CI 染红。changesets 是靠 version
//    PR 保证这点的,现在改成发布前问一次 registry。
//
// 用 npm 而不是 pnpm:插件的 dependencies 里已经没有任何 `workspace:*`(内部包全被
// 内联了),而协议改写正是当初非用 pnpm 不可的唯一理由。npm 由 vp 的 Node 自带,CI
// 因此不再需要 corepack。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { argv, env } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_JSON = new URL("../koishi/package.json", import.meta.url);
const PKG_DIR = fileURLToPath(new URL("../koishi/", import.meta.url));

/**
 * 从版本号推导 npm dist-tag。
 *
 * @param {string} version 形如 `5.0.0-alpha.9` / `5.0.0`。
 * @returns {string} prerelease 的 id(alpha / beta / rc …),纯 semver 则 "latest"。
 */
export function resolveDistTag(version) {
	// build 元数据(+…)不参与判定,先剥掉。
	const core = String(version).split("+")[0];
	const dash = core.indexOf("-");
	if (dash === -1) return "latest";
	// `5.0.0-alpha.9` → 取 prerelease 首段作 tag。纯数字段(如 `5.0.0-1`)不是合法的
	// dist-tag 名,回退 latest —— 宁可不发预览,也不要发出个怪 tag。
	const id = core.slice(dash + 1).split(".")[0];
	return /^[a-z][a-z0-9-]*$/i.test(id) ? id : "latest";
}

/**
 * 该版本是否已经在 registry 上。
 *
 * @param {string[] | null} published registry 上已有的版本列表;拿不到时传 null。
 * @param {string} version 待发布版本。
 * @returns {boolean} true = 已发过,应跳过。
 */
export function isAlreadyPublished(published, version) {
	if (!published || published.length === 0) return false;
	return published.includes(version);
}

/**
 * 组装 `npm publish` 的参数。
 *
 * @param {{ tag: string; provenance: boolean }} opts
 * @returns {string[]}
 */
export function buildPublishArgs({ tag, provenance }) {
	// --access public:scoped 包首发需要(对 unscoped 的 koishi-plugin-* 是 no-op,
	// 保留以防将来改名)。--provenance 仅在受支持的 CI(OIDC)下可用,本地跑会报错。
	const args = ["publish", "--tag", tag, "--access", "public"];
	if (provenance) args.push("--provenance");
	return args;
}

/** 查 registry 上已有的版本列表;包还没发过(E404)时返回 null。 */
function fetchPublishedVersions(name) {
	try {
		const out = execFileSync("npm", ["view", name, "versions", "--json"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const parsed = JSON.parse(out);
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		return null;
	}
}

function main() {
	const { name, version } = JSON.parse(readFileSync(PKG_JSON, "utf8"));

	if (isAlreadyPublished(fetchPublishedVersions(name), version)) {
		console.log(`[publish] ${name}@${version} 已在 registry 上，跳过。`);
		return;
	}

	const tag = resolveDistTag(version);
	const provenance = Boolean(env.CI);
	console.log(`[publish] ${name}@${version} · dist-tag = ${tag} · provenance = ${provenance}`);
	execFileSync("npm", buildPublishArgs({ tag, provenance }), { cwd: PKG_DIR, stdio: "inherit" });
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
	main();
}
