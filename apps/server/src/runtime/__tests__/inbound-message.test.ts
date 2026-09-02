/**
 * 群消息文本抽取 —— 链接解析看到的「正文」到底是什么。
 *
 * 用 B 站 App 的「分享到 QQ」把视频发进群,OneBot 交过来的是一张卡(json / xml 段),
 * 正文里一个字都没有;链接就藏在卡的字段里。只取 text 段的话,这条最常见的分享方式
 * 一个字都看不见,机器人静默不动,主人只会以为功能没开。私聊那条(指令入口)不吃卡片。
 */

import { describe, expect, it } from "vite-plus/test";
import { extractGroupMessage, extractPrivateMessage } from "../inbound-message.js";

const BASE = { post_type: "message", message_type: "group", group_id: 123456, user_id: 20002 };

/** B 站 App「分享到 QQ」发出的小程序卡(抓包样子,字段有删减),链接在 meta.detail_1.qqdocurl。 */
const MINIAPP_CARD = JSON.stringify({
	app: "com.tencent.miniapp_01",
	desc: "哔哩哔哩",
	prompt: "[QQ小程序]哔哩哔哩",
	meta: {
		detail_1: {
			appid: "1109937557",
			title: "哔哩哔哩",
			desc: "示例标题",
			preview: "pubminishare-30161.picsz.qpic.cn/xxx",
			url: "m.q.qq.com/a/s/abcdef",
			qqdocurl: "https://b23.tv/AbCdEf?share_medium=android&share_source=qq",
		},
	},
});

describe("extractGroupMessage — 分享卡里的链接也算贴了链接", () => {
	it("B 站小程序分享卡(json 段,正文为空)→ 卡里的 b23 链接", () => {
		const got = extractGroupMessage({
			...BASE,
			message: [{ type: "json", data: { data: MINIAPP_CARD } }],
			raw_message: "[CQ:json,data=…]",
		});
		expect(got?.text).toBe("https://b23.tv/AbCdEf?share_medium=android&share_source=qq");
	});

	it("结构化消息卡(jumpUrl 带 JSON 的 \\/ 转义)→ 还原成正常链接", () => {
		const card =
			'{"app":"com.tencent.structmsg","meta":{"news":{"jumpUrl":"https:\\/\\/b23.tv\\/XyZ?p=1","title":"t"}}}';
		const got = extractGroupMessage({
			...BASE,
			message: [{ type: "json", data: { data: card } }],
		});
		expect(got?.text).toBe("https://b23.tv/XyZ?p=1");
	});

	it("正文 + 卡片同在一条里:正文保留,卡里的链接接在后面", () => {
		const got = extractGroupMessage({
			...BASE,
			message: [
				{ type: "text", data: { text: "看这个" } },
				{ type: "json", data: { data: MINIAPP_CARD } },
			],
		});
		expect(got?.text).toBe("看这个 https://b23.tv/AbCdEf?share_medium=android&share_source=qq");
	});

	it("xml 卡:url 属性里的 &amp; 还原成 &", () => {
		const got = extractGroupMessage({
			...BASE,
			message: [
				{
					type: "xml",
					data: {
						data: '<?xml version="1.0"?><msg url="https://www.bilibili.com/video/BV1zMtU6uEEb?p=1&amp;t=2" />',
					},
				},
			],
		});
		expect(got?.text).toBe("https://www.bilibili.com/video/BV1zMtU6uEEb?p=1&t=2");
	});

	it("卡里没有链接 → 没有正文,当没这条消息", () => {
		const got = extractGroupMessage({
			...BASE,
			message: [{ type: "json", data: { data: '{"app":"x","meta":{"a":"没有链接"}}' } }],
		});
		expect(got).toBeNull();
	});

	it("字符串格式的 message(老客户端)与 raw_message 一样要还原 CQ 转义", () => {
		const got = extractGroupMessage({
			...BASE,
			message: "&#91;看&#93; https://www.bilibili.com/video/BV1zMtU6uEEb?a=1&amp;b=2",
		});
		expect(got?.text).toBe("[看] https://www.bilibili.com/video/BV1zMtU6uEEb?a=1&b=2");
	});

	it("私聊里的分享卡不算 —— 指令入口只认文字", () => {
		const got = extractPrivateMessage({
			post_type: "message",
			message_type: "private",
			user_id: 10001,
			message: [{ type: "json", data: { data: MINIAPP_CARD } }],
		});
		expect(got).toBeNull();
	});
});
