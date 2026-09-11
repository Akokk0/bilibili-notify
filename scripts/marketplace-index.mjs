#!/usr/bin/env node
// 拓展市场的**官方索引**(ADR-0013):把一条新发的拓展并进当前索引,再用升级清单那把
// 私钥签成信封。
//
// 产出两个文件(同 sign-update-manifest.mjs 的约定):
//   - <out>.json      索引本体(**被签的就是这个文件的字节**)
//   - <out>.sig.json  运输信封 `{ "manifest": "<上面那份的原文>", "signature": "<base64>" }`
//
// 客户端那半边:apps/server/src/extensions/marketplace.ts(拿 fetchSignedJson 验、按
// MarketplaceIndexSchema 读、再过 checkMarketplaceIndex 那两条官方源规矩)。这里的形状检查
// 是那份 schema 的手抄,防漂移靠 scripts/marketplace-index.test.mjs 真拿客户端去验。
//
// 用法:
//   BN_UPDATE_SIGNING_KEY="$(cat key.pem)" node scripts/marketplace-index.mjs \
//     --entry dist/entry.json [--current dist/current.json] [--revoke bridge@0.0.1,…] \
//     --out dist/marketplace

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readArg, readListArg, requireArg } from "./cli-args.mjs";
import { signManifest } from "./sign-update-manifest.mjs";

export const OFFICIAL_INDEX_NAME = "BN 官方拓展";

const ID_SEGMENT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(msg) {
	throw new Error(`索引不合规:${msg}`);
}

/** 一条条目的形状。**官方索引里的 id 不带命名空间**(没有点的 id 保留给官方源)。 */
export function assertEntryShape(e) {
	if (!e || typeof e !== "object") fail("条目不是对象");
	if (typeof e.id !== "string" || !ID_SEGMENT.test(e.id))
		fail(`id 必须是小写字母数字连字符、且不带命名空间(官方索引):${e.id}`);
	if (typeof e.name !== "string" || e.name === "") fail(`${e.id}:name 必须是非空字符串`);
	if (typeof e.version !== "string" || !SEMVER.test(e.version))
		fail(`${e.id}:version 必须是 semver:${e.version}`);
	if (!Number.isInteger(e.apiVersion) || e.apiVersion <= 0) fail(`${e.id}:apiVersion 必须是正整数`);
	if (!e.package || typeof e.package !== "object") fail(`${e.id}:缺 package`);
	const { url, sha256, size } = e.package;
	if (typeof url !== "string" || !url.startsWith("https://"))
		fail(`${e.id}:package.url 必须是 https:${url}`);
	if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))
		fail(`${e.id}:package.sha256 必须是 64 位小写 hex`);
	if (!Number.isInteger(size) || size <= 0) fail(`${e.id}:package.size 必须是正整数`);
	if (
		e.releaseUrl !== undefined &&
		(typeof e.releaseUrl !== "string" || !e.releaseUrl.startsWith("https://"))
	)
		fail(`${e.id}:releaseUrl 必须是 https`);
	try {
		new URL(url);
		if (e.releaseUrl !== undefined) new URL(e.releaseUrl);
	} catch {
		fail(`${e.id}:package.url / releaseUrl 不是合法 URL`);
	}
	return e;
}

export function assertIndexShape(index) {
	if (typeof index.name !== "string" || index.name === "") fail("name 必须是非空字符串");
	if (!Number.isInteger(index.issuedAt) || index.issuedAt <= 0)
		fail("issuedAt 必须是正整数(epoch 秒)");
	if (!Array.isArray(index.extensions)) fail("extensions 必须是数组");
	const seen = new Set();
	for (const e of index.extensions) {
		assertEntryShape(e);
		if (seen.has(e.id)) fail(`${e.id} 列了两遍`);
		seen.add(e.id);
	}
	if (index.revoked !== undefined) {
		if (
			!Array.isArray(index.revoked) ||
			index.revoked.some((r) => typeof r !== "string" || !r.includes("@"))
		)
			fail("revoked 必须是 id@version 的数组");
	}
	return index;
}

/**
 * 版本先后。**这是 `apps/server/src/update/version-order.ts` 的手抄**:那份是 TS,而这个
 * 脚本是 CI 里直接 `node scripts/…` 跑的,进不来。两把尺子给出相反答案的那天就是把一个
 * 版本静默降回去的那天,所以 `marketplace-index.test.mjs` 里有一条用例拿客户端那把逐对
 * 比签,漂了当场红。
 *
 * @param {string} a @param {string} b
 */
export function compareEntryVersions(a, b) {
	const split = (/** @type {string} */ v) => {
		const dash = v.indexOf("-");
		return dash === -1 ? [v, ""] : [v.slice(0, dash), v.slice(dash + 1)];
	};
	const [aCore, aPre] = split(a);
	const [bCore, bPre] = split(b);

	const x = aCore.split(".");
	const y = bCore.split(".");
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const diff = (Number.parseInt(x[i] ?? "0", 10) || 0) - (Number.parseInt(y[i] ?? "0", 10) || 0);
		if (diff !== 0) return diff;
	}

	// 预发布低于同号正式版;段内数字按数值比(alpha.10 高于 alpha.9),数字低于非数字。
	if (!aPre && !bPre) return 0;
	if (!aPre) return 1;
	if (!bPre) return -1;
	const p = aPre.split(".");
	const q = bPre.split(".");
	for (let i = 0; i < Math.max(p.length, q.length); i++) {
		const [ai, bi] = [p[i], q[i]];
		if (ai === undefined) return -1;
		if (bi === undefined) return 1;
		if (ai === bi) continue;
		const [an, bn] = [/^\d+$/.test(ai), /^\d+$/.test(bi)];
		if (an && bn) return Number(ai) - Number(bi);
		if (an !== bn) return an ? -1 : 1;
		return ai < bi ? -1 : 1;
	}
	return 0;
}

/**
 * 这一份索引的 `issuedAt`:客户端拿它当**新鲜度**(比上次见过的旧就整份不收),所以它只
 * 许往前走。两个真会发生的坑都堵在这儿:
 *
 * - **发出去一个不比上一份大的数**(`--issued-at` 手传、runner 时钟回拨)→ 客户端判
 *   stale,这一份索引谁也拉不到,而流水线全绿。所以手传的不够大当场红,不传的取
 *   `max(现在, 当前 + 1)`。
 * - **误传毫秒**(`Date.now()` 而不是 `Date.now()/1000`)→ 那个数比未来几千年的秒数都大,
 *   之后任何一份正常索引都会被判 stale,**永久**。秒数今天约 1.8e9,`1e11` 是 5138 年;
 *   越过它的只可能是毫秒。
 *
 * @param {object | undefined} current @param {number | undefined} given
 */
function nextIssuedAt(current, given) {
	const floor = typeof current?.issuedAt === "number" ? current.issuedAt : 0;
	if (given === undefined) return Math.max(Math.floor(Date.now() / 1000), floor + 1);
	if (!Number.isInteger(given) || given <= 0) fail(`issuedAt 必须是正整数(epoch 秒):${given}`);
	if (given >= 1e11) fail(`issuedAt ${given} 不像秒,像毫秒 —— 发出去会把客户端永久钉死在这一份上`);
	if (given <= floor)
		fail(`issuedAt ${given} 不比当前那份索引的 ${floor} 新 —— 客户端会整份判 stale 不收`);
	return given;
}

/** 可选字段**没传就不写进去**:写 `null` 会让客户端的 zod 判 malformed,而那份是签得过的。 */
function cleanEntry(e) {
	const entry = {
		id: e.id,
		name: e.name,
		description: e.description ?? "",
		version: e.version,
		apiVersion: e.apiVersion,
		package: { url: e.package.url, sha256: e.package.sha256, size: e.package.size },
	};
	if (e.prerelease === true) entry.prerelease = true;
	if (e.releaseUrl !== undefined) entry.releaseUrl = e.releaseUrl;
	if (e.notes !== undefined && e.notes !== "") entry.notes = e.notes;
	return entry;
}

/**
 * 把一条新发的拓展并进当前索引:同 id 换掉、别的照留、按 id 排;`revoked` 照抄再并上新撤的。
 * 每个 id 只列**最新**那一版 —— 老版本靠发布页还能手动下。
 *
 * @param {object | undefined} current 当前索引本体(第一次发时没有)
 * @param {object} entry 新条目
 * @param {{ issuedAt?: number, revoke?: string[] }} [opts]
 */
export function mergeMarketplaceEntry(current, entry, opts = {}) {
	const fresh = cleanEntry(assertEntryShape(entry));
	// 每个 id 只列最新那一版,所以并进来的这一条就是它的新现状 —— 版本降回去等于把已经
	// 发出去的那版从市场上抹掉,装着它的人还会被标成「从别处装的」。重跑一个旧 tag 是这
	// 件事最常见的来路,所以拒;**等于**放行,那是重发同一版(打包可复现,字节一样)。
	const previous = (current?.extensions ?? []).find((e) => e.id === fresh.id);
	if (previous && compareEntryVersions(fresh.version, previous.version) < 0)
		fail(
			`${fresh.id}:要并进去的 ${fresh.version} 比索引里已经有的 ${previous.version} 旧 —— 是不是重跑了一个旧 tag`,
		);
	const rest = (current?.extensions ?? []).filter((e) => e.id !== fresh.id).map(cleanEntry);
	const extensions = [...rest, fresh].sort((a, b) => a.id.localeCompare(b.id));
	const revoked = [...new Set([...(current?.revoked ?? []), ...(opts.revoke ?? [])])];
	const index = {
		name: current?.name ?? OFFICIAL_INDEX_NAME,
		issuedAt: nextIssuedAt(current, opts.issuedAt),
		extensions,
	};
	if (revoked.length > 0) index.revoked = revoked;
	return assertIndexShape(index);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const entry = JSON.parse(await readFile(resolve(requireArg("entry")), "utf8"));
	const currentPath = readArg("current", "");
	const current = currentPath
		? JSON.parse(await readFile(resolve(currentPath), "utf8"))
		: undefined;
	const issuedAtArg = readArg("issued-at", "");
	const revoke = readListArg("revoke");
	const index = mergeMarketplaceEntry(current, entry, {
		issuedAt: issuedAtArg ? Number(issuedAtArg) : undefined,
		revoke: revoke.length > 0 ? revoke : undefined,
	});
	const { manifestJson, envelopeJson } = signManifest(index, process.env.BN_UPDATE_SIGNING_KEY);
	const out = resolve(readArg("out", "dist/marketplace"));
	await mkdir(dirname(out), { recursive: true });
	await writeFile(`${out}.json`, manifestJson, "utf8");
	await writeFile(`${out}.sig.json`, envelopeJson, "utf8");
	process.stdout.write(
		`signed marketplace index (${index.extensions.length} entries) → ${out}.json / ${out}.sig.json\n`,
	);
}
