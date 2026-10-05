/**
 * **直播卡「输入 → 排版」那一步**(`buildLiveCardView`,ADR-0019 决策 68)—— 今天的行为(1.0 第 2 期 ㉒a)。
 *
 * 出卡入口先把中立的 {@link LiveCardInput} 排成块吃的 {@link LiveCardView}:数字排成「1.2万」、开播时刻算成
 * 卡上那句时间、自定义封面盖上去。四份基准快照的夹具(`fixtures/card-fixtures.ts`)直接写排好版的
 * `LiveCardView`,绕过了这一步,所以这一步的回归守卫 10 拦不住;已有的两份直播卡测试
 * (`neutral-live-card.test.ts` / `live-card-bili.test.ts`)是经默认皮肤看每块画出的**文字**。
 * 这里直接钉**视图本身**,补它们够不着的缺口 —— 哪条性质原来就有、哪条是新补的,各条注释里写明。
 *
 * ㉒c 把输入换成最终形状(`creator` / `category` / `currentViewers` …,`startedAt` 改 ISO)时,
 * 这里的输入字段名跟着换、期望值(视图那一侧)不动:视图与皮肤字段名仍归 ㉔。
 */

import { Settings } from "luxon";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { buildLiveCardView, LIVE_COVER_PLACEHOLDER } from "../live-view";
import type { LiveCardInput, LiveCardStatus } from "../templates/live-card";

/** 北京时间 2026-09-13 20:00:00。 */
const STARTED_AT = Date.parse("2026-09-13T12:00:00Z");

function input(over: Partial<LiveCardInput> = {}): LiveCardInput {
	return {
		status: "streaming",
		author: { name: "示例主播", face: "data:image/png;base64,FACE" },
		title: "一场直播",
		area: "虚拟主播",
		description: "纯文本简介",
		cover: "data:image/png;base64,COVER",
		startedAt: STARTED_AT,
		online: 12_345,
		likes: 20_133,
		totalViewers: 31_200,
		fans: 88_800,
		fansChanged: 1_234,
		...over,
	};
}

afterEach(() => {
	vi.useRealTimers();
	Settings.defaultZone = "system";
});

describe("buildLiveCardView — 整个视图", () => {
	/** 新补:把视图的**全部十四个键**一次钉死(原来只有按块看文字),键多了少了、值变了都红。 */
	it("一份满的输入排出一份满的视图", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(STARTED_AT + (2 * 3600 + 13 * 60 + 5) * 1000);
		expect(buildLiveCardView(input())).toEqual({
			status: "streaming",
			username: "示例主播",
			userface: "data:image/png;base64,FACE",
			title: "一场直播",
			area: "虚拟主播",
			description: "纯文本简介",
			cover: "data:image/png;base64,COVER",
			hasCover: true,
			time: "直播时长：2小时13分5秒",
			online: "1.2万",
			likes: "2.0万",
			totalViewers: "3.1万",
			fans: "8.9万",
			fansChanged: "+1234",
		});
	});

	/** 新补:字段都不给时,每个文字格是空串(不是 undefined),块那头才能一律按"空串 = 没有"判。 */
	it("只给必填项:文字格全是空串,封面是占位图且 hasCover 为假", () => {
		const view = buildLiveCardView({ status: "end", author: { name: "甲", face: "" } });
		expect(view).toEqual({
			status: "end",
			username: "甲",
			userface: "",
			title: "",
			area: "",
			description: "",
			cover: LIVE_COVER_PLACEHOLDER,
			hasCover: false,
			time: "",
			online: "",
			likes: "",
			totalViewers: "",
			fans: "",
			fansChanged: "",
		});
	});

	/** 新补:`status` 原样进视图;主播名、头像地址、标题、分区、简介各归各的格。 */
	it("status、主播名、头像地址、标题、分区、简介原样进视图", () => {
		for (const status of ["start", "streaming", "end", "offline"] as const) {
			expect(buildLiveCardView(input({ status })).status).toBe(status);
		}
		const view = buildLiveCardView(
			input({
				author: { name: "名字", face: "https://img/face.jpg" },
				title: "标题",
				area: "分区",
				description: "简介 <原样> & 不再剥",
			}),
		);
		expect(view).toMatchObject({
			username: "名字",
			userface: "https://img/face.jpg",
			title: "标题",
			area: "分区",
			// 富文本是 B 站那头先剥的(`biliLiveCardInput`);视图这一步不再动它。
			description: "简介 <原样> & 不再剥",
		});
	});
});

describe("buildLiveCardView — 卡上那句时间", () => {
	/**
	 * 开播 / 下播:开播时刻按**固定的北京时间**写,与进程所在时区无关。
	 * 新补:已有的两份测试在什么时区跑就是什么结果 —— 开发机恰好在 UTC+8,改成"按本机时区写"它们照样绿,
	 * 只有 UTC 的 CI / 镜像里才红。这里把默认时区拧到别处再断言。
	 * 验红:把 `liveTimeText` 里的 `{ zone: LIVE_TIME_ZONE }` 去掉,这条红。
	 */
	it("start / end:「开播时间：…」固定北京时间,不随默认时区走", () => {
		Settings.defaultZone = "America/Los_Angeles";
		for (const status of ["start", "end"] as const) {
			expect(buildLiveCardView(input({ status })).time).toBe("开播时间：2026-09-13 20:00:00");
		}
	});

	/** 新补(视图层):时区之外还要跨日的一个点 —— UTC 16:30 已是北京时间的次日 00:30。 */
	it("start / end:跨日也按北京时间排(UTC 16:30 → 次日 00:30)", () => {
		const startedAt = Date.parse("2026-09-13T16:30:05Z");
		expect(buildLiveCardView(input({ status: "start", startedAt })).time).toBe(
			"开播时间：2026-09-14 00:30:05",
		);
	});

	/** 原有(neutral-live-card):直播时长由开播时刻与此刻的钟算。这里是视图层的同一条,外加不满一分钟的写法。 */
	it("streaming:「直播时长：…」由开播时刻与此刻的钟算", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(STARTED_AT + (2 * 3600 + 13 * 60 + 5) * 1000);
		expect(buildLiveCardView(input({ status: "streaming" })).time).toBe("直播时长：2小时13分5秒");
		vi.setSystemTime(STARTED_AT + 5_000);
		expect(buildLiveCardView(input({ status: "streaming" })).time).toBe("直播时长：5秒");
	});

	/** 原有(neutral-live-card):offline 写"未开播"。新补:没有开播时刻、和给了一个坏值时同样如此。 */
	it("offline:恒是「未开播」,不看开播时刻有没有", () => {
		expect(buildLiveCardView(input({ status: "offline" })).time).toBe("未开播");
		expect(buildLiveCardView(input({ status: "offline", startedAt: undefined })).time).toBe(
			"未开播",
		);
		expect(buildLiveCardView(input({ status: "offline", startedAt: Number.NaN })).time).toBe(
			"未开播",
		);
	});

	/**
	 * 没有开播时刻就整句不写(空串)—— 写一个后面什么都没有的「开播时间：」不如不出。
	 * 原有(neutral-live-card):start / streaming 没给时刻。新补:end 也如此;坏值(NaN / Infinity)同样当作没有。
	 * 验红:把 `liveTimeText` 里的 `!Number.isFinite(startedAt)` 判断去掉,坏值那几条红。
	 */
	it("没有开播时刻(没给、NaN、Infinity)→ 空串,start / streaming / end 都一样", () => {
		const statuses: LiveCardStatus[] = ["start", "streaming", "end"];
		for (const status of statuses) {
			for (const startedAt of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
				expect(
					buildLiveCardView(input({ status, startedAt })).time,
					`${status} / ${startedAt}`,
				).toBe("");
			}
		}
	});
});

describe("buildLiveCardView — 数字格", () => {
	/**
	 * 数字走 `formatCount`(万 / 亿一位小数,万以下原样);文字原样上卡;没有就空串。
	 * 原有(neutral-live-card):`online` / `likes` / `fans` 给数字、`totalViewers` 给文字。
	 * 新补:四格都过一遍三种形态,外加 0 与空串。
	 */
	it("数字排成「1.2万」,万以下原样,过亿写「亿」", () => {
		const view = buildLiveCardView(
			input({ online: 9_999, likes: 12_345, totalViewers: 100_000_000, fans: 88_800 }),
		);
		expect(view).toMatchObject({
			online: "9999",
			likes: "1.2万",
			totalViewers: "1.0亿",
			fans: "8.9万",
		});
	});

	it("文字原样上卡,哪怕看着像数字;空串仍是空串", () => {
		const view = buildLiveCardView(
			input({ online: "12345", likes: "2.0万+", totalViewers: "3.1万", fans: "" }),
		);
		expect(view).toMatchObject({
			online: "12345",
			likes: "2.0万+",
			totalViewers: "3.1万",
			fans: "",
		});
	});

	/**
	 * 数字 0 是真值:排成 "0",不是空串。块那头 `"0"` 是真值,所以画出来是「人气：0」—— B 站那条路的 `?? 0` 与
	 * 点赞初值 "0" 今天就这样落到卡上(㉒c 要去掉:缺了就缺键、那一格不画)。
	 * 验红:把 `countText` 的 `typeof v === "number"` 换成 `v ?` 之类的真值判断,这条红。
	 */
	it('数字 0 排成 "0",不当成没有', () => {
		const view = buildLiveCardView(
			input({ online: 0, likes: 0, totalViewers: 0, fans: 0, fansChanged: 0 }),
		);
		expect(view).toMatchObject({
			online: "0",
			likes: "0",
			totalViewers: "0",
			fans: "0",
			fansChanged: "0",
		});
	});

	/**
	 * 平台排好的"暂无"也是文字,原样上卡。B 站直播引擎在周期复推时没收到观看人数,会把「暂未获取到」
	 * 写进直播数据(`room-session-watched.test.ts`),下播卡的「累计观看人数」于是印出这句。㉒d 拿掉那条写回。
	 */
	it("累计观看是文字「暂未获取到」时原样上卡", () => {
		expect(buildLiveCardView(input({ totalViewers: "暂未获取到" })).totalViewers).toBe(
			"暂未获取到",
		);
	});

	it('没给的格子是空串,不是 "undefined"', () => {
		const view = buildLiveCardView(
			input({
				online: undefined,
				likes: undefined,
				totalViewers: undefined,
				fans: undefined,
				fansChanged: undefined,
			}),
		);
		expect(view).toMatchObject({
			online: "",
			likes: "",
			totalViewers: "",
			fans: "",
			fansChanged: "",
		});
	});
});

describe("buildLiveCardView — 粉丝数变化带正负号", () => {
	/**
	 * 原有(neutral-live-card):`+1234` / `-35` / `+1.2万` / `-1.2万`(经皮肤契约的 `stats.fansChanged`)。
	 * 新补(视图层):零写 "0"(不带 +)、文字原样(不再补号)。
	 * 验红:去掉 `countText(input.fansChanged, { signed: true })` 里的 `signed`,这条红。
	 */
	it("数字:正数加 +、负数是 -、零是 0;过万写「万」", () => {
		const of = (fansChanged: number) => buildLiveCardView(input({ fansChanged })).fansChanged;
		expect(of(1_234)).toBe("+1234");
		expect(of(-35)).toBe("-35");
		expect(of(0)).toBe("0");
		expect(of(12_345)).toBe("+1.2万");
		expect(of(-12_345)).toBe("-1.2万");
	});

	it("文字:原样,不再补正负号", () => {
		expect(buildLiveCardView(input({ fansChanged: "128" })).fansChanged).toBe("128");
		expect(buildLiveCardView(input({ fansChanged: "+128" })).fansChanged).toBe("+128");
	});

	it("别的数字格不带 +", () => {
		expect(buildLiveCardView(input({ online: 1_234, fans: 1_234 }))).toMatchObject({
			online: "1234",
			fans: "1234",
		});
	});
});

describe("buildLiveCardView — 封面", () => {
	const OVERRIDE = "data:image/png;base64,OVERRIDE";
	const GIVEN = "data:image/png;base64,GIVEN";

	/**
	 * 原有(neutral-live-card 的"自定义直播封面盖在输入的封面上" / "占位图" / 皮肤契约三条):自定义 > 输入 >
	 * 占位,`hasCover` 只认前两样。新补(视图层)三级各一遍,外加自定义封面传空串时落到输入的封面
	 * (`||` 语义,不是 `??`)—— 主人没设自定义封面时出卡入口传的就是空串。
	 * 验红:把 `coverOverride || input.cover` 改成 `??`,空串那条红;让占位图的 `hasCover` 变真,第三条红。
	 */
	it("自定义封面 > 输入的封面", () => {
		expect(buildLiveCardView(input({ cover: GIVEN }), OVERRIDE)).toMatchObject({
			cover: OVERRIDE,
			hasCover: true,
		});
	});

	it("没有自定义封面(没给或空串)→ 输入的封面", () => {
		for (const override of [undefined, ""]) {
			expect(
				buildLiveCardView(input({ cover: GIVEN }), override),
				`override=${override}`,
			).toMatchObject({
				cover: GIVEN,
				hasCover: true,
			});
		}
	});

	it("两样都没有 → 占位图,hasCover 为假(占位图不算真封面)", () => {
		for (const cover of [undefined, ""]) {
			expect(buildLiveCardView(input({ cover }), ""), `cover=${cover}`).toMatchObject({
				cover: LIVE_COVER_PLACEHOLDER,
				hasCover: false,
			});
		}
	});

	it("输入没有封面、只有自定义封面 → 自定义封面,hasCover 为真", () => {
		expect(buildLiveCardView(input({ cover: undefined }), OVERRIDE)).toMatchObject({
			cover: OVERRIDE,
			hasCover: true,
		});
	});
});
