#!/usr/bin/env node
// 官方索引里**一条**条目(ADR-0013):拓展自己的清单 + 这一趟发布的那几个数
// → `dist/entry.json`,交给 `marketplace-index.mjs` 并进索引再签。
//
// 从前这段住在 `extension-release.yml` 里的一大块 `node -e` 中间。挪出来的理由只有一个:
// 那里**测不了**。条目的形状是客户端 zod 的对家,而写错一格的症状全在客户端那边
// (拉回来的索引判 malformed、或者指着 404 的包),流水线一路全绿。
//
// 用法:
//   ID=bridge VERSION=0.0.2 PRERELEASE=false REPO=owner/name \
//   SHA256=… SIZE=… NOTES=… node scripts/marketplace-entry.mjs --out dist/entry.json

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readArg } from "./cli-args.mjs";
import { extensionPackageUrl, extensionReleaseUrl } from "./release-urls.mjs";

/**
 * @param {{ id: string, name: string, description?: string, apiVersion: number }} manifest
 *   `extensions/<id>/extension.json` 的内容。
 * @param {{ version: string, prerelease: boolean, repo: string, sha256: string, size: number, notes?: string }} release
 *   这一趟发布的那几个数。`version` 与清单里那个由 `assert-extension-tag.sh` 保证一致,
 *   所以这里不再判一遍。
 */
export function marketplaceEntryOf(manifest, release) {
	const { id } = manifest;
	return {
		id,
		name: manifest.name,
		// 客户端那份 zod 要它是字符串。清单里没写就给空的 —— `undefined` 会被
		// `JSON.stringify` 整格丢掉,而下游 `cleanEntry` 又会补一个空的回来。
		description: manifest.description ?? "",
		version: release.version,
		apiVersion: manifest.apiVersion,
		prerelease: release.prerelease,
		package: {
			url: extensionPackageUrl(release.repo, id, release.version),
			sha256: release.sha256,
			size: release.size,
		},
		releaseUrl: extensionReleaseUrl(release.repo, id, release.version),
		notes: release.notes,
	};
}

/** env → {@link marketplaceEntryOf} 的第二个参数。`SIZE` 从 env 来一定是字符串。 */
export function releaseFromEnv(env) {
	const need = (key) => {
		const value = env[key];
		if (typeof value !== "string" || value === "") throw new Error(`${key} env 必填`);
		return value;
	};
	const size = Number(need("SIZE"));
	if (!Number.isInteger(size) || size <= 0) throw new Error(`SIZE 不是正整数:${env.SIZE}`);
	return {
		version: need("VERSION"),
		prerelease: env.PRERELEASE === "true",
		repo: need("REPO"),
		sha256: need("SHA256"),
		size,
		notes: env.NOTES,
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const id = process.env.ID;
	if (!id) throw new Error("ID env 必填");
	const manifestPath = resolve(join("extensions", id, "extension.json"));
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	// 同 pack-extension.mjs 那道:目录名与清单里的 id 对不上,打出来的包和索引里那条就
	// 指不着同一个东西了。
	if (manifest.id !== id)
		throw new Error(`${manifestPath} 里的 id 是 ${manifest.id},要发的是 ${id}`);
	const entry = marketplaceEntryOf(manifest, releaseFromEnv(process.env));
	const out = resolve(readArg("out", "dist/entry.json"));
	await mkdir(dirname(out), { recursive: true });
	await writeFile(out, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
	process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
}
