import {
	type DevParamField,
	type DevParamValues,
	fail,
	ok,
	type Result,
	type SourceSubscriptionView,
} from "@bilibili-notify/internal";
import type { OverridableApi } from "../../devtools/api-overrides.js";
import type { DevScenarioDef } from "../../devtools/registry.js";
import type { Api } from "../api/index.js";
import type { LiveRoomHandle, LiveRooms } from "./live-rooms.js";
import { BILI_SHELLS_NOT_READY_SUMMARY } from "./shells.js";

/**
 * A1:开播 / 下播 —— 往房间的事件漏斗塞 `live-start` / `live-end`,走的是与真帧完全相同的
 * 回调,后面渲染开播卡、推送、下播卡、词云、总结全是真链路(想不出网就先开截流)。
 *
 * 光塞事件不够:room-session 收到开播会立刻拉房间信息,拉到 `live_status: 0` 就当没开;
 * 而 `live_time` 是这一场的身份(统计按它认场次)。所以假直播期间 `fetchLiveRoomInfo` 对那个
 * 房间打补丁 —— 真结果 + `live_status: 1` + `live_time` = 现在 + 假标题;别的房间不受影响,
 * 下播即摘掉。
 */

/** 场景里怎么称呼一位 UP:B 站自己的名单里只有 UID,名字在核心的资料缓存里,场景拿不到。 */
export function uidLabel(externalId: string): string {
	return `UID ${externalId}`;
}

/** 场景挑 UP 的那个参数:值是 B 站名单里的 UID,宿主按名单核过才交进来。 */
export const CREATOR_PARAM: DevParamField = { key: "creator", label: "UP主", kind: "creator" };

/** 名单里的这一位(`creator` 参数宿主核过,这里只是取出来)。省略 = undefined。 */
export function givenCreator(params: DevParamValues): string | undefined {
	return params.creator === undefined ? undefined : String(params.creator);
}

export interface RoomPickerDeps {
	/** B 站自己的名单(`ctx.subscriptions()` 那一份),现读;来源还没起来时是空的。 */
	roster: () => readonly SourceSubscriptionView[];
	rooms: LiveRooms;
	/** 来源自己的房号缓存;来源还没起来时没有这个把手。 */
	liveRooms: () => { roomIdOf(externalId: string): string | undefined } | undefined;
}

export interface LiveScenarioDeps extends RoomPickerDeps {
	/** 用 Pick 而不是整个 OverridableApi<Api>:测试里只需要装得下 `fetchLiveRoomInfo`。 */
	api: () => OverridableApi<Pick<Api, "fetchLiveRoomInfo">> | undefined;
}

/**
 * 直播类场景共用的「挑哪位 UP、连着的那条连接在哪」:`creator` 省略 = 名单里第一个直播间
 * 已连上的;给了就用给的(宿主已按名单核过)。房间没连上的一律拒绝,而且说清楚是哪一步没到。
 */
export function pickRoom(
	deps: RoomPickerDeps,
	params: DevParamValues,
): Result<{ externalId: string; roomId: number; handle: LiveRoomHandle }> {
	const roomIdOf = (externalId: string) => deps.liveRooms()?.roomIdOf(externalId);
	const externalId =
		givenCreator(params) ??
		deps.roster().find((view) => {
			const roomId = roomIdOf(view.externalId);
			return roomId !== undefined && deps.rooms.find(Number(roomId));
		})?.externalId;
	if (externalId === undefined) return fail("invalid", "名单里没有一位直播间已连上的 UP");
	const resolved = roomIdOf(externalId);
	if (!resolved) return fail("invalid", `${uidLabel(externalId)} 还没解析出房号(没登录 / 刚添加)`);
	const roomId = Number(resolved);
	const handle = deps.rooms.find(roomId);
	if (!handle) {
		return fail(
			"invalid",
			`${uidLabel(externalId)} 的直播间 ${roomId} 还没连上(订阅停用 / 还在预检 / 被风控)`,
		);
	}
	return ok({ externalId, roomId, handle });
}

const DEFAULT_TITLE = "devtools 造的一场直播";

/** B 站 `live_time` 的格式:北京时间 `yyyy-MM-dd HH:mm:ss`。 */
function beijingTime(ms: number): string {
	return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
}

interface FakeLive {
	externalId: string;
	roomId: number;
	title: string;
	startedAt: number;
}

export function liveScenarios(deps: LiveScenarioDeps): DevScenarioDef[] {
	/** 假直播中的房间。 */
	const fakes = new Map<number, FakeLive>();

	function syncOverride(api: OverridableApi<Pick<Api, "fetchLiveRoomInfo">>): void {
		if (fakes.size === 0) {
			api.clear("fetchLiveRoomInfo");
			return;
		}
		api.override("fetchLiveRoomInfo", async (real, roomId) => {
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
		const api = deps.api();
		if (api) syncOverride(api);
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
			CREATOR_PARAM,
			{ key: "title", label: "直播标题", kind: "text", default: DEFAULT_TITLE },
		],
		run(params) {
			const api = deps.api();
			if (!api) return ok({ summary: BILI_SHELLS_NOT_READY_SUMMARY });
			const picked = pickRoom(deps, params);
			if (!picked.ok) return picked;
			const { externalId, roomId, handle } = picked;
			const title =
				typeof params.title === "string" && params.title !== "" ? params.title : DEFAULT_TITLE;
			fakes.set(roomId, { externalId, roomId, title, startedAt: Date.now() });
			syncOverride(api);
			handle.inject({ kind: "live-start" });
			return ok({
				summary: `已向 ${uidLabel(externalId)} 的直播间 ${roomId} 塞了开播事件,开播卡走真链路。`,
			});
		},
		active() {
			if (fakes.size === 0) return null;
			const names = [...fakes.values()].map((f) => uidLabel(f.externalId)).join(" / ");
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
		params: [CREATOR_PARAM],
		run(params) {
			const api = deps.api();
			if (!api) return ok({ summary: BILI_SHELLS_NOT_READY_SUMMARY });
			const picked = pickRoom(deps, params);
			if (!picked.ok) return picked;
			const { externalId, roomId, handle } = picked;
			const who = uidLabel(externalId);
			if (fakes.has(roomId)) {
				endFake(roomId);
				return ok({ summary: `已向 ${who} 的直播间 ${roomId} 塞了下播事件,假直播结束。` });
			}
			handle.inject({ kind: "live-end" });
			return ok({
				summary: `已向 ${who} 的直播间 ${roomId} 塞了下播事件 —— 这个房间没在假直播,结束的是真的那一场的追踪。`,
			});
		},
	};

	return [start, end];
}
