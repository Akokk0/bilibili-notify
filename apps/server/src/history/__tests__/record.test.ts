/**
 * 推送历史的新模型:**一行 = 一次推送 × 一个目标**,行里是消息列表与逐条结果。
 *
 * 守的契约:
 *   - 首次 `record` 建行、emit `history-recorded`;同 pushId + 同目标再来就往这一行追加消息、
 *     重算状态、emit `history-updated`(不再 recorded)
 *   - jsonl 仍 append-only:追加写的是**补丁行**,读回来按行 id 合并
 *   - 四态:全到 = delivered;本体到了附加没到 = partial;本体没到 = failed;`target: null` = no-targets
 *   - 无目标行消息照存、图照存进图库,只是没有结果
 *   - 按日聚合:total 数行、不计无目标;failures = failed + partial;counts 按 8 把特性键
 *   - 被静音 / 免扰挡下的行:盘上 `status: "silenced"`、每条消息 `isSilenced: true`、没有 `result`;
 *     追加附加项后仍是 silenced;不进按日聚合,补发成功后才计入它建行那天
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEntry, NotificationPayload } from "@bilibili-notify/internal";
import { fail, ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { distinctPng } from "../../__tests__/support/chat-images.js";
import { makeHistoryImages } from "../../__tests__/support/history-images.js";
import type { ImageStore, ImageWriter } from "../../images/image-store.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createHistoryStore, type HistoryStore, type NewHistoryEntry } from "../store.js";

let dataDir: string;
let bus: ReturnType<typeof createNodeMessageBus>;
let store: HistoryStore;
let imageStore: ImageStore;
let historyImages: ImageWriter;
let recorded: HistoryEntry[];
let updated: HistoryEntry[];

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-hist-"));
	bus = createNodeMessageBus();
	recorded = [];
	updated = [];
	bus.on("history-recorded", (e) => recorded.push(e));
	bus.on("history-updated", (e) => updated.push(e));
	const images = makeHistoryImages(dataDir);
	imageStore = images.imageStore;
	historyImages = images.historyImages;
	store = createHistoryStore({
		dataRoot: dataDir,
		bus,
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		images: images.historyImages,
	});
});
afterEach(() => {
	vi.restoreAllMocks();
});

const SUB = randomUUID();
const T1 = randomUUID();
const T2 = randomUUID();
const OK = ok({ latencyMs: 5 });
const FAIL = fail("unavailable", "boom");

function text(t: string): NotificationPayload {
	return { kind: "text", text: t };
}

function input(over: Partial<NewHistoryEntry> = {}): NewHistoryEntry {
	return {
		pushId: randomUUID(),
		feature: "post",
		identity: { sourceKey: "bilibili", externalId: "u1" },
		subscriptionId: SUB,
		targetId: T1,
		messages: [{ payload: text("卡片"), role: "main", result: OK }],
		nameSnapshot: "某UP",
		...over,
	};
}

async function dayLines(entry: HistoryEntry): Promise<string[]> {
	const raw = await readFile(
		join(dataDir, "history", `${entry.createdAt.slice(0, 10)}.jsonl`),
		"utf8",
	);
	return raw.trim().split("\n");
}

describe("record — 建行与追加", () => {
	it("首次 record 建行:status delivered、消息带 role 与结果、emit history-recorded", async () => {
		const pushId = randomUUID();
		const entry = await store.record(input({ pushId }));
		expect(entry).toMatchObject({
			pushId,
			feature: "post",
			identity: { sourceKey: "bilibili", externalId: "u1" },
			subscriptionId: SUB,
			targetId: T1,
			status: "delivered",
			nameSnapshot: "某UP",
		});
		expect(entry.messages).toEqual([
			{ payload: { kind: "text", text: "卡片" }, role: "main", result: OK },
		]);
		expect(recorded.map((e) => e.id)).toEqual([entry.id]);
		expect(updated).toHaveLength(0);
	});

	it("同 pushId 同目标再 record → 追加消息、重算状态、emit history-updated;盘上是补丁行,读回是合并后的一行", async () => {
		const pushId = randomUUID();
		const first = await store.record(input({ pushId }));
		const merged = await store.record(
			input({
				pushId,
				messages: [{ payload: text("词云"), role: "extra", result: FAIL }],
			}),
		);
		expect(merged.id).toBe(first.id);
		expect(merged.status).toBe("partial");
		expect(merged.messages.map((m) => [m.payload.text, m.role, m.result?.ok])).toEqual([
			["卡片", "main", true],
			["词云", "extra", false],
		]);
		expect(recorded).toHaveLength(1);
		expect(updated.map((e) => e.id)).toEqual([first.id]);
		expect(updated[0]?.messages).toHaveLength(2);

		const lines = await dayLines(first);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1] as string)).toMatchObject({ rowId: first.id, status: "partial" });

		const [read] = await store.query({ limit: 10 });
		expect(read).toEqual(merged);
	});

	it("同 pushId 不同目标 → 各自一行,互不影响", async () => {
		const pushId = randomUUID();
		const a = await store.record(input({ pushId, targetId: T1 }));
		const b = await store.record(
			input({
				pushId,
				targetId: T2,
				messages: [{ payload: text("x"), role: "main", result: FAIL }],
			}),
		);
		expect(a.id).not.toBe(b.id);
		expect(a.status).toBe("delivered");
		expect(b.status).toBe("failed");
		expect((await store.query({})).map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
	});

	// ADR-0019 决策 73:拓展行的身份是 `identity`(来源键 = 拓展 id + 外部 id),和 B 站行同一种形状。
	// 这一层把它原样抄进行里,漏抄的话写进去的就是一行「谁也不是」的行。
	it("拓展行:来源键(拓展 id)与外部 id 落盘、读得回来", async () => {
		const entry = await store.record(
			input({
				identity: { sourceKey: "douyin", externalId: "123" },
				nameSnapshot: "某抖音号",
			}),
		);
		expect(entry.identity).toEqual({ sourceKey: "douyin", externalId: "123" });
		const [line] = await dayLines(entry);
		const onDisk = JSON.parse(line as string);
		expect(onDisk).toMatchObject({ identity: { sourceKey: "douyin", externalId: "123" } });
		expect(onDisk).not.toHaveProperty("uid");
		expect(onDisk).not.toHaveProperty("extensionId");
		const [read] = await store.query({});
		expect(read).toMatchObject({
			identity: { sourceKey: "douyin", externalId: "123" },
			nameSnapshot: "某抖音号",
		});
	});

	// 盘上的键序就是迁移器(`migration/history.ts`)把老行改出来的键序 —— 两头是同一个形状,不是两份各写各的。
	it("行的键序:id, pushId, createdAt, feature, identity, subscriptionId, targetId, status, messages, 快照", async () => {
		const stored = await historyImages.put(distinctPng(9));
		if (!stored.ok) throw new Error(stored.message);
		const entry = await store.record(input({ avatarSnapshot: stored.ref }));
		const [line] = await dayLines(entry);
		expect(Object.keys(JSON.parse(line as string))).toEqual([
			"id",
			"pushId",
			"createdAt",
			"feature",
			"identity",
			"subscriptionId",
			"targetId",
			"status",
			"messages",
			"nameSnapshot",
			"avatarSnapshot",
		]);
	});
});

describe("record — 四态", () => {
	it.each<[string, NewHistoryEntry["messages"], HistoryEntry["status"]]>([
		[
			"全到 → delivered",
			[
				{ payload: text("a"), role: "main", result: OK },
				{ payload: text("b"), role: "extra", result: OK },
			],
			"delivered",
		],
		[
			"本体到了、附加没到 → partial",
			[
				{ payload: text("a"), role: "main", result: OK },
				{ payload: text("b"), role: "extra", result: FAIL },
			],
			"partial",
		],
		[
			"本体没到 → failed(附加就算到了也不算)",
			[
				{ payload: text("a"), role: "main", result: FAIL },
				{ payload: text("b"), role: "extra", result: OK },
			],
			"failed",
		],
		[
			"本体分两条、第二条失败 → partial(第一条到了)",
			[
				{ payload: text("a"), role: "main", result: OK },
				{ payload: text("b"), role: "main", result: FAIL },
			],
			"partial",
		],
		[
			"只有附加项、还失败了(@全体 先到) → failed,等本体来了再算",
			[{ payload: text("@全体"), role: "extra", result: FAIL }],
			"failed",
		],
		[
			"有目标却一条结果都没有 → failed(没发出去就不是「全到了」)",
			[{ payload: text("a"), role: "main" }],
			"failed",
		],
	])("%s", async (_name, messages, status) => {
		const entry = await store.record(input({ messages }));
		expect(entry.status).toBe(status);
	});

	it("target: null → no-targets;消息照存、没有结果;后续追加照常", async () => {
		const pushId = randomUUID();
		const entry = await store.record(
			input({ pushId, targetId: null, messages: [{ payload: text("卡片"), role: "main" }] }),
		);
		expect(entry.status).toBe("no-targets");
		expect(entry.targetId).toBeNull();
		expect(entry.messages).toEqual([{ payload: { kind: "text", text: "卡片" }, role: "main" }]);
		const merged = await store.record(
			input({ pushId, targetId: null, messages: [{ payload: text("总结"), role: "extra" }] }),
		);
		expect(merged.id).toBe(entry.id);
		expect(merged.status).toBe("no-targets");
		expect(merged.messages).toHaveLength(2);
	});
});

describe("record — 图存进图库", () => {
	/** 第 `n` 张互不相同的真 PNG(图库按内容起名,字节一样就是同一张图)。 */
	const png = (n: number): NotificationPayload => ({
		kind: "image",
		image: { buffer: distinctPng(n), mime: "image/png" },
	});

	it("多条消息各自存进图库,补丁那条也存;内容不同引用不同,文件在 images/ 里", async () => {
		const pushId = randomUUID();
		await store.record(
			input({
				pushId,
				messages: [
					{ payload: png(1), role: "main", result: OK },
					{ payload: png(2), role: "main", result: OK },
				],
			}),
		);
		const merged = await store.record(
			input({ pushId, messages: [{ payload: png(3), role: "extra", result: OK }] }),
		);
		const refs = merged.messages.map((m) => m.payload.image);
		expect(new Set(refs).size).toBe(3);
		const files = (await readdir(join(dataDir, "images"))).sort();
		expect(files).toEqual([...refs].sort());
		const third = await imageStore.read(refs[2] ?? "");
		expect(new Uint8Array(third?.bytes ?? [])).toEqual(new Uint8Array(distinctPng(3)));
	});

	it("无目标行的图也存进图库", async () => {
		const entry = await store.record(
			input({ targetId: null, messages: [{ payload: png(4), role: "main" }] }),
		);
		expect(entry.messages[0]?.payload.image).toBeDefined();
		expect(await readdir(join(dataDir, "images"))).toHaveLength(1);
	});

	it("无 caption 的纯图:下播的附加项写「[弹幕词云]」,其余写「[卡片图]」", async () => {
		const wc = await store.record(
			input({ feature: "liveEnd", messages: [{ payload: png(5), role: "extra", result: OK }] }),
		);
		expect(wc.messages[0]?.payload.text).toBe("[弹幕词云]");
		const card = await store.record(
			input({ feature: "liveEnd", messages: [{ payload: png(6), role: "main", result: OK }] }),
		);
		expect(card.messages[0]?.payload.text).toBe("[卡片图]");
	});
});

describe("query — feature 过滤与补丁行", () => {
	it("feature 过滤认特性键", async () => {
		const a = await store.record(input({ feature: "liveEnd" }));
		await store.record(input({ feature: "superchat" }));
		expect((await store.query({ feature: "liveEnd" })).map((e) => e.id)).toEqual([a.id]);
	});

	it("补丁行不占 limit:取尾巴按行(row)数", async () => {
		// 三行,每行两个补丁 —— 尾窗按原始行数取会只剩最后一行半。
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const pushId = randomUUID();
			const e = await store.record(input({ pushId }));
			await store.record(
				input({ pushId, messages: [{ payload: text("a"), role: "extra", result: OK }] }),
			);
			await store.record(
				input({ pushId, messages: [{ payload: text("b"), role: "extra", result: OK }] }),
			);
			ids.push(e.id);
		}
		const got = await store.query({ limit: 2 });
		expect(got.map((e) => e.id)).toEqual([ids[2], ids[1]]);
		expect(got.every((e) => e.messages.length === 3)).toBe(true);
	});
});

describe("aggregateDaily — 新口径", () => {
	const TZ = 0;
	it("total 数行、不计无目标;failures = failed + partial;counts 按类", async () => {
		const now = new Date();
		const pushId = randomUUID();
		await store.record(input({ pushId, targetId: T1 })); // delivered
		await store.record(input({ pushId, targetId: T2 })); // delivered(同一次推送,另一个目标也算一行)
		await store.record(
			input({ feature: "liveEnd", messages: [{ payload: text("x"), role: "main", result: FAIL }] }),
		); // failed
		const p = await store.record(input({ feature: "superchat" }));
		await store.record(
			input({
				pushId: p.pushId,
				feature: "superchat",
				messages: [{ payload: text("y"), role: "extra", result: FAIL }],
			}),
		); // → partial
		await store.record(
			input({
				feature: "membership",
				targetId: null,
				messages: [{ payload: text("z"), role: "main" }],
			}),
		); // no-targets

		const [today] = (await store.aggregateDaily({ days: 1, tzOffsetMin: TZ, now })) ?? [];
		expect(today).toMatchObject({ total: 4, failures: 2 });
		expect(today?.counts).toMatchObject({ post: 2, liveEnd: 1, superchat: 1, membership: 0 });
		expect(Object.keys(today?.counts ?? {}).sort()).toEqual(
			[
				"post",
				"liveStart",
				"liveStreaming",
				"liveEnd",
				"membership",
				"superchat",
				"specialDanmaku",
				"specialUserEnter",
			].sort(),
		);
	});
});

/**
 * 被静音 / 免扰挡下的推送照记(ADR-0021 决策 34 的 🔗,10-08)。🔴 历史的 schema 不是 strict ——
 * 认不得的格会被悄悄剥掉、照样写得进去,所以这里**读盘上 JSON 原文**断言,不看 `record` 的返回值。
 */
describe("record — 被静音 / 免扰挡下的行", () => {
	const silencedMessage = (t: string, role: "main" | "extra" = "main") => ({
		payload: text(t),
		role,
		isSilenced: true as const,
	});

	it("盘上原文:status 是 silenced,每条消息带 isSilenced: true、没有 result", async () => {
		const entry = await store.record(
			input({ messages: [silencedMessage("卡片"), silencedMessage("第二条")] }),
		);
		const [line] = await dayLines(entry);
		const onDisk = JSON.parse(line as string);
		expect(onDisk.status).toBe("silenced");
		expect(onDisk.messages).toEqual([
			{ payload: { kind: "text", text: "卡片" }, role: "main", isSilenced: true },
			{ payload: { kind: "text", text: "第二条" }, role: "main", isSilenced: true },
		]);
		expect(recorded.map((e) => e.status)).toEqual(["silenced"]);
	});

	it("被挡的行追加附加项(词云、总结)后仍是 silenced,不被重算成 failed;补丁行原文同样带 isSilenced", async () => {
		const pushId = randomUUID();
		const first = await store.record(
			input({ pushId, feature: "liveEnd", messages: [silencedMessage("下播卡")] }),
		);
		const merged = await store.record(
			input({ pushId, feature: "liveEnd", messages: [silencedMessage("词云", "extra")] }),
		);
		expect(merged.id).toBe(first.id);
		expect(merged.status).toBe("silenced");
		const lines = await dayLines(first);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1] as string)).toEqual({
			rowId: first.id,
			status: "silenced",
			messages: [{ payload: { kind: "text", text: "词云" }, role: "extra", isSilenced: true }],
		});
		const [row] = await store.query({});
		expect(row?.status).toBe("silenced");
		expect(row?.messages.map((m) => m.isSilenced)).toEqual([true, true]);
	});

	it("图片类的消息照样存进图库(补发与面板都要它)", async () => {
		const entry = await store.record(
			input({
				messages: [
					{
						payload: { kind: "image", image: { buffer: distinctPng(7), mime: "image/png" } },
						role: "main",
						isSilenced: true,
					},
				],
			}),
		);
		const ref = entry.messages[0]?.payload.image;
		expect(ref).toBeDefined();
		expect(await readdir(join(dataDir, "images"))).toEqual([ref]);
	});

	it("不进按日聚合(今日推送 / 趋势 / 今日失败);补发成功后计入它建行那天", async () => {
		const entry = await store.record(input({ messages: [silencedMessage("卡片")] }));
		await store.record(input({ targetId: T2 }));
		const before = (await store.aggregateDaily({ days: 1 })).at(-1);
		expect(before).toMatchObject({ total: 1, failures: 0 });
		expect(before?.counts.post).toBe(1);

		const patched = await store.appendToRow(entry.id, entry.createdAt, [
			{ payload: text("卡片"), role: "main", result: OK, repushOf: 0 },
		]);
		expect(patched?.status).toBe("delivered");
		const after = (await store.aggregateDaily({ days: 1 })).at(-1);
		expect(after).toMatchObject({ total: 2, failures: 0 });
		expect(after?.counts.post).toBe(2);
	});

	it("补发失败的那一行算进失败", async () => {
		const entry = await store.record(input({ messages: [silencedMessage("卡片")] }));
		const patched = await store.appendToRow(entry.id, entry.createdAt, [
			{ payload: text("卡片"), role: "main", result: FAIL, repushOf: 0 },
		]);
		expect(patched?.status).toBe("failed");
		expect((await store.aggregateDaily({ days: 1 })).at(-1)).toMatchObject({
			total: 1,
			failures: 1,
		});
	});
});
