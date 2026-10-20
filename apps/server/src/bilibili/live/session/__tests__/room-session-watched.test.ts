import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeSessionHarness } from "./support/room-session.js";

const T0 = 100_000;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

async function ready(externalId = "u1", roomId = "r1") {
	const h = makeSessionHarness({ externalId, roomId });
	await h.bootstrap();
	h.reports.length = 0;
	h.setReportedLive(true);
	return h;
}

function viewerReports(h: Awaited<ReturnType<typeof ready>>) {
	return h.reports.map(
		(entry) => (entry.report as { details?: { totalViewers?: unknown } }).details,
	);
}

describe("WATCHED_CHANGE 帧 · 存进直播数据的值", () => {
	it("存的是精确数 num,不是字符串", async () => {
		const h = await ready();
		await h.dispatch({ kind: "watched", num: 12_345 });
		expect(viewerReports(h)).toEqual([{ totalViewers: 12_345 }]);
	});

	it("每一帧都存(哪怕这一帧被总线节流掉了),最新一帧胜出", async () => {
		const h = await ready();
		await h.dispatch({ kind: "watched", num: 8_000 });
		await h.dispatch({ kind: "watched", num: 9_500 });
		await h.dispatch({ kind: "watched", num: 12_345 });
		expect(viewerReports(h)).toEqual([{ totalViewers: 8_000 }]);
	});
});

describe("WATCHED_CHANGE 帧 · 总线事件(emitViewers)的两秒节流", () => {
	it("第一帧就发,实参是 (uid, num)", async () => {
		const h = await ready("u7", "r7");
		await h.dispatch({ kind: "watched", num: 12_345 });
		expect(h.reports).toEqual([
			{
				externalId: "u7",
				report: { kind: "status", isLive: true, details: { totalViewers: 12_345 } },
			},
		]);
	});

	it("两秒内连来几帧只发一次(发的是最早那帧),每一帧都存", async () => {
		const h = await ready();
		await h.dispatch({ kind: "watched", num: 1 });
		await h.dispatch({ kind: "watched", num: 2 });
		await h.dispatch({ kind: "watched", num: 3 });
		expect(viewerReports(h)).toEqual([{ totalViewers: 1 }]);
	});

	it("差 1 毫秒满两秒还不发,恰好两秒发(含边界),发的是那一帧自己的值", async () => {
		const h = await ready();
		await h.dispatch({ kind: "watched", num: 1 });
		vi.setSystemTime(T0 + 1_999);
		await h.dispatch({ kind: "watched", num: 2 });
		expect(viewerReports(h)).toEqual([{ totalViewers: 1 }]);
		vi.setSystemTime(T0 + 2_000);
		await h.dispatch({ kind: "watched", num: 3 });
		expect(viewerReports(h)).toEqual([{ totalViewers: 1 }, { totalViewers: 3 }]);
	});

	it("节流窗口从**上一次发出**算起,不是从上一帧收到算起", async () => {
		const h = await ready();
		await h.dispatch({ kind: "watched", num: 1 });
		vi.setSystemTime(T0 + 1_500);
		await h.dispatch({ kind: "watched", num: 2 });
		vi.setSystemTime(T0 + 2_100);
		await h.dispatch({ kind: "watched", num: 3 });
		expect(viewerReports(h)).toEqual([{ totalViewers: 1 }, { totalViewers: 3 }]);
	});

	it("每个 UID 各管各的节流:同一刻两个房间各发一次", async () => {
		const a = await ready("ua", "ra");
		const b = await ready("ub", "rb");
		await a.dispatch({ kind: "watched", num: 11 });
		await b.dispatch({ kind: "watched", num: 22 });
		expect(viewerReports(a)).toEqual([{ totalViewers: 11 }]);
		expect(viewerReports(b)).toEqual([{ totalViewers: 22 }]);
	});
});
