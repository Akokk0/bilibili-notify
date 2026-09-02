#!/usr/bin/env node
// 打一个「升级载荷」zip:客户端解开它就得到一个能直接跑起来的版本目录。
//
// 布局与 Dockerfile 的 /app 完全一致 —— server dist 的内容在**根**,web dist 收进
// `web-dist/`。因为服务端就是按 index.mjs 就近找 web-dist 和 package.json 的
// (apps/server/src/config/web-dist.ts、routes/health.ts),布局一变就是「新服务端
// 配旧前端」或者版本号乱报,而且两种都不报错。
//
// 单文件、单次 rename 落盘的原子性由客户端保证(update/install-payload.ts),这里
// 只负责**打出一个内容正确的包**,以及交出清单要用的 sha256 / size。
//
// 用法:
//   node scripts/build-update-payload.mjs --out dist/payload.zip \
//        [--server-dist apps/server/dist] [--web-dist apps/web/dist]

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { readArg } from "./cli-args.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** zip 格式能表示的最早时间。固定它 = 同样的输入打出同样的字节。 */
const ZIP_EPOCH = new Date("1980-01-01T00:00:00Z");

/** zip 里一律 posix 分隔符 —— Windows 上打的包不能只有 Windows 解得开。 */
function toZipPath(baseDir, absPath, prefix) {
	const rel = relative(baseDir, absPath).split(sep).join(posix.sep);
	return prefix ? posix.join(prefix, rel) : rel;
}

async function collectFiles(dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await collectFiles(abs)));
		else if (entry.isFile()) out.push(abs);
	}
	return out;
}

/**
 * @param {{ serverDist: string, webDist: string, outFile: string }} input
 * @returns {Promise<{ sha256: string, size: number, entries: string[], outFile: string }>}
 */
export async function buildUpdatePayload({ serverDist, webDist, outFile }) {
	// 这两条是「装上去起不起得来」的分界线,宁可在发版机上当场炸,也不要打出一个
	// 签好名、传上去、用户装完才发现是空壳的包 —— 那时候只能再发一版。
	if (!existsSync(join(serverDist, "index.mjs")))
		throw new Error(`server dist 里没有 index.mjs:${serverDist} —— 先跑 build:bundle + assemble`);
	if (!existsSync(join(webDist, "index.html")))
		throw new Error(`web dist 里没有 index.html:${webDist} —— 先构建 apps/web`);

	/** @type {Record<string, Uint8Array>} */
	const files = {};
	for (const abs of await collectFiles(serverDist)) {
		files[toZipPath(serverDist, abs, "")] = new Uint8Array(await readFile(abs));
	}
	for (const abs of await collectFiles(webDist)) {
		files[toZipPath(webDist, abs, "web-dist")] = new Uint8Array(await readFile(abs));
	}

	// mtime 固定:同样的输入要打出同样的包。否则每次构建 sha256 都变,「这两个包
	// 是不是同一个东西」就再也答不上来了。zip 的时间戳从 1980 起,给不了 epoch 0。
	const zipped = zipSync(files, { level: 9, mtime: ZIP_EPOCH });
	await mkdir(dirname(outFile), { recursive: true });
	await writeFile(outFile, zipped);

	return {
		sha256: createHash("sha256").update(zipped).digest("hex"),
		size: zipped.byteLength,
		entries: Object.keys(files).sort(),
		outFile,
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const built = await buildUpdatePayload({
		serverDist: resolve(repoRoot, readArg("server-dist", "apps/server/dist")),
		webDist: resolve(repoRoot, readArg("web-dist", "apps/web/dist")),
		outFile: resolve(repoRoot, readArg("out", "dist/update-payload.zip")),
	});
	// stdout 是给 CI 读的:sha256 / size 直接进清单。
	process.stdout.write(`${JSON.stringify({ ...built, entries: built.entries.length }, null, 2)}\n`);
}
