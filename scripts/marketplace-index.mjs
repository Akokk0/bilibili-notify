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
	const rest = (current?.extensions ?? []).filter((e) => e.id !== fresh.id).map(cleanEntry);
	const extensions = [...rest, fresh].sort((a, b) => a.id.localeCompare(b.id));
	const revoked = [...new Set([...(current?.revoked ?? []), ...(opts.revoke ?? [])])];
	const index = {
		name: current?.name ?? OFFICIAL_INDEX_NAME,
		issuedAt: opts.issuedAt ?? Math.floor(Date.now() / 1000),
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
