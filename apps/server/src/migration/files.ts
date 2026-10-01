/**
 * 迁移器改写文件的共用几件:读一份 JSON(分得清没有 / 读不懂 / 读到了)、写一份新文件替掉旧的(原子换名、
 * 沿用原件的权限)、逐行改写一份 jsonl、判一坨东西是不是普通对象。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { atomicWriteFile, atomicWriteJson } from "@bilibili-notify/storage";

export type JsonFile =
	| { kind: "missing" }
	| { kind: "unreadable" }
	| { kind: "ok"; value: unknown };

export async function readJsonFile(path: string): Promise<JsonFile> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		throw err;
	}
	try {
		return { kind: "ok", value: JSON.parse(text) as unknown };
	} catch {
		return { kind: "unreadable" };
	}
}

/**
 * 写一份新文件替掉 `path`(原子换名),权限沿用 `modeFrom` 那份(缺省就是被替掉的那份)。
 *
 * 🔴 不许原地写:搬过来的文件多半是指向第 0 代的硬链接,原地写会改到第 0 代。权限要沿用:连接里有 token,
 * 主人收紧过的文件不能因为迁移这一跳放宽。
 */
export async function rewriteJsonFile(
	path: string,
	value: unknown,
	modeFrom = path,
): Promise<void> {
	await atomicWriteJson(path, value, await modeOptions(modeFrom));
}

/** {@link rewriteJsonFile} 的原文版:写的是现成的一段文本。 */
export async function rewriteTextFile(path: string, text: string, modeFrom = path): Promise<void> {
	await atomicWriteFile(path, text, await modeOptions(modeFrom));
}

/**
 * 逐行改写一份 jsonl:整份按 `\n` 切开交给 `rewrite`(回同样多的行),有一行变了才写,回写没写。没变的行
 * 一个字节不动 —— 空行、坏行、带 `\r` 的行都原样留着。文件不在回 false。
 */
export async function rewriteJsonlFile(
	path: string,
	rewrite: (lines: readonly string[]) => string[],
): Promise<boolean> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
	const lines = text.split("\n");
	const next = rewrite(lines);
	if (next.every((line, i) => line === lines[i])) return false;
	await rewriteTextFile(path, next.join("\n"));
	return true;
}

/** jsonl 的一行解开;解不开回 `undefined`(和读的人一样当坏行跳过)。 */
export function parseJsonLine(line: string): unknown {
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return undefined;
	}
}

/** 一个目录里以 `suffix` 结尾的文件名(按名字排好);目录不在回空。 */
export async function listFiles(dir: string, suffix: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((name) => name.endsWith(suffix)).sort();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
}

async function modeOptions(path: string): Promise<{ mode?: number }> {
	const mode = await modeOf(path);
	return mode === undefined ? {} : { mode };
}

async function modeOf(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mode & 0o777;
	} catch {
		return undefined;
	}
}

/**
 * 普通对象(`JSON.parse` 出来的对象落在 `Object.prototype` 上)。判据和 internal 的 `util/plain-object.ts` 逐字
 * 相同 —— 收进来的 preprocess 用的就是那一份,换一种判据等于对同一坨老数据给出另一种答案。那一份刻意不进
 * internal 的根入口,所以这里留一份。
 */
export function isPlainObject(x: unknown): x is Record<string, unknown> {
	if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
	const proto = Object.getPrototypeOf(x);
	return proto === Object.prototype || proto === null;
}
