/**
 * 推送历史里跟图有关的格 → 图库(ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗,⑳d)。
 *
 * 0.x 的历史图在 `history/img/<名字>`:消息存名字(`imageRef`)、行存 B 站远端头像网址(`uavatarSnapshot`)、重推原件里是
 * `{ ref, mime, own? }`。迁移不整目录搬它们(当成输入):
 *
 * - 保留期内的行(水位线之后):`imageRef` 逐个读文件、嗅探、复制进新代图库,在原位换成 `image: <引用>`;对不上的这一格拿掉;
 * - 水位线及以前的行:`imageRef` 直接拿掉,**不读图文件**;
 * - `uavatarSnapshot` 一律丢掉;
 * - 重推原件:`{ ref, mime, own? }` → 引用,`own` 的从原件自己的日目录读;任何一张读不到,这份原件整份不搬;
 * - 孤儿图不搬;没搬的按数量各记一句。
 *
 * 末尾两条走完整的真读法:迁出来的一代上开真的历史仓 + 重推原件仓 + 图库,行里的图读得出、原件读得回。
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { JPEG_BYTES, PNG_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { distinctPng } from "../../__tests__/support/chat-images.js";
import { makeHistoryImages } from "../../__tests__/support/history-images.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { createRepushStore } from "../../history/repush-store.js";
import { createHistoryStore } from "../../history/store.js";
import { IMAGE_GRACE_MS } from "../../images/image-store.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { historyImageNames, migrateHistoryImageCells } from "../history-images.js";
import { useZeroSandbox } from "./support.js";

const sandbox = useZeroSandbox("bn-zero-history-images-");

const SUB = randomUUID();
const T2 = randomUUID();
/** 此刻 06-15、默认保留 30 天:05-15 及以前到期,水位线 05-15。 */
const NOW = new Date("2026-06-15T12:00:00.000Z");
const EXPIRED_DAY = "2026-05-10";
const LIVE_DAY = "2026-06-10";

const refOfBytes = (bytes: Uint8Array, ext: string) =>
	`${createHash("sha256").update(bytes).digest("hex")}.${ext}`;

/** 一行现在形状的历史,第一条消息是 `payload`。 */
function row(day: string, payload: Record<string, unknown>, over: Record<string, unknown> = {}) {
	return {
		id: randomUUID(),
		pushId: randomUUID(),
		createdAt: `${day}T08:00:00.000Z`,
		feature: "post",
		identity: { sourceKey: "bilibili", externalId: "u1" },
		subscriptionId: SUB,
		targetId: T2,
		status: "delivered",
		messages: [{ payload, role: "main", result: { ok: true, latencyMs: 1 } }],
		...over,
	};
}

const imagePayload = (imageRef: string, text = "卡") => ({ kind: "image", text, imageRef });

async function writeDay(day: string, lines: unknown[]): Promise<void> {
	await sandbox.placeZeroText(
		`history/${day}.jsonl`,
		`${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`,
	);
}

async function readDay(day: string): Promise<Record<string, unknown>[]> {
	return (await readFile(join(sandbox.target, "history", `${day}.jsonl`), "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const payloadOf = (entry: Record<string, unknown> | undefined, i = 0) =>
	(entry?.messages as { payload: Record<string, unknown> }[] | undefined)?.[i]?.payload;

const libraryFiles = async () =>
	(await readdir(join(sandbox.target, "images")).catch(() => [] as string[])).sort();

describe("纯函数:historyImageNames / migrateHistoryImageCells", () => {
	const imageRow = JSON.stringify(
		row(LIVE_DAY, imagePayload("a.png"), { uavatarSnapshot: "https://x/y.jpg" }),
	);

	it("收集消息里的 imageRef(本体行与补丁行);没有图格、坏行、不是行的东西没有", () => {
		expect(historyImageNames(imageRow)).toEqual(["a.png"]);
		const patch = JSON.stringify({
			rowId: randomUUID(),
			status: "delivered",
			messages: [{ payload: imagePayload("b.png"), role: "extra" }],
		});
		expect(historyImageNames(patch)).toEqual(["b.png"]);
		expect(historyImageNames(JSON.stringify(row(LIVE_DAY, { kind: "text", text: "x" })))).toEqual(
			[],
		);
		expect(historyImageNames("{坏行")).toEqual([]);
		expect(historyImageNames("")).toEqual([]);
	});

	it("没有 identity 的行(推不出替谁发的的坏行)整行原样,哪怕带着这两格", () => {
		const bad = JSON.stringify({
			...row(LIVE_DAY, imagePayload("a.png"), { uavatarSnapshot: "https://x/y.jpg" }),
			identity: undefined,
		});
		expect(migrateHistoryImageCells(bad, () => "r.png")).toBe(bad);
		expect(historyImageNames(bad)).toEqual([]);
	});

	it("imageRef 在原位换成 image(键序不变),uavatarSnapshot 丢掉;查不到的拿掉;没有这两格的行回同一个字符串", () => {
		const REF = `${"a".repeat(64)}.png`;
		const out = JSON.parse(migrateHistoryImageCells(imageRow, () => REF)) as Record<
			string,
			unknown
		>;
		expect(payloadOf(out)).toEqual({ kind: "image", text: "卡", image: REF });
		expect(Object.keys(payloadOf(out) ?? {})).toEqual(["kind", "text", "image"]);
		expect(out).not.toHaveProperty("uavatarSnapshot");
		const dropped = JSON.parse(migrateHistoryImageCells(imageRow, () => undefined)) as Record<
			string,
			unknown
		>;
		expect(payloadOf(dropped)).toEqual({ kind: "image", text: "卡" });
		const plain = JSON.stringify(row(LIVE_DAY, { kind: "text", text: "x" }));
		expect(migrateHistoryImageCells(plain, () => REF)).toBe(plain);
	});

	it("补丁行的 imageRef 也换;补丁行仍是 rowId 打头(读侧靠行首认它)", () => {
		const REF = `${"c".repeat(64)}.jpg`;
		const patch = JSON.stringify({
			rowId: randomUUID(),
			status: "delivered",
			messages: [{ payload: imagePayload("b.png", "词云"), role: "extra" }],
		});
		const out = migrateHistoryImageCells(patch, () => REF);
		expect(out.startsWith('{"rowId":')).toBe(true);
		expect(payloadOf(JSON.parse(out))).toEqual({ kind: "image", text: "词云", image: REF });
	});
});

describe("日文件:保留期内的行复制图进图库,过了保留期的行拿掉图格", () => {
	it("保留期内:imageRef → image(真引用 = 字节摘要 + 嗅探出的扩展名),图复制进新代图库、字节一致、不是硬链接", async () => {
		await sandbox.placeZeroBytes("history/img/a.png", PNG_BYTES);
		await sandbox.placeZeroBytes("history/img/b.jpg", JPEG_BYTES); // 0.x 的 jpg,图库里 jpg
		await writeDay(LIVE_DAY, [
			row(LIVE_DAY, imagePayload("a.png")),
			row(LIVE_DAY, imagePayload("b.jpg")),
		]);
		const report = await sandbox.migrate({ now: NOW });

		const [first, second] = await readDay(LIVE_DAY);
		expect(payloadOf(first)).toEqual({
			kind: "image",
			text: "卡",
			image: refOfBytes(PNG_BYTES, "png"),
		});
		expect(payloadOf(second)?.image).toBe(refOfBytes(JPEG_BYTES, "jpg"));
		expect(await libraryFiles()).toEqual(
			[refOfBytes(PNG_BYTES, "png"), refOfBytes(JPEG_BYTES, "jpg")].sort(),
		);
		expect(
			new Uint8Array(await readFile(join(sandbox.target, "images", refOfBytes(PNG_BYTES, "png")))),
		).toEqual(new Uint8Array(PNG_BYTES));
		expect(report.transfers).toEqual(
			expect.arrayContaining([
				{
					from: "history/img/a.png",
					to: `images/${refOfBytes(PNG_BYTES, "png")}`,
					method: "copy",
				},
			]),
		);
		expect(report.rewritten).toContain(`history/${LIVE_DAY}.jsonl`);
	});

	it("水位线及以前的行:imageRef 拿掉、文字照留、不读图文件(图文件读不了也不碍事)", async () => {
		await sandbox.placeZeroBytes("history/img/old.png", PNG_BYTES);
		await chmod(join(sandbox.zero, "history", "img", "old.png"), 0o000);
		try {
			await writeDay(EXPIRED_DAY, [
				row(EXPIRED_DAY, imagePayload("old.png", "旧卡片"), { uavatarSnapshot: "https://x/y.jpg" }),
			]);
			const report = await sandbox.migrate({ now: NOW });

			const [entry] = await readDay(EXPIRED_DAY);
			expect(payloadOf(entry)).toEqual({ kind: "image", text: "旧卡片" });
			expect(entry).not.toHaveProperty("uavatarSnapshot");
			expect(await libraryFiles()).toEqual([]);
			expect(report.skipped).toContainEqual({
				path: "history/img",
				reason: expect.stringMatching(/1 张.*保留期/),
			});
		} finally {
			await chmod(join(sandbox.zero, "history", "img", "old.png"), 0o644);
		}
	});

	it("同一个图文件被好几行引用:只读一次、只落一份,transfers 一条", async () => {
		await sandbox.placeZeroBytes("history/img/shared.png", PNG_BYTES);
		await writeDay(LIVE_DAY, [
			row(LIVE_DAY, imagePayload("shared.png")),
			row(LIVE_DAY, imagePayload("shared.png")),
		]);
		const report = await sandbox.migrate({ now: NOW });

		const refs = (await readDay(LIVE_DAY)).map((e) => payloadOf(e)?.image);
		expect(refs).toEqual([refOfBytes(PNG_BYTES, "png"), refOfBytes(PNG_BYTES, "png")]);
		expect(await libraryFiles()).toHaveLength(1);
		expect(report.transfers.filter((t) => t.from === "history/img/shared.png")).toHaveLength(1);
	});

	it("内容相同的两个旧文件名(各自一个文件):图库里并成一份,两行指同一个引用", async () => {
		await sandbox.placeZeroBytes("history/img/x.png", PNG_BYTES);
		await sandbox.placeZeroBytes("history/img/y.png", PNG_BYTES);
		await writeDay(LIVE_DAY, [
			row(LIVE_DAY, imagePayload("x.png")),
			row(LIVE_DAY, imagePayload("y.png")),
		]);
		await sandbox.migrate({ now: NOW });

		expect(await libraryFiles()).toHaveLength(1);
	});

	it("对不上的图(文件不在 / 不是图 / 名字想跑出目录 / 不是普通文件):这一格拿掉,行与文字留着,记一句", async () => {
		await sandbox.placeZeroText("history/img/notimg.png", "<svg/>");
		await mkdir(join(sandbox.zero, "history", "img", "dir.png"), { recursive: true });
		await sandbox.placeZeroBytes("secret.png", PNG_BYTES);
		await writeDay(LIVE_DAY, [
			row(LIVE_DAY, imagePayload("missing.png", "没文件")),
			row(LIVE_DAY, imagePayload("notimg.png", "不是图")),
			row(LIVE_DAY, imagePayload("../../secret.png", "想跑出去")),
			row(LIVE_DAY, imagePayload("dir.png", "目录")),
		]);
		const report = await sandbox.migrate({ now: NOW });

		const rows = await readDay(LIVE_DAY);
		expect(rows.map((e) => payloadOf(e))).toEqual([
			{ kind: "image", text: "没文件" },
			{ kind: "image", text: "不是图" },
			{ kind: "image", text: "想跑出去" },
			{ kind: "image", text: "目录" },
		]);
		expect(await libraryFiles()).toEqual([]);
		expect(report.skipped).toContainEqual({
			path: "history/img",
			reason: expect.stringMatching(/4 张.*对不上/),
		});
	});

	it("已经是现在形状的行(带 identity)和补丁行也带着图格:一样迁,不因为「已经是新形状」就漏", async () => {
		await sandbox.placeZeroBytes("history/img/a.png", PNG_BYTES);
		await sandbox.placeZeroBytes("history/img/p.png", distinctPng(2));
		const base = row(LIVE_DAY, imagePayload("a.png"));
		const patch = {
			rowId: base.id,
			status: "delivered",
			messages: [{ payload: imagePayload("p.png", "词云"), role: "extra" }],
		};
		await writeDay(LIVE_DAY, [base, patch]);
		await sandbox.migrate({ now: NOW });

		const [first, second] = await readDay(LIVE_DAY);
		expect(payloadOf(first)?.image).toBe(refOfBytes(PNG_BYTES, "png"));
		expect(payloadOf(second)?.image).toBe(refOfBytes(distinctPng(2), "png"));
		expect(Object.keys(second ?? {})[0]).toBe("rowId");
	});

	it("composite 的 imageRef 一样迁;0.x 早期单消息老行(payload 在顶层)迁完图格也到位", async () => {
		await sandbox.placeZeroBytes("history/img/c.png", PNG_BYTES);
		await sandbox.placeZeroBytes("history/img/l.png", distinctPng(3));
		const legacy = {
			id: randomUUID(),
			ts: `${LIVE_DAY}T01:00:00.000Z`,
			source: "dynamic",
			uid: "u9",
			subscriptionId: SUB,
			targetIds: [T2],
			result: { ok: true, per: [{ targetId: T2, ok: true, latencyMs: 3 }] },
			payload: imagePayload("l.png", "老行"),
			unameSnapshot: "老UP",
			uavatarSnapshot: "https://x/y.jpg",
		};
		await writeDay(LIVE_DAY, [
			row(LIVE_DAY, { kind: "composite", text: "图文", imageRef: "c.png" }),
			legacy,
		]);
		await sandbox.migrate({ now: NOW });

		const [composite, old] = await readDay(LIVE_DAY);
		expect(payloadOf(composite)).toEqual({
			kind: "composite",
			text: "图文",
			image: refOfBytes(PNG_BYTES, "png"),
		});
		expect(payloadOf(old)).toEqual({
			kind: "image",
			text: "老行",
			image: refOfBytes(distinctPng(3), "png"),
		});
		expect(old).not.toHaveProperty("uavatarSnapshot");
		expect(old?.nameSnapshot).toBe("老UP");
	});

	it("没有 identity 的坏行整行原样(带 imageRef / uavatarSnapshot 也不碰)", async () => {
		const bad = JSON.stringify({
			...row(LIVE_DAY, imagePayload("a.png"), { uavatarSnapshot: "https://x/y.jpg" }),
			identity: undefined,
			uid: undefined,
		});
		await writeDay(LIVE_DAY, [bad]);
		await sandbox.migrate({ now: NOW });

		expect(
			(await readFile(join(sandbox.target, "history", `${LIVE_DAY}.jsonl`), "utf8")).split("\n")[0],
		).toBe(bad);
	});

	it("迁出来的行,活的 schema 读得进去;迁两遍和迁一遍一样", async () => {
		await sandbox.placeZeroBytes("history/img/a.png", PNG_BYTES);
		await writeDay(LIVE_DAY, [row(LIVE_DAY, imagePayload("a.png"))]);
		await sandbox.migrate({ now: NOW });
		const store = createHistoryStore({
			dataRoot: sandbox.target,
			bus: createNodeMessageBus(),
			logger: silentLogger,
			images: makeHistoryImages(sandbox.target).historyImages,
		});
		const [entry] = await store.query({});
		expect(entry?.messages[0]?.payload.image).toBe(refOfBytes(PNG_BYTES, "png"));
	});
});

describe("重推原件:图格 { ref, mime, own? } → 图库引用", () => {
	const snapshotPath = (day: string, id: string) => `history/repush/${day}/${id}.json`;
	const readSnapshot = async (day: string, id: string) =>
		JSON.parse(await readFile(join(sandbox.target, snapshotPath(day, id)), "utf8")) as {
			version: number;
			messages: { payload: Record<string, unknown>; role: string }[];
		};

	it("整张图 / composite 的图段:历史图的从 history/img/ 读,own 的从原件自己的日目录读;同一张只落一份", async () => {
		const id = randomUUID();
		await sandbox.placeZeroBytes("history/img/card.png", PNG_BYTES);
		await sandbox.placeZeroBytes(`history/repush/${LIVE_DAY}/${id}-0-0.jpg`, JPEG_BYTES);
		await sandbox.placeZero(snapshotPath(LIVE_DAY, id), {
			v: 1,
			messages: [
				{
					payload: {
						kind: "image",
						image: { ref: "card.png", mime: "image/png" },
						caption: "说明",
					},
					role: "main",
				},
				{
					payload: {
						kind: "composite",
						segments: [
							{ type: "text", text: "正文" },
							{ type: "image", image: { ref: "card.png", mime: "image/png" } },
							{ type: "image", image: { ref: `${id}-0-0.jpg`, mime: "image/jpeg", own: true } },
						],
					},
					role: "extra",
				},
			],
		});
		const report = await sandbox.migrate({ now: NOW });

		const snapshot = await readSnapshot(LIVE_DAY, id);
		expect(Object.keys(snapshot)[0]).toBe("version");
		const pngRef = refOfBytes(PNG_BYTES, "png");
		const jpgRef = refOfBytes(JPEG_BYTES, "jpg");
		expect(snapshot.messages[0]?.payload).toEqual({
			kind: "image",
			image: pngRef,
			caption: "说明",
		});
		expect(snapshot.messages[1]?.payload).toEqual({
			kind: "composite",
			segments: [
				{ type: "text", text: "正文" },
				{ type: "image", image: pngRef },
				{ type: "image", image: jpgRef },
			],
		});
		expect(await libraryFiles()).toEqual([pngRef, jpgRef].sort());
		// 原件自己存的图不进新代;只有 JSON。
		expect(await readdir(join(sandbox.target, "history", "repush", LIVE_DAY))).toEqual([
			`${id}.json`,
		]);
		expect(report.transfers).toEqual(
			expect.arrayContaining([
				{
					from: `history/repush/${LIVE_DAY}/${id}-0-0.jpg`,
					to: `images/${jpgRef}`,
					method: "copy",
				},
			]),
		);
		// 原件自己存的图当成输入、没进新代,记了一句(就一个文件,记的是它自己的路径)。
		expect(report.skipped).toContainEqual({
			path: `history/repush/${LIVE_DAY}/${id}-0-0.jpg`,
			reason: expect.stringContaining("重推原件自己存的图"),
		});
	});

	it("原件日目录里有好几个自存的图:合成一条记在这一层目录上,写明共几个", async () => {
		await sandbox.placeZeroBytes(`history/repush/${LIVE_DAY}/a-0-0.png`, PNG_BYTES);
		await sandbox.placeZeroBytes(`history/repush/${LIVE_DAY}/a-0-1.png`, distinctPng(2));
		await sandbox.placeZeroBytes(`history/repush/${LIVE_DAY}/a-0-2.png`, distinctPng(3));
		const report = await sandbox.migrate({ now: NOW });

		expect(report.skipped).toContainEqual({
			path: `history/repush/${LIVE_DAY}`,
			reason: expect.stringMatching(/重推原件自己存的图.*共 3 个/),
		});
	});

	it("有一张图读不到:这份原件整份不搬(从新代里删,transfers 里也没有),别的原件照搬;记一句", async () => {
		const bad = randomUUID();
		const good = randomUUID();
		await sandbox.placeZeroBytes("history/img/ok.png", PNG_BYTES);
		await sandbox.placeZero(snapshotPath(LIVE_DAY, bad), {
			v: 1,
			messages: [
				{ payload: { kind: "image", image: { ref: "ok.png", mime: "image/png" } }, role: "main" },
				{
					payload: { kind: "image", image: { ref: "gone.png", mime: "image/png" } },
					role: "extra",
				},
			],
		});
		await sandbox.placeZero(snapshotPath(LIVE_DAY, good), {
			v: 1,
			messages: [{ payload: { kind: "text", text: "纯文字" }, role: "main" }],
		});
		const report = await sandbox.migrate({ now: NOW });

		expect(await readdir(join(sandbox.target, "history", "repush", LIVE_DAY))).toEqual([
			`${good}.json`,
		]);
		expect(report.transfers.map((t) => t.to)).not.toContain(snapshotPath(LIVE_DAY, bad));
		expect(report.transfers.map((t) => t.to)).toContain(snapshotPath(LIVE_DAY, good));
		expect(report.skipped).toContainEqual({
			path: "history/repush",
			reason: expect.stringMatching(/1 份重推原件.*整份没带过来/),
		});
		// 第 0 代那份不动。
		expect(await readdir(join(sandbox.zero, "history", "repush", LIVE_DAY))).toContain(
			`${bad}.json`,
		);
	});

	it("原件的名字想跑出目录(own 的 ref 带路径):读不到,整份作废", async () => {
		const id = randomUUID();
		await sandbox.placeZeroBytes("secret.png", PNG_BYTES);
		await sandbox.placeZero(snapshotPath(LIVE_DAY, id), {
			v: 1,
			messages: [
				{
					payload: {
						kind: "image",
						image: { ref: "../../../secret.png", mime: "image/png", own: true },
					},
					role: "main",
				},
			],
		});
		await sandbox.migrate({ now: NOW });

		expect(await readdir(join(sandbox.target, "history", "repush", LIVE_DAY))).toEqual([]);
		expect(await libraryFiles()).toEqual([]);
	});

	it("已经是引用的图格原样(对新代再迁不改字节);纯文字原件只改 v → version", async () => {
		const id = randomUUID();
		const REF = `${"e".repeat(64)}.png`;
		const text = JSON.stringify({
			version: 1,
			messages: [{ payload: { kind: "image", image: REF }, role: "main" }],
		});
		await sandbox.placeZeroText(snapshotPath(LIVE_DAY, id), text);
		await sandbox.migrate({ now: NOW });

		expect(await readFile(join(sandbox.target, snapshotPath(LIVE_DAY, id)), "utf8")).toBe(text);
	});

	it("过了保留期的原件整天不带过来,里面的图当然也不读", async () => {
		const id = randomUUID();
		await sandbox.placeZero(snapshotPath(EXPIRED_DAY, id), {
			v: 1,
			messages: [
				{ payload: { kind: "image", image: { ref: "old.png", mime: "image/png" } }, role: "main" },
			],
		});
		const report = await sandbox.migrate({ now: NOW });

		expect(await readdir(join(sandbox.target, "history", "repush")).catch(() => [])).toEqual([]);
		// 这一份不是「读不到图被作废」的那种:是过了保留期,记的是天数那一句。
		expect(report.skipped).toContainEqual({
			path: "history/repush",
			reason: expect.stringMatching(/1 天.*保留期/),
		});
	});
});

describe("账:没搬的按数量各记一句", () => {
	it("历史图目录是输入;过期的、孤儿、对不上的各一句;保留期内被引用的复制过来、记在搬过去的里", async () => {
		await sandbox.placeZeroBytes("history/img/kept.png", PNG_BYTES);
		await sandbox.placeZeroBytes("history/img/expired.png", distinctPng(5));
		await sandbox.placeZeroBytes("history/img/orphan1.png", distinctPng(6));
		await sandbox.placeZeroBytes("history/img/orphan2.png", distinctPng(7));
		await writeDay(EXPIRED_DAY, [row(EXPIRED_DAY, imagePayload("expired.png"))]);
		await writeDay(LIVE_DAY, [
			row(LIVE_DAY, imagePayload("kept.png")),
			row(LIVE_DAY, imagePayload("missing.png")),
		]);
		const report = await sandbox.migrate({ now: NOW });

		const historyImg = report.skipped.filter((s) => s.path === "history/img").map((s) => s.reason);
		expect(historyImg).toEqual([
			expect.stringContaining("不整目录进新代"),
			expect.stringMatching(/1 张历史图只被过了保留期的行引用/),
			expect.stringMatching(/2 张历史图没有任何一行历史或重推原件引用/),
			expect.stringMatching(/1 张历史图对不上/),
		]);
		expect(report.transfers.filter((t) => t.from.startsWith("history/img/"))).toEqual([
			{
				from: "history/img/kept.png",
				to: `images/${refOfBytes(PNG_BYTES, "png")}`,
				method: "copy",
			},
		]);
	});
});

describe("迁出来的一代:真的历史仓、重推原件仓、图库读得通", () => {
	it("行里的图读得出来(图库 read);重推原件 load 读得回原字节与 mime", async () => {
		const id = randomUUID();
		await sandbox.placeZeroBytes("history/img/card.png", PNG_BYTES);
		await sandbox.placeZeroBytes(`history/repush/${LIVE_DAY}/${id}-0-1.jpg`, JPEG_BYTES);
		const entry = row(LIVE_DAY, imagePayload("card.png"), { id });
		await writeDay(LIVE_DAY, [entry]);
		await sandbox.placeZero(`history/repush/${LIVE_DAY}/${id}.json`, {
			v: 1,
			messages: [
				{
					payload: {
						kind: "composite",
						segments: [
							{ type: "image", image: { ref: "card.png", mime: "image/png" } },
							{ type: "image", image: { ref: `${id}-0-1.jpg`, mime: "image/jpeg", own: true } },
						],
					},
					role: "main",
				},
			],
		});
		await sandbox.migrate({ now: NOW });

		const library = makeHistoryImages(sandbox.target);
		const history = createHistoryStore({
			dataRoot: sandbox.target,
			bus: createNodeMessageBus(),
			logger: silentLogger,
			images: library.historyImages,
		});
		const [row0] = await history.query({});
		const ref = row0?.messages[0]?.payload.image ?? "";
		expect((await library.imageStore.read(ref))?.mime).toBe("image/png");

		const repush = createRepushStore({
			dataRoot: sandbox.target,
			logger: silentLogger,
			images: library.repushImages,
			imageStore: library.imageStore,
		});
		const draft = await repush.load(id, `${LIVE_DAY}T08:00:00.000Z`, 1);
		const payload = draft?.messages[0]?.payload;
		if (payload?.kind !== "composite") throw new Error("kind");
		const images = payload.segments.flatMap((seg) => (seg.kind === "image" ? [seg] : []));
		expect(images.map((i) => i.mime)).toEqual(["image/png", "image/jpeg"]);
		expect(new Uint8Array(images[1]?.buffer ?? [])).toEqual(new Uint8Array(JPEG_BYTES));
	});

	it("迁出来的图库引用,图库自己的清扫在宽限期后仍认得:历史行 + 原件引用着,一张不删", async () => {
		const id = randomUUID();
		await sandbox.placeZeroBytes("history/img/card.png", PNG_BYTES);
		await writeDay(LIVE_DAY, [row(LIVE_DAY, imagePayload("card.png"), { id })]);
		await sandbox.placeZero(`history/repush/${LIVE_DAY}/${id}.json`, {
			v: 1,
			messages: [
				{ payload: { kind: "image", image: { ref: "card.png", mime: "image/png" } }, role: "main" },
			],
		});
		await sandbox.migrate({ now: NOW });

		// 图的修改时间是文件系统的真时钟:清扫的时钟拨到真的「宽限期之后」。
		const library = makeHistoryImages(sandbox.target);
		const swept = await library.imageStore.sweep({
			now: new Date(Date.now() + IMAGE_GRACE_MS + 60 * 60 * 1000),
		});
		expect(swept).toMatchObject({ removed: [], referenced: 1 });
	});
});
