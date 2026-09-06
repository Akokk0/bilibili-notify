import type { LiveClient, LiveEvent } from "@bilibili-notify/blive";
import { describe, expect, it } from "vite-plus/test";
import { createLiveRooms } from "../live-rooms.js";

/**
 * 直播间连接登记:blive 每建一条连接报一声,这里记住「房号 → 那条连接的 onEvent」,场景按
 * 房号往里塞事件。连接关了就当没有;同一房间重连以最新那条为准。
 */

function fakeClient(): LiveClient & { end(): void } {
	let closed = false;
	return {
		get closed() {
			return closed;
		},
		close() {
			closed = true;
		},
		end() {
			closed = true;
		},
	};
}

describe("createLiveRooms", () => {
	it("登记后按房号找得到,塞进去的事件到达那条 onEvent", () => {
		const rooms = createLiveRooms();
		const got: LiveEvent[] = [];
		rooms.observe({ roomId: 5050, onEvent: (ev) => got.push(ev), client: fakeClient() });

		expect(rooms.rooms()).toEqual([5050]);
		rooms.find(5050)?.inject({ kind: "live-start" });
		expect(got).toEqual([{ kind: "live-start" }]);
		expect(rooms.find(6060)).toBeUndefined();
	});

	it("连接关了就当没有,也不再列出", () => {
		const rooms = createLiveRooms();
		const client = fakeClient();
		rooms.observe({ roomId: 5050, onEvent: () => {}, client });
		client.end();
		expect(rooms.find(5050)).toBeUndefined();
		expect(rooms.rooms()).toEqual([]);
	});

	it("同一房间重连:以最新那条为准", () => {
		const rooms = createLiveRooms();
		const first: LiveEvent[] = [];
		const second: LiveEvent[] = [];
		const c1 = fakeClient();
		rooms.observe({ roomId: 5050, onEvent: (ev) => first.push(ev), client: c1 });
		c1.end();
		rooms.observe({ roomId: 5050, onEvent: (ev) => second.push(ev), client: fakeClient() });
		rooms.find(5050)?.inject({ kind: "live-end" });
		expect(first).toEqual([]);
		expect(second).toEqual([{ kind: "live-end" }]);
	});
});
