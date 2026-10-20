/**
 * **中立的直播详情 → 直播卡输入**(`liveCardInputFromDetails`,ADR-0021 决策 22 / 24 下 2026-10-05 的 🔗,㉒c)。
 *
 * 详情里的图已经是图库引用(来源先存好再交),这里是同步的纯翻译:开播时刻是毫秒、卡输入里是 ISO;
 * 人数只收精确数,没报就没有这个键;主播头像:详情里的引用优先,否则订阅资料里的。
 *
 * 从前这里的前身 `liveCardInputFromReport` 吃字节、自己存图;存图搬到了 `bindExtensionLive`
 * (`extension-live.test.ts`)。
 */

import type { LiveDetails } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { liveCardInputFromDetails } from "../live-card-input.js";

const COVER = `${"c".repeat(64)}.png`;
const EVENT_AVATAR = `${"b".repeat(64)}.png`;
const PROFILE_AVATAR = `${"a".repeat(64)}.png`;

const base = { status: "start" as const, authorName: "抖音甲" };

describe("liveCardInputFromDetails — 每一格", () => {
	it("一份满的详情:每一格都在,图是引用、开播时刻是 ISO,键不多不少", () => {
		const details: LiveDetails = {
			title: "第一场",
			cover: { ref: COVER },
			category: "聊天",
			description: "简介",
			currentViewers: 10,
			totalViewers: 40,
			likes: 3,
			creator: { name: "事件里的名字", avatar: EVENT_AVATAR },
		};
		expect(
			liveCardInputFromDetails(details, {
				...base,
				status: "end",
				startedAt: Date.UTC(2026, 8, 24, 4, 0, 0),
				followers: 12_345,
				followersDelta: 128,
				profileAvatar: PROFILE_AVATAR,
			}),
		).toStrictEqual({
			status: "end",
			creator: { name: "抖音甲", avatar: EVENT_AVATAR },
			title: "第一场",
			category: "聊天",
			description: "简介",
			cover: { ref: COVER },
			startedAt: "2026-09-24T04:00:00.000Z",
			currentViewers: 10,
			totalViewers: 40,
			likes: 3,
			followers: 12_345,
			followersDelta: 128,
		});
	});

	it("什么都没报:只有状态与主播名,没有别的键(缺了就缺键)", () => {
		expect(liveCardInputFromDetails({}, base)).toStrictEqual({
			status: "start",
			creator: { name: "抖音甲" },
		});
	});

	it("人数报了 0 就是 0(真数,留着);没报才没有", () => {
		const input = liveCardInputFromDetails({ currentViewers: 0, likes: 0 }, base);
		expect(input).toMatchObject({ currentViewers: 0, likes: 0 });
		expect(Object.hasOwn(input, "totalViewers")).toBe(false);
	});
});

describe("liveCardInputFromDetails — 开播时刻(毫秒 → ISO)", () => {
	it("毫秒转成 ISO", () => {
		const input = liveCardInputFromDetails({}, { ...base, startedAt: Date.UTC(2026, 0, 1) });
		expect(input.startedAt).toBe("2026-01-01T00:00:00.000Z");
	});

	/** 场次 / 在播表里是毫秒,坏值(NaN)不能把整张卡弄抛:当没有开播时刻。 */
	it("不是有效时刻(没给、NaN)→ 没有这个键", () => {
		for (const startedAt of [undefined, Number.NaN]) {
			const input = liveCardInputFromDetails({}, { ...base, startedAt });
			expect(Object.hasOwn(input, "startedAt"), String(startedAt)).toBe(false);
		}
	});
});

describe("liveCardInputFromDetails — 主播头像", () => {
	it("详情带了头像引用:用它,订阅资料里的不用", () => {
		const input = liveCardInputFromDetails(
			{ creator: { name: "x", avatar: EVENT_AVATAR } },
			{ ...base, profileAvatar: PROFILE_AVATAR },
		);
		expect(input.creator.avatar).toBe(EVENT_AVATAR);
	});

	it("详情没带头像:订阅资料里的引用顶上", () => {
		const input = liveCardInputFromDetails(
			{ creator: { name: "只带了名字" } },
			{ ...base, profileAvatar: PROFILE_AVATAR },
		);
		expect(input.creator.avatar).toBe(PROFILE_AVATAR);
	});

	it("哪儿都没有头像:creator 里没有 avatar 这个键(头像块收起,不给透明占位)", () => {
		expect(liveCardInputFromDetails({}, base).creator).toStrictEqual({ name: "抖音甲" });
	});
});

describe("liveCardInputFromDetails — 封面", () => {
	it("封面原样带过去(图库引用);没有就没有 cover 这个键,出卡那头画「暂无封面」", () => {
		expect(liveCardInputFromDetails({ cover: { ref: COVER } }, base).cover).toStrictEqual({
			ref: COVER,
		});
		expect(Object.hasOwn(liveCardInputFromDetails({}, base), "cover")).toBe(false);
	});
});
