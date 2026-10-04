/**
 * 0.x 的聊天附件 `assets/chat/*` 进图库(ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗,⑳b)。
 *
 * 不再整目录搬:被会话引用的附件逐个读字节、按嗅探认格式,是图库收的图就**复制**(不硬链接:图库靠刷新
 * 修改时间做宽限期,硬链接会改到第 0 代那份)到新代的 `images/<sha256>.<ext>`,会话里的旧 id 换成引用;
 * 对不上的(文件不在、嗅探不过、超 8MB、路径不对)从消息里拿掉;没有任何会话引用的附件(孤儿)不搬。
 * 搬的记进 `transfers`、没搬的按数量记进 `skipped`,第 0 代一个字节不动。
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { JPEG_BYTES, PNG_BYTES, WEBP_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import {
	CONVERSATIONS_DIR,
	type ConversationStore,
	createConversationStore,
} from "../../ai/conversation-store.js";
import { IMAGE_MAX_BYTES } from "../../images/image-store.js";
import { createChatAttachmentMigrator } from "../chat-attachments.js";
import { migrateConversationFiles } from "../conversations.js";
import { useZeroSandbox } from "./support.js";

const sandbox = useZeroSandbox("bn-zero-chat-attachments-");

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** 0.x 的附件 id:32 位 hex + 后缀。 */
const oldId = (n: number, ext = "png") => `${n.toString(16).padStart(32, "0")}.${ext}`;

const BASE = {
	title: "看图",
	createdAt: "2026-08-17T00:00:00.000Z",
	updatedAt: "2026-08-17T00:00:00.000Z",
	mode: "chat",
	persona: true,
	skinTarget: "dashboard",
} as const;

async function placeAttachment(id: string, bytes: Uint8Array | string): Promise<void> {
	const path = join(sandbox.zero, "assets", "chat", id);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, bytes);
}

/** 摆一份引用着若干附件的 0.x 会话:每条图一条用户消息(`images` 是几个就写几个)。 */
async function placeChat(id: string, ...messages: Array<{ images: unknown }>): Promise<void> {
	await sandbox.placeZero(`ai/chat/${id}.json`, {
		id,
		...BASE,
		messages: messages.map((m, i) => ({
			id: `m${i}`,
			role: "user",
			content: `第 ${i + 1} 条`,
			ts: "2026-08-17T00:00:00.000Z",
			...m,
		})),
	});
}

const imagesDir = () => join(sandbox.target, "images");
const readImagesDir = async () => (await readdir(imagesDir()).catch(() => [])).sort();
const readChat = async (id: string) =>
	JSON.parse(await readFile(join(sandbox.target, ...CONVERSATIONS_DIR, `${id}.json`), "utf8")) as {
		messages: Array<{ images?: unknown }>;
	};

describe("被会话引用的附件", () => {
	it("复制进图库 images/<sha256>.<ext>(不是硬链接),会话里的旧 id 换成引用,搬的记进 transfers", async () => {
		const id = oldId(1);
		await placeAttachment(id, PNG_BYTES);
		await placeChat("c1", { images: [id] });

		const report = await sandbox.migrate();

		const ref = `${sha256(PNG_BYTES)}.png`;
		expect(await readImagesDir()).toEqual([ref]);
		expect(new Uint8Array(await readFile(join(imagesDir(), ref)))).toEqual(
			new Uint8Array(PNG_BYTES),
		);
		// 复制:另一个 inode,新代以后刷新修改时间不会改到第 0 代那份。
		expect((await stat(join(imagesDir(), ref))).ino).not.toBe(
			(await stat(join(sandbox.zero, "assets", "chat", id))).ino,
		);
		expect((await readChat("c1")).messages[0]?.images).toEqual([ref]);
		expect(report.transfers).toContainEqual({
			from: `assets/chat/${id}`,
			to: `images/${ref}`,
			method: "copy",
		});
		expect(report.rewritten).toContain("ai/conversations/c1.json");
		// 整目录不再原样搬进新代。
		expect(await readdir(join(sandbox.target, "assets")).catch(() => [])).toEqual([]);
	});

	it("扩展名按嗅探定,不看旧文件名:jpeg 叫 jpg,webp 照旧", async () => {
		const jpeg = oldId(2, "jpeg");
		const webp = oldId(3, "webp");
		await placeAttachment(jpeg, JPEG_BYTES);
		await placeAttachment(webp, WEBP_BYTES);
		await placeChat("c1", { images: [jpeg, webp] });

		await sandbox.migrate();

		expect((await readChat("c1")).messages[0]?.images).toEqual([
			`${sha256(JPEG_BYTES)}.jpg`,
			`${sha256(WEBP_BYTES)}.webp`,
		]);
	});

	it("内容一样的两个附件在图库里只有一份,两条 transfers 各记自己的旧路径", async () => {
		const a = oldId(4);
		const b = oldId(5);
		await placeAttachment(a, PNG_BYTES);
		await placeAttachment(b, PNG_BYTES);
		await placeChat("c1", { images: [a] }, { images: [b, a] });

		const report = await sandbox.migrate();

		const ref = `${sha256(PNG_BYTES)}.png`;
		expect(await readImagesDir()).toEqual([ref]);
		expect(report.transfers.filter((t) => t.to === `images/${ref}`).map((t) => t.from)).toEqual([
			`assets/chat/${a}`,
			`assets/chat/${b}`,
		]);
		// 同一条消息里两个旧 id 指到同一张图,只留一个引用。
		expect((await readChat("c1")).messages.map((m) => m.images)).toEqual([[ref], [ref]]);
	});
});

describe("带不过来的附件", () => {
	it("没有任何会话引用的附件(孤儿)不搬,按数量记一句", async () => {
		const used = oldId(1);
		await placeAttachment(used, PNG_BYTES);
		await placeAttachment(oldId(2), JPEG_BYTES);
		await placeAttachment(oldId(3), WEBP_BYTES);
		await placeChat("c1", { images: [used] });

		const report = await sandbox.migrate();

		expect(await readImagesDir()).toEqual([`${sha256(PNG_BYTES)}.png`]);
		expect(report.skipped).toContainEqual({
			path: "assets/chat",
			reason: "2 张聊天附件没有任何会话引用,没带过来",
		});
	});

	it("上传闸之前的残留(临时文件)不算孤儿", async () => {
		await placeAttachment(oldId(1), PNG_BYTES);
		await placeAttachment(`${oldId(2)}.bn-tmp.1.abc`, "half");
		await placeChat("c1", { images: [oldId(1)] });

		const report = await sandbox.migrate();

		expect(report.skipped.some((s) => s.reason.includes("没有任何会话引用"))).toBe(false);
	});

	it("被引用却对不上的(文件不在、不是图库收的图、超 8MB、软链、路径不对)从消息里拿掉,别的原样", async () => {
		const good = oldId(1);
		const text = oldId(2);
		const missing = oldId(3);
		const huge = oldId(4);
		const linked = oldId(5);
		await placeAttachment(good, PNG_BYTES);
		await placeAttachment(text, "<svg/>");
		const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
		big.set(PNG_BYTES);
		await placeAttachment(huge, big);
		// 挂在附件目录里的软链:不跟,哪怕指向的是一张好图。
		await writeFile(join(sandbox.zero, "outside.png"), PNG_BYTES);
		await symlink(join(sandbox.zero, "outside.png"), join(sandbox.zero, "assets", "chat", linked));
		// 路径穿越:指到附件目录外的一张好图,也不读。
		await writeFile(join(sandbox.zero, "assets", "secret.png"), JPEG_BYTES);
		await placeChat(
			"c1",
			{ images: [good, text, missing, huge, linked, "../secret.png", 42, null] },
			{ images: [text, "../../secrets/master.key"] },
			{ images: [] },
		);

		const report = await sandbox.migrate();

		const ref = `${sha256(PNG_BYTES)}.png`;
		expect(await readImagesDir()).toEqual([ref]);
		const [first, second, third] = (await readChat("c1")).messages;
		expect(first?.images).toEqual([ref]);
		// 一张都没留下:字段整个拿掉,会话库的约定是「没带图就缺席」。
		expect(second && "images" in second).toBe(false);
		expect(third && "images" in third).toBe(false);
		expect(report.skipped).toContainEqual({
			path: "assets/chat",
			reason:
				"6 张聊天附件对不上(文件不在、不是图库收的图、超过 8MB 或路径不对),已从引用它的消息里拿掉",
		});
	});

	it("连 assets/chat 目录都没有、会话却引用着图 → 都拿掉,不炸,也不建空的 images/", async () => {
		await placeChat("c1", { images: [oldId(1)] });

		await sandbox.migrate();

		const [message] = (await readChat("c1")).messages;
		expect(message && "images" in message).toBe(false);
		expect(await readImagesDir()).toEqual([]);
	});

	it("引用附件的文件读不成会话(坏文件)原样留着,它引用的附件算孤儿", async () => {
		const id = oldId(1);
		await placeAttachment(id, PNG_BYTES);
		await sandbox.placeZeroText(
			"ai/chat/broken.json",
			`{"id":"broken","messages":[null,{"images":["${id}"]}]}`,
		);

		const report = await sandbox.migrate();

		expect(await readImagesDir()).toEqual([]);
		expect(report.skipped.some((s) => s.reason.includes("1 张聊天附件没有任何会话引用"))).toBe(
			true,
		);
	});
});

describe("迁出来的新代", () => {
	it("会话库读得到新代里的引用,图库的读口读得到图", async () => {
		const id = oldId(1);
		await placeAttachment(id, PNG_BYTES);
		await placeChat("c1", { images: [id] });
		await sandbox.migrate();

		const store: ConversationStore = createConversationStore({
			dataRoot: sandbox.target,
			logger: silentLogger,
		});

		expect(await store.listImageRefs()).toEqual([`${sha256(PNG_BYTES)}.png`]);
	});

	it("对新代再迁一次什么都不改:已经是图库引用的条目原样留着,不去第 0 代找", async () => {
		const id = oldId(1);
		await placeAttachment(id, PNG_BYTES);
		await placeChat("c1", { images: [id] });
		await sandbox.migrate();
		const path = join(sandbox.target, ...CONVERSATIONS_DIR, "c1.json");
		const before = await readFile(path, "utf8");

		const again = createChatAttachmentMigrator({
			zeroDir: join(sandbox.zero, "assets", "chat"),
			imagesDir: imagesDir(),
		});
		expect(await migrateConversationFiles(sandbox.target, again)).toEqual([]);

		expect(await readFile(path, "utf8")).toBe(before);
		expect((await again.result()).dropped).toBe(0);
	});
});
