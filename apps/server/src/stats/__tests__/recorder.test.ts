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

describe("StatsRecorder — 场次身份在一场之内保持不变", () => {
	it("同一场被重复观测到,复用第一次用过的 startedAt", async () => {
		// live_time 解析不出时两侧都回退到「此刻」,而重连核对 / 重启 bootstrap 会
		// 再观测同一场 —— 两个「此刻」差着几秒,store 按 startedAt 精确认场次,
		// 同一场就裂成两条区间重叠的记录(正是那条 HIGH 的残余缺口)。
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live", "不是时间"); // 解析不出 → 回退到此刻
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());

		clock = "2026-05-16T10:00:07.000Z"; // 7 秒后重连成功,再观测一次
		trigger("live-state-changed", "1", "live", "还是不是时间");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalledTimes(2));

		const [first, second] = store.openLiveSession.mock.calls;
		expect(second?.[1]).toBe(first?.[1]);
	});

	it("下播之后开的是新一场,身份重新认定", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live", "不是时间");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());
		trigger("live-state-changed", "1", "idle");
		clock = "2026-05-16T15:00:00.000Z";
		trigger("live-state-changed", "1", "live", "不是时间");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalledTimes(2));

		const [first, second] = store.openLiveSession.mock.calls;
		expect(second?.[1]).not.toBe(first?.[1]);
		expect(second?.[1]).toBe("2026-05-16T15:00:00.000Z");
	});

	it("B 站给了真实 live_time 就以它为准,不被记住的旧身份盖住", async () => {
		// 闩只是为了兜住「live_time 用不了、两侧都回退到此刻」那条路径。live_time
		// 拿得到时它**就是**这一场的身份,再去查闩反而会把新一场按到旧一场头上。
		//
		// 触发链:周一开播 → cookie 失效 → auth-lost → LiveEngine.teardown() →
		// disposeAll() 逐个 cancel,**不发 idle**(只有 stopForUid 才发)→ 闩留在原地。
		// 周二重新扫码 → auth-restored → rebuildFromSubs → bootstrap 观测到在播,
		// 带着周二的 live_time 发 live。查闩的话落盘的是周一那个身份,store 认成
		// 「同一场又被观测到」,周二的下播帧于是配到周一的开播上 —— 两场约 3 小时
		// 被并成一场 27 小时,而且写进的是 append-only 文件,事后改不了。
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live", "2026-05-16T09:00:00.000Z");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());

		clock = "2026-05-17T12:00:00.000Z"; // 隔天,期间经历 auth-lost / auth-restored
		trigger("live-state-changed", "1", "live", "2026-05-17T11:00:00.000Z");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalledTimes(2));

		expect(store.openLiveSession.mock.calls[1]?.[1]).toBe("2026-05-17T11:00:00.000Z");
	});

	it("auth-lost 清掉在飞的场次身份 —— 监听已经全停,记着的都不再作数", async () => {
		// live_time 也拿不到的退化情形:光靠「以 live_time 为准」救不回来,因为两次
		// 都得回退到「此刻」。auth-lost 是明确的「从现在起没人在观测了」信号,在这里
		// 把在飞状态清干净,下一场才认得出是新的一场。
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live", "不是时间");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());

		trigger("auth-lost");
		clock = "2026-05-17T12:00:00.000Z";
		trigger("live-state-changed", "1", "live", "还是不是时间");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalledTimes(2));

		expect(store.openLiveSession.mock.calls[1]?.[1]).toBe("2026-05-17T12:00:00.000Z");
	});

	it("退订会清掉记住的身份,不残留到重新订阅之后", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live", "不是时间");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());
		trigger("subscription-changed", [{ type: "remove", id: "sub-1", uid: "1" }]);
		clock = "2026-05-16T16:00:00.000Z";
		trigger("live-state-changed", "1", "live", "不是时间");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalledTimes(2));
		expect(store.openLiveSession.mock.calls[1]?.[1]).toBe("2026-05-16T16:00:00.000Z");
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
