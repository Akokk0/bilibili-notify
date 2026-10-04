/**
 * 迁移器改写文件的共用几件:读一份 JSON(分得清没有 / 读不懂 / 读到了)、写一份新文件替掉旧的(原子换名、
 * 沿用原件的权限)、逐行改写一份 jsonl、判一坨东西是不是普通对象、认第 0 代里的残留。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { atomicWriteFile, atomicWriteJson, isLeftoverName } from "@bilibili-notify/storage";

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
 * 逐行改写一份 jsonl:整份按 `\n` 切开交给 `rewrite`(回同样多的行,可以是异步的 —— 改写要去读别的文件时),
 * 有一行变了才写,回写没写。没变的行一个字节不动 —— 空行、坏行、带 `\r` 的行都原样留着。文件不在回 false。
 */
export async function rewriteJsonlFile(
	path: string,
	rewrite: (lines: readonly string[]) => string[] | Promise<string[]>,
): Promise<boolean> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
	const lines = text.split("\n");
	const next = await rewrite(lines);
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

/**
 * 这个名字是不是残留,是的话为什么不带:上个进程的临时文件与暂存目录(storage 的标记)、0.x 的备份
 * (`*.bak`、恢复备份留下的 `*.restore.bak`)、0.x 自己的临时件与迁移中间件、被隔离的坏文件。
 */
export function leftoverReason(name: string): string | undefined {
	if (isLeftoverName(name)) return "上个进程留下的临时文件";
	if (name.endsWith(".bak")) return "0.x 的备份";
	if (/\.tmp(\.|$)/.test(name) || name.startsWith(".staging-") || name.endsWith(".migrating")) {
		return "0.x 的临时件";
	}
	if (name.includes(".corrupt-")) return "被隔离的坏文件";
	return undefined;
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
 * 普通对象(`JSON.parse` 出来的对象落在 `Object.prototype` 或 `null` 上)。判据带原型检查:数组、`Date`、类实例都不算,
 * 迁移只往普通对象里递归改写。从前 internal 也有一份同判据的,给收进迁移器之前的 preprocess 用;preprocess 搬进来以后
 * 那份没人用了,已删。
 */
export function isPlainObject(x: unknown): x is Record<string, unknown> {
	if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
	const proto = Object.getPrototypeOf(x);
	return proto === Object.prototype || proto === null;
}
