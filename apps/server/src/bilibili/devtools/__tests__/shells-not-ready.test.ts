import { type AuthState, ok } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { type OverridableApi, overridableApi } from "../../../devtools/api-overrides.js";
import { createNodeMessageBus } from "../../../runtime/message-bus.js";
import type { Api } from "../../api/index.js";
import { dynamicScenarios } from "../dynamic.js";
import { liveScenarios, type SubPick } from "../live.js";
import { createLiveRooms } from "../live-rooms.js";
import { loginStateScenario } from "../login-state.js";
import { fakeAuth } from "./support/fake-auth.js";
import { biliRegistry } from "./support/registry.js";

const NOT_READY = "B 站来源还没起来，先等它起来再试";
const SUBS: SubPick[] = [{ id: "s1", uid: "100", name: "甲", enabled: true }];

describe("B 站场景现取开发壳", () => {
	it("直播:壳没起来时回提示且不塞事件;之后起来再按照常生效", async () => {
		let api: OverridableApi<Pick<Api, "fetchLiveRoomInfo">> | undefined;
		const rooms = createLiveRooms();
		const events: unknown[] = [];
		rooms.observe({
			roomId: 5050,
			onEvent: (event) => events.push(event),
			client: { closed: false, close() {} },
		});
		const reg = biliRegistry(
			liveScenarios({
				subs: () => SUBS,
				rooms,
				api: () => api,
				liveRooms: () => ({ roomIdOf: () => "5050" }),
			}),
		);

		await expect(reg.run("bilibili.live.start", {})).resolves.toMatchObject({ summary: NOT_READY });
		expect(events).toEqual([]);

		const shell = overridableApi({
			async fetchLiveRoomInfo(roomId: string) {
				return {
					code: 0,
					data: {
						uid: 100,
						room_id: Number(roomId),
						short_id: 0,
						live_status: 0,
						live_time: "",
						title: `房间 ${roomId}`,
						user_cover: "",
						keyframe: "",
						tags: "",
						area_name: "",
						parent_area_name: "",
					},
				};
			},
		});
		api = shell;
		await expect(reg.run("bilibili.live.start", {})).resolves.toBeDefined();
		expect(events).toEqual([{ kind: "live-start" }]);
		expect((await shell.api.fetchLiveRoomInfo("5050")).data.live_status).toBe(1);
	});

	it("动态:壳没起来时回提示且不跑检测;之后起来再按照常生效", async () => {
		let api: OverridableApi<Pick<Api, "fetchAllDynamic">> | undefined;
		let seen: string[] = [];
		const detectNow = vi.fn(async () => {
			const result = await api?.api.fetchAllDynamic();
			if (result?.ok) seen = result.data.items.map((item) => (item as { id_str: string }).id_str);
		});
		const reg = biliRegistry(
			dynamicScenarios({
				subs: () => SUBS,
				api: () => api,
				dynamic: () => ({ detectNow }),
				profileAvatars: () => undefined,
			}),
		);

		await expect(reg.run("bilibili.dynamic.post", {})).resolves.toMatchObject({
			summary: NOT_READY,
		});
		expect(detectNow).not.toHaveBeenCalled();

		api = overridableApi({
			async fetchAllDynamic() {
				return ok({
					data: {
						has_more: false,
						items: [{ id_str: "real-1" }] as never[],
						offset: "",
						update_baseline: "",
						update_num: 0,
					},
				});
			},
		});
		await expect(reg.run("bilibili.dynamic.post", {})).resolves.toBeDefined();
		expect(detectNow).toHaveBeenCalledOnce();
		expect(seen).toHaveLength(2);
		expect(seen[0]).toMatch(/^dev-/);
		expect(seen[1]).toBe("real-1");
	});

	it("登录状态:壳没起来时回提示且不报状态;之后起来再按照常生效", async () => {
		const real: AuthState = { status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" };
		let auth: OverridableApi<ReturnType<typeof fakeAuth>> | undefined;
		const bus = createNodeMessageBus();
		const reports: Array<{ sourceKey: string; state: AuthState }> = [];
		bus.on("subscription-auth-changed", (changed) => reports.push(changed));
		const reg = biliRegistry([loginStateScenario({ auth: () => auth, bus })]);

		await expect(
			reg.run("bilibili.auth.login-state", {
				status: "logged-in",
				uname: "假账号",
			}),
		).resolves.toMatchObject({ summary: NOT_READY });
		expect(reports).toEqual([]);

		auth = overridableApi(fakeAuth(real, { name: "真的" }));
		await expect(
			reg.run("bilibili.auth.login-state", {
				status: "logged-in",
				uname: "假账号",
			}),
		).resolves.toBeDefined();
		expect(auth.api.state()).toMatchObject({ status: "logged-in" });
		expect(auth.api.account()).toEqual({ name: "假账号" });
		expect(reports).toEqual([{ sourceKey: "bilibili", state: auth.api.state() }]);
	});
});
