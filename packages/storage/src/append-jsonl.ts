import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 持久化底层:追加 JSONL(历史、统计、日志)。一次调用的几条拼成一块、一次写完,一条一行。
 *
 * 不 fsync:追加是高频小写,丢的最多是崩溃前最后几行;读的一方要容得下末尾半行
 * (进程被杀在写的中途)。同一个文件的追加由调用方经写道串行,这里不排队。
 */
export async function appendJsonl(path: string, records: readonly unknown[]): Promise<void> {
	if (records.length === 0) return;
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
}
