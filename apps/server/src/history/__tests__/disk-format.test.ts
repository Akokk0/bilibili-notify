/**
 * 历史落盘的字节(冻结)—— 换写盘方式(追加 / 原子写)时一个字节都不许变。
 *
 * 守的几件事:
 *   - 本体行 = `JSON.stringify(entry)`、补丁行 = `{"rowId":…,"status":…,"messages":…}`:紧凑、一行一条、
 *     末尾换行;补丁行**键序 `rowId` 打头**(读侧靠行首认它,见 `isPatchLine`)
 *   - 图片按原字节存进图库 `images/<sha256>.<ext>`(含非 UTF-8 的字节),行里存的只是这个引用;`history/` 里不再有 `img/`
 *     (⑳d 有意改的:从前图落在 `history/img/<行 id>-<序号>.<ext>`)
 *   - `deleteRange` 改写日文件:留下的行原样、一行一条、末尾换行;窗里全删光 → 文件还在、0 字节;
 *     `history/` 里不留临时文件
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEntry, NotificationPayload } from "@bilibili-notify/internal";
import { fail, ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PNG_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { makeHistoryImages } from "../../__tests__/support/history-images.js";
import type { ImageWriter } from "../../images/image-store.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createHistoryStore, type HistoryStore, type NewHistoryEntry } from "../store.js";

let dataDir: string;
let store: HistoryStore;
let imageWriter: ImageWriter;

/** 往图库里放一张头像,回它的引用(头像快照抄的是别家存好的图)。 */
async function makeAvatar(): Promise<string> {
	const stored = await imageWriter.put(PNG_BYTES);
	if (!stored.ok) throw new Error(stored.message);
	return stored.ref;
}

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-hist-format-"));
	imageWriter = makeHistoryImages(dataDir).historyImages;
	store = createHistoryStore({
		dataRoot: dataDir,
		bus: createNodeMessageBus(),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		images: imageWriter,
	});
});
afterEach(() => {
	vi.useRealTimers();
});

const SUB = randomUUID();
const T1 = randomUUID();
const OK = ok({ latencyMs: 5 });

const text = (t: string): NotificationPayload => ({ kind: "text", text: t });

function input(over: Partial<NewHistoryEntry> = {}): NewHistoryEntry {
	return {
		pushId: randomUUID(),
		feature: "post",
		identity: { sourceKey: "bilibili", externalId: "u1" },
		subscriptionId: SUB,
		targetId: T1,
		messages: [{ payload: text("卡片"), role: "main", result: OK }],
		...over,
	};
}

const dayPath = (iso: string) => join(dataDir, "history", `${iso.slice(0, 10)}.jsonl`);

describe("历史落盘的字节", () => {
	it("本体行与补丁行:紧凑 JSON、一行一条、末尾换行,补丁行 rowId 打头", async () => {
		const pushId = randomUUID();
		const entry = await store.record(input({ pushId }));
		await store.record(
			input({ pushId, messages: [{ payload: text("@全体"), role: "extra", result: OK }] }),
		);

		const raw = await readFile(dayPath(entry.createdAt), "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		expect(raw.endsWith("\n\n")).toBe(false);
		const lines = raw.slice(0, -1).split("\n");
		expect(lines).toHaveLength(2);
		// 本体行就是返回的那份 entry 序列化出来的。
		expect(lines[0]).toBe(JSON.stringify(entry));
		// 补丁行:键序 rowId → status → messages,整行是紧凑 JSON(再序列化一遍字节不变)。
		expect(lines[1]?.startsWith(`{"rowId":"${entry.id}","status":"delivered","messages":[`)).toBe(
			true,
		);
		for (const line of lines) expect(JSON.stringify(JSON.parse(line))).toBe(line);
	});

	/**
	 * ⚠️ 3a-15 第一轮的中间态:投递结果在内存里已经是结果形状(`code` + `message`),盘上那一格还是
	 * 老的 `{ ok, err?, latencyMs }`。第二轮改历史行 schema 时这条跟着改。
	 */
	it("投递结果落盘还是老形状:失败只留原话(进 err)、耗时写 0,码不落盘;截流标记不落盘", async () => {
		const entry = await store.record(
			input({
				messages: [
					{
						payload: text("卡片"),
						role: "main",
						result: ok({ latencyMs: 5, isSynthetic: true as const }),
					},
					{
						payload: text("词云"),
						role: "extra",
						result: fail("unknown", "bot 说不行", { upstreamCode: 1200 }),
					},
					{ payload: text("总结"), role: "extra" },
				],
			}),
		);
		const raw = await readFile(dayPath(entry.createdAt), "utf8");
		const row = JSON.parse(raw.slice(0, -1)) as { messages: Array<{ result?: unknown }> };
		expect(JSON.stringify(row.messages.map((m) => m.result))).toBe(
			'[{"ok":true,"latencyMs":5},{"ok":false,"err":"bot 说不行","latencyMs":0},null]',
		);
		expect(raw).not.toContain("upstreamCode");
		expect(raw).not.toContain('"code"');
		expect(entry.status).toBe("partial");
	});

	it("图片按原字节存进图库(含非 UTF-8 字节),文件名 = 摘要 + 扩展名,images/ 里只有它自己、history/ 里没有 img", async () => {
		// 能过嗅探的 PNG 文件头,后面缀几个非 UTF-8 的字节。
		const bytes = Buffer.concat([PNG_BYTES.subarray(0, 8), Buffer.from([0xff, 0xfe, 0x00, 0x80])]);
		const entry: HistoryEntry = await store.record(
			input({
				messages: [
					{
						payload: { kind: "image", image: { buffer: bytes, mime: "image/png" } },
						role: "main",
						result: OK,
					},
				],
			}),
		);
		const ref = entry.messages[0]?.payload.image;
		expect(ref).toBe(`${createHash("sha256").update(bytes).digest("hex")}.png`);
		const onDisk = await readFile(join(dataDir, "images", ref as string));
		expect(onDisk.equals(bytes)).toBe(true);
		expect(await readdir(join(dataDir, "images"))).toEqual([ref]);
		expect(await readdir(join(dataDir, "history"))).not.toContain("img");
		// 盘上的本体行里,配图那一格叫 `image`、装的就是这个引用。
		const [line] = (await readFile(dayPath(entry.createdAt), "utf8")).split("\n");
		expect(JSON.parse(line as string).messages[0].payload).toEqual({
			kind: "image",
			text: "[卡片图]",
			image: ref,
		});
	});

	it("composite 里的第一张图按原字节存进图库,后面的不记", async () => {
		const webp = (tail: number[]) =>
			Buffer.concat([
				Buffer.from("RIFF"),
				Buffer.from([0, 0, 0, 0]),
				Buffer.from("WEBP"),
				Buffer.from(tail),
			]);
		const first = webp([0xff, 0x10, 0x20]);
		const second = webp([0x01, 0x02]);
		const entry = await store.record(
			input({
				messages: [
					{
						payload: {
							kind: "composite",
							segments: [
								{ type: "text", text: "前" },
								{ type: "image", buffer: first, mime: "image/webp" },
								{ type: "image", buffer: second, mime: "image/webp" },
							],
						},
						role: "main",
						result: OK,
					},
				],
			}),
		);
		const ref = entry.messages[0]?.payload.image as string;
		expect(ref.endsWith(".webp")).toBe(true);
		expect((await readFile(join(dataDir, "images", ref))).equals(first)).toBe(true);
		expect(await readdir(join(dataDir, "images"))).toEqual([ref]);
	});

	it("头像快照:引用存在 avatarSnapshot 里,键序紧跟 nameSnapshot(与迁移器改出来的行同一个排法)", async () => {
		const stored = await makeAvatar();
		const entry = await store.record(input({ nameSnapshot: "某UP", avatarSnapshot: stored }));
		const [line] = (await readFile(dayPath(entry.createdAt), "utf8")).split("\n");
		const row = JSON.parse(line as string) as Record<string, unknown>;
		expect(Object.keys(row).slice(-2)).toEqual(["nameSnapshot", "avatarSnapshot"]);
		expect(row.avatarSnapshot).toBe(stored);
		expect(row).not.toHaveProperty("uavatarSnapshot");
	});
});

describe("deleteRange 改写日文件的字节", () => {
	const fromMs = Date.parse("2026-09-06T08:00:00.000Z");
	const toMs = Date.parse("2026-09-06T08:10:00.000Z");

	async function at(iso: string): Promise<HistoryEntry> {
		vi.setSystemTime(new Date(iso));
		return store.record(input());
	}

	it("留下的行原样、一行一条、末尾换行;history 目录里不留临时文件", async () => {
		vi.useFakeTimers();
		const before = await at("2026-09-06T07:59:00.000Z");
		await at("2026-09-06T08:01:00.000Z");
		const after = await at("2026-09-06T08:11:00.000Z");

		await store.deleteRange({ fromMs, toMs });

		expect(await readFile(dayPath(before.createdAt), "utf8")).toBe(
			`${JSON.stringify(before)}\n${JSON.stringify(after)}\n`,
		);
		expect((await readdir(join(dataDir, "history"))).sort()).toEqual(["2026-09-06.jsonl"]);
	});

	it("窗里全删光 → 日文件还在、0 字节", async () => {
		vi.useFakeTimers();
		const row = await at("2026-09-06T08:01:00.000Z");
		await at("2026-09-06T08:02:00.000Z");

		expect(await store.deleteRange({ fromMs, toMs })).toBe(2);

		expect((await stat(dayPath(row.createdAt))).size).toBe(0);
		expect((await readdir(join(dataDir, "history"))).sort()).toEqual(["2026-09-06.jsonl"]);
	});
});
