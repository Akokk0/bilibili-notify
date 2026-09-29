import { readFileSync, renameSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";

/**
 * 持久化底层:读 JSON。三种结果分开交代,调用方各自决定怎么办 —— 配置文件坏了仍要开机报错,
 * 缓存类当空、下次重建。坏文件先改名成 `<原名>.corrupt-<时刻>` 隔离:原内容一字不丢,
 * 之后的写入落到原位置也不会把它盖掉。
 *
 * 同步版(`…Sync`)三种结果与隔离方式都和异步版一致 —— 给开机早期的同步小状态用。
 */
export type JsonFileRead =
	| { kind: "ok"; value: unknown }
	| { kind: "missing" }
	| { kind: "corrupt"; quarantinedPath: string; message: string };

export async function readJsonFile(path: string): Promise<JsonFileRead> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		throw err;
	}
	try {
		return { kind: "ok", value: JSON.parse(text) };
	} catch (err) {
		const quarantinedPath = await quarantineFile(path);
		return { kind: "corrupt", quarantinedPath, message: (err as Error).message };
	}
}

/**
 * 把一个坏文件改名隔离,返回新路径。时刻用 ISO,冒号与小数点换成 `-`(Windows 文件名不许冒号)。
 * 读得出 JSON、但 schema 不认的文件,调用方也用它隔离。
 */
export async function quarantineFile(path: string): Promise<string> {
	const quarantinedPath = quarantinePathFor(path);
	await rename(path, quarantinedPath);
	return quarantinedPath;
}

/** {@link readJsonFile} 的同步版。 */
export function readJsonFileSync(path: string): JsonFileRead {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		throw err;
	}
	try {
		return { kind: "ok", value: JSON.parse(text) };
	} catch (err) {
		const quarantinedPath = quarantineFileSync(path);
		return { kind: "corrupt", quarantinedPath, message: (err as Error).message };
	}
}

/** {@link quarantineFile} 的同步版。 */
export function quarantineFileSync(path: string): string {
	const quarantinedPath = quarantinePathFor(path);
	renameSync(path, quarantinedPath);
	return quarantinedPath;
}

function quarantinePathFor(path: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${path}.corrupt-${stamp}`;
}
