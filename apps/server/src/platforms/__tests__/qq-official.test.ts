import type { NotificationPayload } from "@bilibili-notify/internal";
import { describe, expect, it } from "vitest";
import {
	buildQQFileUpload,
	buildQQV2Message,
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

	it("fileInfo + content → media 消息(msg_type 7),content 作图说明", () => {
		expect(buildQQV2Message({ content: "看图", fileInfo: "FINFO" })).toEqual({
			content: "看图",
			msg_type: 7,
			media: { file_info: "FINFO" },
		});
	});

	it("fileInfo 无 content → content 占位空格(QQ 要求 content 非空)", () => {
		expect(buildQQV2Message({ fileInfo: "FINFO" })).toEqual({
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
			urls: ["https://i0.hdslb.com/a.jpg", "https://i0.hdslb.com/b.jpg"],
			forward: true,
		};
		expect(qqPayloadToParts(payload)).toEqual([
			{ kind: "image-url", url: "https://i0.hdslb.com/a.jpg" },
			{ kind: "image-url", url: "https://i0.hdslb.com/b.jpg" },
		]);
	});

	it("composite → 按段映射:image→image-buffer、text/link→text、at-all 跳过", () => {
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
			{ kind: "image-buffer", buffer: buf },
			{ kind: "text", text: "标题" },
			{ kind: "text", text: "动态 https://t.bilibili.com/1" },
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
