import type { BilibiliAPI } from "@bilibili-notify/api";
import type { DevParamValues } from "@bilibili-notify/contract";
import type { OverridableApi } from "../api-overrides.js";
import type { LiveRoomHandle, LiveRooms } from "../live-rooms.js";
import { DevParamError, type DevScenarioDef } from "../registry.js";

/**
 * A1:开播 / 下播 —— 往房间的事件漏斗塞 `live-start` / `live-end`,走的是与真帧完全相同的
 * 回调,后面渲染开播卡、推送、下播卡、词云、总结全是真链路(想不出网就先开截流)。
 *
 * 光塞事件不够:room-session 收到开播会立刻拉房间信息,拉到 `live_status: 0` 就当没开;
 * 而 `live_time` 是这一场的身份(统计按它认场次)。所以假直播期间 `getLiveRoomInfo` 对那个
 * 房间打补丁 —— 真结果 + `live_status: 1` + `live_time` = 现在 + 假标题;别的房间不受影响,
 * 下播即摘掉。
 */

/** 场景挑订阅用的那几样;`roomId` 缺 = 还没解析出房号(没登录 / 刚添加)。 */
export interface SubPick {
	id: string;
	uid: string;
	name: string;
	enabled: boolean;
	roomId?: string;
	/** 特别关注的 uid(进场 / 弹幕推送的白名单)。 */
	specialUsers?: string[];
	/** 头像 url(假动态的作者头像 / 封面借它)。 */
	avatar?: string;
}

export interface RoomPickerDeps {
	subs: () => SubPick[];
	rooms: LiveRooms;
}

export interface LiveScenarioDeps extends RoomPickerDeps {
	/** 用 Pick 而不是整个 OverridableApi<BilibiliAPI>:测试里只需要装得下 `getLiveRoomInfo`。 */
	api: OverridableApi<Pick<BilibiliAPI, "getLiveRoomInfo">>;
}

/**
 * 直播类场景共用的「挑哪位 UP、连着的那条连接在哪」:`sub` 省略 = 第一个启用且直播间
 * 已连上的;给了就按 id 找。房间没连上的一律拒绝,而且说清楚是哪一步没到。
 */
export function pickRoom(
	deps: RoomPickerDeps,
	params: DevParamValues,
): { sub: SubPick; roomId: number; handle: LiveRoomHandle } {
	const wanted = params.sub;
	const subs = deps.subs();
	const sub =
		wanted === undefined
			? subs.find((s) => s.enabled && s.roomId && deps.rooms.find(Number(s.roomId)))
			: subs.find((s) => s.id === String(wanted));
	if (!sub) {
		throw new DevParamError(
			wanted === undefined ? "没有一个启用且直播间已连上的订阅" : `没有这个订阅:${wanted}`,
		);
	}
	if (!sub.roomId) throw new DevParamError(`${sub.name} 还没解析出房号(没登录 / 刚添加)`);
	const roomId = Number(sub.roomId);
	const handle = deps.rooms.find(roomId);
	if (!handle) {
		throw new DevParamError(
			`${sub.name} 的直播间 ${roomId} 还没连上(订阅停用 / 还在预检 / 被风控)`,
		);
	}
	return { sub, roomId, handle };
}

const DEFAULT_TITLE = "devtools 造的一场直播";

/** B 站 `live_time` 的格式:北京时间 `yyyy-MM-dd HH:mm:ss`。 */
function beijingTime(ms: number): string {
	return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
}

interface FakeLive {
	sub: SubPick;
	roomId: number;
	title: string;
	startedAt: number;
}

export function liveScenarios(deps: LiveScenarioDeps): DevScenarioDef[] {
	/** 假直播中的房间。 */
	const fakes = new Map<number, FakeLive>();

	function syncOverride(): void {
		if (fakes.size === 0) {
			deps.api.clear("getLiveRoomInfo");
			return;
		}
		deps.api.override("getLiveRoomInfo", async (real, roomId) => {
			const res = await real(roomId);
			const fake = fakes.get(Number(roomId));
			if (!fake || !res.data) return res;
			return {
				...res,
				data: {
					...res.data,
					live_status: 1,
					live_time: beijingTime(fake.startedAt),
					title: fake.title,
				},
			};
		});
	}

	function endFake(roomId: number): void {
		fakes.delete(roomId);
		syncOverride();
		deps.rooms.find(roomId)?.inject({ kind: "live-end" });
	}

	const start: DevScenarioDef = {
		id: "live.start",
		group: "event",
		title: "开播",
		icon: "live",
		desc: "往这位 UP 的直播间塞一条开播事件,并让房间信息在假直播期间说「在播」。开播卡、复推、之后的弹幕 / SC / 下播全走真链路 —— 不想真发就先开截流。",
		quick: true,
		params: [
			{ key: "sub", label: "订阅", kind: "sub" },
			{ key: "title", label: "直播标题", kind: "text", default: DEFAULT_TITLE },
		],
		run(params) {
			const { sub, roomId, handle } = pickRoom(deps, params);
			const title =
				typeof params.title === "string" && params.title !== "" ? params.title : DEFAULT_TITLE;
			fakes.set(roomId, { sub, roomId, title, startedAt: Date.now() });
			syncOverride();
			handle.inject({ kind: "live-start" });
			return { summary: `已向 ${sub.name} 的直播间 ${roomId} 塞了开播事件,开播卡走真链路。` };
		},
		active() {
			if (fakes.size === 0) return null;
			const names = [...fakes.values()].map((f) => f.sub.name).join(" / ");
			return { scenarioId: "live.start", label: `假直播中 · ${names}` };
		},
		reset() {
			for (const roomId of [...fakes.keys()]) endFake(roomId);
		},
	};

	const end: DevScenarioDef = {
		id: "live.end",
		group: "event",
		title: "下播",
		icon: "square",
		desc: "往直播间塞一条下播事件:假直播就此结束(房间信息补丁摘掉);房间没在假直播的话,这是在结束一场真的直播的追踪。",
		quick: true,
		params: [{ key: "sub", label: "订阅", kind: "sub" }],
		run(params) {
			const { sub, roomId, handle } = pickRoom(deps, params);
			if (fakes.has(roomId)) {
				endFake(roomId);
				return { summary: `已向 ${sub.name} 的直播间 ${roomId} 塞了下播事件,假直播结束。` };
			}
			handle.inject({ kind: "live-end" });
			return {
				summary: `已向 ${sub.name} 的直播间 ${roomId} 塞了下播事件 —— 这个房间没在假直播,结束的是真的那一场的追踪。`,
			};
		},
	};

	return [start, end];
}
