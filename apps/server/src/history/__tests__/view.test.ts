/**
 * 历史行 → wire view(`toHistoryView`)。REST 列表与 WS 两个事件共用这一处投影。
 *
 * 钉的是行的身份(ADR-0019 决策 73)一路送到面板:这里一格格抄字段,漏抄 `identity` 的话面板收到的就是
 * 一行「谁也不是」的行 —— 类型、写入测试都照样绿。
 */

import type { HistoryEntry } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { toHistoryView } from "../view.js";

const ROW: HistoryEntry = {
	id: "11111111-1111-4111-8111-111111111111",
	pushId: "22222222-2222-4222-8222-222222222222",
	createdAt: "2026-09-24T00:00:00.000Z",
	feature: "post",
	identity: { sourceKey: "bilibili", externalId: "u1" },
	subscriptionId: "33333333-3333-4333-8333-333333333333",
	targetId: null,
	status: "no-targets",
	messages: [{ payload: { kind: "text", text: "作品" }, role: "main" }],
};

describe("toHistoryView — 行的身份", () => {
	it("拓展行:来源键(拓展 id)与外部 id 带到面板", () => {
		const view = toHistoryView({
			...ROW,
			identity: { sourceKey: "douyin", externalId: "123" },
			nameSnapshot: "某抖音号",
		});
		expect(view).toMatchObject({
			identity: { sourceKey: "douyin", externalId: "123" },
			nameSnapshot: "某抖音号",
		});
	});

	it("B 站行:来源键 bilibili、外部 id 就是 uid", () => {
		const view = toHistoryView(ROW);
		expect(view.identity).toEqual({ sourceKey: "bilibili", externalId: "u1" });
	});

	it("建行时刻叫 createdAt,重投标记叫 repushOf —— 老名字不再出现在视图上", () => {
		const view = toHistoryView({
			...ROW,
			messages: [
				{ payload: { kind: "text", text: "作品" }, role: "main" },
				{ payload: { kind: "text", text: "作品" }, role: "main", repushOf: 0 },
			],
		});
		expect(view.createdAt).toBe(ROW.createdAt);
		expect(view).not.toHaveProperty("ts");
		expect(view.messages[0]).not.toHaveProperty("repushOf");
		expect(view.messages[1]).toMatchObject({ repushOf: 0 });
		expect(view.messages[1]).not.toHaveProperty("retryOf");
	});
});

describe("toHistoryView — 图都是图库引用(⑳d)", () => {
	const IMAGE = `${"a".repeat(64)}.png`;
	const AVATAR = `${"b".repeat(64)}.webp`;

	it("消息带 kind 与配图引用(image),行带头像快照(avatarSnapshot);老名字 imageRef / uavatarSnapshot 不再出现", () => {
		const view = toHistoryView({
			...ROW,
			messages: [
				{ payload: { kind: "image", text: "[卡片图]", image: IMAGE }, role: "main" },
				{ payload: { kind: "text", text: "总结" }, role: "extra" },
			],
			avatarSnapshot: AVATAR,
		});
		expect(view.messages[0]).toMatchObject({ kind: "image", image: IMAGE, text: "[卡片图]" });
		expect(view.messages[1]).toMatchObject({ kind: "text", text: "总结" });
		expect(view.messages[1]?.image).toBeUndefined();
		expect(view.avatarSnapshot).toBe(AVATAR);
		expect(view.messages[0]).not.toHaveProperty("imageRef");
		expect(view).not.toHaveProperty("uavatarSnapshot");
	});

	// 过期的老行迁移时图格被拿掉,只剩 `kind: "image"`:面板靠它在原来画图的位置写「图已清理」。
	it("图格被迁移拿掉的老行:没有 image,kind 仍说它本来是图", () => {
		const view = toHistoryView({
			...ROW,
			messages: [{ payload: { kind: "image", text: "[卡片图]" }, role: "main" }],
		});
		expect(view.messages[0]?.kind).toBe("image");
		expect(view.messages[0]?.image).toBeUndefined();
	});
});

describe("toHistoryView — 被静音 / 免扰挡下的行", () => {
	it("状态与消息上的 isSilenced 带到面板;没被挡的消息不带这一格", () => {
		const view = toHistoryView({
			...ROW,
			targetId: "44444444-4444-4444-8444-444444444444",
			status: "silenced",
			messages: [
				{ payload: { kind: "text", text: "卡片" }, role: "main", isSilenced: true },
				{
					payload: { kind: "text", text: "卡片" },
					role: "main",
					repushOf: 0,
					result: { ok: true, latencyMs: 3 },
				},
			],
		});
		expect(view.status).toBe("silenced");
		expect(view.messages[0]).toMatchObject({ isSilenced: true });
		expect(view.messages[0]).not.toHaveProperty("ok");
		expect(view.messages[1]).not.toHaveProperty("isSilenced");
		expect(view.messages[1]).toMatchObject({ ok: true, repushOf: 0 });
	});
});

/**
 * **能不能补**(ADR-0017 决策 6):有目标、且行里还有没送到的或被挡下的消息,投影就带 `repush`,
 * 条数按身份号算。这是**不查盘**的那一半(原件在不在、路由还在不在由列表路由另问),所以 WS 推来的
 * 行也带 —— 面板画不画按钮只看这一格。看的是消息,不是行的状态。
 */
describe("toHistoryView — 能不能补(不查盘的那一半)", () => {
	const TARGET = "44444444-4444-4444-8444-444444444444";
	const text = { kind: "text", text: "x" } as const;
	const OK = { ok: true, latencyMs: 3 } as const;
	const FAIL = { ok: false, code: "unknown", message: "boom" } as const;
	const row = (over: Partial<HistoryEntry>): HistoryEntry => ({
		...ROW,
		targetId: TARGET,
		...over,
	});

	it("失败行:带 repush,本来几条、还差几条", () => {
		const view = toHistoryView(
			row({
				status: "failed",
				messages: [
					{ payload: text, role: "main", result: FAIL },
					{ payload: text, role: "extra" },
				],
			}),
		);
		expect(view.repush).toEqual({ can: true, total: 2, missing: 2 });
	});

	it("部分失败、补过一次的行:重投不算新的一条,还差的按每一号最后一次算", () => {
		const view = toHistoryView(
			row({
				status: "partial",
				messages: [
					{ payload: text, role: "main", result: OK },
					{ payload: text, role: "extra", result: FAIL },
					{ payload: text, role: "extra" },
					{ payload: text, role: "extra", result: OK, repushOf: 1 },
				],
			}),
		);
		expect(view.repush).toEqual({ can: true, total: 3, missing: 1 });
	});

	it("被挡下的行:整行都还没发", () => {
		const view = toHistoryView(
			row({
				status: "silenced",
				messages: [
					{ payload: text, role: "main", isSilenced: true },
					{ payload: text, role: "extra", isSilenced: true },
				],
			}),
		);
		expect(view.repush).toEqual({ can: true, total: 2, missing: 2 });
	});

	// 🔴 补发一行被挡下的行,本体补完、附加项还没轮到:状态已是 delivered,可还有一条没发。
	it("🔴 状态已送达、可还有被挡下的消息没发:照带", () => {
		const view = toHistoryView(
			row({
				status: "delivered",
				messages: [
					{ payload: text, role: "main", isSilenced: true },
					{ payload: text, role: "extra", isSilenced: true },
					{ payload: text, role: "main", result: OK, repushOf: 0 },
				],
			}),
		);
		expect(view.repush).toEqual({ can: true, total: 2, missing: 1 });
	});

	it("全都送到了的行不带这一格,哪怕行上的状态写的是 failed", () => {
		const messages = [
			{ payload: text, role: "main" as const, result: FAIL },
			{ payload: text, role: "main" as const, result: OK, repushOf: 0 },
		];
		expect(toHistoryView(row({ status: "delivered", messages }))).not.toHaveProperty("repush");
		expect(toHistoryView(row({ status: "failed", messages }))).not.toHaveProperty("repush");
	});

	/**
	 * 🔴 被过滤的行那条消息没有结果、也没被挡 —— 按「还差哪几条」数它是「没发」。必须按状态排除,
	 * 不能只靠「目标那一格空着」顺带挡住:这里特意给它一个目标,排除仍然成立。
	 */
	it("🔴 被过滤的行不带这一格(哪怕它有目标)", () => {
		const filtered = {
			status: "filtered" as const,
			filteredBy: "blocked-keyword" as const,
			messages: [{ payload: text, role: "main" as const }],
		};
		expect(toHistoryView({ ...ROW, ...filtered })).not.toHaveProperty("repush");
		expect(toHistoryView(row(filtered))).not.toHaveProperty("repush");
	});

	it("被过滤的行:状态与原因带到面板;别的行没有 filteredBy 这一格", () => {
		const view = toHistoryView({
			...ROW,
			status: "filtered",
			filteredBy: "blocked-reposts",
			messages: [{ payload: text, role: "main" }],
		});
		expect(view).toMatchObject({
			status: "filtered",
			filteredBy: "blocked-reposts",
			targetId: null,
		});
		expect(toHistoryView(ROW)).not.toHaveProperty("filteredBy");
	});

	// 无目标行的消息全都没发,可它没有目标可补。
	it("无目标行不带这一格", () => {
		expect(toHistoryView(ROW)).not.toHaveProperty("repush");
		expect(toHistoryView({ ...ROW, status: "failed" })).not.toHaveProperty("repush");
	});
});

describe("toHistoryView — 结果不明的实时行", () => {
	it("初次推送和补发结果不明都给禁用原因，不能先显示可补发", () => {
		const failed = {
			payload: { kind: "text" as const, text: "message" },
			role: "main" as const,
			result: {
				ok: false as const,
				code: "indeterminate" as const,
				message: "raw uncertain result",
			},
		};
		for (const messages of [
			[failed],
			[
				{
					...failed,
					result: { ok: false as const, code: "unavailable" as const, message: "offline" },
				},
				{ ...failed, repushOf: 0 },
			],
		]) {
			const view = toHistoryView({
				...ROW,
				targetId: "44444444-4444-4444-8444-444444444444",
				status: "failed",
				messages,
			});
			expect(view.repush).toEqual({
				can: false,
				code: "conflict",
				message: "这行包含发送结果不明的消息，可能已经送达；为避免重复发送，不能再次重推。",
			});
			expect(view.messages.at(-1)).toMatchObject({
				ok: false,
				code: "indeterminate",
				message: "raw uncertain result",
			});
		}
	});
});
