/**
 * 单元测试 — `createStatsRecorder`(mock bus + mock store)。
 *
 * Recorder = 中立的记录器 + B 站适配(ADR-0020 决策 17):B 站适配听
 * `dynamic-detected` / `live-state-changed` / `live-viewers-changed` 三条事件,
 * 就地翻成中立的调用,记录器落进 StatsStore。事件带的是 uid,落盘按**订阅 id**
 * (ADR-0020 决策 2 的 🔗)—— 下面的订阅 id 故意与 uid 不同,键用错了一眼就红。
 *
 * 守护契约:
 *   - dynamic-detected → B 站适配归类:AV 记成 video,开播那两种记成 live,其余记成 post
 *   - live-state-changed live/idle → open/closeLiveSession,时间取注入时钟
 *   - 峰值观看取本场 viewers 的最大值,且跨场不串味(新场重置)
 *   - "1.2万" 这类 B 站压缩字符串在交进记录器之前解析成数字,落盘的是数字
 *   - dispose 后不再写任何东西
 */

import type { MessageBus } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { attachBiliStatsSource } from "../bili-source.js";
import { createStatsRecorder, createStatsRecorderCore } from "../recorder.js";
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
		drop: vi.fn(async () => {}),
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

/** 两位 UP:uid "1" / "2",订阅 id "id-1" / "id-2"。 */
const SUBS = [
	{ kind: "bilibili", id: "id-1", uid: "1" },
	{ kind: "bilibili", id: "id-2", uid: "2" },
];

function setup(subs: () => readonly unknown[] = () => SUBS) {
	const { bus, trigger } = makeBus();
	const store = makeStore();
	const handle = createStatsRecorder({ bus, store, logger, now, subscriptions: subs as never });
	return { trigger, store, handle };
}

describe("StatsRecorder — 动态事件(B 站适配就地归类)", () => {
	it("dynamic-detected 的视频投稿 → appendDynamic 记成 video,按订阅 id 落(不是 uid)", async () => {
		const { trigger, store } = setup();
		trigger("dynamic-detected", {
			uid: "1",
			id: "abc",
			type: "DYNAMIC_TYPE_AV",
			ts: "2026-05-16T09:00:00.000Z",
		});
		await vi.waitFor(() => expect(store.appendDynamic).toHaveBeenCalled());
		expect(store.appendDynamic).toHaveBeenCalledWith("id-1", {
			id: "abc",
			kind: "video",
			ts: "2026-05-16T09:00:00.000Z",
		});
	});

	it("图文 / 纯文字 / 转发 / 没见过的新类型 → post", async () => {
		const { trigger, store } = setup();
		const types = [
			"DYNAMIC_TYPE_DRAW",
			"DYNAMIC_TYPE_WORD",
			"DYNAMIC_TYPE_FORWARD",
			"DYNAMIC_TYPE_SOMETHING_NEW",
		];
		for (const [i, type] of types.entries()) {
			trigger("dynamic-detected", { uid: "1", id: `d${i}`, type, ts: "2026-05-16T09:00:00.000Z" });
		}
		await vi.waitFor(() => expect(store.appendDynamic).toHaveBeenCalledTimes(types.length));
		expect(store.appendDynamic.mock.calls.map((c) => c[1].kind)).toEqual([
			"post",
			"post",
			"post",
			"post",
		]);
	});

	it("开播那两种记成 live —— 不是作品,但「最后活动」与「那天有记录」要用到它", async () => {
		// 没开直播类推送的 UP 不记场次,开播公告是他开过播的唯一痕迹;不记的话天天开播
		// 也会被判成很久没动静、进鸽子榜(ADR-0020 决策 5 的第二个 🔗)。
		const { trigger, store } = setup();
		trigger("dynamic-detected", {
			uid: "1",
			id: "l1",
			type: "DYNAMIC_TYPE_LIVE_RCMD",
			ts: "2026-05-16T09:00:00.000Z",
		});
		trigger("dynamic-detected", {
			uid: "1",
			id: "l2",
			type: "DYNAMIC_TYPE_LIVE",
			ts: "2026-05-16T09:05:00.000Z",
		});
		await vi.waitFor(() => expect(store.appendDynamic).toHaveBeenCalledTimes(2));
		expect(store.appendDynamic).toHaveBeenNthCalledWith(1, "id-1", {
			id: "l1",
			kind: "live",
			ts: "2026-05-16T09:00:00.000Z",
		});
		expect(store.appendDynamic).toHaveBeenNthCalledWith(2, "id-1", {
			id: "l2",
			kind: "live",
			ts: "2026-05-16T09:05:00.000Z",
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
		expect(store.openLiveSession).toHaveBeenCalledWith("id-1", "2026-05-16T09:20:00.000Z");
	});

	it("开播时间缺失 / 不可解析时回退到注入时钟,不写坏数据", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live", "不是时间");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());
		expect(store.openLiveSession).toHaveBeenCalledWith("id-1", "2026-05-16T10:00:00.000Z");
	});

	it("开播时间晚于现在(时钟漂移)时同样回退 —— 不接受未来的开播时间", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live", "2026-05-16T11:00:00.000Z");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());
		expect(store.openLiveSession).toHaveBeenCalledWith("id-1", "2026-05-16T10:00:00.000Z");
	});

	it("live → openLiveSession,时间取注入时钟", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());
		expect(store.openLiveSession).toHaveBeenCalledWith("id-1", "2026-05-16T10:00:00.000Z");
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
		// "1.2万" = 12000 > 9500 > 8000 —— 压缩字符串要参与数值比较,落盘的是解析好的数
		expect(store.closeLiveSession).toHaveBeenCalledWith("id-1", "2026-05-16T13:00:00.000Z", 12_000);
	});

	it("没采到 viewers → 不带峰值收场", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live");
		trigger("live-state-changed", "1", "idle");
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalled());
		expect(store.closeLiveSession).toHaveBeenCalledWith(
			"id-1",
			"2026-05-16T10:00:00.000Z",
			undefined,
		);
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
		expect(store.closeLiveSession.mock.calls[1]?.[2]).toBe(100);
	});

	it("不同 UP 的峰值互不干扰", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live");
		trigger("live-state-changed", "2", "live");
		trigger("live-viewers-changed", "1", "3万");
		trigger("live-viewers-changed", "2", "500");
		trigger("live-state-changed", "2", "idle");
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalled());
		expect(store.closeLiveSession).toHaveBeenCalledWith("id-2", expect.any(String), 500);
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
		trigger("subscription-changed", [{ type: "remove", sub: { id: "id-1", uid: "1" } }]);
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
		expect(store.closeLiveSession).toHaveBeenCalledWith(
			"id-1",
			"2026-05-16T12:00:00.000Z",
			undefined,
		);
	});

	it("没带时刻(WS 即时下播)→ 回退到收到事件的此刻", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live", "2026-05-16T09:00:00.000Z");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());

		clock = "2026-05-16T12:00:00.000Z";
		trigger("live-state-changed", "1", "idle");
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalled());
		expect(store.closeLiveSession).toHaveBeenCalledWith(
			"id-1",
			"2026-05-16T12:00:00.000Z",
			undefined,
		);
	});
});

describe("StatsRecorder — 订阅删除清理", () => {
	it("subscription-changed 的 remove → drop,不留孤儿文件", async () => {
		const { trigger, store } = setup();
		trigger("subscription-changed", [
			{ type: "remove", sub: { id: "id-1", uid: "1" } },
			{ type: "add", sub: { uid: "2" } },
		]);
		await vi.waitFor(() => expect(store.drop).toHaveBeenCalled());
		expect(store.drop).toHaveBeenCalledTimes(1);
		expect(store.drop).toHaveBeenCalledWith("id-1");
	});

	it("删掉的是拓展订阅 → 统计没有它的文件,一个都不删(ADR-0019 决策 12)", async () => {
		const { trigger, store } = setup();
		trigger("subscription-changed", [
			{ type: "remove", sub: { kind: "extension", id: "ext-1", externalId: "1" } },
			{ type: "remove", sub: { id: "id-2", uid: "2" } },
		]);
		await vi.waitFor(() => expect(store.drop).toHaveBeenCalled());
		expect(store.drop).toHaveBeenCalledTimes(1);
		expect(store.drop).toHaveBeenCalledWith("id-2");
	});

	it("退订正在直播的 UP → 关服时不再给他补下播帧,免得把刚删的文件重建出来", async () => {
		// `openLive` 曾经只在正常下播时被摘掉。退订时 `drop` 已经 unlink 了那两个
		// jsonl,但这位 uid 还留在 `openLive` 里 —— 关服的 closeOpenSessions 会给他
		// 再 append 一帧 end,把 stats/live/<uid>.jsonl 整个重新创建出来,从此成为
		// 一份谁也不会再读、也不会再被清理的孤儿。
		const { trigger, store, handle } = setup();
		trigger("live-state-changed", "1", "live", "2026-05-16T09:00:00.000Z");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());

		trigger("subscription-changed", [{ type: "remove", sub: { id: "id-1", uid: "1" } }]);
		await vi.waitFor(() => expect(store.drop).toHaveBeenCalled());

		await handle.closeOpenSessions();
		expect(store.closeLiveSession).not.toHaveBeenCalled();
	});

	it("被删 UP 的开播峰值一并丢弃,不会漏进下一位 UP", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live");
		trigger("live-viewers-changed", "1", "50万");
		trigger("subscription-changed", [{ type: "remove", sub: { id: "id-1", uid: "1" } }]);
		// 重新订阅同一 uid 后开播又下播 —— 峰值必须是新场自己的
		trigger("live-state-changed", "1", "live");
		trigger("live-state-changed", "1", "idle");
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalled());
		expect(store.closeLiveSession).toHaveBeenCalledWith("id-1", expect.any(String), undefined);
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
		expect(store.closeLiveSession).toHaveBeenCalledWith(
			"id-1",
			"2026-05-16T12:00:00.000Z",
			undefined,
		);
	});

	it("带上本场峰值 —— 与正常下播同款口径", async () => {
		const { trigger, store, handle } = setup();
		trigger("live-state-changed", "1", "live", "2026-05-16T09:00:00.000Z");
		trigger("live-viewers-changed", "1", "1.2万");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());

		clock = "2026-05-16T12:00:00.000Z";
		await handle.closeOpenSessions();
		expect(store.closeLiveSession).toHaveBeenCalledWith("id-1", "2026-05-16T12:00:00.000Z", 12_000);
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

describe("StatsRecorder — 观看数解析不出", () => {
	it("解析不出的 viewers 不参与峰值,也不把已有的峰值冲掉", async () => {
		const { trigger, store } = setup();
		trigger("live-state-changed", "1", "live");
		trigger("live-viewers-changed", "1", "3万");
		trigger("live-viewers-changed", "1", "看不懂");
		trigger("live-state-changed", "1", "idle");
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalled());
		expect(store.closeLiveSession).toHaveBeenCalledWith("id-1", expect.any(String), 30_000);
	});
});

describe("中立记录器(给各来源适配用的那一面)", () => {
	function core() {
		const store = makeStore();
		const recorder = createStatsRecorderCore({ store, logger, now });
		return { store, recorder };
	}

	it("关一场时带的 peak 与报过的累计观看取较大的那个", async () => {
		const { store, recorder } = core();
		recorder.openSession("ext-a", "2026-05-16T09:00:00.000Z");
		recorder.reportViewers("ext-a", 800);
		recorder.closeSession("ext-a", "2026-05-16T10:00:00.000Z", 500);
		recorder.openSession("ext-b", "2026-05-16T09:00:00.000Z");
		recorder.reportViewers("ext-b", 800);
		recorder.closeSession("ext-b", "2026-05-16T10:00:00.000Z", 1200);
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalledTimes(2));
		expect(store.closeLiveSession).toHaveBeenNthCalledWith(1, "ext-a", expect.any(String), 800);
		expect(store.closeLiveSession).toHaveBeenNthCalledWith(2, "ext-b", expect.any(String), 1200);
	});

	it("非有限数的累计观看不收", async () => {
		const { store, recorder } = core();
		recorder.openSession("k", "2026-05-16T09:00:00.000Z");
		recorder.reportViewers("k", Number.NaN);
		recorder.closeSession("k", "2026-05-16T10:00:00.000Z", Number.POSITIVE_INFINITY);
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalled());
		expect(store.closeLiveSession).toHaveBeenCalledWith("k", expect.any(String), undefined);
	});

	it("B 站的 auth-lost 只忘 B 站交过的键,别的来源在飞的场次照样在关服时收尾", async () => {
		// S3 的拓展适配会往同一个记录器里开场次。B 站 cookie 失效只说明 B 站那头没人在看,
		// 拓展那一场不该跟着被忘掉 —— 否则关服时它等不到补的那帧下播。
		const { bus, trigger } = makeBus();
		const store = makeStore();
		const recorder = createStatsRecorderCore({ store, logger, now });
		attachBiliStatsSource({ bus, recorder, now, subscriptions: () => SUBS as never });
		trigger("live-state-changed", "1", "live", "2026-05-16T09:00:00.000Z");
		recorder.openSession("ext-x", "2026-05-16T09:30:00.000Z");
		recorder.reportViewers("ext-x", 42);
		trigger("auth-lost");
		clock = "2026-05-16T12:00:00.000Z";
		await recorder.closeOpenSessions();
		expect(store.closeLiveSession).toHaveBeenCalledTimes(1);
		expect(store.closeLiveSession).toHaveBeenCalledWith("ext-x", "2026-05-16T12:00:00.000Z", 42);
	});

	it("drop 忘掉在飞的状态并删文件", async () => {
		const { store, recorder } = core();
		recorder.openSession("ext-y", "2026-05-16T09:00:00.000Z");
		recorder.drop("ext-y");
		await vi.waitFor(() => expect(store.drop).toHaveBeenCalledWith("ext-y"));
		await recorder.closeOpenSessions();
		expect(store.closeLiveSession).not.toHaveBeenCalled();
	});
});

describe("B 站适配:uid → 订阅 id 在边上换", () => {
	it("找不到订阅的 uid → 作品 / 开播 / 观看数 / 下播一样都不记", async () => {
		// 改之前按 uid 照记不误:退订之后引擎补发的那帧 idle 会把刚删掉的 uid 文件重新写出来。
		const { trigger, store } = setup();
		trigger("dynamic-detected", {
			uid: "404",
			id: "x",
			type: "DYNAMIC_TYPE_AV",
			ts: "2026-05-16T09:00:00.000Z",
		});
		trigger("live-state-changed", "404", "live", "2026-05-16T09:00:00.000Z");
		trigger("live-viewers-changed", "404", "3万");
		trigger("live-state-changed", "404", "idle");
		// 对照:同一串事件换成订阅着的 uid 就记 —— 证明监听确实在跑、不是空转。
		trigger("dynamic-detected", {
			uid: "1",
			id: "y",
			type: "DYNAMIC_TYPE_AV",
			ts: "2026-05-16T09:00:00.000Z",
		});
		await vi.waitFor(() => expect(store.appendDynamic).toHaveBeenCalled());
		expect(store.appendDynamic).toHaveBeenCalledTimes(1);
		expect(store.appendDynamic).toHaveBeenCalledWith("id-1", expect.objectContaining({ id: "y" }));
		expect(store.openLiveSession).not.toHaveBeenCalled();
		expect(store.closeLiveSession).not.toHaveBeenCalled();
	});

	it("同一个 uid 两条 B 站订阅(服务端不判重)→ 两条都记", async () => {
		const { trigger, store } = setup(() => [
			{ kind: "bilibili", id: "id-1", uid: "1" },
			{ kind: "bilibili", id: "id-1b", uid: "1" },
		]);
		trigger("dynamic-detected", {
			uid: "1",
			id: "y",
			type: "DYNAMIC_TYPE_WORD",
			ts: "2026-05-16T09:00:00.000Z",
		});
		trigger("live-state-changed", "1", "live", "2026-05-16T09:00:00.000Z");
		trigger("live-viewers-changed", "1", "500");
		trigger("live-state-changed", "1", "idle");
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalledTimes(2));
		expect(store.appendDynamic.mock.calls.map((c) => c[0])).toEqual(["id-1", "id-1b"]);
		expect(store.closeLiveSession.mock.calls.map((c) => [c[0], c[2]])).toEqual([
			["id-1", 500],
			["id-1b", 500],
		]);
	});

	it("拓展订阅的外部 id 撞上 uid 也不认 —— 只查 B 站那一支", async () => {
		const { trigger, store } = setup(() => [{ kind: "extension", id: "ext-x", externalId: "1" }]);
		trigger("dynamic-detected", {
			uid: "1",
			id: "y",
			type: "DYNAMIC_TYPE_AV",
			ts: "2026-05-16T09:00:00.000Z",
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(store.appendDynamic).not.toHaveBeenCalled();
	});

	it("新加的订阅认得出:订阅列表变了之后,那个 uid 的事件就记在新订阅名下", async () => {
		let subs: unknown[] = [];
		const { trigger, store } = setup(() => subs);
		trigger("dynamic-detected", {
			uid: "7",
			id: "early",
			type: "DYNAMIC_TYPE_AV",
			ts: "2026-05-16T09:00:00.000Z",
		});
		subs = [{ kind: "bilibili", id: "id-7", uid: "7" }];
		trigger("subscription-changed", [{ type: "add", sub: subs[0] }]);
		trigger("dynamic-detected", {
			uid: "7",
			id: "late",
			type: "DYNAMIC_TYPE_AV",
			ts: "2026-05-16T09:00:00.000Z",
		});
		await vi.waitFor(() => expect(store.appendDynamic).toHaveBeenCalled());
		expect(store.appendDynamic).toHaveBeenCalledTimes(1);
		expect(store.appendDynamic).toHaveBeenCalledWith(
			"id-7",
			expect.objectContaining({ id: "late" }),
		);
	});

	it("刚加的订阅,作废通知还没到也认得出 —— 查不到时重查一次", async () => {
		let subs: unknown[] = [SUBS[0]];
		const { trigger, store } = setup(() => subs);
		trigger("dynamic-detected", {
			uid: "1",
			id: "warm",
			type: "DYNAMIC_TYPE_AV",
			ts: "2026-05-16T09:00:00.000Z",
		});
		subs = [...SUBS];
		trigger("dynamic-detected", {
			uid: "2",
			id: "new",
			type: "DYNAMIC_TYPE_AV",
			ts: "2026-05-16T09:00:00.000Z",
		});
		await vi.waitFor(() => expect(store.appendDynamic).toHaveBeenCalledTimes(2));
		expect(store.appendDynamic.mock.calls.map((c) => c[0])).toEqual(["id-1", "id-2"]);
	});

	it("删掉的订阅不再记:之后同 uid 的事件不会把文件重新写出来", async () => {
		let subs: unknown[] = [...SUBS];
		const { trigger, store } = setup(() => subs);
		trigger("live-state-changed", "1", "live", "2026-05-16T09:00:00.000Z");
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());
		subs = [SUBS[1]];
		trigger("subscription-changed", [{ type: "remove", sub: SUBS[0] }]);
		trigger("live-state-changed", "1", "idle");
		trigger("dynamic-detected", {
			uid: "1",
			id: "z",
			type: "DYNAMIC_TYPE_AV",
			ts: "2026-05-16T09:00:00.000Z",
		});
		await vi.waitFor(() => expect(store.drop).toHaveBeenCalledWith("id-1"));
		await new Promise((r) => setTimeout(r, 10));
		expect(store.closeLiveSession).not.toHaveBeenCalled();
		expect(store.appendDynamic).not.toHaveBeenCalled();
	});
});
