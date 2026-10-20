import { describe, expect, it } from "vite-plus/test";
import type { LiveEvent } from "../../protocol/events.js";
import { makeSessionHarness } from "./support/room-session.js";

async function listening() {
	const h = makeSessionHarness();
	await h.bootstrap();
	return h;
}

const SUPERCHAT: LiveEvent = {
	kind: "superchat",
	content: "加油",
	price: 50,
	durationSec: 60,
	user: { uid: 7, name: "观众", avatarUrl: "https://example.com/avatar.png" },
};
const CAPTAIN: LiveEvent = {
	kind: "guard-buy",
	guardLevel: 3,
	giftName: "舰长",
	user: { uid: 8, name: "舰长观众" },
	num: 1,
	price: 198_000,
};

describe("醒目留言翻译", () => {
	it("出卡输入是翻译出的事件:观众名、留言、金额、币种、按价格算出的档与消息自带的留言时长", async () => {
		const h = await listening();
		await h.dispatch(SUPERCHAT);
		expect(h.interactions[0]).toEqual({
			externalId: "u1",
			report: {
				kind: "superchat",
				viewer: { id: "7", name: "观众" },
				text: "加油",
				amount: 50,
				currency: "CNY",
				tier: { rank: 2, durationSec: 60 },
				fallbackText: "【U1的直播间】观众的SC:加油（50元）",
			},
		});
	});

	it("消息没带留言时长 → 档里没有 durationSec;主播名取自房间资料", async () => {
		const h = await listening();
		await h.dispatch({ ...SUPERCHAT, durationSec: undefined });
		expect(h.interactions[0]?.report).toMatchObject({
			tier: { rank: 2 },
			fallbackText: "【U1的直播间】观众的SC:加油（50元）",
		});
		const report = h.interactions[0]?.report as { tier: object };
		expect(report.tier).not.toHaveProperty("durationSec");
	});

	it("帧里有头像地址 → 出卡前按头像档抓一次,viewer.avatar 是抓到的引用", async () => {
		const h = await listening();
		await h.dispatch(SUPERCHAT);
		expect(h.superchatAvatars).toEqual([{ viewerId: "7", url: "https://example.com/avatar.png" }]);
	});
});

describe("上舰翻译", () => {
	it("舰长:出卡输入的档来自档位表(档名、rank、档色、徽章、宣告语),观众与主播的名字来自事件与房间资料", async () => {
		const h = await listening();
		await h.dispatch(CAPTAIN);
		expect(h.interactions[0]?.report).toMatchObject({
			kind: "membership",
			viewer: { id: "8", name: "舰长观众" },
			tier: { key: "captain", name: "舰长", rank: 1 },
			months: 1,
			amount: 198,
			currency: "CNY",
		});
	});

	it("总督:同一条路,换成总督那一档(rank 3、档色 #f2a053、徽章与宣告语都是总督的)", async () => {
		const h = await listening();
		await h.dispatch({ ...CAPTAIN, guardLevel: 1, giftName: "总督" });
		expect(h.interactions[0]?.report).toMatchObject({
			tier: { key: "governor", name: "总督", rank: 3 },
		});
	});

	it("guard_level 为 0 → 丢弃并记警告,不推空图 + 空文案", async () => {
		const h = await listening();
		await h.dispatch({ ...CAPTAIN, guardLevel: 0 });
		expect(h.interactions).toEqual([]);
		expect(h.warnings.some((args) => String(args[0]).includes("认不出的档位"))).toBe(true);
	});
});

describe("普通互动翻译", () => {
	it("普通弹幕 → viewerChat", async () => {
		const h = await listening();
		await h.dispatch({
			kind: "danmu",
			content: "来了",
			user: { uid: 7, name: "观众" },
		});
		expect(h.interactions[0]?.report).toEqual({
			kind: "viewerChat",
			viewer: { id: "7", name: "观众" },
			text: "来了",
		});
	});

	it("特别关注用户进房 → 渲染并推送(ViewerEnter)", async () => {
		const h = await listening();
		await h.dispatch({
			kind: "user-action",
			action: "enter",
			user: { uid: 7, name: "观众" },
		});
		expect(h.interactions[0]?.report).toEqual({
			kind: "viewerEnter",
			viewer: { id: "7", name: "观众" },
		});
	});

	it("uid 是数字 → 与字符串白名单比对时不因类型不符而漏推", async () => {
		const h = await listening();
		await h.dispatch({
			kind: "user-action",
			action: "enter",
			user: { uid: 123, name: "数字" },
		});
		expect(h.interactions[0]?.report).toMatchObject({ viewer: { id: "123" } });
	});

	it("非进房动作(关注 / 分享 / 未知)→ 不推送", async () => {
		const h = await listening();
		for (const action of ["follow", "share", "unknown"] as const) {
			await h.dispatch({
				kind: "user-action",
				action,
				user: { uid: 7, name: "观众" },
			});
		}
		expect(h.interactions).toEqual([]);
	});

	it("引擎已拆除 → 进房不再往外推", async () => {
		const h = await listening();
		h.setDisposed(true);
		await h.dispatch({
			kind: "user-action",
			action: "enter",
			user: { uid: 7, name: "观众" },
		});
		expect(h.interactions).toEqual([]);
	});
});
