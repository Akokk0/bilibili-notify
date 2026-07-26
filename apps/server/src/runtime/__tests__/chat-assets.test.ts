/**
 * 单元测试 —— 聊天附件的本地资产存储。
 *
 * 与卡片背景图那套(card-assets)同形但**分开一份**:两者的生命周期完全不同 ——
 * 背景图是主人精心挑的、要长期留着的素材,聊天附件是随手一发、跟着会话生灭的。
 * 混在一个目录里,删会话时就没法只清自己那几张。
 *
 * 最要紧的一条是**路径穿越**。资产 id 会从 HTTP 请求原样进来,而 dataDir 里躺着
 * `bn.config.yaml`(带 apiKey / cookie)。id 校验是唯一那道闸,所以它值得被单独
 * 钉住,而不是指望每个调用点自己记得校验。
 */

import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
	chatImageDir,
	deleteChatImage,
	isValidChatImageId,
	readChatImage,
	readChatImageDataUrl,
	saveChatImage,
} from "../chat-assets.js";

let dataDir: string;
beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-chat-assets-"));
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("isValidChatImageId — 防穿越的唯一闸门", () => {
	it("放行规范 id", () => {
		expect(isValidChatImageId("0123456789abcdef0123456789abcdef.png")).toBe(true);
		expect(isValidChatImageId("0123456789abcdef0123456789abcdef.jpg")).toBe(true);
		expect(isValidChatImageId("0123456789abcdef0123456789abcdef.webp")).toBe(true);
	});

	it("挡住路径穿越 —— dataDir 里躺着带 apiKey / cookie 的配置文件", () => {
		for (const evil of [
			"../../config/bn.config.yaml",
			"../card-bg/0123456789abcdef0123456789abcdef.png",
			"/etc/passwd",
			"..%2F..%2Fbn.config.yaml",
			"0123456789abcdef0123456789abcdef.png/../../x",
		]) {
			expect(isValidChatImageId(evil)).toBe(false);
		}
	});

	it("挡住非白名单扩展名与畸形 id", () => {
		expect(isValidChatImageId("0123456789abcdef0123456789abcdef.svg")).toBe(false);
		expect(isValidChatImageId("0123456789abcdef0123456789abcdef.html")).toBe(false);
		expect(isValidChatImageId("short.png")).toBe(false);
		expect(isValidChatImageId("")).toBe(false);
	});
});

describe("saveChatImage — 落盘", () => {
	it("存下来并返回一个合法 id", async () => {
		const id = await saveChatImage(dataDir, PNG, "image/png");
		expect(isValidChatImageId(id)).toBe(true);
		expect(await readdir(chatImageDir(dataDir))).toEqual([id]);
	});

	it("非图片类型直接拒 —— SVG 能带脚本,不进白名单", async () => {
		await expect(saveChatImage(dataDir, PNG, "image/svg+xml")).rejects.toThrow(/不支持/);
		await expect(saveChatImage(dataDir, PNG, "text/html")).rejects.toThrow(/不支持/);
	});

	it("超过 5MB 拒收", async () => {
		const huge = new Uint8Array(5 * 1024 * 1024 + 1);
		await expect(saveChatImage(dataDir, huge, "image/png")).rejects.toThrow(/过大/);
	});

	it("两次上传同一张图也得到不同 id —— 删一个不该带走另一个", async () => {
		const a = await saveChatImage(dataDir, PNG, "image/png");
		const b = await saveChatImage(dataDir, PNG, "image/png");
		expect(a).not.toBe(b);
	});
});

describe("readChatImageDataUrl — 转 data URL 给视觉模型", () => {
	it("读回 base64 data URL", async () => {
		const id = await saveChatImage(dataDir, PNG, "image/png");
		const url = await readChatImageDataUrl(dataDir, id);
		// 视觉服务商在公网,拉不到主人本地的地址 —— 只能把字节本身带过去。
		expect(url.startsWith("data:image/png;base64,")).toBe(true);
		expect(url).toContain(Buffer.from(PNG).toString("base64"));
	});

	it("非法 id / 不存在的文件 → 空串,不抛", async () => {
		expect(await readChatImageDataUrl(dataDir, "../../bn.config.yaml")).toBe("");
		expect(await readChatImageDataUrl(dataDir, "0123456789abcdef0123456789abcdef.png")).toBe("");
		expect(await readChatImageDataUrl(dataDir, "")).toBe("");
	});

	it("绝不读到资产目录外的文件 —— dataDir 根上就躺着带 apiKey 的配置", async () => {
		// 资产目录是 `<dataDir>/assets/chat`,所以要够到 `<dataDir>/bn.config.yaml`
		// 得**上跳两层**。层数写少一层的话,拼出来的路径压根不存在,于是拆掉 id
		// 校验测试也照样绿 —— 这条断言就成了摆设。(第一版正是这么写错的。)
		await writeFile(join(dataDir, "bn.config.yaml"), "apiKey: sk-secret");

		expect(await readChatImageDataUrl(dataDir, "../../bn.config.yaml")).toBe("");
		expect(await readChatImage(dataDir, "../../bn.config.yaml")).toBeNull();
	});
});

describe("deleteChatImage — 幂等删除", () => {
	it("删掉存在的图返回 true,文件消失", async () => {
		const id = await saveChatImage(dataDir, PNG, "image/png");
		expect(await deleteChatImage(dataDir, id)).toBe(true);
		expect(await readdir(chatImageDir(dataDir))).toEqual([]);
	});

	it("重复删 / 非法 id 返回 false,不抛", async () => {
		const id = await saveChatImage(dataDir, PNG, "image/png");
		await deleteChatImage(dataDir, id);
		expect(await deleteChatImage(dataDir, id)).toBe(false);
		expect(await deleteChatImage(dataDir, "../../bn.config.yaml")).toBe(false);
	});
});
