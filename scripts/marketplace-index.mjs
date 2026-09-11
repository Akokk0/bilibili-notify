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

/**
 * ⚠️ 这两条在 `.github/scripts/assert-extension-tag.sh` 里**还有一份手抄**(那是 bash 的
 * `[[ =~ ]]`,进不来这边)。两把尺子松紧不一样的那天,tag 守卫放行的东西会在并索引这一步
 * 才炸 —— 包已经传上去了,而索引没更新,市场上那条还是老版本。`marketplace-index.test.mjs`
 * 里那一段拿 `.sh` 的原文逐个样本比对,漂了当场红。导出只是为了给那一段用。
 */
export const ID_SEGMENT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

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

/** 这条条目归哪一档。按 `prerelease` 的真假分,不按版本号里有没有 `-`。 */
function channelOf(e) {
	return e.prerelease === true ? "pre" : "stable";
}

export function assertIndexShape(index) {
	if (typeof index.name !== "string" || index.name === "") fail("name 必须是非空字符串");
	if (!Number.isInteger(index.issuedAt) || index.issuedAt <= 0)
		fail("issuedAt 必须是正整数(epoch 秒)");
	if (!Array.isArray(index.extensions)) fail("extensions 必须是数组");
	// 同一个 id 每档只许一条(正式 / 预发布),合计最多两条 —— 同档两条的话「那一档的最新版」
	// 就没法唯一,挑哪条给用户只能靠数组顺序。客户端的 checkMarketplaceIndex 是同一条规矩。
	const seen = new Set();
	for (const e of index.extensions) {
		assertEntryShape(e);
		const key = channelOf(e);
		if (seen.has(`${e.id}@${key}`))
			fail(`${e.id} 的${key === "pre" ? "预发布" : "正式"}版列了两遍`);
		seen.add(`${e.id}@${key}`);
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
 * 把一条新发的拓展并进当前索引:**同 id 同档**换掉、别的照留、按 id 排(同 id 正式在前);
 * `revoked` 照抄再并上新撤的。
 *
 * 每个 id 留两条:一条正式、一条预发布。两档分开是因为**打一个 alpha tag 不该让稳定渠道的
 * 人看不见这个拓展** —— 整条被 alpha 顶掉的话,市场上那张卡对他们就消失了,已经装着的还会
 * 被标成「从别处装的」。每档内部仍然只留最新那一版,老版本靠发布页还能手动下。
 *
 * 三条「只许往前走」:
 * - 同档降版本 → 拒(重跑一个旧 tag 是最常见的来路);**等于**放行,那是重发同一版
 *   (打包可复现,字节一样)。
 * - 预发布比**正式档**还旧 → 也拒:它进了索引也没人看得见(预发布渠道挑两档里版本更高
 *   的那条),白白让一个 tag 看着发成功了。
 * - 正式版发出去之后,比它旧的预发布档**一并删掉** —— 留着只会让尝鲜的人看见一个比正式版
 *   还旧的版本。比它新的(下一轮的 alpha)留着。
 *
 * @param {object | undefined} current 当前索引本体(第一次发时没有)
 * @param {object} entry 新条目
 * @param {{ issuedAt?: number, revoke?: string[] }} [opts]
 */
export function mergeMarketplaceEntry(current, entry, opts = {}) {
	const fresh = cleanEntry(assertEntryShape(entry));
	const channel = channelOf(fresh);
	const sameId = (current?.extensions ?? []).filter((e) => e.id === fresh.id);
	const previous = sameId.find((e) => channelOf(e) === channel);
	if (previous && compareEntryVersions(fresh.version, previous.version) < 0)
		fail(
			`${fresh.id}:要并进去的 ${fresh.version} 比索引里已经有的${channel === "pre" ? "预发布" : "正式"}版 ${previous.version} 旧 —— 是不是重跑了一个旧 tag`,
		);
	const stable = sameId.find((e) => channelOf(e) === "stable");
	if (channel === "pre" && stable && compareEntryVersions(fresh.version, stable.version) < 0)
		fail(
			`${fresh.id}:预发布 ${fresh.version} 比索引里的正式版 ${stable.version} 还旧 —— 发进去也没人看得见`,
		);
	const kept = sameId.filter((e) => {
		if (channelOf(e) === channel) return false;
		// 正式版发出去了,比它旧的预发布档就没有意义了。
		return channel === "stable" ? compareEntryVersions(e.version, fresh.version) > 0 : true;
	});
	const rest = (current?.extensions ?? []).filter((e) => e.id !== fresh.id);
	const extensions = [...rest, ...kept, fresh]
		.map(cleanEntry)
		.sort(
			(a, b) =>
				a.id.localeCompare(b.id) ||
				(channelOf(a) === "stable" ? 0 : 1) - (channelOf(b) === "stable" ? 0 : 1),
		);
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
