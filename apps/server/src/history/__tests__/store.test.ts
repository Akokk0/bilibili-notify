/**
 * 单元测试 — `createHistoryStore` + listDayFiles / collectImageRefs(真实 tmpdir FS)。
 *
 * 守护契约(行模型本身见 record.test.ts):
 *   - record 的 payload reduce:text / image / composite 各自的文案与图片存进图库(按嗅探认格式,存不进的这一格缺着)
 *   - 头像快照:拓展行抄来的图库引用先续期,续不上不写这一格
 *   - schema 拒绝时抛错、logger.error、不写文件、不 emit
 *   - query:跨日 newest-first + 文件内倒序 + limit 钳制 + since / feature 过滤
 *   - 取尾巴的窗口:绕圈、坏行补读
 *   - readJsonl 跳过坏行 / schema 非法行
 *   - aggregateDaily:客户端时区日界、零填充、超 500 条全量
 *   - listDayFiles 仅匹配 YYYY-MM-DD.jsonl;collectImageRefs 数一份日文件里本体行与补丁行引用的图、不过 schema
 *
 * 注:HistoryEntrySchema 要求 subscriptionId / targetId 均为 uuid —— fixture 必须用
 * randomUUID(),否则 record 与 readJsonl 的 safeParse 全拒。
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEntry } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { JPEG_BYTES, PNG_BYTES, WEBP_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { distinctPng } from "../../__tests__/support/chat-images.js";
import { makeHistoryImages } from "../../__tests__/support/history-images.js";
import { storageWriteGate } from "../../__tests__/support/storage-write-gate.js";
import { IMAGE_MAX_BYTES, type ImageStore, type ImageWriter } from "../../images/image-store.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import {
	collectImageRefs,
	createHistoryStore,
	type HistoryStore,
	listDayFiles,
	type NewHistoryEntry,
} from "../store.js";

// 落盘函数前的闸默认敞开;只有「close」那组用例才 hold(见 support/storage-write-gate.ts)。
vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const { gateStorageWrites } = await import("../../__tests__/support/storage-write-gate.js");
	return gateStorageWrites(await importOriginal<typeof import("@bilibili-notify/storage")>());
});

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

let dataDir: string;
let bus: ReturnType<typeof createNodeMessageBus>;
let logger: ReturnType<typeof makeLogger>;
let store: HistoryStore;
let imageStore: ImageStore;
let historyImages: ImageWriter;
let recorded: HistoryEntry[];

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-hist-"));
	bus = createNodeMessageBus();
	logger = makeLogger();
	recorded = [];
	bus.on("history-recorded", (e) => recorded.push(e));
	({ imageStore, historyImages } = makeHistoryImages(dataDir));
	store = createHistoryStore({ dataRoot: dataDir, bus, logger, images: historyImages });
});
afterEach(() => {
	vi.restoreAllMocks();
});

const baseInput = (over: Partial<NewHistoryEntry> = {}): NewHistoryEntry => ({
	pushId: randomUUID(),
	feature: "post",
	identity: { sourceKey: "bilibili", externalId: "u1" },
	subscriptionId: randomUUID(),
	targetId: randomUUID(),
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
		const day = `${entry.createdAt.slice(0, 10)}.jsonl`;
		const raw = await readFile(join(dataDir, "history", day), "utf8");
		expect(raw.trim().split("\n")).toHaveLength(1);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.id).toBe(entry.id);
	});

	it("image payload:图片存进图库(引用 = 摘要 + 嗅探出的扩展名),image + caption→text", async () => {
		const entry = await store.record(
			baseInput({
				messages: [
					{
						payload: {
							kind: "image",
							image: { buffer: PNG_BYTES, mime: "image/png" },
							caption: "cap",
						},
						role: "main",
						result: { ok: true, latencyMs: 1 },
					},
				],
			}),
		);
		const image = only(entry).payload.image;
		expect(image).toMatch(/^[0-9a-f]{64}\.png$/);
		expect(only(entry).payload).toEqual({ kind: "image", text: "cap", image });
		const stored = await imageStore.read(image ?? "");
		expect(stored?.mime).toBe("image/png");
		expect(new Uint8Array(stored?.bytes ?? [])).toEqual(new Uint8Array(PNG_BYTES));
		// 图在图库里,历史自己不再有 img 目录。
		expect(await readdir(join(dataDir, "history"))).not.toContain("img");
		expect(await readdir(join(dataDir, "images"))).toEqual([image]);
	});

	it("扩展名按嗅探认,不信 payload 声明的 mime", async () => {
		const image = (mime: string, buffer: Buffer): NewHistoryEntry["messages"] => [
			{ payload: { kind: "image", image: { buffer, mime } }, role: "main" },
		];
		const webp = await store.record(baseInput({ messages: image("image/png", WEBP_BYTES) }));
		expect(only(webp).payload.image?.endsWith(".webp")).toBe(true);
		const jpeg = await store.record(
			baseInput({ messages: image("application/octet-stream", JPEG_BYTES) }),
		);
		expect(only(jpeg).payload.image?.endsWith(".jpg")).toBe(true);
	});

	it("过不了图库的图(不是图、超 8MB):这一格缺着、行照写、记一句 warn", async () => {
		const notAnImage = Buffer.from("<svg/>");
		const huge = Buffer.concat([PNG_BYTES, Buffer.alloc(IMAGE_MAX_BYTES)]);
		for (const buffer of [notAnImage, huge]) {
			logger.warn.mockClear();
			const entry = await store.record(
				baseInput({
					messages: [
						{
							payload: { kind: "image", image: { buffer, mime: "image/png" }, caption: "没图" },
							role: "main",
							result: { ok: true, latencyMs: 1 },
						},
					],
				}),
			);
			expect(only(entry).payload).toEqual({ kind: "image", text: "没图", image: undefined });
			expect(entry.status).toBe("delivered");
			expect(logger.warn).toHaveBeenCalledTimes(1);
			expect(logger.warn.mock.calls[0]?.[0]).toContain("配图未通过图库校验");
			// 落盘的那一行也没有 image 格,读得回来。
			const [row] = await store.query({ limit: 1 });
			expect(row?.messages[0]?.payload).toEqual({ kind: "image", text: "没图" });
		}
		expect(await readdir(join(dataDir, "images")).catch(() => [])).toEqual([]);
	});

	it("同一张图再记一次回同一个引用,图库里还是一个文件(重推每试一次不再多写一份)", async () => {
		const messages: NewHistoryEntry["messages"] = [
			{ payload: { kind: "image", image: { buffer: PNG_BYTES, mime: "image/png" } }, role: "main" },
		];
		const a = await store.record(baseInput({ messages }));
		const b = await store.record(baseInput({ messages }));
		expect(only(b).payload.image).toBe(only(a).payload.image);
		expect(await readdir(join(dataDir, "images"))).toHaveLength(1);
	});

	it("composite:text/link 拼成 \\n 文本,仅保留首张图片", async () => {
		const entry = await store.record(
			baseInput({
				messages: [
					{
						payload: {
							kind: "composite",
							segments: [
								{ kind: "text", text: "line1" },
								{ kind: "image", buffer: JPEG_BYTES, mime: "image/jpeg" },
								{ kind: "image", buffer: PNG_BYTES, mime: "image/png" },
								{ kind: "link", href: "https://x", title: "T" },
								{ kind: "link", href: "https://y" },
							],
						},
						role: "main",
						result: { ok: true, latencyMs: 1 },
					},
				],
			}),
		);
		const image = only(entry).payload.image;
		expect(only(entry).payload).toEqual({
			kind: "composite",
			text: "line1\nT https://x\nhttps://y",
			image,
		});
		expect(image?.endsWith(".jpg")).toBe(true);
		// 第二张图历史不记(重推原件里每一张都在)。
		expect(await readdir(join(dataDir, "images"))).toEqual([image]);
	});

	it("composite 的第一张图过不了图库:这一格缺着,后面的图不顶上", async () => {
		const entry = await store.record(
			baseInput({
				messages: [
					{
						payload: {
							kind: "composite",
							segments: [
								{ kind: "image", buffer: Buffer.from("<svg/>"), mime: "image/png" },
								{ kind: "image", buffer: PNG_BYTES, mime: "image/png" },
							],
						},
						role: "main",
					},
				],
			}),
		);
		expect(only(entry).payload.image).toBeUndefined();
		expect(await readdir(join(dataDir, "images")).catch(() => [])).toEqual([]);
	});

	it("composite at-all 段 → text 写出「@全体」而非空;与 text 段按段序拼接", async () => {
		const alone = await store.record(
			baseInput({
				feature: "liveStart",
				messages: [
					{ payload: { kind: "composite", segments: [{ kind: "at-all" }] }, role: "extra" },
				],
			}),
		);
		expect(only(alone).payload.text).toBe("@全体");
		const mixed = await store.record(
			baseInput({
				feature: "liveStart",
				messages: [
					{
						payload: {
							kind: "composite",
							segments: [{ kind: "at-all" }, { kind: "text", text: "开播啦" }],
						},
						role: "main",
					},
				],
			}),
		);
		expect(only(mixed).payload.text).toBe("@全体\n开播啦");
	});

	it("image-group → 一句「[图集 N 张]」摘要", async () => {
		const entry = await store.record(
			baseInput({
				messages: [
					{
						payload: {
							kind: "image-group",
							images: [{ url: "https://a" }, { url: "https://b" }],
							mergeForward: true,
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
		await expect(store.record(baseInput({ feature: "not-a-feature" as never }))).rejects.toThrow(
			"history entry schema validation failed",
		);
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(recorded).toHaveLength(0);
		const day = await readdir(join(dataDir, "history"));
		expect(day.filter((f) => f.endsWith(".jsonl"))).toHaveLength(0);
	});
});

// 用一次真实 record 拿 schema 合法样板,克隆出受控 createdAt/feature/identity/id 的 fixture 手写进指定
// 日文件 —— record 的 createdAt 不可控,手写日文件才能确定性测排序与 since。id 必须是 uuid,
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
		const a = clone(base, { id: aId, createdAt: "2026-05-10T01:00:00.000Z" });
		const b = clone(base, { id: bId, createdAt: "2026-05-10T02:00:00.000Z" });
		const c = clone(base, { id: cId, createdAt: "2026-05-12T01:00:00.000Z" });
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
				createdAt: `2026-05-09T00:${String(i).padStart(2, "0")}:00.000Z`,
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
				createdAt: `2026-05-10T00:${String(i).padStart(2, "0")}:00.000Z`,
			}),
		);
		await writeDay("2026-05-10", today, ["{truncated", JSON.stringify({ bogus: true }), "{}"]);
		const older = clone(base, { id: randomUUID(), createdAt: "2026-05-09T00:00:00.000Z" });
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

	it("since 过滤:createdAt <= since 的丢弃", async () => {
		const base = await store.record(baseInput());
		const oldId = randomUUID();
		const newId = randomUUID();
		await writeDay("2026-05-10", [
			clone(base, { id: oldId, createdAt: "2026-05-10T00:00:00.000Z" }),
			clone(base, { id: newId, createdAt: "2026-05-10T10:00:00.000Z" }),
		]);
		const ids = (await store.query({ since: "2026-05-10T05:00:00.000Z" })).map((e) => e.id);
		expect(ids).toContain(newId);
		expect(ids).not.toContain(oldId);
	});

	it("feature 精确过滤", async () => {
		const base = await store.record(baseInput());
		const dId = randomUUID();
		const lId = randomUUID();
		await writeDay("2026-05-11", [
			clone(base, { id: dId, feature: "post" }),
			clone(base, { id: lId, feature: "liveStart" }),
		]);
		expect((await store.query({ feature: "liveStart" })).map((e) => e.id)).toEqual([lId]);
	});

	it("坏 jsonl 行 / schema 非法行 / 认不到亲的补丁行被跳过", async () => {
		const base = await store.record(baseInput());
		const goodId = randomUUID();
		await writeDay(
			"2026-05-09",
			[
				clone(base, {
					id: goodId,
					createdAt: "2026-05-09T00:00:00.000Z",
					identity: { sourceKey: "bilibili", externalId: "u1" },
				}),
			],
			[
				"{not json",
				JSON.stringify({ bogus: true }),
				"   ",
				JSON.stringify({ rowId: randomUUID(), status: "delivered", messages: [] }),
			],
		);
		const res = await store.query({});
		expect(res.some((e) => e.id === goodId)).toBe(true);
		expect(res.every((e) => typeof e.id === "string")).toBe(true);
	});

	it("还带着 0.x 的 `kind`、没有 `feature` 的行读不进来(迁移之前的形状,历史仓只认现在的)", async () => {
		const base = await store.record(baseInput());
		const { feature: _gone, ...rest } = base;
		const stale = randomUUID();
		await writeDay(
			"2026-05-09",
			[],
			[
				JSON.stringify({
					...rest,
					id: stale,
					createdAt: "2026-05-09T00:00:00.000Z",
					kind: "dynamic",
				}),
			],
		);
		expect((await store.query({})).map((e) => e.id)).not.toContain(stale);
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
			clone(base, { createdAt: "2026-05-09T20:00:00.000Z" }),
			clone(base, { createdAt: "2026-05-09T10:00:00.000Z" }), // 北京 05-09 → 窗口外
		]);
		await writeDay("2026-05-10", [clone(base, { createdAt: "2026-05-10T10:00:00.000Z" })]);
		await writeDay("2026-05-12", [
			clone(base, {
				createdAt: "2026-05-12T03:00:00.000Z",
				feature: "liveStart",
				status: "failed",
			}),
		]);

		const days = await store.aggregateDaily({ days: 3, tzOffsetMin: TZ_CN, now });
		expect(days.map((d) => d.d)).toEqual(["2026-05-10", "2026-05-11", "2026-05-12"]);
		expect(days[0]).toMatchObject({ total: 2, failures: 0 });
		expect(days[0]?.counts.post).toBe(2);
		expect(days[1]).toMatchObject({ total: 0, failures: 0 }); // 空日仍出现(零填充)
		expect(days[2]).toMatchObject({ total: 1, failures: 1 });
		expect(days[2]?.counts.liveStart).toBe(1);
		expect(days[2]?.counts.post).toBe(0); // counts 全键零填充
	});

	it("回归:单日超过 query 的 500 条上限也全量计数(趋势图不再被截断)", async () => {
		const base = await store.record(baseInput());
		await writeDay(
			"2026-05-11",
			Array.from({ length: 505 }, () => clone(base, { createdAt: "2026-05-11T10:00:00.000Z" })),
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

describe("listDayFiles / collectImageRefs", () => {
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

	it("collectImageRefs:本体行的配图、补丁行的配图、头像快照都数,日文件(文字)原样", async () => {
		const bodyImage = await putImage(distinctPng(1));
		const patchImage = await putImage(distinctPng(2));
		const avatar = await putImage(distinctPng(3));
		const entry = await store.record(
			baseInput({
				avatarSnapshot: avatar,
				messages: [
					{
						payload: { kind: "image", image: { buffer: distinctPng(1), mime: "image/png" } },
						role: "main",
					},
				],
			}),
		);
		await store.appendToRow(entry.id, entry.createdAt, [
			{
				payload: { kind: "image", image: { buffer: distinctPng(2), mime: "image/png" } },
				role: "extra",
				repushOf: 0,
			},
		]);
		const file = join(dataDir, "history", `${entry.createdAt.slice(0, 10)}.jsonl`);
		const before = await readFile(file, "utf8");

		expect((await collectImageRefs(file)).sort()).toEqual([bodyImage, patchImage, avatar].sort());
		expect(await readFile(file, "utf8")).toBe(before);
	});

	it("collectImageRefs 宁多勿少:一行因为别的格不合 schema 被读侧跳过,它引用的图照样数;形状不对的字符串不数", async () => {
		const ref = await putImage(distinctPng(4));
		await mkdir(join(dataDir, "history"), { recursive: true });
		const file = join(dataDir, "history", "2026-05-01.jsonl");
		await writeFile(
			file,
			`${JSON.stringify({
				id: "不是 uuid",
				messages: [{ payload: { kind: "image", image: ref } }, { payload: { image: "../x.png" } }],
				avatarSnapshot: "https://i0.hdslb.com/bfs/face/x.jpg",
			})}\n{坏行\n`,
		);
		expect(await collectImageRefs(file)).toEqual([ref]);
	});

	it("collectImageRefs:文件不在 → 空;读不动(不是「不在」)→ 抛,图库清扫这一轮一张不删", async () => {
		expect(await collectImageRefs(join(dataDir, "history", "2026-05-02.jsonl"))).toEqual([]);
		await ensureHistoryDir();
		// 把日文件的位置换成一个目录:读它是 EISDIR,不是「不在」。
		await mkdir(join(dataDir, "history", "2026-05-03.jsonl"));
		await expect(collectImageRefs(join(dataDir, "history", "2026-05-03.jsonl"))).rejects.toThrow();
	});
});

describe("头像快照 — 抄来的图库引用,写行前先续期", () => {
	it("引用的图还在:写进行里,图的修改时间刷新(宽限期重新算)", async () => {
		const avatar = await putImage(distinctPng(5));
		const path = join(dataDir, "images", avatar);
		const old = new Date("2020-01-01T00:00:00Z");
		await utimes(path, old, old);

		const entry = await store.record(baseInput({ avatarSnapshot: avatar }));

		expect(entry.avatarSnapshot).toBe(avatar);
		expect((await store.query({ limit: 1 }))[0]?.avatarSnapshot).toBe(avatar);
		expect((await stat(path)).mtimeMs).toBeGreaterThan(old.getTime());
	});

	it("图已经不在了(续期回 false):这一格不写,行照写", async () => {
		const gone = `${"c".repeat(64)}.png`;
		const entry = await store.record(baseInput({ avatarSnapshot: gone }));
		expect(entry.avatarSnapshot).toBeUndefined();
		expect((await store.query({ limit: 1 }))[0]?.avatarSnapshot).toBeUndefined();
		expect(entry.status).toBe("delivered");
	});

	it("续期出错(盘上读不动)也不丢这一行:不带头像、记一句 warn", async () => {
		const broken: ImageWriter = {
			put: historyImages.put,
			keep: async () => {
				throw new Error("EIO");
			},
		};
		const withBroken = createHistoryStore({ dataRoot: dataDir, bus, logger, images: broken });
		const entry = await withBroken.record(baseInput({ avatarSnapshot: `${"d".repeat(64)}.png` }));
		expect(entry.avatarSnapshot).toBeUndefined();
		expect(logger.warn).toHaveBeenCalled();
	});

	it("没给头像快照(B 站行):这一格缺着,不碰图库", async () => {
		const entry = await store.record(baseInput());
		expect(entry.avatarSnapshot).toBeUndefined();
		expect((await store.query({ limit: 1 }))[0]).not.toHaveProperty("avatarSnapshot");
	});
});

async function putImage(bytes: Uint8Array): Promise<string> {
	const stored = await historyImages.put(bytes);
	if (!stored.ok) throw new Error(stored.message);
	return stored.ref;
}

describe("close — 关停时等在途的写、关门后拒写", () => {
	beforeEach(() => storageWriteGate.reset());
	afterEach(() => storageWriteGate.reset());

	const dayRows = async (entry: HistoryEntry): Promise<string[]> =>
		(await readFile(join(dataDir, "history", `${entry.createdAt.slice(0, 10)}.jsonl`), "utf8"))
			.split("\n")
			.filter((line) => line.trim() !== "");

	it("close 等在途的写落盘", async () => {
		storageWriteGate.hold();
		const recording = store.record(baseInput());
		await storageWriteGate.arrived();

		let closed = false;
		const closing = store.close().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(closed).toBe(false);

		storageWriteGate.release();
		await closing;
		const entry = await recording;
		expect(await dayRows(entry)).toHaveLength(1);
	});

	it("close 之后的写被拒且不碰盘", async () => {
		const entry = await store.record(baseInput());
		const before = await dayRows(entry);
		await store.close();
		const writesAtClose = storageWriteGate.writes;

		const closed = { code: "queue_closed" };
		await expect(store.record(baseInput())).rejects.toMatchObject(closed);
		await expect(
			store.appendToRow(entry.id, entry.createdAt, [
				{
					payload: { kind: "text", text: "补" },
					role: "main",
					result: { ok: true, latencyMs: 1 },
					repushOf: 0,
				},
			]),
		).rejects.toMatchObject(closed);
		await expect(store.deleteRange({ fromMs: 0, toMs: Date.now() + 1000 })).rejects.toMatchObject(
			closed,
		);

		expect(storageWriteGate.writes).toBe(writesAtClose);
		expect(await dayRows(entry)).toEqual(before);
		expect(recorded).toHaveLength(1);
	});
});

describe("record — 图库写盘失败(环境的事)", () => {
	it("图库的目录建不出来:record 整个拒、原因带着,行不写、不 emit;不是「这一格缺着」那条 warn", async () => {
		// `<dataRoot>/images` 是个普通文件:图库往里写必挂(ENOTDIR)。
		await writeFile(join(dataDir, "images"), "挡路");

		await expect(
			store.record(
				baseInput({
					messages: [
						{
							payload: { kind: "image", image: { buffer: PNG_BYTES, mime: "image/png" } },
							role: "main",
							result: { ok: true, latencyMs: 1 },
						},
					],
				}),
			),
		).rejects.toThrow(/ENOTDIR/);

		expect(await store.query({ limit: 10 })).toEqual([]);
		expect(recorded).toEqual([]);
		expect(logger.warn).not.toHaveBeenCalled();
	});
});
