/**
 * 单元测试 — 特别弹幕 / 特别进场的装配:开关 → 名单(按 viewer.id 字符串比对)→ 套文案 → 交一条文字。
 * 只经两个入口函数验行为;发送是测试里绑的一个记录函数。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { pushViewerChat, pushViewerEnter } from "../special-viewers";

function danmaku(over: {
	enable?: boolean;
	users?: string[];
	msgTemplate?: string;
	viewerId?: string;
	text?: string;
	creatorName?: string;
}) {
	const send = vi.fn<(text: string) => void>();
	pushViewerChat(
		{
			viewer: { id: over.viewerId ?? "123", name: "小明" },
			text: over.text ?? "你好呀",
			settings: {
				enable: over.enable ?? true,
				specialDanmakuUsers: "users" in over ? over.users : ["123"],
				msgTemplate: over.msgTemplate ?? "-mastername 的直播间里 {uname} 说:-msg",
			},
			creator: { name: over.creatorName ?? "主播A" },
		},
		{ send },
	);
	return send;
}

function enter(over: {
	enable?: boolean;
	users?: string[];
	msgTemplate?: string;
	viewerId?: string;
	creatorName?: string;
}) {
	const send = vi.fn<(text: string) => void>();
	pushViewerEnter(
		{
			viewer: { id: over.viewerId ?? "123", name: "小明" },
			settings: {
				enable: over.enable ?? true,
				specialUsersEnterTheRoom: "users" in over ? over.users : ["123"],
				msgTemplate: over.msgTemplate ?? "{uname} 进入了 -mastername 的直播间",
			},
			creator: { name: over.creatorName ?? "主播A" },
		},
		{ send },
	);
	return send;
}

describe("pushViewerChat", () => {
	it("名单命中 → 交出套好文案的一句话(-key 与 {key} 两种写法)", () => {
		const send = danmaku({});
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith("主播A 的直播间里 小明 说:你好呀");
	});

	it("开关关着 → 不发", () => {
		expect(danmaku({ enable: false })).not.toHaveBeenCalled();
	});

	it("名单外的人 → 不发", () => {
		expect(danmaku({ viewerId: "999" })).not.toHaveBeenCalled();
	});

	it("没有名单 / 空名单 → 不发", () => {
		expect(danmaku({ users: undefined })).not.toHaveBeenCalled();
		expect(danmaku({ users: [] })).not.toHaveBeenCalled();
	});

	it("id 按字符串整串比对:名单里 123,1234 不命中", () => {
		expect(danmaku({ viewerId: "1234" })).not.toHaveBeenCalled();
		expect(danmaku({ viewerId: "123" })).toHaveBeenCalledTimes(1);
	});

	it("主播名给空串 → 那一格是空", () => {
		expect(
			danmaku({ creatorName: "", msgTemplate: "[-mastername] {uname}:-msg" }),
		).toHaveBeenCalledWith("[] 小明:你好呀");
	});

	it("弹幕正文里带占位符样子的字不被二次替换", () => {
		expect(
			danmaku({ text: "{uname}-mastername", msgTemplate: "-msg|{uname}" }),
		).toHaveBeenCalledWith("{uname}-mastername|小明");
	});
});

describe("pushViewerEnter", () => {
	it("名单命中 → 交出套好文案的一句话(-key 与 {key} 两种写法)", () => {
		const send = enter({});
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith("小明 进入了 主播A 的直播间");
	});

	it("开关关着 → 不发", () => {
		expect(enter({ enable: false })).not.toHaveBeenCalled();
	});

	it("名单外的人 → 不发", () => {
		expect(enter({ viewerId: "999" })).not.toHaveBeenCalled();
	});

	it("没有名单 / 空名单 → 不发", () => {
		expect(enter({ users: undefined })).not.toHaveBeenCalled();
		expect(enter({ users: [] })).not.toHaveBeenCalled();
	});

	it("id 按字符串整串比对:名单里 123,1234 不命中", () => {
		expect(enter({ viewerId: "1234" })).not.toHaveBeenCalled();
		expect(enter({ viewerId: "123" })).toHaveBeenCalledTimes(1);
	});

	it("主播名给空串 → 那一格是空", () => {
		expect(
			enter({ creatorName: "", msgTemplate: "{uname} 进了 -mastername" }),
		).toHaveBeenCalledWith("小明 进了 ");
	});
});
