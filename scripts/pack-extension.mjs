#!/usr/bin/env node
// 把一个拓展的构建产物打成**拓展包**(zip),并算出索引要的 sha256 与大小。
//
// 包里只有四个名字,与装载那头的白名单逐字一致:必需的 extension.json + index.mjs,
// 外加可选的 README.md / CHANGELOG.md(判据是「**这个文件会不会被 import**」——
// 文档不会,所以进得来)。这四个之外多放一个都会被拒。
//
// 用法:node scripts/pack-extension.mjs --id bridge --out dist/bridge-0.0.2.zip
// stdout 打一行 JSON:{ "path", "sha256", "size", "version" }

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readArg, requireArg } from "./cli-args.mjs";
import { extensionAssetName } from "./release-urls.mjs";
import { digestOf, EXTENSION_ZIP_EPOCH, reproducibleZip } from "./reproducible-zip.mjs";

export const EXTENSION_PACKAGE_FILES = ["extension.json", "index.mjs"];
/**
 * 给人看的那两份,**两份都可选**。名字与装载那头的白名单是同一套 —— 那边多认一个名字,
 * 这边就得多打一个,否则官方拓展发出去了市场上却没有说明。
 */
export const EXTENSION_PACKAGE_DOC_FILES = ["README.md", "CHANGELOG.md"];
/**
 * 一份文档的上限,**与装载那头(`apps/server/src/extensions/discover.ts`)是同一个数**。
 *
 * 🔴 这道闸必须在**打包**这头,光靠拆包那头拦不住要命的那条路:release 是不可变的,
 * 一旦带着超大文档发出去、sha256 进了签名索引,此后每个用户点安装都得到「包拆不开」,
 * 只能升版号重发。两头各写一份数会漂,所以 `pack-extension.test.mjs` 拿它们对着钉。
 */
export const EXTENSION_DOC_MAX_BYTES = 512 * 1024;

/** @param {Record<string, Uint8Array>} files */
export function packExtension(files) {
	const entries = {};
	for (const name of EXTENSION_PACKAGE_FILES) {
		const bytes = files[name];
		if (!bytes) throw new Error(`拓展包缺 ${name}`);
		entries[name] = bytes;
	}
	// 可选的按**固定顺序**追加:条目顺序会进 zip 的字节,而 sha256 是索引里钉着的。
	for (const name of EXTENSION_PACKAGE_DOC_FILES) {
		const bytes = files[name];
		if (!bytes) continue;
		if (bytes.byteLength > EXTENSION_DOC_MAX_BYTES) {
			throw new Error(
				`${name} 太大了(${bytes.byteLength} 字节,上限 ${EXTENSION_DOC_MAX_BYTES})—— 装载那头会拒,发出去就是个谁都装不上的包`,
			);
		}
		entries[name] = bytes;
	}
	// 固定时间戳:同样的产物打出同样的字节,sha256 才复现得了。
	const zip = reproducibleZip(entries, EXTENSION_ZIP_EPOCH);
	return { zip, ...digestOf(zip) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const id = requireArg("id");
	const dist = resolve(readArg("dist", join("extensions", id, "dist")));
	// 文档是**源码**不是产物,所以从拓展目录读,不从 dist 读。
	const src = resolve(readArg("src", join("extensions", id)));
	const files = {};
	for (const name of EXTENSION_PACKAGE_FILES)
		files[name] = new Uint8Array(await readFile(join(dist, name)));
	for (const name of EXTENSION_PACKAGE_DOC_FILES) {
		try {
			files[name] = new Uint8Array(await readFile(join(src, name)));
		} catch {
			// 没写就是没写 —— 不是打不了包的理由。
		}
	}
	const manifest = JSON.parse(Buffer.from(files["extension.json"]).toString("utf8"));
	if (manifest.id !== id) throw new Error(`清单里的 id 是 ${manifest.id},要打的是 ${id}`);
	const { zip, sha256, size } = packExtension(files);
	const out = resolve(readArg("out", join("dist", extensionAssetName(id, manifest.version))));
	await mkdir(dirname(out), { recursive: true });
	await writeFile(out, zip);
	process.stdout.write(
		`${JSON.stringify({ path: out, sha256, size, version: manifest.version })}\n`,
	);
}
