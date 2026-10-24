/**
 * 直播拆键(⑬d):0.x 的 `live` 一把开关同时管开播、周期「正在直播」与重启补报;1.0 拆成 `liveStart` / `liveStreaming`
 * 两把特性,周期间隔与重启补报各是自己的设置。
 *
 * 两头:
 * - 走接缝(第 0 代 → `migrateZeroGeneration` → 新代上配置仓开机):输入是 `./zero-fixtures.ts` 冻住的 0.x 字面量,
 *   **期望值是字面量**(新代文件里的原样 JSON,和配置仓装载出来的值各看一遍)。最后一组把「全局 × 订阅」所有取值的
 *   组合各迁一遍,断言**折出来的生效值**与 0.x 当年的行为一致;
 * - 函数级:幂等、已经是新键的数据不动、认不得的形状原样放过。
 *
 * 订阅那一步要全局的 `pushTime` 与开播开关:设置那一步已经把 `pushTime` 折成间隔(0 与 1 都是 1),从迁好的设置里
 * 反推不出,所以订阅那一步从第 0 代的全局设置取(见 `live-split.ts` 文件头)。「全局开播关着、`pushTime` > 0、订阅
 * 把开播打开」那一条专门钉着这一点。
 */

import { resolve } from "@bilibili-notify/internal";
import { templateDefaultsFor } from "@bilibili-notify/internal/builtin-texts";
import { DEFAULT_LOCALE } from "@bilibili-notify/internal/i18n";
import { pendingTemplateUpdates } from "@bilibili-notify/internal/template-defaults";
import { describe, expect, it } from "vite-plus/test";
import {
	liveFactsOf,
	splitGlobalLiveSettings,
	splitSubscriptionLiveSettings,
} from "../live-split.js";
import { useZeroSandbox } from "./support.js";
import {
	makeZeroGlobals,
	zeroBiliRow,
	zeroEmptyRouting,
	zeroExtensionRow,
} from "./zero-fixtures.js";

const FACTORY_TEMPLATES = templateDefaultsFor(DEFAULT_LOCALE);

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const T1 = "22222222-2222-4222-8222-222222222222";
const T2 = "44444444-4444-4444-8444-444444444444";
const SUB_ID = "33333333-3333-4333-8333-333333333333";
const EXT_SUB_ID = "55555555-5555-4555-8555-555555555555";

const CONNECTION = {
	id: CONNECTION_ID,
	name: "NapCat",
	platform: "onebot",
	enabled: true,
	kind: "direct",
	connector: "http",
	config: {
		transport: "http",
		baseUrl: "http://127.0.0.1:3000",
		protocolVersion: "v11",
		headers: {},
		timeoutMs: 15_000,
		imageMinTimeoutMs: 30_000,
		forwardMinTimeoutMs: 60_000,
		retryTimes: 0,
		retryIntervalMs: 1_000,
	},
};

function sessionTarget(id: string, name: string, address: string) {
	return {
		id,
		name,
		connectionId: CONNECTION_ID,
		kind: "session",
		platform: "onebot",
		scope: "group",
		enabled: true,
		address,
	};
}

type Obj = Record<string, unknown>;

/** 全局设置:`live`(开播开关)、`pushTime`、`restartPush` 三格是这一组要摆弄的,其余出厂。 */
function zeroGlobals(live: { live?: boolean; pushTime?: number; restartPush?: boolean }) {
	const globals = makeZeroGlobals();
	if (live.live !== undefined) globals.defaults.features.live = live.live;
	if (live.pushTime !== undefined) globals.defaults.schedule.pushTime = live.pushTime;
	if (live.restartPush !== undefined) globals.defaults.schedule.restartPush = live.restartPush;
	return globals;
}

describe("直播拆键 · 迁移器接缝", () => {
	const sandbox = useZeroSandbox("bn-live-split-");

	async function placeConnectionsAndTargets(): Promise<void> {
		await sandbox.placeZero("state/connections.json", [CONNECTION]);
		await sandbox.placeZero("state/targets.json", [
			sessionTarget(T1, "主群", "111"),
			sessionTarget(T2, "副群", "222"),
		]);
	}

	/** 新代 `config/subscriptions.json` 里的行(按 id)。 */
	async function subscriptionRow(id: string): Promise<Obj> {
		const file = await sandbox.readConfig<{ subscriptions: Obj[] }>("subscriptions.json");
		const row = file.subscriptions.find((r) => r.id === id);
		if (!row) throw new Error(`no subscription row ${id}`);
		return row;
	}

	async function coreDefaults(): Promise<Obj> {
		return (await sandbox.readConfig<{ defaults: Obj }>("settings/core.json")).defaults;
	}

	// ── 全局 ──────────────────────────────────────────────────────────────────

	it("全局:开播开 + pushTime 3 → liveStreaming 开、间隔 3;schedule 只拿走那两格,其余原样", async () => {
		await sandbox.placeZero("state/globals.json", zeroGlobals({ live: true, pushTime: 3 }));

		await sandbox.migrate();

		const defaults = await coreDefaults();
		expect((defaults.features as Obj).liveStart).toBe(true);
		expect((defaults.features as Obj).liveStreaming).toBe(true);
		expect(defaults.liveStreaming).toEqual({ streamingIntervalHours: 3 });
		expect(defaults.schedule).toEqual({
			quietHours: [],
			liveEndGrace: false,
			liveEndGraceMinutes: 2,
		});
		expect(Object.keys(defaults.features as Obj).slice(0, 4)).toEqual([
			"post",
			"liveStart",
			"liveStreaming",
			"liveEnd",
		]);

		const store = await sandbox.load();
		expect(store.getGlobals().defaults.features.liveStreaming).toBe(true);
		expect(store.getGlobals().defaults.liveStreaming).toEqual({ streamingIntervalHours: 3 });
	});

	it("全局:pushTime 0 → liveStreaming 关、间隔填 1 小时(旧的「关」交给开关)", async () => {
		await sandbox.placeZero("state/globals.json", zeroGlobals({ live: true, pushTime: 0 }));

		await sandbox.migrate();

		const defaults = await coreDefaults();
		expect((defaults.features as Obj).liveStart).toBe(true);
		expect((defaults.features as Obj).liveStreaming).toBe(false);
		expect(defaults.liveStreaming).toEqual({ streamingIntervalHours: 1 });

		const store = await sandbox.load();
		expect(store.getGlobals().defaults.liveStreaming).toEqual({ streamingIntervalHours: 1 });
	});

	it("全局:开播关着、pushTime 3 → liveStreaming 关(周期要开播开着才算),间隔照旧用 3", async () => {
		await sandbox.placeZero("state/globals.json", zeroGlobals({ live: false, pushTime: 3 }));

		await sandbox.migrate();

		const defaults = await coreDefaults();
		expect((defaults.features as Obj).liveStreaming).toBe(false);
		expect(defaults.liveStreaming).toEqual({ streamingIntervalHours: 3 });
	});

	it("全局:restartPush → liveStart.catchUpOnBoot(真假都照搬)", async () => {
		await sandbox.placeZero("state/globals.json", zeroGlobals({ restartPush: true }));
		await sandbox.migrate();
		expect((await coreDefaults()).liveStart).toEqual({ catchUpOnBoot: true });
		expect((await sandbox.load()).getGlobals().defaults.liveStart).toEqual({
			catchUpOnBoot: true,
		});
	});

	it("全局:0.12 出厂的设置迁完,三个新格就是 1.0 的出厂值(周期关、间隔 1、不补报)", async () => {
		await sandbox.placeZero("state/globals.json", makeZeroGlobals());
		const store = await sandbox.migrateAndLoad();
		const { defaults } = store.getGlobals();
		expect(defaults.features.liveStreaming).toBe(false);
		expect(defaults.liveStreaming).toEqual({ streamingIntervalHours: 1 });
		expect(defaults.liveStart).toEqual({ catchUpOnBoot: false });
	});

	it("文案 templates.liveOngoing → liveStreaming:改过的文字照存，其他 0.12 默认删键；账本跟着换键", async () => {
		await placeConnectionsAndTargets();
		const globals = makeZeroGlobals();
		globals.defaults.templates.liveOngoing = "【直播中】{name} {time}";
		await sandbox.placeZero("state/globals.json", globals);
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow(
				{ id: SUB_ID, uid: "12345" },
				{ overrides: { templates: { liveOngoing: "我的直播中 {name}", liveEnd: "我的下播" } } },
			),
		]);

		await sandbox.migrate();

		const defaults = await coreDefaults();
		const templates = defaults.templates as Obj;
		expect(templates.liveStreaming).toBe("【直播中】{name} {time}");
		expect(templates).not.toHaveProperty("liveOngoing");
		expect(Object.keys(templates)).toEqual(["liveStreaming", "wordcloudStopWords", "membership"]);
		// 迁出来的账本在核心设置顶层(上提在换键之后),defaults 里没有老键。
		expect(defaults).not.toHaveProperty("templateDefaultsSeen");
		const ledger = (await sandbox.readConfig<{ templatesSeen: Obj }>("settings/core.json"))
			.templatesSeen;
		expect(ledger.liveStreaming).toBe("oopixp");
		expect(ledger).not.toHaveProperty("liveOngoing");
		expect((await subscriptionRow(SUB_ID)).overrides).toEqual({
			templates: { liveStreaming: "我的直播中 {name}", liveEnd: "我的下播" },
		});

		// 他写过自己的「正在直播」文案:账本里新键的指纹就是 1.0 默认的指纹,不会凭空亮「默认文案有更新」的灯。
		// 其他没改过的文字已删,`post` 不再存也不再留账,所以这里没有待更新项。
		const store = await sandbox.load();
		const g = store.getGlobals().defaults;
		expect(g.templates.liveStreaming).toBe("【直播中】{name} {time}");
		expect(
			pendingTemplateUpdates(g.templates, FACTORY_TEMPLATES, store.getGlobals().templatesSeen),
		).toEqual([]);
	});

	// ── 订阅 ──────────────────────────────────────────────────────────────────

	it("订阅 routing:liveStreaming 是 liveStart 的拷贝,键序在 liveStart 之后", async () => {
		await placeConnectionsAndTargets();
		await sandbox.placeZero("state/globals.json", makeZeroGlobals());
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow(
				{ id: SUB_ID, uid: "12345" },
				{ routing: { ...zeroEmptyRouting(), dynamic: [T1], live: [T1, T2], liveEnd: [T2] } },
			),
		]);
		await sandbox.placeZero("state/extension-subscriptions.json", [
			zeroExtensionRow(
				{ id: EXT_SUB_ID, extensionId: "douyin", externalId: "sec-uid" },
				{ routing: { ...zeroEmptyRouting(), live: [T2] } },
			),
		]);

		await sandbox.migrate();

		const routing = (await subscriptionRow(SUB_ID)).routing as Obj;
		expect(routing).toEqual({
			post: [T1],
			liveStart: [T1, T2],
			liveStreaming: [T1, T2],
			liveEnd: [T2],
			membership: [],
			superchat: [],
			viewerChat: [],
			viewerEnter: [],
		});
		expect(Object.keys(routing).slice(0, 4)).toEqual([
			"post",
			"liveStart",
			"liveStreaming",
			"liveEnd",
		]);
		expect(((await subscriptionRow(EXT_SUB_ID)).routing as Obj).liveStreaming).toEqual([T2]);

		const store = await sandbox.load();
		expect(store.getSubscriptions().find((s) => s.id === SUB_ID)?.routing).toEqual(routing);
	});

	it("订阅覆盖 pushTime 0、全局 3 → 这条写 features.liveStreaming:false,不写间隔;schedule 空了就删掉", async () => {
		await sandbox.placeZero("state/globals.json", zeroGlobals({ live: true, pushTime: 3 }));
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow({ id: SUB_ID, uid: "12345" }, { overrides: { schedule: { pushTime: 0 } } }),
		]);

		await sandbox.migrate();

		expect((await subscriptionRow(SUB_ID)).overrides).toEqual({
			features: { liveStreaming: false },
		});
		const store = await sandbox.load();
		expect(store.getSubscriptions()[0]?.overrides.liveStreaming).toBeUndefined();
	});

	it("订阅覆盖 pushTime 5、全局 3 → 写间隔 5;开关和全局一样(都开)不写", async () => {
		await sandbox.placeZero("state/globals.json", zeroGlobals({ live: true, pushTime: 3 }));
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow({ id: SUB_ID, uid: "12345" }, { overrides: { schedule: { pushTime: 5 } } }),
		]);

		await sandbox.migrate();

		expect((await subscriptionRow(SUB_ID)).overrides).toEqual({
			liveStreaming: { streamingIntervalHours: 5 },
		});
	});

	it("订阅覆盖的 pushTime 和全局一样 → 什么都不写,schedule 里那一格拿掉", async () => {
		await sandbox.placeZero("state/globals.json", zeroGlobals({ live: true, pushTime: 3 }));
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow(
				{ id: SUB_ID, uid: "12345" },
				{ overrides: { schedule: { pushTime: 3, quietHours: [{ start: 1, end: 5 }] } } },
			),
		]);

		await sandbox.migrate();

		expect((await subscriptionRow(SUB_ID)).overrides).toEqual({
			schedule: { quietHours: [{ start: 1, end: 5 }] },
		});
	});

	it("订阅覆盖 live: false、全局周期开着 → 这条的 liveStreaming 也关(和全局不同才写),liveStart 照旧", async () => {
		await sandbox.placeZero("state/globals.json", zeroGlobals({ live: true, pushTime: 3 }));
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow({ id: SUB_ID, uid: "12345" }, { overrides: { features: { live: false } } }),
		]);

		await sandbox.migrate();

		const overrides = (await subscriptionRow(SUB_ID)).overrides as Obj;
		expect(overrides.features).toEqual({ liveStart: false, liveStreaming: false });
		expect(Object.keys(overrides.features as Obj)).toEqual(["liveStart", "liveStreaming"]);
	});

	it("订阅覆盖 live: false、全局周期本来就关 → 不写(合并后还是关,和全局一样)", async () => {
		await sandbox.placeZero("state/globals.json", zeroGlobals({ live: true, pushTime: 0 }));
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow({ id: SUB_ID, uid: "12345" }, { overrides: { features: { live: false } } }),
		]);

		await sandbox.migrate();

		expect(((await subscriptionRow(SUB_ID)).overrides as Obj).features).toEqual({
			liveStart: false,
		});
	});

	it("订阅覆盖 pushTime 2、全局 pushTime 0 → 周期这条开着(和全局不同,写 true),间隔 2 也写", async () => {
		await sandbox.placeZero("state/globals.json", zeroGlobals({ live: true, pushTime: 0 }));
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow({ id: SUB_ID, uid: "12345" }, { overrides: { schedule: { pushTime: 2 } } }),
		]);

		await sandbox.migrate();

		expect((await subscriptionRow(SUB_ID)).overrides).toEqual({
			features: { liveStreaming: true },
			liveStreaming: { streamingIntervalHours: 2 },
		});
	});

	// 订阅那一步要的全局值得是**迁移前**的:全局开播关着时,迁好的设置里「pushTime 是 0 还是 1」已经分不出来。
	it("全局开播关着、pushTime 3,订阅把开播打开、没写 pushTime → 这条周期开着(沿用全局的 pushTime 3)", async () => {
		await sandbox.placeZero("state/globals.json", zeroGlobals({ live: false, pushTime: 3 }));
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow({ id: SUB_ID, uid: "12345" }, { overrides: { features: { live: true } } }),
		]);

		await sandbox.migrate();

		expect(((await subscriptionRow(SUB_ID)).overrides as Obj).features).toEqual({
			liveStart: true,
			liveStreaming: true,
		});
	});

	it("全局开播关着、pushTime 0,订阅把开播打开、没写 pushTime → 周期仍然关着(不写),与上一条只差 pushTime 一格", async () => {
		await sandbox.placeZero("state/globals.json", zeroGlobals({ live: false, pushTime: 0 }));
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow({ id: SUB_ID, uid: "12345" }, { overrides: { features: { live: true } } }),
		]);

		await sandbox.migrate();

		expect(((await subscriptionRow(SUB_ID)).overrides as Obj).features).toEqual({
			liveStart: true,
		});
	});

	it("订阅的 restartPush → overrides.liveStart.catchUpOnBoot(false 也搬:盖掉全局的 true 也是一种覆盖)", async () => {
		await sandbox.placeZero("state/globals.json", zeroGlobals({ restartPush: true }));
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow(
				{ id: SUB_ID, uid: "12345" },
				{ overrides: { schedule: { restartPush: false } } },
			),
		]);

		await sandbox.migrate();

		expect((await subscriptionRow(SUB_ID)).overrides).toEqual({
			liveStart: { catchUpOnBoot: false },
		});
	});

	it("什么都没覆盖的订阅:overrides 一格不长(没有 liveStart / liveStreaming / features)", async () => {
		await sandbox.placeZero("state/globals.json", zeroGlobals({ live: true, pushTime: 3 }));
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow({ id: SUB_ID, uid: "12345" }),
			zeroBiliRow(
				{ id: "66666666-6666-4666-8666-666666666666", uid: "777" },
				{
					overrides: { schedule: { liveEndGrace: true } },
				},
			),
		]);

		await sandbox.migrate();

		expect((await subscriptionRow(SUB_ID)).overrides).toEqual({});
		expect((await subscriptionRow("66666666-6666-4666-8666-666666666666")).overrides).toEqual({
			schedule: { liveEndGrace: true },
		});
	});

	it("拓展订阅同样算(它的覆盖也可能写过 schedule.pushTime)", async () => {
		await sandbox.placeZero("state/globals.json", zeroGlobals({ live: true, pushTime: 3 }));
		await sandbox.placeZero("state/extension-subscriptions.json", [
			zeroExtensionRow(
				{ id: EXT_SUB_ID, extensionId: "douyin", externalId: "sec-uid" },
				{ overrides: { schedule: { pushTime: 0 } } },
			),
		]);

		await sandbox.migrate();

		expect((await subscriptionRow(EXT_SUB_ID)).overrides).toEqual({
			features: { liveStreaming: false },
		});
	});

	it("第 0 代没有全局设置文件:订阅按 0.12 的出厂值算(开播开、pushTime 0)", async () => {
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow({ id: SUB_ID, uid: "12345" }, { overrides: { schedule: { pushTime: 4 } } }),
		]);

		await sandbox.migrate();

		expect((await subscriptionRow(SUB_ID)).overrides).toEqual({
			features: { liveStreaming: true },
			liveStreaming: { streamingIntervalHours: 4 },
		});
	});

	// ── 生效值与 0.x 当年的行为一致 ──────────────────────────────────────────────

	// 0.x 的周期「正在直播」:这条订阅合并后的开播开关开着,且合并后的 pushTime > 0。迁完、配置仓装载、折出生效值,
	// 开关与间隔都得对上 —— 全局 × 订阅的每一种取值各迁一遍。
	describe("折出来的生效值 = 0.x 当年的行为(全局 × 订阅的所有取值)", () => {
		const GLOBAL_LIVE = [true, false];
		const GLOBAL_PUSH = [0, 3];
		const SUB_LIVE = [undefined, true, false];
		const SUB_PUSH = [undefined, 0, 3, 5];

		for (const gLive of GLOBAL_LIVE) {
			for (const gPush of GLOBAL_PUSH) {
				it(`全局 live=${gLive} pushTime=${gPush}`, async () => {
					await placeConnectionsAndTargets();
					await sandbox.placeZero(
						"state/globals.json",
						zeroGlobals({ live: gLive, pushTime: gPush }),
					);
					const cases: Array<{ id: string; sLive?: boolean; sPush?: number }> = [];
					const rows: Obj[] = [];
					let n = 0;
					for (const sLive of SUB_LIVE) {
						for (const sPush of SUB_PUSH) {
							n += 1;
							const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
							const overrides: Obj = {};
							if (sLive !== undefined) overrides.features = { live: sLive };
							if (sPush !== undefined) overrides.schedule = { pushTime: sPush };
							rows.push(
								zeroBiliRow(
									{ id, uid: String(1000 + n) },
									{ routing: { ...zeroEmptyRouting(), live: [T1] }, overrides },
								),
							);
							cases.push({ id, sLive, sPush });
						}
					}
					await sandbox.placeZero("state/subscriptions.json", rows);

					const store = await sandbox.migrateAndLoad();

					const { defaults } = store.getGlobals();
					const subs = store.getSubscriptions();
					expect(subs).toHaveLength(SUB_LIVE.length * SUB_PUSH.length);
					for (const { id, sLive, sPush } of cases) {
						const sub = subs.find((s) => s.id === id);
						if (!sub) throw new Error(`missing ${id}`);
						const eff = resolve(sub, defaults);
						const liveOn = sLive ?? gLive;
						const pushTime = sPush ?? gPush;
						const label = `sLive=${sLive} sPush=${sPush}`;
						// 开播开关没动。
						expect(eff.features.liveStart, label).toBe(liveOn);
						// 周期开关:0.x 里「开播开着 且 pushTime > 0」。
						expect(eff.features.liveStreaming, label).toBe(liveOn && pushTime > 0);
						// 周期开着时间隔就是 0.x 的 pushTime(没开着的间隔没有意义)。
						if (liveOn && pushTime > 0) {
							expect(eff.liveStreaming.streamingIntervalHours, label).toBe(pushTime);
						}
						// 目标是开播目标的拷贝。
						expect(sub.routing.liveStreaming, label).toEqual([T1]);
					}
				});
			}
		}

		for (const gRestart of [false, true]) {
			it(`补报:全局 restartPush=${gRestart},订阅各取值,折出来的 catchUpOnBoot 与 0.x 一致`, async () => {
				await sandbox.placeZero("state/globals.json", zeroGlobals({ restartPush: gRestart }));
				const cases = [undefined, false, true].map((sRestart, i) => ({
					sRestart,
					id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
				}));
				await sandbox.placeZero(
					"state/subscriptions.json",
					cases.map(({ id, sRestart }, i) =>
						zeroBiliRow(
							{ id, uid: String(2000 + i) },
							{ overrides: sRestart === undefined ? {} : { schedule: { restartPush: sRestart } } },
						),
					),
				);

				const store = await sandbox.migrateAndLoad();

				for (const { id, sRestart } of cases) {
					const sub = store.getSubscriptions().find((s) => s.id === id);
					if (!sub) throw new Error(`missing ${id}`);
					expect(
						resolve(sub, store.getGlobals().defaults).liveStart.catchUpOnBoot,
						`sub=${sRestart}`,
					).toBe(sRestart ?? gRestart);
				}
			});
		}
	});
});

describe("直播拆键 · 函数级", () => {
	/** 改名之后、拆键之前的全局设置(1.0 的特性键,schedule 还带着那两格)。 */
	function renamedGlobals(pushTime: number, restartPush: boolean, liveStart = true): Obj {
		return {
			app: { logLevel: "info" },
			defaults: {
				features: { post: true, liveStart, liveEnd: true, extras: { wordcloud: true } },
				filters: { minScPrice: 0 },
				schedule: {
					pushTime,
					restartPush,
					quietHours: [],
					liveEndGrace: false,
					liveEndGraceMinutes: 2,
				},
				templates: { liveStart: "a" },
			},
		};
	}

	function splitGlobals(): Obj {
		return {
			app: { logLevel: "info" },
			defaults: {
				features: {
					post: true,
					liveStart: true,
					liveStreaming: true,
					liveEnd: true,
					extras: { wordcloud: true },
				},
				filters: { minScPrice: 0 },
				schedule: { quietHours: [], liveEndGrace: false, liveEndGraceMinutes: 2 },
				liveStart: { catchUpOnBoot: true },
				liveStreaming: { streamingIntervalHours: 3 },
				templates: { liveStart: "a" },
			},
		};
	}

	it("全局设置:一次拆完,值与键序都是字面量", () => {
		const out = splitGlobalLiveSettings(renamedGlobals(3, true)) as Obj;
		expect(out).toEqual(splitGlobals());
		const defaults = out.defaults as Obj;
		expect(Object.keys(defaults)).toEqual([
			"features",
			"filters",
			"schedule",
			"liveStart",
			"liveStreaming",
			"templates",
		]);
		expect(Object.keys(defaults.features as Obj)).toEqual([
			"post",
			"liveStart",
			"liveStreaming",
			"liveEnd",
			"extras",
		]);
	});

	it("全局设置:幂等,拆过的再跑一遍原样(同一个对象)", () => {
		const once = splitGlobalLiveSettings(renamedGlobals(3, true));
		expect(splitGlobalLiveSettings(once)).toBe(once);
		const split = splitGlobals();
		expect(splitGlobalLiveSettings(split)).toBe(split);
	});

	it("全局设置:新老键并存时以新键为准 —— 已经有的 liveStreaming / liveStart 不被盖掉,老的两格照样拿掉", () => {
		const input = renamedGlobals(3, true) as { defaults: Obj };
		(input.defaults.features as Obj).liveStreaming = false;
		input.defaults.liveStreaming = { streamingIntervalHours: 8 };
		input.defaults.liveStart = { catchUpOnBoot: false };
		const out = splitGlobalLiveSettings(input) as { defaults: Obj };
		expect((out.defaults.features as Obj).liveStreaming).toBe(false);
		expect(out.defaults.liveStreaming).toEqual({ streamingIntervalHours: 8 });
		expect(out.defaults.liveStart).toEqual({ catchUpOnBoot: false });
		expect(out.defaults.schedule).toEqual({
			quietHours: [],
			liveEndGrace: false,
			liveEndGraceMinutes: 2,
		});
	});

	it("全局设置:认不得的形状原样放过(没有 defaults / schedule 不是对象 / 两格都不是该有的类型)", () => {
		expect(splitGlobalLiveSettings(null)).toBe(null);
		expect(splitGlobalLiveSettings("x")).toBe("x");
		const noDefaults = { app: {} };
		expect(splitGlobalLiveSettings(noDefaults)).toBe(noDefaults);
		const badSchedule = { defaults: { schedule: "oops", features: {} } };
		expect(splitGlobalLiveSettings(badSchedule)).toBe(badSchedule);
		const badValues = { defaults: { schedule: { pushTime: "3", restartPush: 1 }, features: {} } };
		expect(splitGlobalLiveSettings(badValues)).toBe(badValues);
	});

	it("liveFactsOf:取开播开关与 pushTime;形状不对回 undefined", () => {
		expect(liveFactsOf(renamedGlobals(3, true, false))).toEqual({ liveStart: false, pushTime: 3 });
		expect(liveFactsOf(null)).toBeUndefined();
		expect(liveFactsOf({ defaults: {} })).toBeUndefined();
		expect(liveFactsOf({ defaults: { features: {}, schedule: { pushTime: 3 } } })).toBeUndefined();
		expect(
			liveFactsOf({ defaults: { features: { liveStart: true }, schedule: { pushTime: "3" } } }),
		).toBeUndefined();
	});

	const GLOBAL = { liveStart: true, pushTime: 3 };

	/** 一条改名之后、拆键之前的订阅行。 */
	function row(overrides: Obj | undefined, routingLiveStart: string[] = [T1]): Obj {
		return {
			id: SUB_ID,
			identity: { sourceKey: "bilibili", externalId: "12345" },
			enabled: true,
			routing: {
				post: [],
				liveStart: routingLiveStart,
				liveEnd: [],
				membership: [],
				superchat: [],
				viewerChat: [],
				viewerEnter: [],
			},
			...(overrides ? { overrides } : {}),
		};
	}

	it("订阅行:routing 拷贝、覆盖按合并值拆,一次改完", () => {
		const out = splitSubscriptionLiveSettings(
			row({
				features: { liveStart: true },
				schedule: { pushTime: 0, restartPush: true, quietHours: [{ start: 1, end: 5 }] },
				templates: { liveStreaming: "x" },
			}),
			GLOBAL,
		) as Obj;
		expect((out.routing as Obj).liveStreaming).toEqual([T1]);
		expect(out.overrides).toEqual({
			features: { liveStart: true, liveStreaming: false },
			schedule: { quietHours: [{ start: 1, end: 5 }] },
			liveStart: { catchUpOnBoot: true },
			templates: { liveStreaming: "x" },
		});
		expect(Object.keys(out.overrides as Obj)).toEqual([
			"features",
			"schedule",
			"liveStart",
			"templates",
		]);
	});

	it("订阅行:routing 的拷贝与开播那份不是同一个数组(改一边不连着另一边)", () => {
		const out = splitSubscriptionLiveSettings(row(undefined), GLOBAL) as { routing: Obj };
		expect(out.routing.liveStreaming).toEqual(out.routing.liveStart);
		expect(out.routing.liveStreaming).not.toBe(out.routing.liveStart);
	});

	it("订阅行:幂等,拆过的再跑一遍原样(同一个对象)", () => {
		const once = splitSubscriptionLiveSettings(
			row({ schedule: { pushTime: 5, restartPush: false } }),
			GLOBAL,
		);
		expect(once).toEqual({
			...row(undefined),
			routing: { ...(row(undefined).routing as Obj), liveStreaming: [T1] },
			overrides: {
				liveStreaming: { streamingIntervalHours: 5 },
				liveStart: { catchUpOnBoot: false },
			},
		});
		expect(splitSubscriptionLiveSettings(once, GLOBAL)).toBe(once);
	});

	it("订阅行:新老键并存时以新键为准,自己写过的 liveStreaming 开关 / 间隔不被盖掉", () => {
		const out = splitSubscriptionLiveSettings(
			row({
				features: { liveStreaming: true },
				liveStreaming: { streamingIntervalHours: 9 },
				schedule: { pushTime: 0 },
			}),
			GLOBAL,
		) as Obj;
		expect(out.overrides).toEqual({
			features: { liveStreaming: true },
			liveStreaming: { streamingIntervalHours: 9 },
		});
	});

	it("订阅行:认不得的形状原样放过(不是对象 / 没有 routing / overrides 不是对象)", () => {
		expect(splitSubscriptionLiveSettings(null, GLOBAL)).toBe(null);
		expect(splitSubscriptionLiveSettings("x", GLOBAL)).toBe("x");
		const noRouting = { id: SUB_ID, overrides: "oops" };
		expect(splitSubscriptionLiveSettings(noRouting, GLOBAL)).toBe(noRouting);
		const badValues = row({ schedule: { pushTime: "3", restartPush: 1 } });
		const out = splitSubscriptionLiveSettings(badValues, GLOBAL) as Obj;
		expect(out.overrides).toEqual({ schedule: { pushTime: "3", restartPush: 1 } });
	});
});
