#!/usr/bin/env node
// 把一个拓展的构建产物打成**拓展包**(zip),并算出索引要的 sha256 与大小。
//
// 包里的名字与装载那头的白名单逐字一致:必需的 extension.json + index.mjs,
// 外加可选的 README.md / CHANGELOG.md,以及 locales/<语言码>.json(判据是「**这个文件会不会
// 被 import**」—— 文档与译文是数据,所以进得来)。这些之外多放一个都会被拒。
//
// 用法:node scripts/pack-extension.mjs --id bridge --out dist/bridge-0.0.2.zip
// stdout 打一行 JSON:{ "path", "sha256", "size", "version" }

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readArg, requireArg } from "./cli-args.mjs";
import {
	EXTENSION_PACKAGE_DOC_FILES,
	EXTENSION_PACKAGE_FILES,
	EXTENSION_PACKAGE_LOCALES,
	packExtension,
} from "./extension-package-files.mjs";
import { extensionAssetName } from "./release-urls.mjs";

export * from "./extension-package-files.mjs";

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
	// 译文是构建产物,从 dist 读;只读语言表里的那几种,别的名字连看都不看。
	for (const code of EXTENSION_PACKAGE_LOCALES) {
		try {
			files[`locales/${code}.json`] = new Uint8Array(
				await readFile(join(dist, "locales", `${code}.json`)),
			);
		} catch {
			// 没带这种语言不是打不了包的理由。
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
