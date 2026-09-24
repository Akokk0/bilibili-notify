/**
 * 🪦 **直播卡的旧形状照样画得对**。块与契约改吃 `LiveCardView` 之后(ADR-0019 决策 68),
 * `apps/server/src/routes/cards.ts` 的示例预览这一波还在拼旧的 `LiveCardProps`(B 站接口原样的
 * `data` + 压成角标用的状态码)。皮肤渲染器在入口处把它翻成视图 —— 这里钉的是翻过去之后与
 * 直接交视图**逐字节相同**。那边改掉、翻译那一步删掉时,这份一起删。
 */

import { DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import type { LiveCardProps, LiveCardView } from "../../templates/live-card";
import { renderCardWithSkin } from "../render-skin";

const COVER = "data:image/svg+xml;utf8,COVER";
const OVERRIDE = "data:image/png;base64,OVERRIDE";

/** 照路由的示例预览拼的那一份(`buildLivePreviewProps`)。 */
function legacy(over: Partial<LiveCardProps> = {}): LiveCardProps {
	return {
		data: {
			user_cover: COVER,
			keyframe: "",
			title: "示例直播标题",
			area_name: "游戏",
			description: "<p>今晚 7 点开始</p>",
			online: 12_345,
		},
		username: "示例 UP 主",
		userface: "data:image/svg+xml;utf8,FACE",
		titleStatus: "已开播 12 分钟",
		liveTime: "2026-05-09 19:00:00",
		liveStatus: 1,
		cover: true,
		onlineNum: "1.2万",
		likedNum: "8.7万",
		watchedNum: "3.4万",
		fansNum: "215万",
		fansChanged: "+128",
		...over,
	};
}

/** 同一张卡直接写成视图。 */
function view(over: Partial<LiveCardView> = {}): LiveCardView {
	return {
		status: "streaming",
		username: "示例 UP 主",
		userface: "data:image/svg+xml;utf8,FACE",
		title: "示例直播标题",
		area: "游戏",
		description: "今晚 7 点开始",
		cover: COVER,
		time: "2026-05-09 19:00:00",
		online: "1.2万",
		likes: "8.7万",
		totalViewers: "3.4万",
		fans: "215万",
		fansChanged: "+128",
		...over,
	};
}

const html = (props: LiveCardProps | LiveCardView) =>
	renderCardWithSkin("live", props, DEFAULT_CARD_SKIN);

describe("直播卡的旧形状 → 视图", () => {
	/** 验红:把 `liveCardViewOf` 里状态码的映射改错一档(比如 1 → end),这条红。 */
	it("1 = 直播中、2 = 已下播、其余 = 未开播,与直接交视图画出同一张卡", async () => {
		expect(await html(legacy({ liveStatus: 1 }))).toBe(await html(view({ status: "streaming" })));
		expect(await html(legacy({ liveStatus: 2 }))).toBe(await html(view({ status: "end" })));
		expect(await html(legacy({ liveStatus: 0 }))).toBe(await html(view({ status: "offline" })));
	});

	it("封面:自定义封面优先;否则 cover 为真取房间封面、为假取关键帧", async () => {
		expect(await html(legacy({ coverOverride: OVERRIDE }))).toBe(
			await html(view({ cover: OVERRIDE })),
		);
		expect(await html(legacy({ cover: false }))).toBe(await html(view({ cover: "" })));
	});
});
