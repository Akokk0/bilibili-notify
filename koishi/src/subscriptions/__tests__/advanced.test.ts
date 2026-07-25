import { deterministicUuid, PushTargetSchema } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { type AdvancedSubRawConfigShape, buildAdvancedSubAndTargets } from "../advanced";

function makeRaw(
	uid: string,
	channelId: string,
	platform = "onebot",
	opts: {
		/** UP 级 @全体 默认。undefined → 走 koishi schema default(dynamic:false, live:true)。 */
		upDynamicAtAll?: boolean;
		upLiveAtAll?: boolean;
		/** per-channel @全体 显式覆写。undefined → inherit。 */
		chDynamicAtAll?: boolean;
		chLiveAtAll?: boolean;
	} = {},
) {
	return {
		uid,
		roomId: "",
		dynamic: true,
		// koishi schema 给的 default(模拟 schema parse 后的 raw config)。
		dynamicAtAll: opts.upDynamicAtAll ?? false,
		live: true,
		liveAtAll: opts.upLiveAtAll ?? true,
		liveEnd: false,
		liveGuardBuy: false,
		superchat: false,
		wordcloud: true,
		liveSummary: true,
		target: [
			{
				platform,
				channelArr: [
					{
						channelId,
						dynamic: true,
						live: true,
						liveEnd: false,
						liveGuardBuy: false,
						superchat: false,
						wordcloud: true,
						liveSummary: true,
						specialDanmaku: false,
						specialUserEnter: false,
						// optional — undefined 表示 inherit
						...(opts.chDynamicAtAll !== undefined ? { dynamicAtAll: opts.chDynamicAtAll } : {}),
						...(opts.chLiveAtAll !== undefined ? { liveAtAll: opts.chLiveAtAll } : {}),
					},
				],
			},
		],
		customLiveSummary: { enable: false },
		customLiveMsg: { enable: false },
		customCardStyle: { enable: false },
		customGuardBuy: { enable: false },
		customSpecialDanmakuUsers: { enable: false },
		customSpecialUsersEnterTheRoom: { enable: false },
	};
}

describe("buildAdvancedSubAndTargets()", () => {
	it("显式 feature 布尔写入 overrides.features,默认关闭的 SC/舰长勾选后可启用", () => {
		const raw = makeRaw("11", "111111");
		raw.liveEnd = false;
		raw.liveGuardBuy = true;
		raw.superchat = true;
		raw.target[0].channelArr[0].liveEnd = false;
		raw.target[0].channelArr[0].liveGuardBuy = true;
		raw.target[0].channelArr[0].superchat = true;
		const cfg: AdvancedSubRawShim = { subs: { "UP-1": raw } };

		const { subs, targets } = buildAdvancedSubAndTargets(
			cfg as unknown as AdvancedSubRawConfigShape,
		);
		const sub = subs[0];
		const targetId = targets[0].id;

		expect(sub.overrides.features).toMatchObject({
			liveEnd: false,
			liveGuardBuy: true,
			superchat: true,
		});
		expect(sub.routing.liveEnd).toEqual([]);
		expect(sub.routing.liveGuardBuy).toEqual([targetId]);
		expect(sub.routing.superchat).toEqual([targetId]);
		expect(sub.overrides.features?.specialDanmaku).toBeUndefined();
		expect(sub.overrides.features?.specialUserEnter).toBeUndefined();
	});

	it("channel 级 specialDanmaku/specialUserEnter 只影响 routing,不写入 UP 级 feature overrides", () => {
		const raw = makeRaw("11", "111111");
		raw.target[0].channelArr[0].specialDanmaku = true;
		raw.target[0].channelArr[0].specialUserEnter = true;
		const rawWithStrayUpSpecial = raw as ReturnType<typeof makeRaw> & {
			specialDanmaku?: boolean;
			specialUserEnter?: boolean;
		};
		// 即便旧配置/手写配置误带 UP 级 special 布尔,也不能当成 UP feature 或 master gate。
		rawWithStrayUpSpecial.specialDanmaku = false;
		rawWithStrayUpSpecial.specialUserEnter = false;
		const cfg: AdvancedSubRawShim = { subs: { "UP-1": raw } };

		const { subs, targets } = buildAdvancedSubAndTargets(
			cfg as unknown as AdvancedSubRawConfigShape,
		);
		const sub = subs[0];
		const targetId = targets[0].id;

		expect(sub.routing.specialDanmaku).toEqual([targetId]);
		expect(sub.routing.specialUserEnter).toEqual([targetId]);
		expect(sub.overrides.features?.specialDanmaku).toBeUndefined();
		expect(sub.overrides.features?.specialUserEnter).toBeUndefined();
	});

	it("emits a target for every channel referenced by routing (Fix 6)", () => {
		const cfg: AdvancedSubRawShim = {
			subs: {
				"UP-1": makeRaw("11", "111111"),
				"UP-2": makeRaw("22", "222222"),
			},
		};
		const { subs, targets } = buildAdvancedSubAndTargets(
			cfg as unknown as AdvancedSubRawConfigShape,
		);
		expect(subs).toHaveLength(2);
		expect(targets).toHaveLength(2);

		// Every targetId mentioned in any sub.routing must exist in the targets list.
		const targetIdSet = new Set(targets.map((t) => t.id));
		for (const sub of subs) {
			for (const ids of Object.values(sub.routing)) {
				for (const id of ids) expect(targetIdSet.has(id)).toBe(true);
			}
		}

		// All synthesized targets must pass the canonical PushTargetSchema.
		for (const t of targets) {
			const r = PushTargetSchema.safeParse(t);
			expect(r.success).toBe(true);
		}
	});

	it("dedups targets when multiple subs share the same (platform, channelId)", () => {
		const cfg: AdvancedSubRawShim = {
			subs: {
				"UP-1": makeRaw("11", "shared"),
				"UP-2": makeRaw("22", "shared"),
			},
		};
		const { subs, targets } = buildAdvancedSubAndTargets(
			cfg as unknown as AdvancedSubRawConfigShape,
		);
		expect(subs).toHaveLength(2);
		expect(targets).toHaveLength(1);
		// Both subs must reference the deduped target id.
		expect(subs[0].routing.live?.[0]).toBe(targets[0].id);
		expect(subs[1].routing.live?.[0]).toBe(targets[0].id);
	});

	it("把配置字典 key 当 UP 昵称写入 Subscription.name,供 core 渲染", () => {
		const cfg: AdvancedSubRawShim = {
			subs: {
				时之沙: makeRaw("12345", "111"),
				小花花: makeRaw("67890", "222"),
				"  带空格  ": makeRaw("55555", "555"),
				// key 恰等于 uid / 纯空白 → 无意义,不写(渲染回退 uid)
				"99999": makeRaw("99999", "333"),
				"   ": makeRaw("77777", "777"),
			},
		};
		const { subs } = buildAdvancedSubAndTargets(cfg as unknown as AdvancedSubRawConfigShape);
		expect(Object.fromEntries(subs.map((s) => [s.uid, s.name]))).toEqual({
			"12345": "时之沙",
			"67890": "小花花",
			"55555": "带空格",
			"99999": undefined,
			"77777": undefined,
		});
	});

	it("maps UP-level dynamicAtAll/liveAtAll to Subscription.atAllDefaults", () => {
		const cfg: AdvancedSubRawShim = {
			subs: {
				"UP-1": makeRaw("11", "111", "onebot", { upDynamicAtAll: true, upLiveAtAll: false }),
				"UP-2": makeRaw("22", "222", "onebot"), // 用 schema 默认 false / true
			},
		};
		const { subs } = buildAdvancedSubAndTargets(cfg as unknown as AdvancedSubRawConfigShape);
		expect(subs[0].atAllDefaults).toEqual({ dynamic: true, live: false });
		expect(subs[1].atAllDefaults).toEqual({ dynamic: false, live: true });
	});

	it("maps per-channel @全体 toggles to Subscription.atAll Map (optional → inherit)", () => {
		const cfg: AdvancedSubRawShim = {
			subs: {
				// UP-1:per-channel 显式 ON + OFF
				"UP-1": makeRaw("11", "111", "onebot", { chDynamicAtAll: true, chLiveAtAll: false }),
				// UP-2:per-channel 完全没填 → Map 空,走 atAllDefaults
				"UP-2": makeRaw("22", "222"),
			},
		};
		const { subs } = buildAdvancedSubAndTargets(cfg as unknown as AdvancedSubRawConfigShape);
		// UP-1:Map 有 entry,显式覆写
		const up1TargetId = subs[0].routing.dynamic[0];
		expect(subs[0].atAll.dynamic[up1TargetId]).toBe(true);
		expect(subs[0].atAll.live[up1TargetId]).toBe(false);
		// UP-2:Map 空,inherit
		expect(subs[1].atAll.dynamic).toEqual({});
		expect(subs[1].atAll.live).toEqual({});
		// Map keys 都是 routing 子集
		for (const key of Object.keys(subs[0].atAll.dynamic)) {
			expect(subs[0].routing.dynamic).toContain(key);
		}
		for (const key of Object.keys(subs[0].atAll.live)) {
			expect(subs[0].routing.live).toContain(key);
		}
	});
});

describe("customFilters / customSchedule enable 门(分组收口 + 继承修正)", () => {
	function withGroups(extra: {
		customFilters?: Record<string, unknown>;
		customSchedule?: Record<string, unknown>;
	}): AdvancedSubRawConfigShape {
		return {
			subs: { "UP-1": { ...makeRaw("11", "111111"), ...extra } },
		} as unknown as AdvancedSubRawConfigShape;
	}

	it("两组缺省 → 不写 overrides.filters / schedule(纯继承全局,修掉旧版无条件过度覆盖)", () => {
		const { subs } = buildAdvancedSubAndTargets(withGroups({}));
		expect(subs[0].overrides.filters).toBeUndefined();
		expect(subs[0].overrides.schedule).toBeUndefined();
	});

	it("customFilters.enable=false → 即便带字段也整组跳过", () => {
		const { subs } = buildAdvancedSubAndTargets(
			withGroups({ customFilters: { enable: false, blockForward: true, minScPrice: 50 } }),
		);
		expect(subs[0].overrides.filters).toBeUndefined();
	});

	it("customFilters.enable=true → 数组空继承、标量显式;部分字段 partial 写入(含 blockDraw / blockAv)", () => {
		const { subs } = buildAdvancedSubAndTargets(
			withGroups({
				customFilters: {
					enable: true,
					blockForward: true,
					blockArticle: false,
					blockDraw: true,
					blockAv: false,
					blockKeywords: ["spam"],
					blockRegex: [],
					whitelistKeywords: [],
					whitelistRegex: [],
					minScPrice: 30,
					minGuardLevel: 2,
				},
			}),
		);
		expect(subs[0].overrides.filters).toEqual({
			blockForward: true,
			blockArticle: false,
			blockDraw: true,
			blockAv: false,
			blockKeywords: ["spam"],
			minScPrice: 30,
			minGuardLevel: 2,
		});
		// 空数组项不写 → 继承全局
		expect(subs[0].overrides.filters?.blockRegex).toBeUndefined();
		expect(subs[0].overrides.filters?.whitelistKeywords).toBeUndefined();
	});

	it("customSchedule.enable=false → 不写 overrides.schedule", () => {
		const { subs } = buildAdvancedSubAndTargets(
			withGroups({ customSchedule: { enable: false, pushTime: 6, restartPush: true } }),
		);
		expect(subs[0].overrides.schedule).toBeUndefined();
	});

	it("customSchedule.enable=true → quietHours/pushTime/restartPush 进 overrides.schedule", () => {
		const { subs } = buildAdvancedSubAndTargets(
			withGroups({
				customSchedule: {
					enable: true,
					quietHours: [{ start: 1, end: 7 }],
					pushTime: 6,
					restartPush: true,
				},
			}),
		);
		expect(subs[0].overrides.schedule).toEqual({
			quietHours: [{ start: 1, end: 7 }],
			pushTime: 6,
			restartPush: true,
		});
	});

	it("customSchedule.enable=true 但 quietHours 空 → 仅写 pushTime/restartPush", () => {
		const { subs } = buildAdvancedSubAndTargets(
			withGroups({
				customSchedule: { enable: true, quietHours: [], pushTime: 0, restartPush: false },
			}),
		);
		expect(subs[0].overrides.schedule).toEqual({ pushTime: 0, restartPush: false });
	});

	it("customFilters.enable=true 但所有字段缺省 → overrides.filters 仍 undefined(无空对象写入)", () => {
		// 任务点:enable 开但没填任何字段时,filterOverrides 为空对象,
		// Object.keys().length === 0 守卫必须让 overrides.filters 保持 undefined,
		// 否则 resolve 时会写一个空 override(虽 merge 行为等价,但 store 幂等
		// stableStringify 会因多一个 {} 字段产生噪声 diff)。
		const { subs } = buildAdvancedSubAndTargets(withGroups({ customFilters: { enable: true } }));
		expect(subs[0].overrides.filters).toBeUndefined();
	});

	it("customSchedule.enable=true 但三字段全缺省 → overrides.schedule 仍 undefined", () => {
		const { subs } = buildAdvancedSubAndTargets(withGroups({ customSchedule: { enable: true } }));
		expect(subs[0].overrides.schedule).toBeUndefined();
	});

	it("混合:customFilters 开 + customSchedule 关 → 只写 filters,schedule 纯继承", () => {
		const { subs } = buildAdvancedSubAndTargets(
			withGroups({
				customFilters: { enable: true, blockForward: true },
				customSchedule: { enable: false, pushTime: 9, restartPush: true },
			}),
		);
		expect(subs[0].overrides.filters).toEqual({ blockForward: true });
		expect(subs[0].overrides.schedule).toBeUndefined();
	});

	it("混合:customFilters 关 + customSchedule 开 → 只写 schedule,filters 纯继承", () => {
		const { subs } = buildAdvancedSubAndTargets(
			withGroups({
				customFilters: { enable: false, blockKeywords: ["x"], minScPrice: 99 },
				customSchedule: { enable: true, pushTime: 4 },
			}),
		);
		expect(subs[0].overrides.filters).toBeUndefined();
		expect(subs[0].overrides.schedule).toEqual({ pushTime: 4 });
	});

	it("customSchedule.enable=true:仅 quietHours(无 pushTime/restartPush)→ 序列化 spread 不丢字段", () => {
		// 守卫三段独立 if-spread(quietHours→pushTime→restartPush)的合并次序:
		// 只有 quietHours 命中时,后两段 !== undefined 守卫跳过,overrides.schedule
		// 必须恰为 { quietHours },不能因为缺省被空对象覆盖或丢键。
		const { subs } = buildAdvancedSubAndTargets(
			withGroups({ customSchedule: { enable: true, quietHours: [{ start: 22, end: 6 }] } }),
		);
		expect(subs[0].overrides.schedule).toEqual({ quietHours: [{ start: 22, end: 6 }] });
	});

	it("customSchedule.enable=true:quietHours + restartPush 但无 pushTime → 两字段都保留", () => {
		// 中间段(pushTime)被跳过时,第三段(restartPush)仍要 spread 住第一段
		// 写入的 quietHours,验证 `...(sub.overrides.schedule ?? {})` 链式不丢前序键。
		const { subs } = buildAdvancedSubAndTargets(
			withGroups({
				customSchedule: { enable: true, quietHours: [{ start: 1, end: 5 }], restartPush: true },
			}),
		);
		expect(subs[0].overrides.schedule).toEqual({
			quietHours: [{ start: 1, end: 5 }],
			restartPush: true,
		});
	});

	it("customFilters.enable=true:标量 false/0 仍显式写(区别于继承)", () => {
		// blockForward:false / minScPrice:0 是用户「明确要关/不设门槛」的语义,
		// 必须显式进 overrides(!== undefined 守卫),不能被当成「缺省=继承」。
		const { subs } = buildAdvancedSubAndTargets(
			withGroups({
				customFilters: { enable: true, blockForward: false, minScPrice: 0, minGuardLevel: 1 },
			}),
		);
		expect(subs[0].overrides.filters).toEqual({
			blockForward: false,
			minScPrice: 0,
			minGuardLevel: 1,
		});
	});
});

describe("customDynamicMsg enable 门 → overrides.templates.dynamic/dynamicVideo (Part B)", () => {
	function withDynamicMsg(extra: { customDynamicMsg?: Record<string, unknown> }) {
		return {
			subs: { "UP-1": { ...makeRaw("11", "111111"), ...extra } },
		} as unknown as AdvancedSubRawConfigShape;
	}

	it("缺省 customDynamicMsg → 不写 overrides.templates.dynamic/dynamicVideo(纯继承全局)", () => {
		const { subs } = buildAdvancedSubAndTargets(withDynamicMsg({}));
		expect(subs[0].overrides.templates?.dynamic).toBeUndefined();
		expect(subs[0].overrides.templates?.dynamicVideo).toBeUndefined();
	});

	it("enable=false → 即便带字段也整组跳过", () => {
		const { subs } = buildAdvancedSubAndTargets(
			withDynamicMsg({
				customDynamicMsg: { enable: false, dynamicText: "x{name}", videoText: "y{name}" },
			}),
		);
		expect(subs[0].overrides.templates?.dynamic).toBeUndefined();
		expect(subs[0].overrides.templates?.dynamicVideo).toBeUndefined();
	});

	it("enable=true → dynamicText/videoText 折进 overrides.templates", () => {
		const { subs } = buildAdvancedSubAndTargets(
			withDynamicMsg({
				customDynamicMsg: {
					enable: true,
					dynamicText: "🔔 {name} 有新动态 {url}",
					videoText: "🎬 {name} 投稿 {url}",
				},
			}),
		);
		expect(subs[0].overrides.templates?.dynamic).toBe("🔔 {name} 有新动态 {url}");
		expect(subs[0].overrides.templates?.dynamicVideo).toBe("🎬 {name} 投稿 {url}");
	});

	it("enable=true 但仅填 dynamicText → 只写 dynamic,dynamicVideo 仍继承(undefined)", () => {
		const { subs } = buildAdvancedSubAndTargets(
			withDynamicMsg({ customDynamicMsg: { enable: true, dynamicText: "只改普通动态 {name}" } }),
		);
		expect(subs[0].overrides.templates?.dynamic).toBe("只改普通动态 {name}");
		expect(subs[0].overrides.templates?.dynamicVideo).toBeUndefined();
	});
});

/**
 * 指定发送账号(高级订阅 target 项里的 selfId)。
 *
 * 背景:同平台挂了两个机器人时,原来只能拿到 `ctx.bots` 里第一个在线的那个 ——
 * 顺序是插件注册顺序,重启后还可能换一个,而且全程没有任何日志。
 *
 * 这里守的是**身份派生**:adapter id 的种子必须含 selfId,否则同平台两个账号会算出
 * 同一个 adapter id,`config.selfId` 互相覆盖,选谁全看哪个 entry 最后写入。
 */
describe("buildAdvancedSubAndTargets() — 指定发送账号", () => {
	/** 造一份带 selfId 的 target 项(复用 makeRaw 造好的 channelArr 形状)。 */
	function targetEntry(raw: ReturnType<typeof makeRaw>, channelId: string, selfId?: string) {
		const ch = { ...raw.target[0].channelArr[0], channelId };
		return { platform: "onebot", channelArr: [ch], ...(selfId ? { selfId } : {}) };
	}

	it("填了 selfId → adapter 种子含它,config 也带上", () => {
		const raw = makeRaw("11", "g1");
		raw.target = [targetEntry(raw, "g1", "222")];
		const { adapters } = buildAdvancedSubAndTargets({
			subs: { "UP-1": raw },
		} as unknown as AdvancedSubRawConfigShape);

		expect(adapters).toHaveLength(1);
		expect(adapters[0].id).toBe(deterministicUuid("adapter:koishi-bot:onebot:222"));
		expect((adapters[0].config as { selfId?: string }).selfId).toBe("222");
	});

	it("没填 selfId → adapter id 与改动前一字不差(老配置不能变成孤儿)", () => {
		const raw = makeRaw("11", "g1");
		const { adapters } = buildAdvancedSubAndTargets({
			subs: { "UP-1": raw },
		} as unknown as AdvancedSubRawConfigShape);

		expect(adapters[0].id).toBe(deterministicUuid("adapter:koishi-bot:onebot"));
		expect((adapters[0].config as { selfId?: string }).selfId).toBeUndefined();
	});

	it("同平台两个不同账号 → 两个 adapter、两组 target,互不相扰", () => {
		const raw = makeRaw("11", "g1");
		raw.target = [targetEntry(raw, "g1", "111"), targetEntry(raw, "g2", "222")];
		const { adapters, targets } = buildAdvancedSubAndTargets({
			subs: { "UP-1": raw },
		} as unknown as AdvancedSubRawConfigShape);

		expect(adapters).toHaveLength(2);
		expect(new Set(adapters.map((a) => a.id)).size).toBe(2);
		expect(targets).toHaveLength(2);
		// 每个 target 挂在自己那个 adapter 上,不能串。
		const byChannel = new Map(
			targets.map((t) => [(t.session as { channelId?: string }).channelId, t.adapterId]),
		);
		expect(byChannel.get("g1")).toBe(deterministicUuid("adapter:koishi-bot:onebot:111"));
		expect(byChannel.get("g2")).toBe(deterministicUuid("adapter:koishi-bot:onebot:222"));
	});

	it("同一个群配在两个不同账号下 → 照发两条,但要吐一条 warning", () => {
		// 加 selfId 之前这两项会算出同一个 target id 而被自动去重,群只收一条;
		// 现在 adapter 分开了,去重不再发生 —— 一个事件会让那个群收到两条。
		// 不擅自吞掉主人写下的配置(确实可能是想双号播报),但必须让他知道。
		const raw = makeRaw("11", "g1");
		raw.target = [targetEntry(raw, "同一个群", "111"), targetEntry(raw, "同一个群", "222")];
		const { subs, targets, warnings } = buildAdvancedSubAndTargets({
			subs: { "UP-1": raw },
		} as unknown as AdvancedSubRawConfigShape);

		expect(targets).toHaveLength(2);
		// routing 里两个都在 —— 「照发」不是空话。
		expect(subs[0].routing.dynamic).toHaveLength(2);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("同一个群");
		expect(warnings[0]).toContain("111");
		expect(warnings[0]).toContain("222");
	});

	it("没配重时 warnings 为空 —— 别让正常配置也跳一条", () => {
		const raw = makeRaw("11", "g1");
		raw.target = [targetEntry(raw, "g1", "111"), targetEntry(raw, "g2", "222")];
		const { warnings } = buildAdvancedSubAndTargets({
			subs: { "UP-1": raw },
		} as unknown as AdvancedSubRawConfigShape);
		expect(warnings).toEqual([]);
	});

	it("两个 UP 推同一个群不算配重 —— 那本来就该各发各的", () => {
		// 跨订阅撞同一个群是常态(两个 UP 推同一个群),各自是独立事件,不是重复推送。
		const a = makeRaw("11", "群A");
		const b = makeRaw("22", "群A");
		const { warnings } = buildAdvancedSubAndTargets({
			subs: { "UP-1": a, "UP-2": b },
		} as unknown as AdvancedSubRawConfigShape);
		expect(warnings).toEqual([]);
	});
});

// shim to keep the test typing-light without importing the schemastery type
type AdvancedSubRawShim = {
	subs: Record<string, ReturnType<typeof makeRaw>>;
};
