/**
 * OneBot 帧 → 入站消息,adapter 这一层的归一化。
 *
 * 私聊那半边是审批 / 指令的入口;群那半边是链接解析的入口 —— 用 B 站 App 的「分享到 QQ」
 * 把视频发进群,OneBot 交过来的是一张卡(json / xml 段),正文里一个字都没有;链接就藏在
 * 卡的字段里。只取 text 段的话,这条最常见的分享方式一个字都看不见,机器人静默不动,
 * 主人只会以为功能没开。私聊那条(指令入口)不吃卡片。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import {
	extractGroupMessage,
	extractPrivateMessage,
	routeInboundFrame,
} from "../onebot-inbound.js";

const MASTER = 10001;

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
	it("B 站小程序分享卡(json 段,正文为空)→ 卡里的 b23 链接,正文留空", () => {
		const got = extractGroupMessage({
			...BASE,
			message: [{ type: "json", data: { data: MINIAPP_CARD } }],
			raw_message: "[CQ:json,data=…]",
		});
		expect(got).toEqual({
			groupId: "123456",
			userId: "20002",
			selfId: undefined,
			text: "",
			cardLinks: ["https://b23.tv/AbCdEf?share_medium=android&share_source=qq"],
		});
	});

	it("结构化消息卡(jumpUrl 带 JSON 的 \\/ 转义)→ 还原成正常链接", () => {
		const card =
			'{"app":"com.tencent.structmsg","meta":{"news":{"jumpUrl":"https:\\/\\/b23.tv\\/XyZ?p=1","title":"t"}}}';
		const got = extractGroupMessage({
			...BASE,
			message: [{ type: "json", data: { data: card } }],
		});
		expect(got?.cardLinks).toEqual(["https://b23.tv/XyZ?p=1"]);
	});

	it("正文 + 卡片同在一条里:正文还是正文,卡里的链接另放一格", () => {
		const got = extractGroupMessage({
			...BASE,
			message: [
				{ type: "text", data: { text: "看这个" } },
				{ type: "json", data: { data: MINIAPP_CARD } },
			],
		});
		expect(got?.text).toBe("看这个");
		expect(got?.cardLinks).toEqual(["https://b23.tv/AbCdEf?share_medium=android&share_source=qq"]);
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
		expect(got?.cardLinks).toEqual(["https://www.bilibili.com/video/BV1zMtU6uEEb?p=1&t=2"]);
	});

	it("卡里没有链接、也没正文 → 当没这条消息", () => {
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
		expect(got?.cardLinks).toEqual([]);
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

describe("extractPrivateMessage", () => {
	it("群消息不算 —— 群里有人打个 y 不该把待审的周报发出去", () => {
		expect(
			extractPrivateMessage({
				post_type: "message",
				message_type: "group",
				user_id: MASTER,
				raw_message: "y",
			}),
		).toBeNull();
	});

	it("非消息事件(心跳 / 通知)不算", () => {
		expect(
			extractPrivateMessage({ post_type: "meta_event", meta_event_type: "heartbeat" }),
		).toBeNull();
	});

	it("段数组只取 text 段拼起来 —— 客户端可能捎带别的段", () => {
		const got = extractPrivateMessage({
			post_type: "message",
			message_type: "private",
			user_id: 10001,
			message: [
				{ type: "reply", data: { id: "1" } },
				{ type: "text", data: { text: "y a3" } },
			],
		});
		expect(got).toEqual({ userId: "10001", text: "y a3" });
	});

	// 真实客户端**两个字段都发**:raw_message 是裹着 CQ 码的字符串。它曾经
	// 只要非空就抢跑,段数组的容错路径永远轮不到 —— 主人在手机上长按引用草稿
	// 回 "y",拿到的 text 是 "[CQ:reply,id=…]y",y/n 和指令全认不出。
	it("段数组与 raw_message 并存 → 段数组优先,reply 段不进 text", () => {
		const got = extractPrivateMessage({
			post_type: "message",
			message_type: "private",
			user_id: 10001,
			raw_message: "[CQ:reply,id=123]y",
			message: [
				{ type: "reply", data: { id: "123" } },
				{ type: "text", data: { text: "y" } },
			],
		});
		expect(got).toEqual({ userId: "10001", text: "y" });
	});

	it("只有 raw_message(无段数组的老客户端)→ 仍可用,且 CQ 转义要还原", () => {
		const got = extractPrivateMessage({
			post_type: "message",
			message_type: "private",
			user_id: 10001,
			raw_message: "&#91;测试&#93; a &amp; b",
		});
		expect(got).toEqual({ userId: "10001", text: "[测试] a & b" });
	});
});

describe("routeInboundFrame — 一帧至多进一路,没接的那路连解析都不做", () => {
	const meta = { adapterId: "a1" };
	const priv = { post_type: "message", message_type: "private", user_id: 7, raw_message: "y" };
	const group = { ...BASE, self_id: 1, message: [{ type: "text", data: { text: "hi" } }] };

	it("私聊进 onInboundPrivate,群进 onInboundGroup,都带 meta", () => {
		const onInboundPrivate = vi.fn();
		const onInboundGroup = vi.fn();
		routeInboundFrame(priv, meta, { onInboundPrivate, onInboundGroup });
		routeInboundFrame(group, meta, { onInboundPrivate, onInboundGroup });
		expect(onInboundPrivate).toHaveBeenCalledWith({ userId: "7", text: "y" }, meta);
		expect(onInboundGroup).toHaveBeenCalledWith(
			{ groupId: "123456", userId: "20002", selfId: "1", text: "hi", cardLinks: [] },
			meta,
		);
		expect(onInboundPrivate).toHaveBeenCalledTimes(1);
		expect(onInboundGroup).toHaveBeenCalledTimes(1);
	});

	it("只接了一路 → 另一种消息静默丢掉;心跳谁都不进", () => {
		const onInboundPrivate = vi.fn();
		routeInboundFrame(group, meta, { onInboundPrivate });
		routeInboundFrame({ post_type: "meta_event", meta_event_type: "heartbeat" }, meta, {
			onInboundPrivate,
			onInboundGroup: vi.fn(),
		});
		expect(onInboundPrivate).not.toHaveBeenCalled();
	});
});
