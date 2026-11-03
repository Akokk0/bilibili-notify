import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { packageText } from "@bilibili-notify/internal/texts";

/*
 * 持久化底层:追加行(历史、统计、日志)。一次调用的几条拼成一块、一次写完,一条一行。
 *
 * 不 fsync:追加是高频小写,丢的最多是崩溃前最后几行;读的一方要容得下末尾半行
 * (进程被杀在写的中途)。同一个文件的追加由调用方经写道串行,这里不排队。
 */

/**
 * 按原样追加若干行:每个元素就是一行、不带换行,写成 `行\n` 拼起来一次追加。给自己序列化的
 * 调用方用(日志要带循环引用兜底,不能交给 `JSON.stringify`),要求按原字节落盘。
 *
 * 任何一个元素里含 `\n` 就抛 TypeError、整批一行都不写:一行里混进换行,JSONL 的读方会把它
 * 劈成两条,而且劈出来的两半往往各自都不是合法 JSON。空数组什么都不做。
 */
export async function appendLines(path: string, lines: readonly string[]): Promise<void> {
	if (lines.length === 0) return;
	for (const line of lines) {
		if (line.includes("\n")) {
			throw new TypeError(packageText("storage.append-jsonl.1"));
		}
	}
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, lines.map((line) => `${line}\n`).join(""), "utf8");
}

/**
 * 追加若干条记录:每条 `JSON.stringify` 成一行,再交给 {@link appendLines}。
 *
 * 序列化不出 JSON 的记录(`undefined`、函数)抛 TypeError、整批不写 —— 不然盘上会多出一行
 * `undefined`,读方逐行解析时整行作废。
 */
export async function appendJsonl(path: string, records: readonly unknown[]): Promise<void> {
	const lines = records.map((record, index) => {
		const line = JSON.stringify(record) as string | undefined;
		if (line === undefined) {
			throw new TypeError(packageText("storage.append-jsonl.2", { value0: index }));
		}
		return line;
	});
	await appendLines(path, lines);
}
