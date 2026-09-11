#!/usr/bin/env node
// 把一个拓展的构建产物打成**拓展包**(zip:extension.json + index.mjs,只此两个文件 ——
// 装载那头的白名单就这两样,多放一个都会被拒),并算出索引要的 sha256 与大小。
//
// 用法:node scripts/pack-extension.mjs --id bridge --out dist/bridge-0.0.2.zip
// stdout 打一行 JSON:{ "path", "sha256", "size", "version" }

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { readArg, requireArg } from "./cli-args.mjs";

export const EXTENSION_PACKAGE_FILES = ["extension.json", "index.mjs"];

/** @param {Record<string, Uint8Array>} files */
export function packExtension(files) {
	const entries = {};
	for (const name of EXTENSION_PACKAGE_FILES) {
		const bytes = files[name];
		if (!bytes) throw new Error(`拓展包缺 ${name}`);
		entries[name] = bytes;
	}
	// 固定时间戳:同样的产物打出同样的字节,sha256 才复现得了。
	const zip = zipSync(entries, { level: 9, mtime: new Date("2000-01-01T00:00:00Z") });
	return { zip, sha256: createHash("sha256").update(zip).digest("hex"), size: zip.byteLength };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const id = requireArg("id");
	const dist = resolve(readArg("dist", join("extensions", id, "dist")));
	const files = {};
	for (const name of EXTENSION_PACKAGE_FILES)
		files[name] = new Uint8Array(await readFile(join(dist, name)));
	const manifest = JSON.parse(Buffer.from(files["extension.json"]).toString("utf8"));
	if (manifest.id !== id) throw new Error(`清单里的 id 是 ${manifest.id},要打的是 ${id}`);
	const { zip, sha256, size } = packExtension(files);
	const out = resolve(readArg("out", join("dist", `${id}-${manifest.version}.zip`)));
	await mkdir(dirname(out), { recursive: true });
	await writeFile(out, zip);
	process.stdout.write(
		`${JSON.stringify({ path: out, sha256, size, version: manifest.version })}\n`,
	);
}
