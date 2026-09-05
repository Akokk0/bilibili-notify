/**
 * 单元测试 — `createHistoryStore` + listDayFiles / deleteDayFile(真实 tmpdir FS)。
 *
 * 守护契约(行模型本身见 record.test.ts):
 *   - record 的 payload reduce:text / image / composite 各自的文案与图片落盘
 *   - schema 拒绝时抛错、logger.error、不写文件、不 emit
 *   - query:跨日 newest-first + 文件内倒序 + limit 钳制 + since / uid 过滤
 *   - 取尾巴的窗口:绕圈、坏行补读
 *   - readJsonl 跳过坏行 / schema 非法行
 *   - aggregateDaily:客户端时区日界、零填充、超 500 条全量
 *   - listDayFiles 仅匹配 YYYY-MM-DD.jsonl;deleteDayFile 删除指定文件
 *
 * 注:HistoryEntrySchema 要求 subscriptionId / targetId 均为 uuid —— fixture 必须用
 * randomUUID(),否则 record 与 readJsonl 的 safeParse 全拒。
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEntry } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import {
	createHistoryStore,
	deleteDayFile,
	type HistoryRecordInput,
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

const baseInput = (over: Partial<HistoryRecordInput> = {}): HistoryRecordInput => ({
	pushId: randomUUID(),
	kind: "dynamic",
	uid: "u1",
	subscriptionId: randomUUID(),
	target: randomUUID(),
	messages: [
		{ payload: { kind: "text", text: "hello" }, role: "main", result: { ok: true, latencyMs: 10 } },
	],
	...over,
});

function only(entry: HistoryEntry) {
	const m = entry.messages[0];
	if (!m) throw new Error("no message");
	return m;
}

describe("record — payload reduce + 落盘 + emit", () => {
	it("text payload:写入日文件一行 + emit 解析后的 entry", async () => {
		const entry = await store.record(baseInput());
		expect(only(entry).payload).toEqual({ kind: "text", text: "hello" });
		expect(entry.status).toBe("delivered");
		const day = `${entry.ts.slice(0, 10)}.jsonl`;
		const raw = await readFile(join(dataDir, "history", day), "utf8");
		expect(raw.trim().split("\n")).toHaveLength(1);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.id).toBe(entry.id);
	});

	it("image payload:图片落盘到 history/img/<id>-<idx>.<ext>,imageRef + caption→text", async () => {
		const entry = await store.record(
			baseInput({
				messages: [
					{
						payload: {
							kind: "image",
							image: { buffer: Buffer.from("PNGDATA"), mime: "image/png" },
							caption: "cap",
						},
						role: "main",
						result: { ok: true, latencyMs: 1 },
					},
				],
			}),
		);
		expect(only(entry).payload).toEqual({
			kind: "image",
			text: "cap",
			imageRef: `${entry.id}-0.png`,
		});
		const img = await readFile(join(store.imageDir(), `${entry.id}-0.png`));
		expect(img.toString()).toBe("PNGDATA");
	});

	it("mime → 扩展名映射(webp/未知→jpg)", async () => {
		const image = (mime: string): HistoryRecordInput["messages"] => [
			{ payload: { kind: "image", image: { buffer: Buffer.from("a"), mime } }, role: "main" },
		];
		const webp = await store.record(baseInput({ messages: image("image/webp") }));
		expect(only(webp).payload.imageRef?.endsWith(".webp")).toBe(true);
		const unknown = await store.record(baseInput({ messages: image("application/octet-stream") }));
		expect(only(unknown).payload.imageRef?.endsWith(".jpg")).toBe(true);
	});

	it("composite:text/link 拼成 \\n 文本,仅保留首张图片", async () => {
		const entry = await store.record(
			baseInput({
				messages: [
					{
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
						role: "main",
						result: { ok: true, latencyMs: 1 },
					},
				],
			}),
		);
		expect(only(entry).payload).toEqual({
			kind: "composite",
			text: "line1\nT https://x\nhttps://y",
			imageRef: `${entry.id}-0-0.jpg`,
		});
		expect(await readdir(store.imageDir())).toEqual([`${entry.id}-0-0.jpg`]);
	});

	it("composite at-all 段 → text 写出「@全体」而非空;与 text 段按段序拼接", async () => {
		const alone = await store.record(
			baseInput({
				kind: "live",
				messages: [
					{ payload: { kind: "composite", segments: [{ type: "at-all" }] }, role: "extra" },
				],
			}),
		);
		expect(only(alone).payload.text).toBe("@全体");
		const mixed = await store.record(
			baseInput({
				kind: "live",
				messages: [
					{
						payload: {
							kind: "composite",
							segments: [{ type: "at-all" }, { type: "text", text: "开播啦" }],
						},
						role: "main",
					},
				],
			}),
		);
		expect(only(mixed).payload.text).toBe("@全体\n开播啦");
	});

	it("forward-images → 一句「[图集 N 张]」摘要", async () => {
		const entry = await store.record(
			baseInput({
				messages: [
					{
						payload: {
							kind: "forward-images",
							images: [{ url: "https://a" }, { url: "https://b" }],
							forward: true,
						},
						role: "extra",
						result: { ok: true, latencyMs: 1 },
					},
				],
			}),
		);
		expect(only(entry).payload).toEqual({ kind: "text", text: "[图集 2 张 · 合并转发]" });
	});

	it("schema 拒绝:抛错 + logger.error + 不写文件不 emit", async () => {
		await expect(store.record(baseInput({ kind: "not-a-kind" as never }))).rejects.toThrow(
			"history entry schema validation failed",
		);
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(recorded).toHaveLength(0);
		const day = await readdir(join(dataDir, "history"));
		expect(day.filter((f) => f.endsWith(".jsonl"))).toHaveLength(0);
	});
});

// 用一次真实 record 拿 schema 合法样板,克隆出受控 ts/kind/uid/id 的 fixture 手写进指定
// 日文件 —— record 的 ts 不可控,手写日文件才能确定性测排序与 since。id 必须是 uuid,
// 否则 readJsonl 的 safeParse 会丢弃整行。
function clone(base: HistoryEntry, over: Partial<HistoryEntry>): HistoryEntry {
	const id = over.id ?? randomUUID();
	return { ...base, ...over, id, pushId: over.pushId ?? id };
}
async function writeDay(date: string, entries: HistoryEntry[], extraLines: string[] = []) {
	await mkdir(join(dataDir, "history"), { recursive: true });
	const lines = [...entries.map((e) => JSON.stringify(e)), ...extraLines];
	await writeFile(join(dataDir, "history", `${date}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

describe("query — 排序 / 过滤 / 容错", () => {
	it("跨日 newest-first + 文件内倒序;limit 钳制", async () => {
		const base = await store.record(baseInput());
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

	it("单日条数远超 limit → 只回最新那几条,且仍是 newest-first", async () => {
		// 取尾巴那条路是滑动窗口:当天只有寥寥几条时窗口装得下,坑照不出来 ——
		// 所以这里刻意写满 47 条只取 5 条。
		const base = await store.record(baseInput());
		const entries = Array.from({ length: 47 }, (_, i) =>
			clone(base, {
				id: randomUUID(),
				// 时序递增,与 append-only 的日文件一致(走分钟,别写出「46 点」)
				ts: `2026-05-09T00:${String(i).padStart(2, "0")}:00.000Z`,
			}),
		);
		await writeDay("2026-05-09", entries);

		// seed 那条落在今日文件里,日期最新 → 永远排最前,单独占一格。
		const got = await store.query({ limit: 6 });
		expect(got[0]?.id).toBe(base.id);
		expect(got.slice(1).map((e) => e.id)).toEqual(
			entries
				.slice(-5)
				.reverse()
				.map((e) => e.id),
		);
	});

	it("尾巴里混了坏行 → 拿当天更早那几条补上,不是跳去前一天", async () => {
		// 取尾巴那条快路数的是**行**,可返回的是**能解析回来的条目**。尾窗里只要有
		// 读不回来的行(进程崩在写一半、旧 schema 留下的行),这一份就少给几条,
		// 而调用方拿这个短数去更早的日文件里补 —— 夹在中间那些完好的记录于是
		// 从历史页上彻底消失,连翻页都翻不到。
		const base = await store.record(baseInput());
		const today = Array.from({ length: 10 }, (_, i) =>
			clone(base, {
				id: randomUUID(),
				ts: `2026-05-10T00:${String(i).padStart(2, "0")}:00.000Z`,
			}),
		);
		await writeDay("2026-05-10", today, ["{truncated", JSON.stringify({ bogus: true }), "{}"]);
		const older = clone(base, { id: randomUUID(), ts: "2026-05-09T00:00:00.000Z" });
		await writeDay("2026-05-09", [older]);

		const got = await store.query({ limit: 6 });
		expect(got[0]?.id).toBe(base.id); // 今日 seed 永远最前,单独占一格
		expect(got.slice(1).map((e) => e.id)).toEqual(
			today
				.slice(-5)
				.reverse()
				.map((e) => e.id),
		);
		expect(got.map((e) => e.id)).not.toContain(older.id);
	});

	it("since 过滤:ts <= since 的丢弃", async () => {
		const base = await store.record(baseInput());
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

	it("kind / uid 精确过滤", async () => {
		const base = await store.record(baseInput());
		const dId = randomUUID();
		const lId = randomUUID();
		await writeDay("2026-05-11", [
			clone(base, { id: dId, kind: "dynamic", uid: "uA" }),
			clone(base, { id: lId, kind: "live", uid: "uB" }),
		]);
		expect((await store.query({ kind: "live" })).map((e) => e.id)).toEqual([lId]);
		const byUid = (await store.query({ uid: "uA" })).map((e) => e.id);
		expect(byUid).toContain(dId);
		expect(byUid).not.toContain(lId);
	});

	it("坏 jsonl 行 / schema 非法行 / 认不到亲的补丁行被跳过", async () => {
		const base = await store.record(baseInput());
		const goodId = randomUUID();
		await writeDay(
			"2026-05-09",
			[clone(base, { id: goodId, ts: "2026-05-09T00:00:00.000Z", uid: "u1" })],
			[
				"{not json",
				JSON.stringify({ bogus: true }),
				"   ",
				JSON.stringify({ patch: randomUUID(), status: "delivered", messages: [] }),
			],
		);
		const res = await store.query({ uid: "u1" });
		expect(res.some((e) => e.id === goodId)).toBe(true);
		expect(res.every((e) => typeof e.id === "string")).toBe(true);
	});
});

describe("aggregateDaily — 按客户端时区口径的按日聚合", () => {
	// 复用 query describe 的手写日文件套路。真实 record 落在「真·今天」的日文件,
	// 但注入的 now 固定在 2026-05-12,窗口外 → 不污染计数(顺带覆盖「窗口外丢弃」)。
	// UTC+8(北京)的 getTimezoneOffset() 口径
	const TZ_CN = -480;
	const now = new Date("2026-05-12T12:00:00.000Z"); // 北京 05-12 20:00

	it("零填充窗口 + 跨 UTC 日界归属 + 失败计数", async () => {
		const base = await store.record(baseInput());
		// A/B 同属北京 05-10:A 在 UTC 05-09 的日文件里(05-09T20:00Z = 北京 05-10 04:00)
		// —— UTC 日文件与本地日错位,必须跨文件归属才数得对。C 在窗口前一天,丢弃。
		await writeDay("2026-05-09", [
			clone(base, { ts: "2026-05-09T20:00:00.000Z" }),
			clone(base, { ts: "2026-05-09T10:00:00.000Z" }), // 北京 05-09 → 窗口外
		]);
		await writeDay("2026-05-10", [clone(base, { ts: "2026-05-10T10:00:00.000Z" })]);
		await writeDay("2026-05-12", [
			clone(base, { ts: "2026-05-12T03:00:00.000Z", kind: "live", status: "failed" }),
		]);

		const days = await store.aggregateDaily({ days: 3, tzOffsetMin: TZ_CN, now });
		expect(days.map((d) => d.d)).toEqual(["2026-05-10", "2026-05-11", "2026-05-12"]);
		expect(days[0]).toMatchObject({ total: 2, failures: 0 });
		expect(days[0]?.counts.dynamic).toBe(2);
		expect(days[1]).toMatchObject({ total: 0, failures: 0 }); // 空日仍出现(零填充)
		expect(days[2]).toMatchObject({ total: 1, failures: 1 });
		expect(days[2]?.counts.live).toBe(1);
		expect(days[2]?.counts.dynamic).toBe(0); // counts 全类零填充
	});

	it("回归:单日超过 query 的 500 条上限也全量计数(趋势图不再被截断)", async () => {
		const base = await store.record(baseInput());
		await writeDay(
			"2026-05-11",
			Array.from({ length: 505 }, () => clone(base, { ts: "2026-05-11T10:00:00.000Z" })),
		);
		const days = await store.aggregateDaily({ days: 3, tzOffsetMin: TZ_CN, now });
		expect(days[1]?.d).toBe("2026-05-11");
		expect(days[1]?.total).toBe(505);
	});

	it("无任何日文件:返回零填充窗口(默认 tzOffset=0,UTC 口径)", async () => {
		const days = await store.aggregateDaily({ days: 7, now });
		expect(days).toHaveLength(7);
		expect(days.every((d) => d.total === 0 && d.failures === 0)).toBe(true);
		expect(days[6]?.d).toBe("2026-05-12");
		expect(days[0]?.d).toBe("2026-05-06");
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
});
