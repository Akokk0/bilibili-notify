/**
 * **重推原件**(ADR-0017 决策 1-5)——「失败那一刻留一份能再发一次的原料」。
 *
 * 🔴 为什么不能从历史行重建:**历史里的 payload 是给人看的有损摘要**。图集只剩一句
 * 「[图集 N 张]」、小程序卡只剩标题、composite 只留第一张图,而 `at-all` 段被写成
 * **字面文字**「@全体」—— 拿它重发,那四个字会真的发到群里,而该响的铃一个都不响。
 * 本文件里「三种历史丢得最狠的 payload」那一组就是钉这件事的。
 *
 * 形状上的几条:
 *
 * 1. **落盘,不放内存。** 要解的场景是「离线一段时间后上线」,而这段时间里服务端重启
 *    完全可能(本项目自己就有应用内自主升级,升级即重启)。内存版会在最需要它的那一次
 *    恰好是空的。
 * 2. **按 UTC 日分目录**,与历史的日文件同名。保留期删 `2026-09-20.jsonl` 时顺手删
 *    `repush/2026-09-20/` —— 一个数管两处(决策 4),而且整目录删得干净:历史那边的
 *    `deleteDayFile` 只 unlink jsonl,`history/img/` 至今没有清理器,原件的图混进去
 *    就是往那个洞里再加东西。
 * 3. **图复用历史已经写过的那一份**(决策 3),一个字节都不多存;只有历史丢掉的
 *    (composite 第二张图起)才写进原件自己的日目录。
 * 4. **下标与历史行的 `messages` 一一对应。** 「只补没到的」靠下标认亲,错位了就补错
 *    消息。所以读回来时拿条数对一次表,对不上宁可整份作废(面板据此把按钮灰掉并说明
 *    原因,决策 9),也不交一份错位的原料出去。
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotificationPayload } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createRepushStore, type RepushStore } from "../repush-store.js";

let dataDir: string;
let store: RepushStore;

const TS = "2026-09-20T08:30:00.000Z";
const DAY = "2026-09-20";

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-repush-"));
	store = createRepushStore({
		dataDir,
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	});
});
afterEach(() => vi.restoreAllMocks());

/** 原件的日目录。 */
const dayDir = () => join(dataDir, "history", "repush", DAY);

/** 历史那边已经把图写进 `history/img/` 了 —— 造一份出来好让原件去引用。 */
async function putHistoryImage(name: string, bytes: string): Promise<void> {
	const dir = join(dataDir, "history", "img");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, name), Buffer.from(bytes));
}

const text = (t: string): NotificationPayload => ({ kind: "text", text: t });

describe("append + load — 进去什么,出来还是什么", () => {
	it("纯文字:原样回来", async () => {
		const id = randomUUID();
		await store.append(id, TS, [
			{ payload: text("卡片"), role: "main", reduced: { kind: "text" } },
		]);
		const out = await store.load(id, TS, 1);
		expect(out?.messages).toEqual([{ payload: { kind: "text", text: "卡片" }, role: "main" }]);
	});

	it("分几次 append 累积成一行,顺序就是下标", async () => {
		const id = randomUUID();
		await store.append(id, TS, [
			{ payload: text("卡片"), role: "main", reduced: { kind: "text" } },
		]);
		await store.append(id, TS, [
			{ payload: text("词云"), role: "extra", reduced: { kind: "text" } },
			{ payload: text("总结"), role: "extra", reduced: { kind: "text" } },
		]);
		const out = await store.load(id, TS, 3);
		expect(out?.messages.map((m) => (m.payload.kind === "text" ? m.payload.text : "?"))).toEqual([
			"卡片",
			"词云",
			"总结",
		]);
		expect(out?.messages.map((m) => m.role)).toEqual(["main", "extra", "extra"]);
	});

	it("图片:复用历史写好的那一份,原件自己一个图都不写", async () => {
		const id = randomUUID();
		await putHistoryImage(`${id}-0.png`, "卡片图的字节");
		await store.append(id, TS, [
			{
				payload: {
					kind: "image",
					image: { buffer: Buffer.from("卡片图的字节"), mime: "image/png" },
				},
				role: "main",
				reduced: { kind: "image", text: "[卡片图]", imageRef: `${id}-0.png` },
			},
		]);
		// 日目录里只该有那一份 json,没有图。
		expect((await readdir(dayDir())).sort()).toEqual([`${id}.json`]);
		const out = await store.load(id, TS, 1);
		const p = out?.messages[0]?.payload;
		expect(p?.kind).toBe("image");
		if (p?.kind !== "image") throw new Error("kind");
		expect(p.image.buffer.toString()).toBe("卡片图的字节");
		expect(p.image.mime).toBe("image/png");
	});
});

/**
 * 🔴 这一组是整份定案的地基。三种 payload 经过历史那道 `reduce` 之后**面目全非**,
 * 而原件必须字字不差 —— 每一条都写清楚「历史剩下什么」,免得哪天有人觉得
 * 「从历史重建也差不多」。
 */
describe("三种历史丢得最狠的 payload", () => {
	it("at-all 段:原件留住段本身(历史只剩字面文字「@全体」)", async () => {
		const id = randomUUID();
		const payload: NotificationPayload = { kind: "composite", segments: [{ type: "at-all" }] };
		await store.append(id, TS, [
			{ payload, role: "extra", reduced: { kind: "composite", text: "@全体" } },
		]);
		const out = await store.load(id, TS, 1);
		expect(out?.messages[0]?.payload).toEqual({
			kind: "composite",
			segments: [{ type: "at-all" }],
		});
	});

	it("图集:N 张的 url 全留着(历史只剩「[图集 N 张]」)", async () => {
		const id = randomUUID();
		const payload: NotificationPayload = {
			kind: "forward-images",
			images: [
				{ url: "https://i0.hdslb.com/a.jpg", width: 800, height: 600 },
				{ url: "https://i0.hdslb.com/b.jpg" },
			],
			forward: true,
		};
		await store.append(id, TS, [
			{ payload, role: "extra", reduced: { kind: "text", text: "[图集 2 张]" } },
		]);
		const out = await store.load(id, TS, 1);
		expect(out?.messages[0]?.payload).toEqual(payload);
	});

	it("小程序卡:五个字段都留着(历史只剩标题)", async () => {
		const id = randomUUID();
		const payload: NotificationPayload = {
			kind: "miniapp-card",
			title: "标题",
			desc: "简介",
			picUrl: "https://i0.hdslb.com/p.jpg",
			path: "pages/video",
			jumpUrl: "https://b23.tv/x",
		};
		await store.append(id, TS, [
			{ payload, role: "main", reduced: { kind: "text", text: "[小程序卡] 标题" } },
		]);
		const out = await store.load(id, TS, 1);
		expect(out?.messages[0]?.payload).toEqual(payload);
	});

	it("composite 的第二张图起:历史丢了,原件自己写一份", async () => {
		const id = randomUUID();
		await putHistoryImage(`${id}-0-0.png`, "第一张");
		const payload: NotificationPayload = {
			kind: "composite",
			segments: [
				{ type: "text", text: "正文" },
				{ type: "image", buffer: Buffer.from("第一张"), mime: "image/png" },
				{ type: "image", buffer: Buffer.from("第二张"), mime: "image/png" },
			],
		};
		// 历史只写了第一张(`reduce` 里那句 `!imageRef`)。
		await store.append(id, TS, [
			{
				payload,
				role: "main",
				reduced: { kind: "composite", text: "正文", imageRef: `${id}-0-0.png` },
			},
		]);
		// 日目录里多出来的正是第二张,第一张仍然只有历史那一份。
		const files = (await readdir(dayDir())).sort();
		expect(files).toHaveLength(2);
		expect(files.some((f) => f.endsWith(".json"))).toBe(true);
		const out = await store.load(id, TS, 1);
		const p = out?.messages[0]?.payload;
		if (p?.kind !== "composite") throw new Error("kind");
		expect(p.segments[0]).toEqual({ type: "text", text: "正文" });
		expect(p.segments[1]).toMatchObject({ type: "image", mime: "image/png" });
		expect(p.segments[2]).toMatchObject({ type: "image", mime: "image/png" });
		const bytes = p.segments
			.flatMap((s) => (s.type === "image" ? [s.buffer.toString()] : []))
			.sort();
		expect(bytes).toEqual(["第一张", "第二张"]);
	});
});

describe("load — 对不上号就整份作废", () => {
	it("从来没存过 → null", async () => {
		expect(await store.load(randomUUID(), TS, 1)).toBeNull();
	});

	/**
	 * 条数对不上 = 原件与历史行错位了(某一次 append 没写成)。「只补没到的」是按下标
	 * 认亲的,错位之后补的就是**别的消息** —— 宁可整份作废让按钮灰掉,也不发错东西。
	 */
	it("条数与历史行对不上 → null,不交一份错位的原料出去", async () => {
		const id = randomUUID();
		await store.append(id, TS, [
			{ payload: text("卡片"), role: "main", reduced: { kind: "text" } },
		]);
		expect(await store.load(id, TS, 2)).toBeNull();
		expect(await store.load(id, TS, 1)).not.toBeNull();
	});

	it("json 坏了 → null,不抛", async () => {
		const id = randomUUID();
		await store.append(id, TS, [
			{ payload: text("卡片"), role: "main", reduced: { kind: "text" } },
		]);
		await writeFile(join(dayDir(), `${id}.json`), "{ 这不是 json", "utf8");
		expect(await store.load(id, TS, 1)).toBeNull();
	});

	it("引用的图已经不在盘上 → null(原件不完整,补不出原样)", async () => {
		const id = randomUUID();
		await store.append(id, TS, [
			{
				payload: { kind: "image", image: { buffer: Buffer.from("x"), mime: "image/png" } },
				role: "main",
				reduced: { kind: "image", text: "[卡片图]", imageRef: `${id}-0.png` }, // 故意没往 history/img 里放
			},
		]);
		expect(await store.load(id, TS, 1)).toBeNull();
	});
});

describe("has — 只问在不在,不读图", () => {
	it("存过就在,没存过就不在", async () => {
		const id = randomUUID();
		expect(await store.has(id, TS)).toBe(false);
		await store.append(id, TS, [
			{ payload: text("卡片"), role: "main", reduced: { kind: "text" } },
		]);
		expect(await store.has(id, TS)).toBe(true);
	});

	/**
	 * 面板要为**每一行失败的**问一次「按钮该不该灰」(决策 9),所以这一口必须便宜:
	 * 只看文件在不在,不解析 json、更不把图读进内存。
	 */
	it("drop 之后就不在了", async () => {
		const id = randomUUID();
		await store.append(id, TS, [
			{ payload: text("卡片"), role: "main", reduced: { kind: "text" } },
		]);
		await store.drop(id, TS);
		expect(await store.has(id, TS)).toBe(false);
	});
});

describe("drop / dropDay — 收摊", () => {
	it("drop 删掉这一行的原件与它自己写的图,别的行不动", async () => {
		const a = randomUUID();
		const b = randomUUID();
		await putHistoryImage(`${a}-0-0.png`, "第一张");
		await store.append(a, TS, [
			{
				payload: {
					kind: "composite",
					segments: [
						{ type: "image", buffer: Buffer.from("第一张"), mime: "image/png" },
						{ type: "image", buffer: Buffer.from("第二张"), mime: "image/png" },
					],
				},
				role: "main",
				reduced: { kind: "composite", imageRef: `${a}-0-0.png` },
			},
		]);
		await store.append(b, TS, [{ payload: text("别人"), role: "main", reduced: { kind: "text" } }]);
		await store.drop(a, TS);
		expect((await readdir(dayDir())).sort()).toEqual([`${b}.json`]);
		expect(await store.load(a, TS, 1)).toBeNull();
		expect(await store.load(b, TS, 1)).not.toBeNull();
	});

	it("drop 一个不存在的行不算错", async () => {
		await expect(store.drop(randomUUID(), TS)).resolves.toBeUndefined();
	});

	it("dropDay 端掉一整天,别的天不动", async () => {
		const a = randomUUID();
		const b = randomUUID();
		const otherTs = "2026-09-19T23:00:00.000Z";
		await store.append(a, TS, [{ payload: text("今天"), role: "main", reduced: { kind: "text" } }]);
		await store.append(b, otherTs, [
			{ payload: text("昨天"), role: "main", reduced: { kind: "text" } },
		]);
		await store.dropDay(DAY);
		expect(await store.load(a, TS, 1)).toBeNull();
		expect(await store.load(b, otherTs, 1)).not.toBeNull();
	});

	it("dropDay 一个没有原件的日子不算错", async () => {
		await expect(store.dropDay("2020-01-01")).resolves.toBeUndefined();
	});
});
