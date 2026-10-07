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
 * 2. **按 UTC 日分目录**,与历史的日文件同名。保留期的清扫清到 `2026-09-20` 时顺手删
 *    `repush/2026-09-20/` —— 一个数管两处(决策 4),而且整目录删得干净。
 * 3. **图全在图库里**(ADR-0022 决策 9,⑳d):原件里每一张图(含 composite 第二张起)都 `put` 进图库,存的只是引用,
 *    原件的日目录里只有 JSON;原件是图库的一家引用方,`drop` / `dropDay` 只删 JSON,图由图库的清扫收走。
 * 4. **下标与历史行的 `messages` 一一对应。** 「只补没到的」靠下标认亲,错位了就补错
 *    消息。所以读回来时拿条数对一次表,对不上宁可整份作废(面板据此把按钮灰掉并说明
 *    原因,决策 9),也不交一份错位的原料出去。
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotificationPayload } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { JPEG_BYTES, PNG_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { distinctPng } from "../../__tests__/support/chat-images.js";
import { makeHistoryImages } from "../../__tests__/support/history-images.js";
import { IMAGE_GRACE_MS, type ImageStore } from "../../images/image-store.js";
import {
	createRepushStore,
	dropRepushDay,
	listRepushImageRefs,
	type RepushStore,
} from "../repush-store.js";

let dataDir: string;
let store: RepushStore;
let imageStore: ImageStore;
const warn = vi.fn();

const TS = "2026-09-20T08:30:00.000Z";
const DAY = "2026-09-20";

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-repush-"));
	warn.mockClear();
	const images = makeHistoryImages(dataDir);
	imageStore = images.imageStore;
	store = createRepushStore({
		dataRoot: dataDir,
		logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
		images: images.repushImages,
		imageStore,
	});
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(dataDir, { recursive: true, force: true });
});

/** 原件的日目录。 */
const dayDir = () => join(dataDir, "history", "repush", DAY);
const imagesOnDisk = () => readdir(join(dataDir, "images")).catch(() => [] as string[]);

const text = (t: string): NotificationPayload => ({ kind: "text", text: t });
const png = (n: number): NotificationPayload => ({
	kind: "image",
	image: { buffer: distinctPng(n), mime: "image/png" },
});

describe("盘上形状 —— 原件是 `{ version, messages }`(⑱c)", () => {
	it("写下去的原件:`version` 打头,不再有 `v`", async () => {
		const id = randomUUID();
		await store.append(id, TS, [{ payload: text("卡片"), role: "main" }]);
		const raw = await readFile(join(dayDir(), `${id}.json`), "utf8");
		expect(Object.keys(JSON.parse(raw))[0]).toBe("version");
		expect(JSON.parse(raw)).toEqual({
			version: 1,
			messages: [{ payload: { kind: "text", text: "卡片" }, role: "main" }],
		});
	});

	it("还是 `v` 的老原件不认(迁移早把它改写了):读回 null", async () => {
		const id = randomUUID();
		await mkdir(dayDir(), { recursive: true });
		const messages = [{ payload: { kind: "text", text: "卡片" }, role: "main" }];
		await writeFile(join(dayDir(), `${id}.json`), JSON.stringify({ v: 1, messages }));
		expect(await store.load(id, TS, 1)).toBeNull();
	});

	it("图格是一个图库引用(字符串),不再是 `{ ref, mime, own }`;日目录里只有 JSON", async () => {
		const id = randomUUID();
		await store.append(id, TS, [{ payload: png(1), role: "main" }]);
		const raw = JSON.parse(await readFile(join(dayDir(), `${id}.json`), "utf8"));
		const image = raw.messages[0].payload.image;
		expect(image).toMatch(/^[0-9a-f]{64}\.png$/);
		expect(await imagesOnDisk()).toEqual([image]);
		expect(await readdir(dayDir())).toEqual([`${id}.json`]);
	});

	it("还是 `{ ref, mime, own? }` 的旧图格不认(迁移早把它改写了):读回 null", async () => {
		const id = randomUUID();
		await mkdir(dayDir(), { recursive: true });
		const messages = [
			{
				payload: { kind: "image", image: { ref: `${id}-0.png`, mime: "image/png" } },
				role: "main",
			},
		];
		await writeFile(join(dayDir(), `${id}.json`), JSON.stringify({ version: 1, messages }));
		expect(await store.load(id, TS, 1)).toBeNull();
	});
});

describe("append + load — 进去什么,出来还是什么", () => {
	it("纯文字:原样回来", async () => {
		const id = randomUUID();
		await store.append(id, TS, [{ payload: text("卡片"), role: "main" }]);
		const out = await store.load(id, TS, 1);
		expect(out?.messages).toEqual([{ payload: { kind: "text", text: "卡片" }, role: "main" }]);
	});

	it("分几次 append 累积成一行,顺序就是下标", async () => {
		const id = randomUUID();
		await store.append(id, TS, [{ payload: text("卡片"), role: "main" }]);
		await store.append(id, TS, [
			{ payload: text("词云"), role: "extra" },
			{ payload: text("总结"), role: "extra" },
		]);
		const out = await store.load(id, TS, 3);
		expect(out?.messages.map((m) => (m.payload.kind === "text" ? m.payload.text : "?"))).toEqual([
			"卡片",
			"词云",
			"总结",
		]);
		expect(out?.messages.map((m) => m.role)).toEqual(["main", "extra", "extra"]);
	});

	it("图片:存进图库,字节与 mime 从图库读回来(mime 随引用,按嗅探)", async () => {
		const id = randomUUID();
		await store.append(id, TS, [
			{
				payload: {
					kind: "image",
					image: { buffer: PNG_BYTES, mime: "application/octet-stream" },
					caption: "说明",
				},
				role: "main",
			},
		]);
		const out = await store.load(id, TS, 1);
		const p = out?.messages[0]?.payload;
		if (p?.kind !== "image") throw new Error("kind");
		expect(new Uint8Array(p.image.buffer)).toEqual(new Uint8Array(PNG_BYTES));
		expect(p.image.mime).toBe("image/png");
		expect(p.caption).toBe("说明");
	});

	it("同一张图 append 几次(重推每试一次)只有一个文件、一个引用", async () => {
		const a = randomUUID();
		const b = randomUUID();
		await store.append(a, TS, [{ payload: png(1), role: "main" }]);
		await store.append(a, TS, [{ payload: png(1), role: "main" }]);
		await store.append(b, TS, [{ payload: png(1), role: "main" }]);
		expect(await imagesOnDisk()).toHaveLength(1);
	});

	it("图过不了图库(不是图):append 抛、不留半份原件,调用方收成 warn", async () => {
		const id = randomUUID();
		await expect(
			store.append(id, TS, [
				{ payload: text("卡片"), role: "main" },
				{
					payload: { kind: "image", image: { buffer: Buffer.from("<svg/>"), mime: "image/png" } },
					role: "extra",
				},
			]),
		).rejects.toThrow("图存不进图库");
		expect(await store.has(id, TS)).toBe(false);
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
		await store.append(id, TS, [{ payload, role: "extra" }]);
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
		await store.append(id, TS, [{ payload, role: "extra" }]);
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
		await store.append(id, TS, [{ payload, role: "main" }]);
		const out = await store.load(id, TS, 1);
		expect(out?.messages[0]?.payload).toEqual(payload);
	});

	it("composite 的每一张图(含历史丢掉的第二张起)都存进图库,顺序与格式原样回来", async () => {
		const id = randomUUID();
		const payload: NotificationPayload = {
			kind: "composite",
			segments: [
				{ type: "text", text: "正文" },
				{ type: "image", buffer: PNG_BYTES, mime: "image/png" },
				{ type: "link", href: "https://b23.tv/x", title: "链接" },
				{ type: "image", buffer: JPEG_BYTES, mime: "image/jpeg" },
			],
		};
		await store.append(id, TS, [{ payload, role: "main" }]);
		// 日目录里只有 json,两张图都在图库里。
		expect(await readdir(dayDir())).toEqual([`${id}.json`]);
		expect(await imagesOnDisk()).toHaveLength(2);
		const out = await store.load(id, TS, 1);
		const p = out?.messages[0]?.payload;
		if (p?.kind !== "composite") throw new Error("kind");
		expect(p.segments.map((s) => s.type)).toEqual(["text", "image", "link", "image"]);
		const images = p.segments.flatMap((s) => (s.type === "image" ? [s] : []));
		expect(images.map((s) => s.mime)).toEqual(["image/png", "image/jpeg"]);
		expect(new Uint8Array(images[0]?.buffer ?? [])).toEqual(new Uint8Array(PNG_BYTES));
		expect(new Uint8Array(images[1]?.buffer ?? [])).toEqual(new Uint8Array(JPEG_BYTES));
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
		await store.append(id, TS, [{ payload: text("卡片"), role: "main" }]);
		expect(await store.load(id, TS, 2)).toBeNull();
		expect(await store.load(id, TS, 1)).not.toBeNull();
	});

	it("json 坏了 → null,不抛", async () => {
		const id = randomUUID();
		await store.append(id, TS, [{ payload: text("卡片"), role: "main" }]);
		await writeFile(join(dayDir(), `${id}.json`), "{ 这不是 json", "utf8");
		expect(await store.load(id, TS, 1)).toBeNull();
	});

	it("引用的图图库里已经没有 → null,记一句 warn(原件不完整,补不出原样)", async () => {
		const id = randomUUID();
		await store.append(id, TS, [{ payload: png(1), role: "main" }]);
		// 过了宽限期又没人引用的图被清扫收走:这里直接把图库里的文件删了。
		await rm(join(dataDir, "images"), { recursive: true, force: true });
		expect(await store.load(id, TS, 1)).toBeNull();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("图读不回来");
	});
});

describe("has — 只问在不在,不读图", () => {
	it("存过就在,没存过就不在", async () => {
		const id = randomUUID();
		expect(await store.has(id, TS)).toBe(false);
		await store.append(id, TS, [{ payload: text("卡片"), role: "main" }]);
		expect(await store.has(id, TS)).toBe(true);
	});

	/**
	 * 面板要为**每一行失败的**问一次「按钮该不该灰」(决策 9),所以这一口必须便宜:
	 * 只看文件在不在,不解析 json、更不把图读进内存。
	 */
	it("drop 之后就不在了", async () => {
		const id = randomUUID();
		await store.append(id, TS, [{ payload: text("卡片"), role: "main" }]);
		await store.drop(id, TS);
		expect(await store.has(id, TS)).toBe(false);
	});
});

describe("drop / dropRepushDay — 收摊(只删 JSON,不删图)", () => {
	it("drop 删掉这一行的原件,别的行不动;它引用的图还在图库里", async () => {
		const a = randomUUID();
		const b = randomUUID();
		await store.append(a, TS, [{ payload: png(1), role: "main" }]);
		await store.append(b, TS, [{ payload: text("别人"), role: "main" }]);
		const before = await imagesOnDisk();
		expect(before).toHaveLength(1);

		await store.drop(a, TS);

		expect((await readdir(dayDir())).sort()).toEqual([`${b}.json`]);
		expect(await store.load(a, TS, 1)).toBeNull();
		expect(await store.load(b, TS, 1)).not.toBeNull();
		// 图不由原件删:同一张图可能还被别的行、原件引用着,收走是图库清扫的事。
		expect(await imagesOnDisk()).toEqual(before);
	});

	it("drop 一个不存在的行不算错", async () => {
		await expect(store.drop(randomUUID(), TS)).resolves.toBeUndefined();
	});

	it("dropRepushDay 端掉一整天,别的天不动;图还在图库里", async () => {
		const a = randomUUID();
		const b = randomUUID();
		const otherTs = "2026-09-19T23:00:00.000Z";
		await store.append(a, TS, [{ payload: png(1), role: "main" }]);
		await store.append(b, otherTs, [{ payload: text("昨天"), role: "main" }]);

		await dropRepushDay(dataDir, DAY);

		expect(await store.load(a, TS, 1)).toBeNull();
		expect(await store.load(b, otherTs, 1)).not.toBeNull();
		expect(await imagesOnDisk()).toHaveLength(1);
	});

	it("dropRepushDay 一个没有原件的日子不算错", async () => {
		await expect(dropRepushDay(dataDir, "2020-01-01")).resolves.toBeUndefined();
	});
});

describe("listRepushImageRefs — 图库的引用方名单", () => {
	it("盘上每份原件里的图:整张图的消息、composite 的每个图段,跨日、跨原件", async () => {
		const a = randomUUID();
		const b = randomUUID();
		await store.append(a, TS, [
			{ payload: png(1), role: "main" },
			{
				payload: {
					kind: "composite",
					segments: [
						{ type: "image", buffer: distinctPng(2), mime: "image/png" },
						{ type: "image", buffer: distinctPng(3), mime: "image/png" },
					],
				},
				role: "extra",
			},
		]);
		await store.append(b, "2026-09-19T23:00:00.000Z", [{ payload: png(4), role: "main" }]);
		await store.append(randomUUID(), TS, [{ payload: text("纯文字"), role: "main" }]);

		const refs = await listRepushImageRefs(dataDir);

		expect(refs.sort()).toEqual((await imagesOnDisk()).sort());
		expect(refs).toHaveLength(4);
	});

	it("没有原件目录 → 空;读不懂的原件不算引用也不连累别的;日目录读不动 → 抛", async () => {
		expect(await listRepushImageRefs(dataDir)).toEqual([]);
		const id = randomUUID();
		await store.append(id, TS, [{ payload: png(1), role: "main" }]);
		await writeFile(join(dayDir(), `${randomUUID()}.json`), "{ 这不是 json", "utf8");
		expect(await listRepushImageRefs(dataDir)).toHaveLength(1);

		// 把原件根目录换成一个文件:读目录是 ENOTDIR,不是「不在」,名单列不出来就抛。
		await rm(join(dataDir, "history", "repush"), { recursive: true });
		await writeFile(join(dataDir, "history", "repush"), "x");
		await expect(listRepushImageRefs(dataDir)).rejects.toThrow();
	});

	it("接线:原件引用着的图,清扫过了宽限期也不收;原件的日目录没了,下一轮才收走", async () => {
		const id = randomUUID();
		await store.append(id, TS, [{ payload: png(1), role: "main" }]);
		const [ref] = await imagesOnDisk();
		const later = new Date(Date.now() + IMAGE_GRACE_MS + 60 * 60 * 1000);

		// 历史那一家一行也没有:留住这张图的只可能是「重推原件」这一家。
		expect(await imageStore.sweep({ now: later })).toMatchObject({ removed: [], referenced: 1 });
		expect(await imagesOnDisk()).toEqual([ref]);

		await dropRepushDay(dataDir, DAY);
		expect((await imageStore.sweep({ now: later })).removed).toEqual([ref]);
		expect(await imagesOnDisk()).toEqual([]);
	});
});

describe("图库写盘失败(环境的事)", () => {
	it("图库的目录建不出来:append 抛、原因带着,不留半份原件", async () => {
		// `<dataRoot>/images` 是个普通文件:图库往里写必挂(ENOTDIR)。
		await writeFile(join(dataDir, "images"), "挡路");
		const id = randomUUID();

		await expect(
			store.append(id, TS, [
				{ payload: text("卡片"), role: "main" },
				{ payload: png(1), role: "extra" },
			]),
		).rejects.toThrow(/ENOTDIR/);
		expect(await store.has(id, TS)).toBe(false);
	});
});
