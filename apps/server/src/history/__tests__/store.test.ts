/**
 * 单元测试 — `createHistoryStore` + listDayFiles / deleteDayFile(真实 tmpdir FS)。
 *
 * 守护契约:
 *   - append text/image/composite → payload reduce 正确 + 图片落盘 + emit history-recorded
 *   - result.ok = targets.every(ok)
 *   - schema 拒绝时抛错、logger.error、不写文件、不 emit
 *   - query:跨日 newest-first + 文件内倒序 + limit 钳制 + since / source / uid 过滤
 *   - readJsonl 跳过坏行 / schema 非法行
 *   - listDayFiles 仅匹配 YYYY-MM-DD.jsonl;deleteDayFile 删除指定文件
 *
 * 注:HistoryEntrySchema 要求 subscriptionId / targetIds / per[].targetId 均为
 * uuid —— fixture 必须用 randomUUID(),否则 append 与 readJsonl 的 safeParse 全拒。
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEntry } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import {
	createHistoryStore,
	deleteDayFile,
	type HistoryAppendInput,
	type HistoryStore,
	listDayFiles,
} from "../store.js";

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

let dataDir: string;
let bus: ReturnType<typeof createNodeMessageBus>;
let logger: ReturnType<typeof makeLogger>;
let store: HistoryStore;
let recorded: HistoryEntry[];

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-hist-"));
	bus = createNodeMessageBus();
	logger = makeLogger();
	recorded = [];
	bus.on("history-recorded", (e) => recorded.push(e));
	store = createHistoryStore({ dataDir, bus, logger });
});
afterEach(() => {
	vi.restoreAllMocks();
});

const baseInput = (over: Partial<HistoryAppendInput> = {}): HistoryAppendInput => ({
	source: "dynamic",
	uid: "u1",
	subscriptionId: randomUUID(),
	targets: [{ targetId: randomUUID(), ok: true, latencyMs: 10 }],
	payload: { kind: "text", text: "hello" },
	...over,
});

describe("append — payload reduce + 落盘 + emit", () => {
	it("text payload:写入日文件一行 + emit 解析后的 entry", async () => {
		const entry = await store.append(baseInput());
		expect(entry.payload).toEqual({ kind: "text", text: "hello" });
		expect(entry.result.ok).toBe(true);
		const day = `${entry.ts.slice(0, 10)}.jsonl`;
		const raw = await readFile(join(dataDir, "history", day), "utf8");
		expect(raw.trim().split("\n")).toHaveLength(1);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.id).toBe(entry.id);
	});

	it("image payload:图片落盘到 history/img/<id>.<ext>,imageRef + caption→text", async () => {
		const entry = await store.append(
			baseInput({
				payload: {
					kind: "image",
					image: { buffer: Buffer.from("PNGDATA"), mime: "image/png" },
					caption: "cap",
				},
			}),
		);
		expect(entry.payload.kind).toBe("image");
		expect(entry.payload.text).toBe("cap");
		expect(entry.payload.imageRef).toBe(`${entry.id}.png`);
		const img = await readFile(join(store.imageDir(), `${entry.id}.png`));
		expect(img.toString()).toBe("PNGDATA");
	});

	it("mime → 扩展名映射(webp/未知→jpg)", async () => {
		const webp = await store.append(
			baseInput({
				payload: { kind: "image", image: { buffer: Buffer.from("a"), mime: "image/webp" } },
			}),
		);
		expect(webp.payload.imageRef?.endsWith(".webp")).toBe(true);
		const unknown = await store.append(
			baseInput({
				payload: {
					kind: "image",
					image: { buffer: Buffer.from("a"), mime: "application/octet-stream" },
				},
			}),
		);
		expect(unknown.payload.imageRef?.endsWith(".jpg")).toBe(true);
	});

	it("composite:text/link 拼成 \\n 文本,仅保留首张图片", async () => {
		const entry = await store.append(
			baseInput({
				payload: {
					kind: "composite",
					segments: [
						{ type: "text", text: "line1" },
						{ type: "image", buffer: Buffer.from("IMG1"), mime: "image/jpeg" },
						{ type: "image", buffer: Buffer.from("IMG2"), mime: "image/jpeg" },
						{ type: "link", href: "https://x", title: "T" },
						{ type: "link", href: "https://y" },
					],
				},
			}),
		);
		expect(entry.payload.kind).toBe("composite");
		expect(entry.payload.text).toBe("line1\nT https://x\nhttps://y");
		expect(entry.payload.imageRef).toBe(`${entry.id}-0.jpg`);
		const files = await readdir(store.imageDir());
		expect(files).toEqual([`${entry.id}-0.jpg`]);
	});

	it("result.ok = targets.every(ok);任一失败则 false", async () => {
		const t1 = randomUUID();
		const t2 = randomUUID();
		const entry = await store.append(
			baseInput({
				targets: [
					{ targetId: t1, ok: true, latencyMs: 1 },
					{ targetId: t2, ok: false, latencyMs: 2, err: "boom" },
				],
			}),
		);
		expect(entry.result.ok).toBe(false);
		expect(entry.targetIds).toEqual([t1, t2]);
	});

	it("schema 拒绝:抛错 + logger.error + 不写文件不 emit", async () => {
		await expect(
			store.append(baseInput({ source: "not-a-valid-source" as never })),
		).rejects.toThrow("history entry schema validation failed");
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(recorded).toHaveLength(0);
		const day = await readdir(join(dataDir, "history"));
		expect(day.filter((f) => f.endsWith(".jsonl"))).toHaveLength(0);
	});
});

describe("query — 排序 / 过滤 / 容错", () => {
	// 用一次真实 append 拿 schema 合法样板,克隆出受控 ts/source/uid/id 的 fixture
	// 手写进指定日文件 —— append 的 ts 不可控,手写日文件才能确定性测排序与 since。
	// id 必须是 uuid,否则 readJsonl 的 safeParse 会丢弃整行。
	function clone(base: HistoryEntry, over: Partial<HistoryEntry>): HistoryEntry {
		return { ...base, ...over, id: over.id ?? randomUUID() };
	}
	async function writeDay(date: string, entries: HistoryEntry[], extraLines: string[] = []) {
		await mkdir(join(dataDir, "history"), { recursive: true });
		const lines = [...entries.map((e) => JSON.stringify(e)), ...extraLines];
		await writeFile(join(dataDir, "history", `${date}.jsonl`), `${lines.join("\n")}\n`, "utf8");
	}

	it("跨日 newest-first + 文件内倒序;limit 钳制", async () => {
		const base = await store.append(baseInput());
		const aId = randomUUID();
		const bId = randomUUID();
		const cId = randomUUID();
		const a = clone(base, { id: aId, ts: "2026-05-10T01:00:00.000Z" });
		const b = clone(base, { id: bId, ts: "2026-05-10T02:00:00.000Z" });
		const c = clone(base, { id: cId, ts: "2026-05-12T01:00:00.000Z" });
		await writeDay("2026-05-10", [a, b]); // 文件内 chronological
		await writeDay("2026-05-12", [c]);
		const ids = (await store.query({})).map((e) => e.id);
		// 今日 seed 日期最新 → 最前;跨日 newest-first;文件内倒序 b 在 a 前
		expect(ids[0]).toBe(base.id);
		expect(ids.indexOf(cId)).toBeLessThan(ids.indexOf(bId));
		expect(ids.indexOf(bId)).toBeLessThan(ids.indexOf(aId));

		expect(await store.query({ limit: 2 })).toHaveLength(2);
	});

	it("since 过滤:ts <= since 的丢弃", async () => {
		const base = await store.append(baseInput());
		const oldId = randomUUID();
		const newId = randomUUID();
		await writeDay("2026-05-10", [
			clone(base, { id: oldId, ts: "2026-05-10T00:00:00.000Z" }),
			clone(base, { id: newId, ts: "2026-05-10T10:00:00.000Z" }),
		]);
		const ids = (await store.query({ since: "2026-05-10T05:00:00.000Z" })).map((e) => e.id);
		expect(ids).toContain(newId);
		expect(ids).not.toContain(oldId);
	});

	it("source / uid 精确过滤", async () => {
		const base = await store.append(baseInput());
		const dId = randomUUID();
		const lId = randomUUID();
		await writeDay("2026-05-11", [
			clone(base, { id: dId, source: "dynamic", uid: "uA" }),
			clone(base, { id: lId, source: "live", uid: "uB" }),
		]);
		expect((await store.query({ source: "live" })).map((e) => e.id)).toEqual([lId]);
		const byUid = (await store.query({ uid: "uA" })).map((e) => e.id);
		expect(byUid).toContain(dId);
		expect(byUid).not.toContain(lId);
	});

	it("坏 jsonl 行 / schema 非法行被跳过", async () => {
		const base = await store.append(baseInput());
		const goodId = randomUUID();
		await writeDay(
			"2026-05-09",
			[clone(base, { id: goodId, ts: "2026-05-09T00:00:00.000Z", uid: "u1" })],
			["{not json", JSON.stringify({ bogus: true }), "   "],
		);
		const res = await store.query({ uid: "u1" });
		expect(res.some((e) => e.id === goodId)).toBe(true);
		expect(res.every((e) => typeof e.id === "string")).toBe(true);
	});
});

describe("listDayFiles / deleteDayFile", () => {
	async function ensureHistoryDir() {
		await mkdir(join(dataDir, "history"), { recursive: true });
	}

	it("listDayFiles 仅匹配 YYYY-MM-DD.jsonl", async () => {
		await ensureHistoryDir();
		await writeFile(join(dataDir, "history", "2026-05-01.jsonl"), "x\n");
		await writeFile(join(dataDir, "history", "notes.txt"), "x");
		await writeFile(join(dataDir, "history", "2026-5-1.jsonl"), "x"); // 非零填充,不匹配
		const files = await listDayFiles(dataDir);
		expect(files).toContain("2026-05-01.jsonl");
		expect(files).not.toContain("notes.txt");
		expect(files).not.toContain("2026-5-1.jsonl");
	});

	it("deleteDayFile 删除指定日文件", async () => {
		await ensureHistoryDir();
		await writeFile(join(dataDir, "history", "2026-04-30.jsonl"), "x\n");
		await deleteDayFile(dataDir, "2026-04-30.jsonl");
		expect(await listDayFiles(dataDir)).not.toContain("2026-04-30.jsonl");
	});

	it("listDayFiles 在 history 目录不存在时返回 []", async () => {
		const empty = await mkdtemp(join(tmpdir(), "bn-hist-empty-"));
		expect(await listDayFiles(empty)).toEqual([]);
	});
});
