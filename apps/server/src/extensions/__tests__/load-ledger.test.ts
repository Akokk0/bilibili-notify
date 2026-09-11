/**
 * 拓展的**失败记账**(ADR-0012 后果段:按 id + 版本记账,连续失败自动停用)。
 *
 * 骨架照搬开机选版那套:**要加载它的那一刻就记一笔,起来了才销账**。反过来(加载成功
 * 才记)的话,「一加载就把进程带走」这种循环永远累加不到上限 —— 而那正是这套机制唯一
 * 要救的场景。
 *
 * 记账键带**版本**:换一版就是重新给一次机会,不必让主人去哪里手动解封。
 * 停用也**不去动主人按的那个开关** —— 两者语义相反,共用一格的话「修好了重装」会变成
 * 「装好了但开关莫名其妙是关的」。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { markLoadSucceeded, readLoadLedger, recordLoadAttempt } from "../load-ledger.js";

let root: string;
const MAX = 3;

function attempt(id: string, version = "1.0.0"): void {
	recordLoadAttempt({ root, id, version, maxFailures: MAX });
}

/** 盘上那份原样 —— 计数是内部状态,只有这几条「记到第几笔了」的用例才掰开看。 */
async function raw(): Promise<unknown> {
	return JSON.parse(await readFile(join(root, "load-state.json"), "utf8"));
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "bn-ext-ledger-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("拓展失败记账", () => {
	it("第一次要加载 → 记一笔,还没到上限", async () => {
		attempt("bridge");
		expect(await raw()).toEqual({ attempts: { "bridge@1.0.0": 1 }, blocked: [] });
		expect(readLoadLedger(root).blocked).toEqual([]);
	});

	it("连着到上限 → 自动停用,而且是**这一次**就停(判死记在选中那一刻)", () => {
		attempt("bridge");
		attempt("bridge");
		attempt("bridge");
		expect(readLoadLedger(root).blocked).toEqual(["bridge@1.0.0"]);
	});

	it("起来了就销账 —— 也从名单里放出来:阈值那一次它已经进名单了,可它其实活了", () => {
		attempt("bridge");
		attempt("bridge");
		attempt("bridge");
		markLoadSucceeded({ root, id: "bridge", version: "1.0.0" });
		expect(readLoadLedger(root).blocked).toEqual([]);
		// 从头数:再记一笔也不该当场又进名单。
		attempt("bridge");
		expect(readLoadLedger(root).blocked).toEqual([]);
	});

	it("换一版就重新给机会 —— 记账键带版本,不必去哪里手动解封", () => {
		attempt("bridge");
		attempt("bridge");
		attempt("bridge");
		attempt("bridge", "1.0.1");
		// 新那版从头数,老那版还关着:修好的是新版,不是它。
		expect(readLoadLedger(root).blocked).toEqual(["bridge@1.0.0"]);
	});

	it("一个拓展记账不牵连另一个", async () => {
		attempt("bridge");
		attempt("bridge");
		attempt("bridge");
		attempt("douyin");
		expect(readLoadLedger(root).blocked).toEqual(["bridge@1.0.0"]);
		expect((await raw()) as { attempts: Record<string, number> }).toMatchObject({
			attempts: { "douyin@1.0.0": 1 },
		});
	});

	it("状态文件被写坏了 → 当作从没记过,不抛", async () => {
		attempt("bridge");
		await writeFile(join(root, "load-state.json"), "{ 半个 JSON");
		attempt("bridge");
		// 从头数,不是接着上一笔数 —— 读不出来的那份当没记过。
		expect(await raw()).toEqual({ attempts: { "bridge@1.0.0": 1 }, blocked: [] });
	});

	it("写不进去也不抛 —— 这份状态是启发,坏了不该让拓展加载不了", () => {
		// 根本不是目录:写盘一路失败,而调用方什么都不必知道。
		expect(() =>
			recordLoadAttempt({
				root: join(root, "load-state.json", "x"),
				id: "a",
				version: "1.0.0",
				maxFailures: MAX,
			}),
		).not.toThrow();
	});

	it("落盘的是一份看得懂的 JSON —— 主人要能自己打开删一行", async () => {
		attempt("bridge");
		expect(await raw()).toEqual({ attempts: { "bridge@1.0.0": 1 }, blocked: [] });
	});
});
