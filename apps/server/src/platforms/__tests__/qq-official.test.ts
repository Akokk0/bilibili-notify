import type { NotificationPayload } from "@bilibili-notify/internal";
import { describe, expect, it } from "vitest";
import {
	buildQQFileUpload,
	buildQQMarkdownGallery,
	buildQQV2MarkdownMessage,
	buildQQV2Message,
	QQ_MSG_TYPE,
	qqMessageEndpoint,
	qqPayloadToParts,
} from "../qq-official";

describe("qqMessageEndpoint — target scope → 发消息 REST 路径", () => {
	it("channel → /channels/{channelId}/messages", () => {
		expect(qqMessageEndpoint("channel", { channelId: "c1" })).toEqual({
			path: "/channels/c1/messages",
		});
	});

	it("group → /v2/groups/{groupOpenid}/messages", () => {
		expect(qqMessageEndpoint("group", { groupOpenid: "G123" })).toEqual({
			path: "/v2/groups/G123/messages",
		});
	});

	it("private(C2C) → /v2/users/{userOpenid}/messages", () => {
		expect(qqMessageEndpoint("private", { userOpenid: "U456" })).toEqual({
			path: "/v2/users/U456/messages",
		});
	});

	it("channel 缺 channelId → err(运行期校验,不发注定失败的 REST)", () => {
		expect(qqMessageEndpoint("channel", {})).toEqual({ err: "channel: channelId missing" });
	});

	it("group 缺 groupOpenid → err", () => {
		expect(qqMessageEndpoint("group", {})).toEqual({ err: "group: groupOpenid missing" });
	});

	it("private 缺 userOpenid → err", () => {
		expect(qqMessageEndpoint("private", {})).toEqual({ err: "private: userOpenid missing" });
	});
});

describe("buildQQFileUpload — 群/C2C 富媒体上传体", () => {
	it("image Buffer → file_type 1 + srv_send_msg false + base64 file_data(命门:自包含不需公网 URL)", () => {
		const buf = Buffer.from([1, 2, 3, 4, 250, 200]);
		expect(buildQQFileUpload(buf)).toEqual({
			file_type: 1,
			srv_send_msg: false,
			file_data: buf.toString("base64"),
		});
	});
});

describe("buildQQV2Message — 群/C2C 消息体", () => {
	it("纯文本 → content + msg_type 0(TEXT)", () => {
		expect(buildQQV2Message({ content: "阿绫发布了一条动态" })).toEqual({
			content: "阿绫发布了一条动态",
			msg_type: 0,
		});
	});

	it("media + content → media 消息(msg_type 7),content 作图说明,透传完整 /files 返回", () => {
		expect(
			buildQQV2Message({
				content: "看图",
				media: { file_uuid: "FUUID", file_info: "FINFO", ttl: 3600 },
			}),
		).toEqual({
			content: "看图",
			msg_type: 7,
			media: { file_uuid: "FUUID", file_info: "FINFO", ttl: 3600 },
		});
	});

	it("media 无 content → content 占位空格(QQ 要求 content 非空)", () => {
		expect(buildQQV2Message({ media: { file_info: "FINFO" } })).toEqual({
			content: " ",
			msg_type: 7,
			media: { file_info: "FINFO" },
		});
	});
});

describe("qqPayloadToParts — NotificationPayload → 有序发送片段", () => {
	it("text payload → 单个 text 片段", () => {
		const payload: NotificationPayload = { kind: "text", text: "你好" };
		expect(qqPayloadToParts(payload)).toEqual([{ kind: "text", text: "你好" }]);
	});

	it("image payload(卡片 Buffer)→ image-buffer 片段(带 caption)", () => {
		const buf = Buffer.from("png-bytes");
		const payload: NotificationPayload = {
			kind: "image",
			image: { buffer: buf, mime: "image/png" },
			caption: "阿绫开播了",
		};
		expect(qqPayloadToParts(payload)).toEqual([
			{ kind: "image-buffer", buffer: buf, caption: "阿绫开播了" },
		]);
	});

	it("forward-images(图集 URL)→ 多个 image-url 片段(QQ 无合并转发,展开成多条)", () => {
		const payload: NotificationPayload = {
			kind: "forward-images",
			images: [{ url: "https://i0.hdslb.com/a.jpg" }, { url: "https://i0.hdslb.com/b.jpg" }],
			forward: true,
		};
		expect(qqPayloadToParts(payload)).toEqual([
			{ kind: "image-url", url: "https://i0.hdslb.com/a.jpg" },
			{ kind: "image-url", url: "https://i0.hdslb.com/b.jpg" },
		]);
	});

	it("composite 的 image 后续 text/link → 合并为同一条 media content", () => {
		const buf = Buffer.from("card");
		const payload: NotificationPayload = {
			kind: "composite",
			segments: [
				{ type: "at-all" },
				{ type: "image", buffer: buf, mime: "image/png" },
				{ type: "text", text: "标题" },
				{ type: "link", href: "https://t.bilibili.com/1", title: "动态" },
			],
		};
		expect(qqPayloadToParts(payload)).toEqual([
			{ kind: "image-buffer", buffer: buf, caption: "标题\n动态 https://t.bilibili.com/1" },
		]);
	});

	it("composite 的前置 text 不并入后续图片(对齐 Koishi 先图后文)", () => {
		const buf = Buffer.from("card");
		const payload: NotificationPayload = {
			kind: "composite",
			segments: [
				{ type: "text", text: "前置" },
				{ type: "image", buffer: buf, mime: "image/png" },
				{ type: "text", text: "后置" },
			],
		};
		expect(qqPayloadToParts(payload)).toEqual([
			{ kind: "text", text: "前置" },
			{ kind: "image-buffer", buffer: buf, caption: "后置" },
		]);
	});

	it("composite 的 link 无 title → 仅 href", () => {
		const payload: NotificationPayload = {
			kind: "composite",
			segments: [{ type: "link", href: "https://t.bilibili.com/2" }],
		};
		expect(qqPayloadToParts(payload)).toEqual([{ kind: "text", text: "https://t.bilibili.com/2" }]);
	});
});

describe("buildQQMarkdownGallery — 图集合并成一条多图 markdown(私域绕过无合并转发)", () => {
	it("带尺寸 → `![图片 #宽px #高px](url)` 每行一图", () => {
		const md = buildQQMarkdownGallery([
			{ url: "https://i0.hdslb.com/a.jpg", width: 800, height: 600 },
			{ url: "https://i0.hdslb.com/b.jpg", width: 1080, height: 1920 },
		]);
		expect(md).toBe(
			"![图片 #800px #600px](https://i0.hdslb.com/a.jpg)\n" +
				"![图片 #1080px #1920px](https://i0.hdslb.com/b.jpg)",
		);
	});

	it("缺尺寸 → 退化为无尺寸 `![图片](url)`", () => {
		expect(buildQQMarkdownGallery([{ url: "https://x/a.jpg" }])).toBe("![图片](https://x/a.jpg)");
	});
});

describe("buildQQV2MarkdownMessage — 群/C2C 原生 markdown 消息体", () => {
	it("msg_type 2(MARKDOWN)+ markdown.content,不带顶层 content", () => {
		const body = buildQQV2MarkdownMessage("![图片](u)");
		expect(body).toEqual({ msg_type: QQ_MSG_TYPE.MARKDOWN, markdown: { content: "![图片](u)" } });
		expect("content" in body).toBe(false);
	});
});
