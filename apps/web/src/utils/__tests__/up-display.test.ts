/**
 * 历史行在面板上「是谁」(ADR-0019 决策 73,⑱b 起身份是一格 `identity`):颜色与那行身份小字。
 *
 * - 颜色跟着人走:B 站行按 uid、拓展行按「拓展 id:外部 id」这一串 —— 与订阅卡同一个颜色,删了再加
 *   也不变。
 * - 身份小字:B 站行「UID xxx」;拓展行「平台名 · 外部 id」,平台名由调用方按已装拓展的清单取。
 * - 是不是拓展来的只看 `identity.sourceKey`(订阅与历史行共用 `isExtensionIdentity`)。
 * - 订阅资料里头像的显示地址(`profileAvatarUrl`):存进图库的走 `/api/images/<ref>`,否则是远端网址,都没有就是没有。
 * - 历史行上的头像地址(`historyRowAvatarUrl`):行的头像快照(图库引用,拓展行才有)优先,没有就退到订阅现在的头像;
 *   过了保留期的行不用快照(那几天已不是图库的引用方,图会被清扫收走)。
 */

import { colorFromSeed } from "@bilibili-notify/internal/identity";
import { describe, expect, it } from "vite-plus/test";
import { makeEmptySubscription } from "../../types/domain";
import {
	historyRowAvatarUrl,
	historyRowColor,
	historyRowIdentity,
	isExtensionIdentity,
	profileAvatarUrl,
	subscriptionColor,
} from "../up-display";

const BILI_ROW = {
	subscriptionId: "s-gone",
	identity: { sourceKey: "bilibili", externalId: "12345" },
};
const EXT_ROW = {
	subscriptionId: "s-gone",
	identity: { sourceKey: "douyin", externalId: "12345" },
};

describe("profileAvatarUrl(订阅资料里头像的显示地址)", () => {
	const REF = `${"a".repeat(64)}.png`;

	it("存进图库的(拓展订阅的 avatar)→ 图库的同源读口 /api/images/<ref>", () => {
		expect(profileAvatarUrl({ avatar: REF })).toBe(`/api/images/${REF}`);
	});

	it("不认核心资料之外的 avatarUrl;没图库引用就画首字", () => {
		const legacy = { avatarUrl: "https://i0.hdslb.com/bfs/face/x.jpg" };
		expect(profileAvatarUrl(legacy as unknown as { avatar?: string })).toBeUndefined();
	});

	it("没有图库引用(没有资料或旧数据里的空串)→ undefined,头像件画首字", () => {
		expect(profileAvatarUrl(undefined)).toBeUndefined();
		expect(profileAvatarUrl({})).toBeUndefined();
		expect(profileAvatarUrl({ avatar: "" })).toBeUndefined();
	});
});

describe("isExtensionIdentity", () => {
	it("来源键是 bilibili → 不是拓展;别的来源键(拓展 id)→ 是", () => {
		expect(isExtensionIdentity(BILI_ROW.identity)).toBe(false);
		expect(isExtensionIdentity(EXT_ROW.identity)).toBe(true);
	});
});

describe("historyRowColor", () => {
	it("B 站行与它那条订阅卡同一个颜色(按 uid)", () => {
		expect(historyRowColor(BILI_ROW)).toBe(
			subscriptionColor(makeEmptySubscription({ sourceKey: "bilibili", externalId: "12345" })),
		);
	});

	it("拓展行与同一个人的订阅卡同一个颜色 —— 订阅删了又加(id 变了)也一样", () => {
		const readded = makeEmptySubscription({ sourceKey: "douyin", externalId: "12345" });
		expect(historyRowColor(EXT_ROW)).toBe(subscriptionColor(readded));
	});

	it("拓展行不按外部 id 取色:外部 id 恰好等于某个 B 站 uid 时,取色的种子也不是那串 uid", () => {
		expect(historyRowColor(EXT_ROW)).toBe(colorFromSeed("douyin:12345"));
	});
});

/**
 * 颜色与搬家之前一字不差(ADR-0020 决策 15:拓展的配色种子搬进 internal,面板与出卡共用)。下面的
 * 色值是拿**搬之前**那份代码(git 里 up-display.ts 的 `extensionColorSeed` + internal 的
 * `colorFromSeed`)现算出来写死的 —— 搬完之后订阅卡、历史行上同一个人的颜色一个都不许变。
 */
describe("颜色与搬家之前一字不差", () => {
	const BILI: Array<[string, string]> = [
		["1", "#ffaf7b"],
		["12345", "#fb7299"],
		["946974", "#01b355"],
		["387654321", "#ff9c89"],
	];
	const EXT: Array<[string, string, string]> = [
		["douyin", "12345", "#ffaf7b"],
		["douyin", "MS4wLjABAAAA-abc/def", "#fb7299"],
		["fake-source", "1", "#b3cd2f"],
		["kuaishou", "3xabc", "#ff93d1"],
	];

	it("B 站:订阅卡与历史行都是搬之前那个颜色", () => {
		for (const [uid, color] of BILI) {
			expect(
				subscriptionColor(makeEmptySubscription({ sourceKey: "bilibili", externalId: uid })),
				uid,
			).toBe(color);
			expect(
				historyRowColor({
					subscriptionId: "s",
					identity: { sourceKey: "bilibili", externalId: uid },
				}),
				uid,
			).toBe(color);
		}
	});

	it("拓展:订阅卡与历史行都是搬之前那个颜色", () => {
		for (const [extensionId, externalId, color] of EXT) {
			const sub = makeEmptySubscription({ sourceKey: extensionId, externalId: externalId });
			expect(subscriptionColor(sub), externalId).toBe(color);
			expect(
				historyRowColor({ subscriptionId: "s", identity: { sourceKey: extensionId, externalId } }),
				externalId,
			).toBe(color);
		}
	});
});

describe("historyRowIdentity", () => {
	const labelOf = (extensionId: string) => (extensionId === "douyin" ? "抖音" : extensionId);

	it("B 站行:「UID xxx」", () => {
		expect(historyRowIdentity(BILI_ROW, labelOf)).toBe("UID 12345");
	});

	it("拓展行:「平台名 · 外部 id」", () => {
		expect(historyRowIdentity(EXT_ROW, labelOf)).toBe("抖音 · 12345");
	});

	it("拓展行、没给平台名 → 写拓展 id", () => {
		expect(historyRowIdentity(EXT_ROW)).toBe("douyin · 12345");
	});
});

describe("historyRowAvatarUrl(历史行上 UP 的头像地址)", () => {
	const SNAPSHOT = `${"b".repeat(64)}.png`;
	const CURRENT = `${"c".repeat(64)}.png`;

	it("有头像快照(拓展行)→ 快照的图库地址,不管订阅现在的头像是什么", () => {
		expect(historyRowAvatarUrl({ avatarSnapshot: SNAPSHOT }, { avatar: CURRENT })).toBe(
			`/api/images/${SNAPSHOT}`,
		);
	});

	it("没有快照(B 站行)→ 订阅现在的图库头像;远端网址不认", () => {
		expect(historyRowAvatarUrl({}, { avatar: CURRENT })).toBe(`/api/images/${CURRENT}`);
		const legacy = { avatarUrl: "https://i0.hdslb.com/new.jpg" };
		expect(historyRowAvatarUrl({}, legacy as unknown as { avatar?: string })).toBeUndefined();
	});

	it("没有快照、订阅也没了(或没有头像)→ undefined,头像件画首字", () => {
		expect(historyRowAvatarUrl({}, undefined)).toBeUndefined();
		expect(historyRowAvatarUrl({}, {})).toBeUndefined();
	});

	it("过了保留期的行不用快照(图随时会被清扫收走):退到订阅现在的头像", () => {
		const past = { avatarSnapshot: SNAPSHOT, isPastRetention: true as const };
		expect(historyRowAvatarUrl(past, { avatar: CURRENT })).toBe(`/api/images/${CURRENT}`);
		expect(historyRowAvatarUrl(past, undefined)).toBeUndefined();
	});
});
