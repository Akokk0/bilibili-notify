/**
 * `PushRouter.onSend` → `HistoryStore.record` 的字段搬运。
 *
 * 推送层只知道订阅 id / feature / target / 消息与结果;历史行还要「替谁发的」(B 站 uid,或拓展 id +
 * 外部 id)、UP 的名字头像快照。这一层把它们拼齐:无目标那次照记(target: null),附加项的
 * role 与逐条结果原样带过去。头像快照只装图库引用(⑳d):拓展行抄资料里的 `avatar`,B 站行不带(服务端不抓 B 站头像)。
 */

import { fail, makeEmptySubscription } from "@bilibili-notify/internal";
import type { PushSendResult } from "@bilibili-notify/push";
import { describe, expect, it } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { POST_SUMMARY_MAX_CHARS } from "../../stats/post-entry-extras.js";
import { historyRecordFromFilteredPost, historyRecordFromSend } from "../push-history.js";

const SUB_ID = "11111111-1111-4111-8111-111111111111";
const target = {
	id: "22222222-2222-4222-8222-222222222222",
	name: "群",
	connectionId: "a",
	platform: "onebot",
	scope: "group",
	enabled: true,
	session: {},
} as unknown as PushSendResult["target"] & object;

const EXT_ID = "33333333-3333-4333-8333-333333333333";
const EXT_AVATAR = `${"a".repeat(64)}.png`;
const BILI_AVATAR = `${"b".repeat(64)}.webp`;
const lookups = {
	subscriptionOf: (subscriptionId: string) =>
		subscriptionId === SUB_ID
			? {
					subscription: makeEmptySubscription({
						id: SUB_ID,
						identity: { sourceKey: "bilibili", externalId: "u1" },
					}),
					profile: { name: "某UP", avatar: BILI_AVATAR, avatarUrl: "http://a/x.jpg" },
				}
			: subscriptionId === EXT_ID
				? {
						// 外部 id 恰好也是 "u1" —— 拓展行的来源键是拓展 id,不会被认成 B 站的 uid。
						subscription: makeExtensionSubscription({
							id: EXT_ID,
							extensionId: "douyin",
							externalId: "u1",
						}),
						// 拓展订阅的头像是图库引用(`avatar`),历史行抄它当头像快照。
						profile: { name: "某抖音号", avatar: EXT_AVATAR },
					}
				: undefined,
};

describe("historyRecordFromSend", () => {
	it("有目标:pushId / feature / 订阅 id / 快照 / 消息逐条带 role 与结果", () => {
		const info: PushSendResult = {
			pushId: "p1",
			subscriptionId: SUB_ID,
			feature: "liveEnd",
			target,
			messages: [
				{ payload: { kind: "text", text: "卡" }, role: "main", result: { ok: true, latencyMs: 3 } },
				{
					payload: { kind: "text", text: "词云" },
					role: "extra",
					result: fail("unavailable", "boom"),
				},
			],
		};
		expect(historyRecordFromSend(info, lookups)).toEqual({
			pushId: "p1",
			feature: "liveEnd",
			identity: { sourceKey: "bilibili", externalId: "u1" },
			subscriptionId: SUB_ID,
			targetId: target.id,
			messages: [
				{ payload: { kind: "text", text: "卡" }, role: "main", result: { ok: true, latencyMs: 3 } },
				{
					payload: { kind: "text", text: "词云" },
					role: "extra",
					result: fail("unavailable", "boom"),
				},
			],
			nameSnapshot: "某UP",
			avatarSnapshot: BILI_AVATAR,
		});
	});

	// 被静音 / 免扰挡下的那次回调:消息上的 isSilenced 原样带给历史仓(没有它,这一行会被算成 failed)。
	it("被挡的回调:消息带 isSilenced、没有结果,原样交给历史仓", () => {
		const info: PushSendResult = {
			pushId: "p1",
			subscriptionId: SUB_ID,
			feature: "liveEnd",
			target,
			messages: [
				{ payload: { kind: "text", text: "卡" }, role: "main", isSilenced: true },
				{ payload: { kind: "text", text: "词云" }, role: "extra", isSilenced: true },
			],
		};
		const input = historyRecordFromSend(info, lookups);
		expect(input?.targetId).toBe(target.id);
		expect(input?.messages).toEqual([
			{ payload: { kind: "text", text: "卡" }, role: "main", isSilenced: true },
			{ payload: { kind: "text", text: "词云" }, role: "extra", isSilenced: true },
		]);
	});

	// B 站头像抓进了图库(3a-35):B 站行和拓展行一样,抄资料里的图库引用 `avatar`;远端网址 `avatarUrl` 不抄。
	it("B 站行:带头像快照(资料里的图库引用);资料里只有头像网址时不带", () => {
		const info: PushSendResult = {
			pushId: "p1",
			subscriptionId: SUB_ID,
			feature: "post",
			target,
			messages: [],
		};
		const input = historyRecordFromSend(info, lookups);
		expect(input).toMatchObject({ nameSnapshot: "某UP", avatarSnapshot: BILI_AVATAR });
		expect(input).not.toHaveProperty("uavatarSnapshot");

		const onlyUrl = historyRecordFromSend(info, {
			subscriptionOf: (id) => {
				const found = lookups.subscriptionOf(id);
				return found && { ...found, profile: { name: "某UP", avatarUrl: "http://a/x.jpg" } };
			},
		});
		expect(onlyUrl).not.toHaveProperty("avatarSnapshot");
	});

	it("无目标:target null、消息没有结果", () => {
		const info: PushSendResult = {
			pushId: "p2",
			subscriptionId: SUB_ID,
			feature: "post",
			target: null,
			messages: [{ payload: { kind: "text", text: "卡" }, role: "main" }],
		};
		expect(historyRecordFromSend(info, lookups)).toMatchObject({
			targetId: null,
			messages: [{ payload: { kind: "text", text: "卡" }, role: "main" }],
		});
		expect(historyRecordFromSend(info, lookups)?.messages[0]).not.toHaveProperty("result");
	});

	it("查不到订阅(推送中途被删)→ 没有订阅 id 就不记,返回 null", () => {
		const info: PushSendResult = {
			pushId: "p3",
			subscriptionId: "44444444-4444-4444-8444-444444444444",
			feature: "post",
			target,
			messages: [],
		};
		expect(historyRecordFromSend(info, lookups)).toBeNull();
	});

	it("行的订阅 id 就是推送层带来的那个,身份从订阅上取(推送层不带身份)", () => {
		const info: PushSendResult = {
			pushId: "p4",
			subscriptionId: SUB_ID,
			feature: "post",
			target,
			messages: [],
		};
		expect(historyRecordFromSend(info, lookups)).toMatchObject({
			subscriptionId: SUB_ID,
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
	});

	// 拓展行的身份就是订阅的 `identity`(来源键 = 拓展 id + 外部 id,ADR-0019 决策 73);头像快照抄资料里存进
	// 图库的 `avatar`(⑳d 起,取代决策 74 的「拓展行不存头像快照」),写行前由历史仓续期。
	it("拓展订阅 → 照记:带来源键(拓展 id)与外部 id、有名字快照、头像快照是资料里的图库引用", () => {
		const info: PushSendResult = {
			pushId: "p5",
			subscriptionId: EXT_ID,
			feature: "post",
			target,
			messages: [
				{
					payload: { kind: "text", text: "作品" },
					role: "main",
					result: { ok: true, latencyMs: 1 },
				},
			],
		};
		const input = historyRecordFromSend(info, lookups);
		expect(input).toMatchObject({
			pushId: "p5",
			feature: "post",
			subscriptionId: EXT_ID,
			identity: { sourceKey: "douyin", externalId: "u1" },
			targetId: target.id,
			nameSnapshot: "某抖音号",
			avatarSnapshot: EXT_AVATAR,
		});
		expect(input).not.toHaveProperty("uavatarSnapshot");
	});

	// 拓展还没报过资料时(订阅刚加、拓展没报资料更新)订阅上没有资料名字:行的名字快照就留空 —— 主人
	// 填的别名已退役(ADR-0021 决策 16),外部 id 在行上另有一格。`notes` 是自由文字,不当名字用。
	describe("拓展行的名字快照:只取资料里的名字,没有就留空(别名已退役,ADR-0021 决策 16)", () => {
		const EXT_NO_PROFILE = "55555555-5555-4555-8555-555555555555";
		const info: PushSendResult = {
			pushId: "p7",
			subscriptionId: EXT_NO_PROFILE,
			feature: "post",
			target,
			messages: [],
		};
		const lookupsWith = (
			over: { notes?: string },
			profile?: { name?: string; avatar?: string; avatarUrl?: string },
		) => ({
			subscriptionOf: (id: string) =>
				id === EXT_NO_PROFILE
					? {
							subscription: makeExtensionSubscription({ id: EXT_NO_PROFILE, ...over }),
							profile,
						}
					: undefined,
		});

		it("没有资料 → 没有名字快照", () => {
			const input = historyRecordFromSend(info, lookupsWith({}));
			expect(input?.nameSnapshot).toBeUndefined();
		});

		it("资料里没有存进图库的头像(没报过头像,或只有 avatarUrl)→ 没有头像快照,这一格不出现", () => {
			for (const profile of [
				undefined,
				{ name: "甲" },
				{ name: "甲", avatarUrl: "http://a/x.jpg" },
			]) {
				const input = historyRecordFromSend(info, lookupsWith({}, profile));
				expect(input).not.toHaveProperty("avatarSnapshot");
			}
		});

		it("资料里名字是空的(或只有空白)→ 没有名字快照", () => {
			for (const name of ["", "  "]) {
				const input = historyRecordFromSend(info, lookupsWith({}, { name }));
				expect(input?.nameSnapshot).toBeUndefined();
			}
		});

		it("资料里有名字 → 就是资料的名字", () => {
			expect(historyRecordFromSend(info, lookupsWith({}, { name: "报来的名" }))).toMatchObject({
				nameSnapshot: "报来的名",
			});
		});

		it("备注不当名字用:没有资料名时备注也进不了名字快照", () => {
			const input = historyRecordFromSend(info, lookupsWith({ notes: "推给一群,周末别推" }));
			expect(input?.nameSnapshot).toBeUndefined();
		});

		it("B 站行不受影响:资料里没名字就没有快照", () => {
			const BILI = "66666666-6666-4666-8666-666666666666";
			const input = historyRecordFromSend(
				{ ...info, subscriptionId: BILI },
				{
					subscriptionOf: () => ({
						subscription: makeEmptySubscription({
							id: BILI,
							identity: { sourceKey: "bilibili", externalId: "9" },
						}),
					}),
				},
			);
			expect(input?.nameSnapshot).toBeUndefined();
		});

		// 验红:`push-history.ts` 的 `rowIdentityOf` 里把 B 站那一支改回 `profile?.name`(空白串也照存),这条红。
		// 两支同一种取法(「有字才算有」):B 站资料名是空串或只有空白时,快照也是没有(从前这一种会把空白照存下来)。
		it("B 站行与拓展行同一种取法:资料名是空串或空白 → 没有名字快照;有字的原样存", () => {
			const BILI = "66666666-6666-4666-8666-666666666666";
			const withName = (name: string | undefined) =>
				historyRecordFromSend(
					{ ...info, subscriptionId: BILI },
					{
						subscriptionOf: () => ({
							subscription: makeEmptySubscription({
								id: BILI,
								identity: { sourceKey: "bilibili", externalId: "9" },
							}),
							profile: name === undefined ? undefined : { name },
						}),
					},
				);
			for (const blank of ["", "  ", "\t\n"]) {
				expect(withName(blank)?.nameSnapshot, JSON.stringify(blank)).toBeUndefined();
			}
			expect(withName("某UP")?.nameSnapshot).toBe("某UP");
			// 过滤留痕那一支同一种取法。
			const filteredRow = historyRecordFromFilteredPost(
				{
					subscriptionId: BILI,
					filteredBy: "blocked-keyword",
					text: "字",
					url: "https://t.bilibili.com/9",
				},
				{
					subscriptionOf: () => ({
						subscription: makeEmptySubscription({
							id: BILI,
							identity: { sourceKey: "bilibili", externalId: "9" },
						}),
						profile: { name: "  " },
					}),
				},
			);
			expect(filteredRow?.nameSnapshot).toBeUndefined();
		});
	});

	it("B 站订阅的行没有散格(uid / extensionId / externalId),身份只有 identity 一格", () => {
		const info: PushSendResult = {
			pushId: "p6",
			subscriptionId: SUB_ID,
			feature: "post",
			target,
			messages: [],
		};
		const input = historyRecordFromSend(info, lookups);
		expect(input).not.toHaveProperty("uid");
		expect(input).not.toHaveProperty("extensionId");
		expect(input).not.toHaveProperty("externalId");
	});
});

/**
 * **被过滤的作品 → 历史的一行**(ADR-0021 决策 34 的 🔗)。一条订阅一行:目标那一格空着、带 `filteredBy`、
 * 一条文字(摘要 + 换行 + 原帖链接)。身份与名字 / 头像快照和推送那一支同一种取法;查不到订阅就不记。
 */
describe("historyRecordFromFilteredPost", () => {
	const filtered = (over: Record<string, unknown> = {}) => ({
		subscriptionId: SUB_ID,
		filteredBy: "blocked-keyword" as const,
		text: "今天也含禁词",
		url: "https://t.bilibili.com/1",
		...over,
	});

	/** 那一条消息的字(留痕的行恒为一条文字)。 */
	const textOf = (over: Record<string, unknown> = {}): string | undefined => {
		const payload = historyRecordFromFilteredPost(filtered(over), lookups)?.messages[0]?.payload;
		return payload?.kind === "text" ? payload.text : undefined;
	};

	it("B 站订阅:身份 / 订阅 id / 名字与头像快照照推送那一支取;目标空着、特性是作品、带原因", () => {
		const record = historyRecordFromFilteredPost(filtered(), lookups);
		expect(record).toEqual({
			pushId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			feature: "post",
			identity: { sourceKey: "bilibili", externalId: "u1" },
			subscriptionId: SUB_ID,
			targetId: null,
			filteredBy: "blocked-keyword",
			messages: [
				{ payload: { kind: "text", text: "今天也含禁词\nhttps://t.bilibili.com/1" }, role: "main" },
			],
			nameSnapshot: "某UP",
			avatarSnapshot: BILI_AVATAR,
		});
	});

	it("拓展订阅:来源键是拓展 id,名字与头像快照是它自己的", () => {
		const record = historyRecordFromFilteredPost(
			filtered({ subscriptionId: EXT_ID, filteredBy: "blocked-videos" }),
			lookups,
		);
		expect(record).toMatchObject({
			identity: { sourceKey: "douyin", externalId: "u1" },
			subscriptionId: EXT_ID,
			filteredBy: "blocked-videos",
			nameSnapshot: "某抖音号",
			avatarSnapshot: EXT_AVATAR,
		});
	});

	it("每一行有自己的 pushId(它不对应任何一次推送)", () => {
		const a = historyRecordFromFilteredPost(filtered(), lookups);
		const b = historyRecordFromFilteredPost(filtered(), lookups);
		expect(a?.pushId).not.toBe(b?.pushId);
	});

	it("查不到订阅(中途被退订)→ 不记", () => {
		expect(historyRecordFromFilteredPost(filtered({ subscriptionId: "nope" }), lookups)).toBeNull();
	});

	it("摘要截到现成的摘要上限(按字符,不截断代理对),链接不截", () => {
		const long = `${"字".repeat(POST_SUMMARY_MAX_CHARS - 1)}😀尾巴`;
		const [summary, link] = (textOf({ text: long }) ?? "").split("\n");
		expect([...(summary ?? "")]).toHaveLength(POST_SUMMARY_MAX_CHARS);
		expect(summary?.endsWith("😀")).toBe(true);
		expect(link).toBe("https://t.bilibili.com/1");
	});

	it("没有地址就只有摘要;没有字就只有地址;都没有是空字", () => {
		expect(textOf({ url: undefined })).toBe("今天也含禁词");
		expect(textOf({ url: "" })).toBe("今天也含禁词");
		expect(textOf({ text: "  " })).toBe("https://t.bilibili.com/1");
		expect(textOf({ text: "", url: undefined })).toBe("");
	});

	it("消息没有 result、没有 isSilenced(它没发过,也不是被静音挡的)", () => {
		const message = historyRecordFromFilteredPost(filtered(), lookups)?.messages[0];
		expect(message).not.toHaveProperty("result");
		expect(message).not.toHaveProperty("isSilenced");
	});
});
