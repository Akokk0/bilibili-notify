/**
 * **B 站房间数据 → 中立的直播卡输入**(`liveCardInputFromRoomInfo`,ADR-0019 决策 68;㉒c)。
 *
 * 从前这条翻译住在 `packages/image`(`biliLiveCardInput`),它的测试夹在出卡入口的 B 站适配层里
 * (`live-card-bili.test.ts`,经默认皮肤看每块画出的文字)。入口收成一个以后,翻译搬来这里,测试也改成直接看
 * **输入**:每种状态码翻成哪个状态、哪句开播时刻、哪张封面、哪几格数;卡上怎么画归出图器那头
 * (`neutral-live-card.test.ts` / `live-view.test.ts`)。
 *
 * 人数只收精确数,缺了就缺键 —— 用 `toStrictEqual` 钉,它分得出「键不在」与「键是 undefined」。
 */

import { describe, expect, it } from "vite-plus/test";
import { liveCardInputFromRoomInfo } from "../live-card-input";
import type { LiveData } from "../types";

const USER_COVER = "http://i0.hdslb.com/bfs/live/new_room_cover/room.jpg";
const KEYFRAME = "http://i0.hdslb.com/bfs/live-key-frame/keyframe.jpg";

/** B 站直播间接口里翻译会读的那几格(`online` 与 `description` 类型里没声明,接口真会给)。 */
const ROOM = {
	title: "周年庆典特别直播",
	area_name: "虚拟主播",
	user_cover: USER_COVER,
	keyframe: KEYFRAME,
	description: "<p>每晚八点开播&nbsp;&amp;&nbsp;周末加场</p><br>&lt;b&gt;见动态&lt;/b&gt;",
	online: 12_345,
	live_time: "2026-09-13 20:00:00",
};

/** 直播引擎攒下的那几个数。累计观看今天存的是 B 站的成品字符串(㉒d 才改精确数)。 */
const LIVE_DATA: LiveData = {
	likedNum: 20_133,
	watchedNum: "3.1万",
	fansNum: 88_800,
	fansChanged: 1_234,
};

const translate = (
	liveStatus: number,
	room: Record<string, unknown> = ROOM,
	liveData: LiveData = LIVE_DATA,
) => liveCardInputFromRoomInfo(room, "示例主播", liveData, liveStatus);

describe("liveCardInputFromRoomInfo — 每一格", () => {
	it("一份满的房间数据:开播翻成 start,每一格都在,键不多不少", () => {
		expect(translate(1)).toStrictEqual({
			status: "start",
			creator: { name: "示例主播" },
			title: "周年庆典特别直播",
			category: "虚拟主播",
			// 富文本剥成纯文本:标签与 entity 都去掉(entity 解出来的 `<b>` 也当标签剥)。
			description: "每晚八点开播 & 周末加场 见动态",
			cover: { url: USER_COVER },
			// B 站 `live_time` 是北京时间,翻成 ISO(UTC)。
			startedAt: "2026-09-13T12:00:00.000Z",
			currentViewers: 12_345,
			likes: 20_133,
			// 累计观看今天是字符串,不收(见下面「累计观看」)。
			followers: 88_800,
			followersDelta: 1_234,
		});
	});

	it("主播只有名字:B 站的头像是远端地址,Creator.avatar 只收图库引用,3a 才有", () => {
		expect(translate(1).creator).toStrictEqual({ name: "示例主播" });
	});

	it("房间数据缺失(null / undefined):不抛,标题等是空串,没有封面、开播时刻与人数", () => {
		for (const room of [null, undefined]) {
			expect(liveCardInputFromRoomInfo(room, "甲", {}, 1)).toStrictEqual({
				status: "start",
				creator: { name: "甲" },
				title: "",
				category: "",
				description: "",
			});
		}
	});
});

describe("liveCardInputFromRoomInfo — 状态码翻成状态", () => {
	it("0 / 1 / 2 / 3 → offline / start / streaming / end", () => {
		expect([0, 1, 2, 3].map((code) => translate(code).status)).toEqual([
			"offline",
			"start",
			"streaming",
			"end",
		]);
	});

	/** 今天没有调用方传进来的其余状态码(比如 4 首次开播):画成「直播中」角标、不写那句时间、先用房间封面。 */
	it("其余状态码(4)→ start,没有开播时刻,先用房间封面", () => {
		const input = translate(4);
		expect(input.status).toBe("start");
		expect(input.startedAt).toBeUndefined();
		expect(input.cover).toEqual({ url: USER_COVER });
	});

	it("已知状态码都带开播时刻(含 0:没在播的卡不写它,但翻译不替出图器决定)", () => {
		for (const code of [0, 1, 2, 3]) {
			expect(translate(code).startedAt, `状态 ${code}`).toBe("2026-09-13T12:00:00.000Z");
		}
	});
});

describe("liveCardInputFromRoomInfo — 开播时刻(live_time → ISO)", () => {
	it("北京时间按 +08:00 读,与进程时区无关", () => {
		expect(translate(1, { ...ROOM, live_time: "2026-01-01 03:30:15" }).startedAt).toBe(
			"2025-12-31T19:30:15.000Z",
		);
	});

	/** B 站对没开播的房间给全零;缺了、空串、坏格式同样当没有 —— 键不在,不是 undefined。 */
	it("缺了 / 空串 / 全零 / 坏格式 → 没有这个键", () => {
		for (const live_time of [undefined, "", "0000-00-00 00:00:00", "2026-13-45 10:00:00", "昨天"]) {
			const input = translate(1, { ...ROOM, live_time });
			expect(Object.hasOwn(input, "startedAt"), String(live_time)).toBe(false);
		}
	});
});

describe("liveCardInputFromRoomInfo — 封面(两张互相兜底)", () => {
	/**
	 * 直播中先取关键帧(实时画面),别的状态先取房间封面,先取的那张没有就拿另一张。没开播时 B 站给的关键帧是空串,
	 * 刚开播时关键帧也常常还没生成 —— 从前那一格画成一张只剩 alt 文字的裂图。
	 */
	it("直播中先关键帧;开播 / 下播 / 没在播先房间封面", () => {
		expect(translate(2).cover).toEqual({ url: KEYFRAME });
		for (const code of [0, 1, 3]) {
			expect(translate(code).cover, `状态 ${code}`).toEqual({ url: USER_COVER });
		}
	});

	it("直播中却没有关键帧(空串或缺)→ 退到房间封面", () => {
		expect(translate(2, { ...ROOM, keyframe: "" }).cover).toEqual({ url: USER_COVER });
		expect(translate(2, { ...ROOM, keyframe: undefined }).cover).toEqual({ url: USER_COVER });
	});

	it("开播 / 下播 / 没在播 / 其余却没有房间封面 → 退到关键帧", () => {
		for (const code of [0, 1, 3, 4]) {
			expect(translate(code, { ...ROOM, user_cover: "" }).cover, `状态 ${code}`).toEqual({
				url: KEYFRAME,
			});
		}
	});

	it("两张都没有 → 没有 cover 这个键(出卡那头画「暂无封面」占位),不是空 url", () => {
		for (const code of [1, 2]) {
			const input = translate(code, { ...ROOM, keyframe: "", user_cover: "" });
			expect(Object.hasOwn(input, "cover"), `状态 ${code}`).toBe(false);
		}
	});
});

describe("liveCardInputFromRoomInfo — 人数只收精确数,缺了就缺键", () => {
	it("此刻在线读房间接口的 online;数字样的字符串也认", () => {
		expect(translate(1, { ...ROOM, online: 0 }).currentViewers).toBe(0);
		expect(translate(1, { ...ROOM, online: "321" }).currentViewers).toBe(321);
	});

	/** 从前 `+(data?.online ?? 0)` 把缺了写成 0,卡上印出「人气：0」。 */
	it("online 缺了 / 空串 / 不是数 → 没有 currentViewers 这个键(不补 0)", () => {
		for (const online of [
			undefined,
			null,
			"",
			"  ",
			"很多",
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			const input = translate(1, { ...ROOM, online });
			expect(Object.hasOwn(input, "currentViewers"), String(online)).toBe(false);
		}
	});

	/** 从前直播数据的点赞初值是 "0",没收到点赞帧也画「点赞：0」。 */
	it("直播引擎没攒到的数 → 没有对应的键", () => {
		const input = translate(3, ROOM, {});
		for (const key of ["likes", "totalViewers", "followers", "followersDelta"]) {
			expect(Object.hasOwn(input, key), key).toBe(false);
		}
	});

	it("攒到的 0 是真数,留着", () => {
		const input = translate(3, ROOM, { likedNum: 0, fansNum: 0, fansChanged: 0 });
		expect(input).toMatchObject({ likes: 0, followers: 0, followersDelta: 0 });
	});

	/**
	 * 累计观看:今天 B 站那条路存的是 `text_small` 字符串("3.1万"),输入只收精确数 —— 这一片不收,
	 * 卡上这一格(下播卡的「累计观看人数」)暂时不画;㉒d 把引擎改存精确数,读法已经就位(是数字才给),
	 * 那一天这两条的期望跟着翻。
	 */
	it("累计观看是字符串 → 暂时不给;是数字 → 给", () => {
		expect(Object.hasOwn(translate(3, ROOM, { watchedNum: "3.1万" }), "totalViewers")).toBe(false);
		expect(Object.hasOwn(translate(3, ROOM, { watchedNum: "暂未获取到" }), "totalViewers")).toBe(
			false,
		);
		expect(translate(3, ROOM, { watchedNum: 31_200 }).totalViewers).toBe(31_200);
	});
});
