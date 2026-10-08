/**
 * **历史行的身份**(ADR-0019 决策 73,⑱b 并成一格)。
 *
 * 一行历史记的是「BN 发出去了什么、替谁发的」。替谁发的是一格 `identity`(来源键 + 外部 id,和订阅同一种身份):
 * B 站行的来源键是 `bilibili`、外部 id 是 uid,拓展行的来源键是拓展 id。外部 id 恰好是一串等于某个 B 站 uid 的数字时,
 * 来源键不同,订阅删掉之后也不会被认成那位 B 站 UP。
 *
 * 钉的是:两种来源的行读得进来且两格原样保留;老的三个散格(`uid` / `extensionId` / `externalId`)与老名字
 * (`ts` / `unameSnapshot` / 消息的 `retryOf`)、老格式行读不进来(那是迁移器的事);
 * 推送种类那一格叫 `feature`、值就是特性键(⑬f),八把键都认,别的值与老的 `kind` 形状一律读不进来。
 */

import { describe, expect, it } from "vite-plus/test";
import { countsAsDelivery, countsAsFailure, FEATURE_KEYS, PUSH_STATUSES } from "../../constants.js";
import { PostFilterReason } from "../../post.js";
import { HistoryEntrySchema, HistoryMessageResultSchema } from "../history.js";

const BASE = {
	id: "11111111-1111-4111-8111-111111111111",
	pushId: "22222222-2222-4222-8222-222222222222",
	createdAt: "2026-09-24T00:00:00.000Z",
	feature: "post",
	identity: { sourceKey: "bilibili", externalId: "u1" },
	subscriptionId: "33333333-3333-4333-8333-333333333333",
	targetId: "44444444-4444-4444-8444-444444444444",
	status: "delivered",
	messages: [{ payload: { kind: "text", text: "卡片" }, role: "main" }],
} as const;

describe("HistoryEntrySchema — 推送种类那一格是特性键", () => {
	it.each(FEATURE_KEYS)("feature %s 读得进来", (feature) => {
		expect(HistoryEntrySchema.parse({ ...BASE, feature }).feature).toBe(feature);
	});

	it("不是特性键的值读不进来(含 0.x 的推送种类名)", () => {
		for (const feature of ["dynamic", "live", "live-ongoing", "live-end", "guard", "sc", "nope"]) {
			expect(HistoryEntrySchema.safeParse({ ...BASE, feature }).success, feature).toBe(false);
		}
	});

	it("0.x 最新形状的行(带 `kind`、没有 `feature`)读不进来 —— 那是迁移器的事", () => {
		const { feature: _gone, ...rest } = BASE;
		expect(HistoryEntrySchema.safeParse({ ...rest, kind: "dynamic" }).success).toBe(false);
	});
});

describe("HistoryEntrySchema — 行的身份", () => {
	it("拓展行:来源键是拓展 id → 读得进来,两格原样保留", () => {
		const parsed = HistoryEntrySchema.parse({
			...BASE,
			identity: { sourceKey: "douyin", externalId: "123" },
			nameSnapshot: "某抖音号",
		});
		expect(parsed.identity).toEqual({ sourceKey: "douyin", externalId: "123" });
		expect(parsed.nameSnapshot).toBe("某抖音号");
	});

	it("B 站行:来源键 bilibili、外部 id 就是 uid", () => {
		const parsed = HistoryEntrySchema.parse(BASE);
		expect(parsed.identity).toEqual({ sourceKey: "bilibili", externalId: "u1" });
		expect(parsed).not.toHaveProperty("uid");
		expect(parsed).not.toHaveProperty("extensionId");
	});

	it("没有 identity 的行读不进来 —— 老的三个散格(uid / extensionId + externalId)是迁移器的事", () => {
		const { identity: _gone, ...rest } = BASE;
		expect(HistoryEntrySchema.safeParse(rest).success).toBe(false);
		expect(HistoryEntrySchema.safeParse({ ...rest, uid: "u1" }).success).toBe(false);
		expect(
			HistoryEntrySchema.safeParse({ ...rest, extensionId: "douyin", externalId: "123" }).success,
		).toBe(false);
	});

	it("老名字不认:`ts` 顶不了 `createdAt`(缺了读不进来)、`unameSnapshot` 不会被当成 `nameSnapshot`", () => {
		const { createdAt, ...rest } = BASE;
		expect(HistoryEntrySchema.safeParse({ ...rest, ts: createdAt }).success).toBe(false);
		const parsed = HistoryEntrySchema.parse({ ...BASE, unameSnapshot: "老名字" });
		expect(parsed).not.toHaveProperty("unameSnapshot");
		expect(parsed).not.toHaveProperty("nameSnapshot");
	});

	it("消息的重投标记叫 `repushOf`:老的 `retryOf` 被剥掉、不当成重投", () => {
		const parsed = HistoryEntrySchema.parse({
			...BASE,
			messages: [
				{ payload: { kind: "text", text: "补的" }, role: "main", repushOf: 0, retryOf: 0 },
			],
		});
		expect(parsed.messages[0]).toHaveProperty("repushOf", 0);
		expect(parsed.messages[0]).not.toHaveProperty("retryOf");
	});

	// 0.x 的老行(一行 = 一个目标 × 一条消息,带 `source` / `result` / `payload`)由迁移器在搬家时改写
	// (`apps/server/src/migration/history.ts`,等价性在 `migration/__tests__/zero-generation-history.test.ts` 钉着)。
	// 活的 schema 不再认老形状:没人改写就拿到这样的行,是该报错的 —— 静默映射等于把迁移器该做的事又在读这头做一遍。
	it("老格式行(source / result / payload)读不进来 —— 那是迁移器的事,活 schema 只认现在的形状", () => {
		const legacy = {
			id: BASE.id,
			ts: BASE.createdAt,
			source: "live-summary",
			uid: "u7",
			subscriptionId: BASE.subscriptionId,
			targetIds: [BASE.targetId],
			payload: { kind: "text", text: "词云" },
			result: { ok: true, per: [{ ok: true, latencyMs: 4 }] },
			unameSnapshot: "老UP",
		};
		expect(HistoryEntrySchema.safeParse(legacy).success).toBe(false);
	});
});

describe("HistoryEntrySchema — 头像快照只装图库引用(⑳d)", () => {
	const REF = `${"b".repeat(64)}.png`;

	it("avatarSnapshot 收图库引用;缺着也行(B 站行就是缺着)", () => {
		expect(HistoryEntrySchema.parse({ ...BASE, avatarSnapshot: REF }).avatarSnapshot).toBe(REF);
		expect(HistoryEntrySchema.parse(BASE).avatarSnapshot).toBeUndefined();
	});

	it("远端网址、路径、旧的 uavatarSnapshot 都不是头像快照:前两种整行读不进来,旧格被丢掉", () => {
		for (const avatarSnapshot of ["https://i0.hdslb.com/bfs/face/x.jpg", "../x.png", "x.png"]) {
			expect(
				HistoryEntrySchema.safeParse({ ...BASE, avatarSnapshot }).success,
				avatarSnapshot,
			).toBe(false);
		}
		const parsed = HistoryEntrySchema.parse({
			...BASE,
			uavatarSnapshot: "https://i0.hdslb.com/bfs/face/x.jpg",
		});
		expect(parsed).not.toHaveProperty("uavatarSnapshot");
		expect(parsed.avatarSnapshot).toBeUndefined();
	});
});

/**
 * 一条消息的投递结果落盘就是结果形状(ADR-0026 决策 5):送达 `{ ok: true, latencyMs }`,
 * 没送达 `{ ok: false, code, message, upstreamCode? }` —— 失败不带耗时,原因不再叫 `err`。
 */
describe("HistoryMessageResultSchema — 结果形状", () => {
	it("送达:只留 ok 与耗时(截流标记之类认不得的格剥掉)", () => {
		expect(HistoryMessageResultSchema.parse({ ok: true, latencyMs: 5, isSynthetic: true })).toEqual(
			{
				ok: true,
				latencyMs: 5,
			},
		);
	});

	it("没送达:码、原话、upstreamCode(数字或字符串)都留着", () => {
		expect(
			HistoryMessageResultSchema.parse({
				ok: false,
				code: "unknown",
				message: "bot 说不行",
				upstreamCode: 1200,
			}),
		).toEqual({ ok: false, code: "unknown", message: "bot 说不行", upstreamCode: 1200 });
		expect(
			HistoryMessageResultSchema.parse({
				ok: false,
				code: "unavailable",
				message: "HTTP 502",
				upstreamCode: "http:502",
			}),
		).toEqual({ ok: false, code: "unavailable", message: "HTTP 502", upstreamCode: "http:502" });
		expect(
			HistoryMessageResultSchema.parse({ ok: false, code: "indeterminate", message: "超时" }),
		).toEqual({ ok: false, code: "indeterminate", message: "超时" });
	});

	it("没送达不带耗时:多写的 latencyMs / err 剥掉", () => {
		expect(
			HistoryMessageResultSchema.parse({
				ok: false,
				code: "unknown",
				message: "x",
				latencyMs: 7,
				err: "x",
			}),
		).toEqual({ ok: false, code: "unknown", message: "x" });
	});

	it("老形状的失败(`{ ok: false, latencyMs, err }`,没有 code / message)读不进来 —— 那是迁移器的事", () => {
		expect(
			HistoryMessageResultSchema.safeParse({ ok: false, latencyMs: 7, err: "boom" }).success,
		).toBe(false);
		expect(HistoryMessageResultSchema.safeParse({ ok: false, latencyMs: 7 }).success).toBe(false);
	});

	it("码只认标准码表;送达必须带耗时", () => {
		expect(
			HistoryMessageResultSchema.safeParse({ ok: false, code: "nope", message: "x" }).success,
		).toBe(false);
		expect(HistoryMessageResultSchema.safeParse({ ok: true }).success).toBe(false);
	});
});

/**
 * 被全局静音 / 免扰时段挡下的推送照记(ADR-0021 决策 34 的 🔗,10-08):行的状态多一档 `silenced`,
 * 被挡的每条消息带 `isSilenced: true`、没有结果。它不算推送、也不算失败。
 */
describe("HistoryEntrySchema — 被静音 / 免扰挡下的行", () => {
	const SILENCED = {
		...BASE,
		status: "silenced",
		messages: [
			{ payload: { kind: "text", text: "卡片" }, role: "main", isSilenced: true },
			{ payload: { kind: "text", text: "词云" }, role: "extra", isSilenced: true },
		],
	} as const;

	it("状态 silenced 读得进来;消息上的 isSilenced 原样留着,没有 result", () => {
		const parsed = HistoryEntrySchema.parse(SILENCED);
		expect(parsed.status).toBe("silenced");
		for (const m of parsed.messages) {
			expect(m.isSilenced).toBe(true);
			expect(m).not.toHaveProperty("result");
		}
	});

	it("isSilenced 只有 true 一个取值:没被挡的消息不带这一格,写成 false 的行读不进来", () => {
		expect(HistoryEntrySchema.parse(BASE).messages[0]).not.toHaveProperty("isSilenced");
		const withFalse = {
			...BASE,
			messages: [{ payload: { kind: "text", text: "卡片" }, role: "main", isSilenced: false }],
		};
		expect(HistoryEntrySchema.safeParse(withFalse).success).toBe(false);
	});

	it("词表里有 silenced;它不算推送(今日推送 / 趋势),也不算失败(今日失败)", () => {
		expect(PUSH_STATUSES).toContain("silenced");
		expect(countsAsDelivery("silenced")).toBe(false);
		expect(countsAsFailure("silenced")).toBe(false);
	});

	it("两个谓词的全表:no-targets、silenced 与 filtered 不算推送,只有 failed 与 partial 算失败", () => {
		expect(
			PUSH_STATUSES.map((status) => [status, countsAsDelivery(status), countsAsFailure(status)]),
		).toEqual([
			["delivered", true, false],
			["partial", true, true],
			["failed", true, true],
			["no-targets", false, false],
			["silenced", false, false],
			["filtered", false, false],
		]);
	});
});

/**
 * 被过滤挡下的作品在历史里留一行(ADR-0021 决策 34 的 🔗「被过滤的作品也留痕」,10-08):状态 `filtered`,
 * 行上一格 `filteredBy` 记原因(六种 `PostFilterReason`),目标那一格空着,只有一条文字、没有结果。
 * 它不算推送、不算失败。新状态与新格都是加出来的:没有 `filteredBy` 的老行照旧读得进来。
 */
describe("HistoryEntrySchema — 被过滤的行", () => {
	const FILTERED = {
		...BASE,
		targetId: null,
		status: "filtered",
		filteredBy: "blocked-keyword",
		messages: [{ payload: { kind: "text", text: "摘要\nhttps://example.com/p/1" }, role: "main" }],
	} as const;

	it("状态 filtered 与 filteredBy 读得进来,原样留着", () => {
		const parsed = HistoryEntrySchema.parse(FILTERED);
		expect(parsed.status).toBe("filtered");
		expect(parsed.filteredBy).toBe("blocked-keyword");
		expect(parsed.targetId).toBeNull();
	});

	it.each(Object.values(PostFilterReason))("原因 %s 认", (filteredBy) => {
		expect(HistoryEntrySchema.parse({ ...FILTERED, filteredBy }).filteredBy).toBe(filteredBy);
	});

	it("原因的词表是那六种,不认别的值", () => {
		expect(Object.values(PostFilterReason).sort()).toEqual([
			"allowlist-unmatched",
			"blocked-articles",
			"blocked-images",
			"blocked-keyword",
			"blocked-reposts",
			"blocked-videos",
		]);
		expect(HistoryEntrySchema.safeParse({ ...FILTERED, filteredBy: "blocked" }).success).toBe(
			false,
		);
	});

	it("没有 filteredBy 的行(所有老行)照旧读得进来,读出来也没有这一格", () => {
		expect(HistoryEntrySchema.parse(BASE)).not.toHaveProperty("filteredBy");
	});

	it("词表里有 filtered;它不算推送,也不算失败", () => {
		expect(PUSH_STATUSES).toContain("filtered");
		expect(countsAsDelivery("filtered")).toBe(false);
		expect(countsAsFailure("filtered")).toBe(false);
	});
});
