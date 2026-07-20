/**
 * 单元测试 — `createStatsRecorder`(mock bus + mock store)。
 *
 * Recorder 是采集层唯一的 bus 消费者:把 `dynamic-detected` /
 * `live-state-changed` / `live-viewers-changed` 三条事件落进 StatsStore。
 *
 * 守护契约:
 *   - dynamic-detected → appendDynamic 原样透传(不在这层做类型归类)
 *   - live-state-changed live/idle → open/closeLiveSession,时间取注入时钟
 *   - 峰值观看取本场 viewers 的最大值,且跨场不串味(新场重置)
 *   - "1.2万" 这类 B 站压缩字符串要能与纯数字正确比大小
 *   - dispose 后不再写任何东西
 */

import type { MessageBus } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createStatsRecorder } from "../recorder.js";
import type { StatsStore } from "../store.js";

function makeBus() {
	const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
	const bus = {
		emit: () => {},
		on: (event: string, handler: (...a: unknown[]) => void) => {
			const arr = handlers.get(event) ?? [];
			arr.push(handler);
			handlers.set(event, arr);
			// 真解绑 —— dispose 用例要验的是「recorder 归还了 bus 句柄」这个契约,
			// 而不是它内部有没有自己记一个 disposed 标志位。
			return {
				dispose: () => {
					const cur = handlers.get(event);
					if (cur)
						handlers.set(
							event,
							cur.filter((h) => h !== handler),
						);
				},
			};
		},
	} as unknown as MessageBus;
	return {
		bus,
		trigger: (event: string, ...a: unknown[]) => {
			for (const h of handlers.get(event) ?? []) h(...a);
		},
	};
}

function makeStore() {
	return {
		appendDynamic: vi.fn(async () => {}),
		listDynamics: vi.fn(async () => []),
		openLiveSession: vi.fn(async () => {}),
		closeLiveSession: vi.fn(async () => {}),
		listLiveSessions: vi.fn(async () => []),
		recordingSince: vi.fn(async () => "1970-01-01T00:00:00.000Z"),
		dropUid: vi.fn(async () => {}),
	} satisfies Record<keyof StatsStore, unknown> as unknown as StatsStore & {
		appendDynamic: ReturnType<typeof vi.fn>;
		openLiveSession: ReturnType<typeof vi.fn>;
		closeLiveSession: ReturnType<typeof vi.fn>;
	};
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

let clock: string;
const now = () => new Date(clock);

beforeEach(() => {
	clock = "2026-05-16T10:00:00.000Z";
	vi.clearAllMocks();
});

function setup() {
	const { bus, trigger } = makeBus();
	const store = makeStore();
	const handle = createStatsRecorder({ bus, store, logger, now });
	return { trigger, store, handle };
}

describe("StatsRecorder — 动态事件", () => {
	it("dynamic-detected → appendDynamic 原样透传", async () => {
		const { trigger, store } = setup();
		trigger("dynamic-detected", {
			uid: "1",
			id: "abc",
			type: "DYNAMIC_TYPE_AV",
			ts: "2026-05-16T09:00:00.000Z",
		});
		await vi.waitFor(() => expect(store.appendDynamic).toHaveBeenCalled());
		expect(store.appendDynamic).toHaveBeenCalledWith("1", {
			id: "abc",
			type: "DYNAMIC_TYPE_AV",
			ts: "2026-05-16T09:00:00.000Z",
		});
	});
});

describe("StatsRecorder — 直播场次", () => {
	it("事件带了真实开播时间就用它,而不是我们发现的时刻", async () => {
		// 服务器 10:00 启动时 UP 已经播了 40 分钟。记成 10:00 会平白吞掉这 40 分钟 ——
		// 「直播时长 Top」在这种情况下会显示成 0。
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live", "2026-05-16T09:20:00.000Z");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());
		expect(store.openLiveSession).toHaveBeenCalledWith("1", "2026-05-16T09:20:00.000Z");
	});

	it("开播时间缺失 / 不可解析时回退到注入时钟,不写坏数据", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live", "不是时间");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());
		expect(store.openLiveSession).toHaveBeenCalledWith("1", "2026-05-16T10:00:00.000Z");
	});

	it("开播时间晚于现在(时钟漂移)时同样回退 —— 不接受未来的开播时间", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live", "2026-05-16T11:00:00.000Z");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());
		expect(store.openLiveSession).toHaveBeenCalledWith("1", "2026-05-16T10:00:00.000Z");
	});

	it("live → openLiveSession,时间取注入时钟", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());
		expect(store.openLiveSession).toHaveBeenCalledWith("1", "2026-05-16T10:00:00.000Z");
	});

	it("idle → closeLiveSession,带本场峰值观看", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live");
		trigger("live-viewers-changed", "1", "8000");
		trigger("live-viewers-changed", "1", "1.2万");
		trigger("live-viewers-changed", "1", "9500");
		clock = "2026-05-16T13:00:00.000Z";
		trigger("live-state-changed", "1", "idle");
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalled());
		// "1.2万" = 12000 > 9500 > 8000 —— 压缩字符串要参与数值比较
		expect(store.closeLiveSession).toHaveBeenCalledWith("1", "2026-05-16T13:00:00.000Z", "1.2万");
	});

	it("没采到 viewers → 不带峰值收场", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live");
		trigger("live-state-changed", "1", "idle");
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalled());
		expect(store.closeLiveSession).toHaveBeenCalledWith("1", "2026-05-16T10:00:00.000Z", undefined);
	});

	it("新一场直播重置峰值,不串上一场的数字", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live");
		trigger("live-viewers-changed", "1", "50万");
		trigger("live-state-changed", "1", "idle");
		trigger("live-state-changed", "1", "live");
		trigger("live-viewers-changed", "1", "100");
		trigger("live-state-changed", "1", "idle");
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalledTimes(2));
		expect(store.closeLiveSession.mock.calls[1]?.[2]).toBe("100");
	});

	it("不同 UP 的峰值互不干扰", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live");
		trigger("live-state-changed", "2", "live");
		trigger("live-viewers-changed", "1", "3万");
		trigger("live-viewers-changed", "2", "500");
		trigger("live-state-changed", "2", "idle");
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalled());
		expect(store.closeLiveSession).toHaveBeenCalledWith("2", expect.any(String), "500");
	});
});

describe("StatsRecorder — 下播时刻", () => {
	it("事件带了真实下播时刻就用它,不用收到事件的此刻", async () => {
		// 断流接续:真实下播在进入挂起那刻就定格了,事件却要等 N 分钟窗口到期才发。
		// 用收到事件的此刻落盘,每场直播都平白多出整个 grace 窗口(默认 2 分钟,
		// 最长 10 分钟),而下播卡上写的是定格时长 —— 同一场两个数对不上。
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live", "2026-05-16T09:00:00.000Z");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());

		clock = "2026-05-16T12:02:00.000Z"; // grace 到期,事件此刻才发出
		trigger("live-state-changed", "1", "idle", "2026-05-16T12:00:00.000Z"); // 真实下播
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalled());
		expect(store.closeLiveSession).toHaveBeenCalledWith("1", "2026-05-16T12:00:00.000Z", undefined);
	});

	it("没带时刻(WS 即时下播)→ 回退到收到事件的此刻", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live", "2026-05-16T09:00:00.000Z");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());

		clock = "2026-05-16T12:00:00.000Z";
		trigger("live-state-changed", "1", "idle");
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalled());
		expect(store.closeLiveSession).toHaveBeenCalledWith("1", "2026-05-16T12:00:00.000Z", undefined);
	});
});

describe("StatsRecorder — 订阅删除清理", () => {
	it("subscription-changed 的 remove → dropUid,不留孤儿文件", async () => {
		const { trigger, store } = setup();
		trigger("subscription-changed", [
			{ type: "remove", id: "sub-1", uid: "1" },
			{ type: "add", sub: { uid: "2" } },
		]);
		await vi.waitFor(() => expect(store.dropUid).toHaveBeenCalled());
		expect(store.dropUid).toHaveBeenCalledTimes(1);
		expect(store.dropUid).toHaveBeenCalledWith("1");
	});

	it("退订正在直播的 UP → 关服时不再给他补下播帧,免得把刚删的文件重建出来", async () => {
		// `openLive` 曾经只在正常下播时被摘掉。退订时 `dropUid` 已经 unlink 了那两个
		// jsonl,但这位 uid 还留在 `openLive` 里 —— 关服的 closeOpenSessions 会给他
		// 再 append 一帧 end,把 stats/live/<uid>.jsonl 整个重新创建出来,从此成为
		// 一份谁也不会再读、也不会再被清理的孤儿。
		const { trigger, store, handle } = setup();
		trigger("live-state-changed", "1", "live", "2026-05-16T09:00:00.000Z");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());

		trigger("subscription-changed", [{ type: "remove", id: "sub-1", uid: "1" }]);
		await vi.waitFor(() => expect(store.dropUid).toHaveBeenCalled());

		await handle.closeOpenSessions();
		expect(store.closeLiveSession).not.toHaveBeenCalled();
	});

	it("被删 UP 的开播峰值一并丢弃,不会漏进下一位 UP", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live");
		trigger("live-viewers-changed", "1", "50万");
		trigger("subscription-changed", [{ type: "remove", id: "sub-1", uid: "1" }]);
		// 重新订阅同一 uid 后开播又下播 —— 峰值必须是新场自己的
		trigger("live-state-changed", "1", "live");
		trigger("live-state-changed", "1", "idle");
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalled());
		expect(store.closeLiveSession).toHaveBeenCalledWith("1", expect.any(String), undefined);
	});
});

describe("StatsRecorder — dispose", () => {
	it("dispose 后事件不再落盘", async () => {
		const { trigger, store, handle } = setup();
		handle.dispose();
		trigger("dynamic-detected", { uid: "1", id: "a", type: "T", ts: "2026-05-16T09:00:00.000Z" });
		trigger("live-state-changed", "1", "live");
		await new Promise((r) => setTimeout(r, 10));
		expect(store.appendDynamic).not.toHaveBeenCalled();
		expect(store.openLiveSession).not.toHaveBeenCalled();
	});
});

describe("StatsRecorder — 关服时闭合在播场次", () => {
	it("关服时把敞开的场写上下播帧,不丢掉已经播的时长", async () => {
		// 关服路径不会触发真实下播事件(teardown/cancel 都不翻 liveStatus),
		// 不补这一帧的话,这一场永远等不到 end,已观测到的时长就白丢了。
		const { trigger, store, handle } = setup();
		trigger("live-state-changed", "1", "live", "2026-05-16T09:00:00.000Z");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());

		clock = "2026-05-16T12:00:00.000Z";
		await handle.closeOpenSessions();
		expect(store.closeLiveSession).toHaveBeenCalledWith("1", "2026-05-16T12:00:00.000Z", undefined);
	});

	it("带上本场峰值 —— 与正常下播同款口径", async () => {
		const { trigger, store, handle } = setup();
		trigger("live-state-changed", "1", "live", "2026-05-16T09:00:00.000Z");
		trigger("live-viewers-changed", "1", "1.2万");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());

		clock = "2026-05-16T12:00:00.000Z";
		await handle.closeOpenSessions();
		expect(store.closeLiveSession).toHaveBeenCalledWith("1", "2026-05-16T12:00:00.000Z", "1.2万");
	});

	it("没有在播的场次 → 不写多余的帧", async () => {
		const { store, handle } = setup();
		await handle.closeOpenSessions();
		expect(store.closeLiveSession).not.toHaveBeenCalled();
	});

	it("已经正常下播的场次不会在关服时被重复闭合", async () => {
		const { trigger, store, handle } = setup();
		trigger("live-state-changed", "1", "live", "2026-05-16T09:00:00.000Z");
		trigger("live-state-changed", "1", "idle");
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalledTimes(1));

		await handle.closeOpenSessions();
		expect(store.closeLiveSession).toHaveBeenCalledTimes(1);
	});
});

describe("StatsRecorder — 采集水位线", () => {
	it("recorder 一建起来就钉下水位线,不等第一次有人来读", async () => {
		// 惰性创建的话,水位线盖的是「第一次打开统计页」的时刻。升级后过几天才
		// 点开统计页,这几天真采到的活动会全被判成「无记录」—— 数据在盘上,
		// 界面上却是空白,而且水位线一旦落下就恒定,永远显示不出来。
		const { store } = setup();
		await vi.waitFor(() => expect(store.recordingSince).toHaveBeenCalled());
	});
});
