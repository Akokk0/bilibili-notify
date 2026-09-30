/**
 * 历史落盘的字节(冻结)—— 换写盘方式(追加 / 原子写)时一个字节都不许变。
 *
 * 守的几件事:
 *   - 本体行 = `JSON.stringify(entry)`、补丁行 = `{"patch":…,"status":…,"messages":…}`:紧凑、一行一条、
 *     末尾换行;补丁行**键序 `patch` 打头**(读侧靠行首认它,见 `isPatchLine`)
 *   - 图片按原字节落在 `history/img/`(含非 UTF-8 的字节),目录里没有别的东西
 *   - `deleteRange` 改写日文件:留下的行原样、一行一条、末尾换行;窗里全删光 → 文件还在、0 字节;
 *     `history/` 里不留临时文件
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEntry, NotificationPayload } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createHistoryStore, type HistoryRecordInput, type HistoryStore } from "../store.js";

let dataDir: string;
let store: HistoryStore;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-hist-format-"));
	store = createHistoryStore({
		dataRoot: dataDir,
		bus: createNodeMessageBus(),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	});
});
afterEach(() => {
	vi.useRealTimers();
});

const SUB = randomUUID();
const T1 = randomUUID();
const OK = { ok: true, latencyMs: 5 };

const text = (t: string): NotificationPayload => ({ kind: "text", text: t });

function input(over: Partial<HistoryRecordInput> = {}): HistoryRecordInput {
	return {
		pushId: randomUUID(),
		kind: "dynamic",
		uid: "u1",
		subscriptionId: SUB,
		target: T1,
		messages: [{ payload: text("卡片"), role: "main", result: OK }],
		...over,
	};
}

const dayPath = (iso: string) => join(dataDir, "history", `${iso.slice(0, 10)}.jsonl`);

describe("历史落盘的字节", () => {
	it("本体行与补丁行:紧凑 JSON、一行一条、末尾换行,补丁行 patch 打头", async () => {
		const pushId = randomUUID();
		const entry = await store.record(input({ pushId }));
		await store.record(
			input({ pushId, messages: [{ payload: text("@全体"), role: "extra", result: OK }] }),
		);

		const raw = await readFile(dayPath(entry.ts), "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		expect(raw.endsWith("\n\n")).toBe(false);
		const lines = raw.slice(0, -1).split("\n");
		expect(lines).toHaveLength(2);
		// 本体行就是返回的那份 entry 序列化出来的。
		expect(lines[0]).toBe(JSON.stringify(entry));
		// 补丁行:键序 patch → status → messages,整行是紧凑 JSON(再序列化一遍字节不变)。
		expect(lines[1]?.startsWith(`{"patch":"${entry.id}","status":"delivered","messages":[`)).toBe(
			true,
		);
		for (const line of lines) expect(JSON.stringify(JSON.parse(line))).toBe(line);
	});

	it("图片按原字节落盘(含非 UTF-8 字节),img 目录里只有它自己", async () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
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
		const ref = entry.messages[0]?.payload.imageRef;
		expect(ref).toBe(`${entry.id}-0.png`);
		const onDisk = await readFile(join(store.imageDir(), ref as string));
		expect(onDisk.equals(bytes)).toBe(true);
		expect(await readdir(store.imageDir())).toEqual([ref]);
	});

	it("composite 里的第一张图按原字节落盘,后面的不写", async () => {
		const first = Buffer.from([0x00, 0xff, 0x10, 0x20]);
		const second = Buffer.from([0x01, 0x02]);
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
		const ref = entry.messages[0]?.payload.imageRef as string;
		expect(ref.endsWith(".webp")).toBe(true);
		expect((await readFile(join(store.imageDir(), ref))).equals(first)).toBe(true);
		expect(await readdir(store.imageDir())).toEqual([ref]);
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

		expect(await readFile(dayPath(before.ts), "utf8")).toBe(
			`${JSON.stringify(before)}\n${JSON.stringify(after)}\n`,
		);
		expect((await readdir(join(dataDir, "history"))).sort()).toEqual(["2026-09-06.jsonl", "img"]);
	});

	it("窗里全删光 → 日文件还在、0 字节", async () => {
		vi.useFakeTimers();
		const row = await at("2026-09-06T08:01:00.000Z");
		await at("2026-09-06T08:02:00.000Z");

		expect(await store.deleteRange({ fromMs, toMs })).toBe(2);

		expect((await stat(dayPath(row.ts))).size).toBe(0);
		expect((await readdir(join(dataDir, "history"))).sort()).toEqual(["2026-09-06.jsonl", "img"]);
	});
});
