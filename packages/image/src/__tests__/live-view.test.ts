/**
 * **直播卡「输入 → 排版」那一步**(`buildLiveCardView`,ADR-0019 决策 68)。
 *
 * 出卡入口先把中立的 {@link LiveCardInput} 排成块吃的 {@link LiveCardView}:数字排成「1.2万」、开播时刻算成
 * 卡上那句时间、图库引用换成可画的地址、自定义封面盖上去。四份基准快照的夹具(`fixtures/card-fixtures.ts`)直接写
 * 排好版的 `LiveCardView`,绕过了这一步,所以这一步的回归守卫 10 拦不住;已有的 `neutral-live-card.test.ts`
 * 是经默认皮肤看每块画出的**文字**。这里直接钉**视图本身**。
 *
 * ㉒a 钉过一版(旧形状:`author` / `area` / `online` / `fans` / `fansChanged`,开播时刻是毫秒,数字格也收文字);
 * ㉒c 把输入换成最终形状,这里跟着翻 —— 期望值(视图那一侧)一个没动,动的是输入的字段名与类型:
 * - 数字格只收精确数:「文字原样上卡」那几条没有了(类型就不让写);「累计观看是文字『暂未获取到』」那条也没有了
 *   (B 站翻译不再把字符串交给卡,见 `apps/server/src/bilibili/live` 的 `live-card-input.test.ts`);换成「不是有限的数当作没有」;
 * - 开播时刻是 ISO:原来的 NaN / Infinity 换成读不懂的字符串;
 * - 头像、封面是引用:经 `imageUrl` 解析,解析不到的收起 / 画占位。
 */

import { Settings } from "luxon";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { buildLiveCardView, LIVE_COVER_PLACEHOLDER } from "../live-view";
import type { LiveCardInput, LiveCardStatus } from "../templates/live-card";

/** 北京时间 2026-09-13 20:00:00。 */
const STARTED_AT = "2026-09-13T12:00:00.000Z";
const STARTED_AT_MS = Date.parse(STARTED_AT);

const AVATAR_REF = `${"a".repeat(64)}.png`;
const COVER_REF = `${"b".repeat(64)}.png`;
const TABLE: Record<string, string> = {
	[AVATAR_REF]: "data:image/png;base64,AVATAR",
	[COVER_REF]: "data:image/png;base64,COVER-REF",
};
const imageUrl = (ref: string): string | undefined => TABLE[ref];

function input(over: Partial<LiveCardInput> = {}): LiveCardInput {
	return {
		status: "streaming",
		creator: { name: "示例主播", avatar: AVATAR_REF },
		title: "一场直播",
		category: "虚拟主播",
		description: "纯文本简介",
		cover: { ref: COVER_REF },
		startedAt: STARTED_AT,
		currentViewers: 12_345,
		likes: 20_133,
		totalViewers: 31_200,
		followers: 88_800,
		followersDelta: 1_234,
		...over,
	};
}

afterEach(() => {
	vi.useRealTimers();
	Settings.defaultZone = "system";
});

describe("buildLiveCardView — 整个视图", () => {
	/** 把视图的**全部十四个键**一次钉死(原来只有按块看文字),键多了少了、值变了都红。 */
	it("一份满的输入排出一份满的视图", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(STARTED_AT_MS + (2 * 3600 + 13 * 60 + 5) * 1000);
		expect(buildLiveCardView(input(), { imageUrl })).toEqual({
			status: "streaming",
			creatorName: "示例主播",
			creatorAvatarUrl: "data:image/png;base64,AVATAR",
			title: "一场直播",
			category: "虚拟主播",
			description: "纯文本简介",
			cover: "data:image/png;base64,COVER-REF",
			hasCover: true,
			time: "直播时长：2小时13分5秒",
			currentViewers: "1.2万",
			likes: "2.0万",
			totalViewers: "3.1万",
			followers: "8.9万",
			followersDelta: "+1234",
		});
	});

	/** 字段都不给时,每个文字格是空串(不是 undefined),块那头才能一律按"空串 = 没有"判。 */
	it("只给必填项:文字格全是空串,封面是占位图且 hasCover 为假", () => {
		const view = buildLiveCardView({ status: "end", creator: { name: "甲" } });
		expect(view).toEqual({
			status: "end",
			creatorName: "甲",
			creatorAvatarUrl: "",
			title: "",
			category: "",
			description: "",
			cover: LIVE_COVER_PLACEHOLDER,
			hasCover: false,
			time: "",
			currentViewers: "",
			likes: "",
			totalViewers: "",
			followers: "",
			followersDelta: "",
		});
	});

	it("status、主播名、标题、分区、简介原样进视图", () => {
		for (const status of ["start", "streaming", "end", "offline"] as const) {
			expect(buildLiveCardView(input({ status })).status).toBe(status);
		}
		const view = buildLiveCardView(
			input({
				creator: { name: "名字" },
				title: "标题",
				category: "分区",
				description: "简介 <原样> & 不再剥",
			}),
		);
		expect(view).toMatchObject({
			creatorName: "名字",
			title: "标题",
			category: "分区",
			// 富文本是 B 站那头先剥的(`liveCardInputFromRoomInfo`);视图这一步不再动它。
			description: "简介 <原样> & 不再剥",
		});
	});
});

describe("buildLiveCardView — 主播头像(creator.avatar 是引用)", () => {
	/**
	 * 验红:让 `creatorAvatarUrl` 不再经 `imageUrl` 解析,第一条红;让解析不到时回引用本身(或占位),后两条红。
	 */
	it("引用解析到了:creatorAvatarUrl 是解析出的地址", () => {
		expect(buildLiveCardView(input(), { imageUrl }).creatorAvatarUrl).toBe(
			"data:image/png;base64,AVATAR",
		);
	});

	it("引用解析不到、或没注入解析口:creatorAvatarUrl 是空串(头像块收起)", () => {
		expect(buildLiveCardView(input(), { imageUrl: () => undefined }).creatorAvatarUrl).toBe("");
		expect(buildLiveCardView(input()).creatorAvatarUrl).toBe("");
	});

	it("没有头像:creatorAvatarUrl 是空串,解析口一次也没被问", () => {
		const asked: string[] = [];
		// 封面也拿掉:它是引用,同样会去问解析口。
		const view = buildLiveCardView(input({ creator: { name: "甲" }, cover: undefined }), {
			imageUrl: (ref) => {
				asked.push(ref);
				return TABLE[ref];
			},
		});
		expect(view.creatorAvatarUrl).toBe("");
		expect(asked).toEqual([]);
	});
});

describe("buildLiveCardView — 卡上那句时间", () => {
	/**
	 * 开播 / 下播:开播时刻按**给的时区**(全局时区设置)写,与进程所在时区无关。
	 * 这里把默认时区拧到别处再断言。验红:把 `startedAtOf` 里的 `{ zone }` 去掉,这条红。
	 */
	it("start / end:「开播时间：…」按给的时区排,不随默认时区走", () => {
		Settings.defaultZone = "America/Los_Angeles";
		for (const status of ["start", "end"] as const) {
			expect(buildLiveCardView(input({ status }), { timezone: "Asia/Shanghai" }).time).toBe(
				"开播时间：2026-09-13 20:00:00",
			);
		}
	});

	it("start / end:跨日也按北京时间排(UTC 16:30 → 次日 00:30)", () => {
		const startedAt = "2026-09-13T16:30:05Z";
		expect(
			buildLiveCardView(input({ status: "start", startedAt }), { timezone: "Asia/Shanghai" }).time,
		).toBe("开播时间：2026-09-14 00:30:05");
	});

	/** ISO 带别的偏移也照样换算成北京时间;不带偏移的当北京时间读。 */
	it("ISO 带偏移:换算成北京时间;不带偏移:当北京时间", () => {
		expect(
			buildLiveCardView(input({ status: "end", startedAt: "2026-09-13T15:00:00-04:00" }), {
				timezone: "Asia/Shanghai",
			}).time,
		).toBe("开播时间：2026-09-14 03:00:00");
		expect(
			buildLiveCardView(input({ status: "end", startedAt: "2026-09-13T20:00:00" }), {
				timezone: "Asia/Shanghai",
			}).time,
		).toBe("开播时间：2026-09-13 20:00:00");
	});

	/** 全局时区换成纽约:带偏移的换算到纽约,不带偏移的当纽约读(仍是原样印出)。 */
	it("纽约:带偏移的换算过去,不带偏移的当纽约读", () => {
		const timezone = "America/New_York";
		expect(
			buildLiveCardView(input({ status: "end", startedAt: "2026-09-13T16:30:05Z" }), { timezone })
				.time,
		).toBe("开播时间：2026-09-13 12:30:05");
		expect(
			buildLiveCardView(input({ status: "end", startedAt: "2026-09-13T20:00:00" }), { timezone })
				.time,
		).toBe("开播时间：2026-09-13 20:00:00");
	});

	it("streaming:「直播时长：…」由开播时刻与此刻的钟算", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(STARTED_AT_MS + (2 * 3600 + 13 * 60 + 5) * 1000);
		expect(buildLiveCardView(input({ status: "streaming" })).time).toBe("直播时长：2小时13分5秒");
		vi.setSystemTime(STARTED_AT_MS + 5_000);
		expect(buildLiveCardView(input({ status: "streaming" })).time).toBe("直播时长：5秒");
	});

	it("offline:恒是「未开播」,不看开播时刻有没有、读不读得懂", () => {
		for (const startedAt of [STARTED_AT, undefined, "读不懂"]) {
			expect(
				buildLiveCardView(input({ status: "offline", startedAt })).time,
				String(startedAt),
			).toBe("未开播");
		}
	});

	/**
	 * 没有开播时刻就整句不写(空串)—— 写一个后面什么都没有的「开播时间：」不如不出。读不懂的 ISO 同样当没有,
	 * 不印「Invalid DateTime」。
	 * 验红:把 `startedAtOf` 里的 `at.isValid` 判断去掉,读不懂的那几条红。
	 */
	it("没有开播时刻(没给、空串、读不懂)→ 空串,start / streaming / end 都一样", () => {
		const statuses: LiveCardStatus[] = ["start", "streaming", "end"];
		for (const status of statuses) {
			for (const startedAt of [undefined, "", "昨晚八点", "2026-13-45T99:00:00Z"]) {
				expect(
					buildLiveCardView(input({ status, startedAt })).time,
					`${status} / ${startedAt}`,
				).toBe("");
			}
		}
	});
});

describe("buildLiveCardView — 数字格(只收精确数)", () => {
	/** 数字走 `formatCount`(万 / 亿一位小数,万以下原样);没有就空串。 */
	it("数字排成「1.2万」,万以下原样,过亿写「亿」", () => {
		const view = buildLiveCardView(
			input({
				currentViewers: 9_999,
				likes: 12_345,
				totalViewers: 100_000_000,
				followers: 88_800,
			}),
		);
		expect(view).toMatchObject({
			currentViewers: "9999",
			likes: "1.2万",
			totalViewers: "1.0亿",
			followers: "8.9万",
		});
	});

	/**
	 * 数字 0 是真数:排成 "0",不是空串。块那头 `"0"` 是真值,所以真报了 0 就画「人气：0」。缺了才不画 ——
	 * B 站那条路的 `?? 0` 与点赞初值 "0" 在 ㉒c 去掉了(缺了就缺键)。
	 * 验红:把 `countText` 的 `typeof v === "number"` 换成真值判断,这条红。
	 */
	it('数字 0 排成 "0",不当成没有', () => {
		const view = buildLiveCardView(
			input({
				currentViewers: 0,
				likes: 0,
				totalViewers: 0,
				followers: 0,
				followersDelta: 0,
			}),
		);
		expect(view).toMatchObject({
			currentViewers: "0",
			likes: "0",
			totalViewers: "0",
			followers: "0",
			followersDelta: "0",
		});
	});

	/** 不是有限的数(NaN / Infinity)不往卡上印「NaN」「Infinity」,当作没有。 */
	it("NaN / Infinity 当作没有:空串", () => {
		const view = buildLiveCardView(
			input({
				currentViewers: Number.NaN,
				likes: Number.POSITIVE_INFINITY,
				totalViewers: Number.NEGATIVE_INFINITY,
				followers: Number.NaN,
				followersDelta: Number.NaN,
			}),
		);
		expect(view).toMatchObject({
			currentViewers: "",
			likes: "",
			totalViewers: "",
			followers: "",
			followersDelta: "",
		});
	});

	it('没给的格子是空串,不是 "undefined"', () => {
		const view = buildLiveCardView(
			input({
				currentViewers: undefined,
				likes: undefined,
				totalViewers: undefined,
				followers: undefined,
				followersDelta: undefined,
			}),
		);
		expect(view).toMatchObject({
			currentViewers: "",
			likes: "",
			totalViewers: "",
			followers: "",
			followersDelta: "",
		});
	});
});

describe("buildLiveCardView — 粉丝数变化带正负号", () => {
	/** 验红:去掉 `countText(input.followersDelta, { signed: true })` 里的 `signed`,这条红。 */
	it("正数加 +、负数是 -、零是 0;过万写「万」", () => {
		const of = (followersDelta: number) =>
			buildLiveCardView(input({ followersDelta })).followersDelta;
		expect(of(1_234)).toBe("+1234");
		expect(of(-35)).toBe("-35");
		expect(of(0)).toBe("0");
		expect(of(12_345)).toBe("+1.2万");
		expect(of(-12_345)).toBe("-1.2万");
	});

	it("别的数字格不带 +", () => {
		expect(buildLiveCardView(input({ currentViewers: 1_234, followers: 1_234 }))).toMatchObject({
			currentViewers: "1234",
			followers: "1234",
		});
	});
});

describe("buildLiveCardView — 封面", () => {
	const OVERRIDE = "data:image/png;base64,OVERRIDE";
	/** 输入的封面:图库引用,经解析口认成地址。 */
	const GIVEN = { ref: COVER_REF };
	const GIVEN_URL = "data:image/png;base64,COVER-REF";

	/**
	 * 自定义 > 输入的封面 > 占位,`hasCover` 只认前两样。自定义封面传空串时落到输入的封面(`||` 语义,不是 `??`)
	 * —— 主人没设自定义封面时出卡入口传的就是空串。
	 * 验红:把 `coverOverride || …` 改成 `??`,空串那条红;让占位图的 `hasCover` 变真,第三条红。
	 */
	it("自定义封面 > 输入的封面", () => {
		expect(buildLiveCardView(input({ cover: GIVEN }), { coverOverride: OVERRIDE })).toMatchObject({
			cover: OVERRIDE,
			hasCover: true,
		});
	});

	it("没有自定义封面(没给或空串)→ 输入的封面", () => {
		for (const coverOverride of [undefined, ""]) {
			expect(
				buildLiveCardView(input({ cover: GIVEN }), { coverOverride, imageUrl }),
				`override=${coverOverride}`,
			).toMatchObject({ cover: GIVEN_URL, hasCover: true });
		}
	});

	it("两样都没有 → 占位图,hasCover 为假(占位图不算真封面)", () => {
		for (const cover of [undefined, {}, { url: "" }, { url: "https://example.com/c.png" }]) {
			expect(
				buildLiveCardView(input({ cover }), { coverOverride: "" }),
				JSON.stringify(cover),
			).toMatchObject({ cover: LIVE_COVER_PLACEHOLDER, hasCover: false });
		}
	});

	it("输入没有封面、只有自定义封面 → 自定义封面,hasCover 为真", () => {
		expect(
			buildLiveCardView(input({ cover: undefined }), { coverOverride: OVERRIDE }),
		).toMatchObject({ cover: OVERRIDE, hasCover: true });
	});

	/** 封面是 PostImage:只认 ref 的解析结果;解析不到就是没有封面(占位),**不退回 url**;只有 url 同样是没有封面。 */
	it("引用解析到了 → 解析结果;hasCover 为真", () => {
		expect(buildLiveCardView(input({ cover: { ref: COVER_REF } }), { imageUrl })).toMatchObject({
			cover: "data:image/png;base64,COVER-REF",
			hasCover: true,
		});
	});

	it("引用解析不到(或没注入解析口)→ 占位,哪怕带着 url", () => {
		const cover = { ref: COVER_REF, url: "https://example.com/c.png" };
		for (const options of [{ imageUrl: () => undefined }, {}]) {
			expect(buildLiveCardView(input({ cover }), options)).toMatchObject({
				cover: LIVE_COVER_PLACEHOLDER,
				hasCover: false,
			});
		}
	});

	it("只有 url → 没有封面(占位;地址不进卡,渲染页不联网);引用与 url 都有且解析到了 → 认引用", () => {
		for (const options of [{ imageUrl }, {}]) {
			expect(
				buildLiveCardView(input({ cover: { url: "https://example.com/c.png" } }), options),
			).toMatchObject({ cover: LIVE_COVER_PLACEHOLDER, hasCover: false });
		}
		expect(
			buildLiveCardView(input({ cover: { ref: COVER_REF, url: "https://example.com/c.png" } }), {
				imageUrl,
			}).cover,
		).toBe("data:image/png;base64,COVER-REF");
	});
});
