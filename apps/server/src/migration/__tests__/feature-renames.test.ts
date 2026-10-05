/**
 * 0.x 最新形状 → 1.0 的改名(⑬c):特性键、附加项键、文案键、版式键、逐目标表、过滤键(㉑a),在设置与订阅两头各改一遍。
 *
 * 0.x 那一遍(`features.ts` / `templates.ts` …)吐出来的是 0.x 最新的形状 —— 特性键 `dynamic` / `live` / `liveGuardBuy`、
 * 附加项 `atAllDynamic` / `atAllLive`、文案 `templates.dynamic` / `dynamicVideo`、版式 `messageLayout.dynamic`、订阅顶层
 * 的逐目标表 `extras`。这一步把它们换成 1.0 的名字(`post` / `liveStart` / `membership` / `atAllPost` / `atAllLiveStart` /
 * `templates.post` / `postVideo` / `messageLayout.post` / `extraTargets`),值原样搬、键序不变。过滤键(㉑a)同理:全局
 * `defaults.filters` 与订阅 `overrides.filters` 里的 `blockForward` / `blockArticle` / `blockDraw` / `blockAv` /
 * `whitelistKeywords` / `whitelistRegex` 换成 `blockReposts` / `blockArticles` / `blockImages` / `blockVideos` /
 * `allowKeywords` / `allowRegex`,屏蔽关键词、屏蔽正则不动;两个直播阈值 `minScPrice` / `minGuardLevel` 不是改名、是搬家
 * (㉓d,`membership-moves.test.ts` 钉函数级,接缝在下面「过滤键」那几条),这一步的函数级用例里它们原样带过。
 *
 * 两头:
 * - 走接缝(第 0 代 → `migrateZeroGeneration` → 新代上配置仓开机):输入是 `./zero-fixtures.ts` 冻住的 0.x 字面量,
 *   **期望值是字面量**(新代文件里的原样 JSON,和配置仓装载出来的值各看一遍);
 * - 函数级:幂等、已经是新键的数据不动、新老键并存以新键为准、认不得的形状原样放过。
 *
 * 同一条订阅里 `routing.<主特性>` 与 `extraTargets.<附加项>` 必须在同一步改完 —— 活 schema 要求附加项目标 ⊆ 主特性目标,
 * 只改了一边的话配置仓开机就拒收整个订阅文件(接缝那几条会红在开机上)。
 */

import { ContentFiltersSchema } from "@bilibili-notify/internal";
import { DEFAULT_TEMPLATES } from "@bilibili-notify/internal/constants";
import { pendingTemplateUpdates } from "@bilibili-notify/internal/template-defaults";
import { describe, expect, it } from "vite-plus/test";
import { renameGlobalSettingsKeys, renameSubscriptionKeys } from "../feature-renames.js";
import { ZERO_FILTER_KEYS, ZERO_MOVED_FILTER_KEYS } from "../zero-vocabulary.js";
import { useZeroSandbox } from "./support.js";
import {
	makeZeroGlobals,
	zeroBiliRow,
	zeroEmptyExtras,
	zeroEmptyRouting,
	zeroExtensionRow,
	zeroGuardBuy,
	zeroMembershipOverrides,
} from "./zero-fixtures.js";

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
const TARGETS = [sessionTarget(T1, "主群", "111"), sessionTarget(T2, "副群", "222")];

type Obj = Record<string, unknown>;

/** 0.x 的六个过滤键(㉑a 改名):迁完以后盘上与装载出来的值里一个都不该剩。 */
const OLD_FILTER_KEYS = [
	"blockForward",
	"blockArticle",
	"blockDraw",
	"blockAv",
	"whitelistKeywords",
	"whitelistRegex",
] as const;

/** 0.x 过滤键里搬出 `filters` 的两个阈值(㉓d):迁完以后 filters 里也一个都不该剩。 */
const MOVED_FILTER_KEYS = ["minScPrice", "minGuardLevel"] as const;

/** 新代 `config/subscriptions.json` 里的行(按 id)。 */
async function subscriptionRow(
	sandbox: ReturnType<typeof useZeroSandbox>,
	id: string,
): Promise<Obj> {
	const file = await sandbox.readConfig<{ subscriptions: Obj[] }>("subscriptions.json");
	const row = file.subscriptions.find((r) => r.id === id);
	if (!row) throw new Error(`no subscription row ${id}`);
	return row;
}

/** 0.x 的版式块:卡片 + 文本 + 链接。 */
const blocks = (linkVisible: boolean) => [
	{ id: "card", type: "card", visible: true },
	{ id: "text", type: "text", visible: true },
	{ id: "link", type: "link", visible: linkVisible },
];

describe("0.x 最新 → 1.0 改名 · 迁移器接缝", () => {
	const sandbox = useZeroSandbox("bn-feature-renames-");

	async function placeConnectionsAndTargets(): Promise<void> {
		await sandbox.placeZero("state/connections.json", [CONNECTION]);
		await sandbox.placeZero("state/targets.json", TARGETS);
	}

	it("routing 的三把改名的键:dynamic → post、live → liveStart、liveGuardBuy → membership,目标原样、键序不变", async () => {
		await placeConnectionsAndTargets();
		await sandbox.placeZero("state/globals.json", makeZeroGlobals());
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow(
				{ id: SUB_ID, uid: "12345" },
				{
					routing: {
						...zeroEmptyRouting(),
						dynamic: [T1],
						live: [T1, T2],
						liveEnd: [T2],
						liveGuardBuy: [T2],
						superchat: [T1],
					},
				},
			),
		]);

		await sandbox.migrate();

		const routing = (await subscriptionRow(sandbox, SUB_ID)).routing as Obj;
		// `liveStreaming` 是直播拆键(⑬d)补的:拷一份开播的目标,细节在 `./live-split.test.ts`。
		expect(routing).toEqual({
			post: [T1],
			liveStart: [T1, T2],
			liveStreaming: [T1, T2],
			liveEnd: [T2],
			membership: [T2],
			superchat: [T1],
			specialDanmaku: [],
			specialUserEnter: [],
		});
		expect(Object.keys(routing)).toEqual([
			"post",
			"liveStart",
			"liveStreaming",
			"liveEnd",
			"membership",
			"superchat",
			"specialDanmaku",
			"specialUserEnter",
		]);

		const store = await sandbox.load();
		expect(store.getSubscriptions().find((s) => s.id === SUB_ID)?.routing).toEqual(routing);
	});

	it("全局 defaults.features:三把开关与 extras 里的两把 @全体 换名,开关的值原样", async () => {
		await placeConnectionsAndTargets();
		const globals = makeZeroGlobals();
		globals.defaults.features = {
			dynamic: false,
			live: true,
			liveEnd: false,
			liveGuardBuy: true,
			superchat: true,
			specialDanmaku: false,
			specialUserEnter: true,
			extras: { atAllDynamic: true, atAllLive: false, wordcloud: false, liveSummary: true },
		};
		await sandbox.placeZero("state/globals.json", globals);

		await sandbox.migrate();

		const onDisk = await sandbox.readConfig<{ defaults: { features: Obj } }>("settings/core.json");
		// `liveStreaming` 是直播拆键(⑬d)补的(开播开着、pushTime 是出厂的 0 → 关),细节在 `./live-split.test.ts`。
		expect(onDisk.defaults.features).toEqual({
			post: false,
			liveStart: true,
			liveStreaming: false,
			liveEnd: false,
			membership: true,
			superchat: true,
			specialDanmaku: false,
			specialUserEnter: true,
			extras: { atAllPost: true, atAllLiveStart: false, wordcloud: false, liveSummary: true },
		});
		expect(Object.keys(onDisk.defaults.features)).toEqual([
			"post",
			"liveStart",
			"liveStreaming",
			"liveEnd",
			"membership",
			"superchat",
			"specialDanmaku",
			"specialUserEnter",
			"extras",
		]);
		expect(Object.keys(onDisk.defaults.features.extras as Obj)).toEqual([
			"atAllPost",
			"atAllLiveStart",
			"wordcloud",
			"liveSummary",
		]);

		const store = await sandbox.load();
		expect(store.getGlobals().defaults.features).toEqual(onDisk.defaults.features);
	});

	it("逐订阅 overrides.features:稀疏的覆盖只换写过的键(含 .extras),没写的不凭空长出来", async () => {
		await placeConnectionsAndTargets();
		await sandbox.placeZero("state/globals.json", makeZeroGlobals());
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow(
				{ id: SUB_ID, uid: "12345" },
				{
					overrides: {
						features: {
							dynamic: false,
							liveGuardBuy: true,
							extras: { atAllLive: false, wordcloud: true },
						},
					},
				},
			),
			zeroBiliRow(
				{ id: "66666666-6666-4666-8666-666666666666", uid: "777" },
				{ overrides: { features: { liveEnd: false, extras: { liveSummary: false } } } },
			),
		]);

		await sandbox.migrate();

		const overrides = (await subscriptionRow(sandbox, SUB_ID)).overrides as Obj;
		expect(overrides.features).toEqual({
			post: false,
			membership: true,
			extras: { atAllLiveStart: false, wordcloud: true },
		});
		// 一把要改名的键都没写的覆盖原样。
		const other = (await subscriptionRow(sandbox, "66666666-6666-4666-8666-666666666666"))
			.overrides as Obj;
		expect(other.features).toEqual({ liveEnd: false, extras: { liveSummary: false } });

		const store = await sandbox.load();
		expect(store.getSubscriptions().find((s) => s.id === SUB_ID)?.overrides.features).toEqual(
			overrides.features,
		);
	});

	it("订阅顶层的逐目标表 extras → extraTargets,里面的键同步换名;和 routing 同一步改完,配置仓开机才不拒收", async () => {
		await placeConnectionsAndTargets();
		await sandbox.placeZero("state/globals.json", makeZeroGlobals());
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow(
				{ id: SUB_ID, uid: "12345" },
				{
					routing: { ...zeroEmptyRouting(), dynamic: [T1], live: [T2], liveEnd: [T1] },
					extras: {
						...zeroEmptyExtras(),
						atAllDynamic: { [T1]: true },
						atAllLive: { [T2]: false },
						wordcloud: { [T1]: true },
					},
				},
			),
		]);
		await sandbox.placeZero("state/extension-subscriptions.json", [
			zeroExtensionRow(
				{ id: EXT_SUB_ID, extensionId: "douyin", externalId: "sec-uid" },
				{
					routing: { ...zeroEmptyRouting(), live: [T1] },
					extras: { ...zeroEmptyExtras(), atAllLive: { [T1]: true } },
				},
			),
		]);

		await sandbox.migrate();

		const row = await subscriptionRow(sandbox, SUB_ID);
		expect(row).not.toHaveProperty("extras");
		expect(row.extraTargets).toEqual({
			atAllPost: { [T1]: true },
			atAllLiveStart: { [T2]: false },
			wordcloud: { [T1]: true },
			liveSummary: {},
		});
		const extRow = await subscriptionRow(sandbox, EXT_SUB_ID);
		expect(extRow).not.toHaveProperty("extras");
		expect(extRow.extraTargets).toEqual({
			atAllPost: {},
			atAllLiveStart: { [T1]: true },
			wordcloud: {},
			liveSummary: {},
		});
		expect((extRow.routing as Obj).liveStart).toEqual([T1]);

		// 开机不拒收:附加项目标 ⊆ 主特性目标这条约束在新键上也成立。
		const store = await sandbox.load();
		const sub = store.getSubscriptions().find((s) => s.id === SUB_ID);
		expect(sub?.extraTargets).toEqual(row.extraTargets);
		expect(store.getSubscriptions().find((s) => s.id === EXT_SUB_ID)?.extraTargets).toEqual(
			extRow.extraTargets,
		);
	});

	it("文案 templates.dynamic / dynamicVideo → post / postVideo:全局与逐订阅覆盖,文字原样、键序不变;稀疏覆盖不长出键", async () => {
		await placeConnectionsAndTargets();
		const globals = makeZeroGlobals();
		globals.defaults.templates.dynamic = "【新动态】{name}";
		globals.defaults.templates.dynamicVideo = "【新视频】{name}";
		await sandbox.placeZero("state/globals.json", globals);
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow(
				{ id: SUB_ID, uid: "12345" },
				{
					overrides: { templates: { dynamic: "我的动态 {name}", dynamicVideo: "我的视频 {name}" } },
				},
			),
			zeroBiliRow(
				{ id: "66666666-6666-4666-8666-666666666666", uid: "777" },
				{ overrides: { templates: { liveEnd: "只改下播" } } },
			),
		]);

		await sandbox.migrate();

		const core = await sandbox.readConfig<{ defaults: { templates: Obj } }>("settings/core.json");
		const templates = core.defaults.templates;
		expect(templates.post).toBe("【新动态】{name}");
		expect(templates.postVideo).toBe("【新视频】{name}");
		expect(templates).not.toHaveProperty("dynamic");
		expect(templates).not.toHaveProperty("dynamicVideo");
		expect(Object.keys(templates)).toEqual([
			"liveStart",
			"liveStreaming",
			"liveEnd",
			"liveSummary",
			"post",
			"postVideo",
			"wordcloudStopWords",
			"specialDanmaku",
			"specialUserEnter",
			// 上舰文案搬成 `membership.guard`(㉓d),占的还是原来的位置。
			"membership",
		]);
		expect((await subscriptionRow(sandbox, SUB_ID)).overrides).toEqual({
			templates: { post: "我的动态 {name}", postVideo: "我的视频 {name}" },
		});
		expect(
			(await subscriptionRow(sandbox, "66666666-6666-4666-8666-666666666666")).overrides,
		).toEqual({ templates: { liveEnd: "只改下播" } });

		const store = await sandbox.load();
		expect(store.getGlobals().defaults.templates.post).toBe("【新动态】{name}");
		expect(store.getSubscriptions().find((s) => s.id === SUB_ID)?.overrides.templates).toEqual({
			post: "我的动态 {name}",
			postVideo: "我的视频 {name}",
		});
	});

	it("文案账本 templateDefaultsSeen:post / postVideo / liveStreaming 三个路径的键换名,指纹值原样;上舰那六条换成新路径两条(㉓d)", async () => {
		await placeConnectionsAndTargets();
		await sandbox.placeZero("state/globals.json", makeZeroGlobals());

		await sandbox.migrate();

		const core = await sandbox.readConfig<{ defaults: { templateDefaultsSeen: Obj } }>(
			"settings/core.json",
		);
		expect(core.defaults.templateDefaultsSeen).toEqual({
			liveStart: "1nkgnb7",
			liveStreaming: "oopixp",
			liveEnd: "1mtqdty",
			liveSummary: "1hxy5zb",
			post: "7uw5nq",
			postVideo: "1omlggn",
			wordcloudStopWords: "ztntfp",
			specialDanmaku: "t4zkxd",
			specialUserEnter: "1qh1423",
			// 上舰文案搬成体系默认一条(㉓d):账本记的是新默认「{viewer} 成为了 {name} 的{tier}！」与空图的指纹。
			"membership.guard.default.template": "8q6guf",
			"membership.guard.default.imageUrl": "ztntfp",
		});
		expect(Object.keys(core.defaults.templateDefaultsSeen).slice(3, 7)).toEqual([
			"liveSummary",
			"post",
			"postVideo",
			"wordcloudStopWords",
		]);
	});

	it("升上来的人不会凭空亮「默认文案有更新」的灯:他写过自己的文案,账本里 post / postVideo 的指纹就是 1.0 默认的指纹", async () => {
		await placeConnectionsAndTargets();
		const globals = makeZeroGlobals();
		// 主人自己写的、和默认不一样的两条:「默认文案有更新」的判定只对这样的文案才有话说(和默认一样的,账本换没换键它都不亮)。
		globals.defaults.templates.dynamic = "我写的动态 {name}";
		globals.defaults.templates.dynamicVideo = "我写的视频 {name}";
		await sandbox.placeZero("state/globals.json", globals);

		const store = await sandbox.migrateAndLoad();

		// 面板(`Rules.tsx`)用的就是这个判定。账本里 `post` / `postVideo` 的指纹是「这版默认他见过了」;
		// 没有换键的话账本里查不到这两条,就会被当成「这版默认他没见过」,凭空亮两个灯。
		const { templates, templateDefaultsSeen } = store.getGlobals().defaults;
		expect(templates.post).toBe("我写的动态 {name}");
		expect(templates.postVideo).toBe("我写的视频 {name}");
		expect(pendingTemplateUpdates(templates, DEFAULT_TEMPLATES, templateDefaultsSeen)).toEqual([]);
	});

	it("messageLayout.dynamic → post:全局与逐订阅覆盖;live 那组(开播 / 正在直播 / 下播)不改名", async () => {
		await placeConnectionsAndTargets();
		const globals = makeZeroGlobals();
		globals.defaults.messageLayout = {
			version: 1,
			dynamic: { blocks: blocks(false), separator: " | " },
			live: { blocks: blocks(true), separator: "\n" },
		};
		await sandbox.placeZero("state/globals.json", globals);
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow(
				{ id: SUB_ID, uid: "12345" },
				{
					overrides: {
						messageLayout: {
							version: 1,
							dynamic: { blocks: blocks(true), separator: "~" },
							live: { blocks: blocks(false), separator: "," },
						},
					},
				},
			),
		]);

		await sandbox.migrate();

		const core = await sandbox.readConfig<{ defaults: { messageLayout: Obj } }>(
			"settings/core.json",
		);
		expect(core.defaults.messageLayout).toEqual({
			version: 1,
			post: { blocks: blocks(false), separator: " | " },
			live: { blocks: blocks(true), separator: "\n" },
		});
		expect(Object.keys(core.defaults.messageLayout)).toEqual(["version", "post", "live"]);
		expect((await subscriptionRow(sandbox, SUB_ID)).overrides).toEqual({
			messageLayout: {
				version: 1,
				post: { blocks: blocks(true), separator: "~" },
				live: { blocks: blocks(false), separator: "," },
			},
		});

		const store = await sandbox.load();
		expect(store.getGlobals().defaults.messageLayout).toEqual(core.defaults.messageLayout);
	});

	it("过滤键:全局 defaults.filters 里六个键换名,值原样、键序不变;关键词 / 正则两格不动,老键不带过去;两个阈值搬出去(㉓d)", async () => {
		await placeConnectionsAndTargets();
		const globals = makeZeroGlobals();
		// 挑和出厂不同的值:出厂值全是 false / 空,看不出改名有没有把值带过去。
		globals.defaults.filters = {
			blockForward: true,
			blockArticle: false,
			blockDraw: true,
			blockAv: false,
			blockKeywords: ["广告"],
			blockRegex: ["^抽奖"],
			whitelistKeywords: ["新歌"],
			whitelistRegex: ["^上新"],
			minScPrice: 30,
			minGuardLevel: 2,
		};
		await sandbox.placeZero("state/globals.json", globals);

		await sandbox.migrate();

		const core = await sandbox.readConfig<{ defaults: Obj & { filters: Obj } }>(
			"settings/core.json",
		);
		expect(core.defaults.filters).toEqual({
			blockReposts: true,
			blockArticles: false,
			blockImages: true,
			blockVideos: false,
			blockKeywords: ["广告"],
			blockRegex: ["^抽奖"],
			allowKeywords: ["新歌"],
			allowRegex: ["^上新"],
		});
		expect(Object.keys(core.defaults.filters)).toEqual([
			"blockReposts",
			"blockArticles",
			"blockImages",
			"blockVideos",
			"blockKeywords",
			"blockRegex",
			"allowKeywords",
			"allowRegex",
		]);
		for (const old of [...OLD_FILTER_KEYS, ...MOVED_FILTER_KEYS]) {
			expect(core.defaults.filters).not.toHaveProperty(old);
		}
		// 两个阈值搬成自己的两段:旧金额 30 元 → superchat.minAmount;旧等级 2(提督以上)→ guard 的 rank 2。
		expect(core.defaults.superchat).toEqual({ minAmount: 30 });
		expect(core.defaults.membership).toEqual({ minRank: { guard: 2 } });

		// 开机不拒收:全局那份过滤的键在活 schema 里是必填的,老键留着的话整份设置读不进来。
		const store = await sandbox.load();
		const loaded = store.getGlobals().defaults;
		expect(loaded.filters).toEqual(core.defaults.filters);
		expect(loaded.superchat).toEqual({ minAmount: 30 });
		expect(loaded.membership).toEqual({ minRank: { guard: 2 } });
	});

	it("两个阈值是 0.x 的出厂值(金额 0、等级 3 = 全推):不写,盘上没有这两段,装载出来是空段", async () => {
		await placeConnectionsAndTargets();
		await sandbox.placeZero("state/globals.json", makeZeroGlobals());

		const store = await sandbox.migrateAndLoad();

		const core = await sandbox.readConfig<{ defaults: Obj & { filters: Obj } }>(
			"settings/core.json",
		);
		expect(core.defaults).not.toHaveProperty("superchat");
		expect(core.defaults).not.toHaveProperty("membership");
		for (const old of MOVED_FILTER_KEYS) expect(core.defaults.filters).not.toHaveProperty(old);
		expect(store.getGlobals().defaults.superchat).toEqual({});
		expect(store.getGlobals().defaults.membership).toEqual({});
	});

	it("上舰文案:全局 templates.guardBuy → templates.membership.guard,改过的档进 tiers、占位符改写、没动过的档跟随体系默认;开机装得进来(㉓d)", async () => {
		await placeConnectionsAndTargets();
		const globals = makeZeroGlobals();
		globals.defaults.templates.guardBuy = zeroGuardBuy({
			enable: true,
			captain: {
				imageUrl: "https://img.test/captain.png",
				template: "-uname 登上了 -mname 的船,档位 -guard",
			},
			// 提督没动:出厂文案,图片空(`zeroGuardBuy` 的缺省)。
			governor: { imageUrl: "", template: "总督 {uname} 驾到\\n欢迎来到 {mname}" },
		});
		await sandbox.placeZero("state/globals.json", globals);

		const store = await sandbox.migrateAndLoad();

		const core = await sandbox.readConfig<{ defaults: { templates: Obj } }>("settings/core.json");
		expect(core.defaults.templates).not.toHaveProperty("guardBuy");
		const guard = {
			enabled: true,
			default: { template: "{viewer} 成为了 {name} 的{tier}！", imageUrl: "" },
			tiers: {
				captain: {
					template: "{viewer} 登上了 {name} 的船,档位 {tier}",
					imageUrl: "https://img.test/captain.png",
				},
				governor: { template: "总督 {viewer} 驾到\\n欢迎来到 {name}" },
			},
		};
		expect((core.defaults.templates.membership as Obj).guard).toEqual(guard);
		expect(
			Object.keys(((core.defaults.templates.membership as Obj).guard as Obj).tiers as Obj),
		).toEqual(["captain", "governor"]);
		expect(store.getGlobals().defaults.templates.membership.guard).toEqual(guard);
	});

	it("上舰文案的账本:新路径记着新默认的指纹,升上来的人以后自己改了体系默认也不会被提示「默认文案有更新」(㉓d)", async () => {
		await placeConnectionsAndTargets();
		await sandbox.placeZero("state/globals.json", makeZeroGlobals());

		const store = await sandbox.migrateAndLoad();

		const { templates, templateDefaultsSeen } = store.getGlobals().defaults;
		// 升级当下:体系默认就是出厂默认,没有要更新的。
		expect(pendingTemplateUpdates(templates, DEFAULT_TEMPLATES, templateDefaultsSeen)).toEqual([]);
		// 主人以后把体系默认改成自己的话:这一版默认他「见过了」(账本里是新默认的指纹),不提示。没有这两条账,下面这一步就会亮灯。
		const edited = {
			...templates,
			membership: {
				guard: {
					...templates.membership.guard,
					default: { template: "我自己写的体系默认 {viewer}", imageUrl: "https://img.test/x.png" },
				},
			},
		};
		expect(pendingTemplateUpdates(edited, DEFAULT_TEMPLATES, templateDefaultsSeen)).toEqual([]);
		expect(
			pendingTemplateUpdates(edited, DEFAULT_TEMPLATES, {
				...templateDefaultsSeen,
				"membership.guard.default.template": "过期的指纹",
			}),
		).toEqual(["membership.guard.default.template"]);
		expect(Object.keys(templateDefaultsSeen).filter((key) => key.startsWith("guardBuy"))).toEqual(
			[],
		);
	});

	it("逐订阅(夹具 `zeroMembershipOverrides`):写着出厂阈值与一份改过的上舰文案 → 阈值照搬(0 也写、rank 1 也写),文案只搬改过的档", async () => {
		await placeConnectionsAndTargets();
		await sandbox.placeZero("state/globals.json", makeZeroGlobals());
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow({ id: SUB_ID, uid: "12345" }, { overrides: zeroMembershipOverrides() }),
		]);

		const store = await sandbox.migrateAndLoad();

		const expected = {
			superchat: { minAmount: 0 },
			membership: { minRank: { guard: 1 } },
			templates: {
				membership: {
					guard: {
						enabled: true,
						default: { template: "{viewer} 成为了 {name} 的{tier}！", imageUrl: "" },
						tiers: {
							captain: {
								template: "{viewer} 登上了 {name} 的船",
								imageUrl: "https://img.test/captain.png",
							},
							governor: { template: "总督 {viewer} 驾到,档位 {tier}" },
						},
					},
				},
			},
		};
		expect((await subscriptionRow(sandbox, SUB_ID)).overrides).toEqual(expected);
		expect(store.getSubscriptions().find((sub) => sub.id === SUB_ID)?.overrides).toEqual(expected);
	});

	it("逐订阅:overrides.templates.guardBuy 与 overrides.filters 里的阈值一起搬(B 站与拓展订阅),开机装得进来(㉓d)", async () => {
		await placeConnectionsAndTargets();
		await sandbox.placeZero("state/globals.json", makeZeroGlobals());
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow(
				{ id: SUB_ID, uid: "12345" },
				{
					overrides: {
						filters: { minScPrice: 0, minGuardLevel: 3 },
						templates: {
							guardBuy: {
								enable: true,
								captain: { imageUrl: "", template: "{uname} 成为了 {mname} 的舰长！" },
								commander: {
									imageUrl: "https://img.test/c.png",
									template: "-uname 加入 {mname} 的-guard",
								},
								// 更早一代的上舰默认原文(逐订阅覆盖不经 0.x 那一遍的旧默认迁移):也算没动过。
								governor: { imageUrl: "", template: "{user} 成为了 {mastername} 的总督！" },
							},
						},
					},
				},
			),
		]);
		await sandbox.placeZero("state/extension-subscriptions.json", [
			zeroExtensionRow(
				{ id: EXT_SUB_ID, extensionId: "douyin", externalId: "sec-uid" },
				{ overrides: { filters: { minScPrice: 12 } } },
			),
		]);

		const store = await sandbox.migrateAndLoad();

		const bili = (await subscriptionRow(sandbox, SUB_ID)).overrides as Obj;
		expect(bili).toEqual({
			superchat: { minAmount: 0 },
			membership: { minRank: { guard: 1 } },
			templates: {
				membership: {
					guard: {
						enabled: true,
						default: { template: "{viewer} 成为了 {name} 的{tier}！", imageUrl: "" },
						tiers: {
							commander: {
								template: "{viewer} 加入 {name} 的{tier}",
								imageUrl: "https://img.test/c.png",
							},
						},
					},
				},
			},
		});
		expect((await subscriptionRow(sandbox, EXT_SUB_ID)).overrides).toEqual({
			superchat: { minAmount: 12 },
		});
		const loaded = (id: string) => store.getSubscriptions().find((sub) => sub.id === id)?.overrides;
		expect(loaded(SUB_ID)).toEqual(bili);
		expect(loaded(EXT_SUB_ID)).toEqual({ superchat: { minAmount: 12 } });
	});

	it("0.x 的十个过滤键一个不漏:改名的去了新名字、搬走的去了新的段,没有哪个 0.x 键留在 filters 里(去向对照的运行期复核)", async () => {
		await placeConnectionsAndTargets();
		const globals = makeZeroGlobals();
		const zeroFilters = globals.defaults.filters as Obj;
		// 夹具里的 0.12 出厂过滤就带全了十个键;下面把两个阈值调成非出厂的值,看它们各去了哪。
		expect(Object.keys(zeroFilters).sort()).toEqual([...ZERO_FILTER_KEYS].sort());
		globals.defaults.filters = { ...zeroFilters, minScPrice: 7, minGuardLevel: 1 };
		await sandbox.placeZero("state/globals.json", globals);

		await sandbox.migrate();

		const core = await sandbox.readConfig<{ defaults: Obj & { filters: Obj } }>(
			"settings/core.json",
		);
		expect(Object.keys(core.defaults.filters).sort()).toEqual(
			Object.keys(ContentFiltersSchema.shape).sort(),
		);
		for (const key of ZERO_FILTER_KEYS) {
			if (!(ZERO_MOVED_FILTER_KEYS as readonly string[]).includes(key)) continue;
			expect(core.defaults.filters, key).not.toHaveProperty(key);
		}
		expect(core.defaults.superchat).toEqual({ minAmount: 7 });
		expect(core.defaults.membership).toEqual({ minRank: { guard: 3 } });
	});

	it("过滤键:逐订阅 overrides.filters(B 站与拓展)只换写过的键,没写的不凭空长出来;老键不带过去;阈值搬成 superchat / membership 两段(㉓d)", async () => {
		await placeConnectionsAndTargets();
		await sandbox.placeZero("state/globals.json", makeZeroGlobals());
		const THRESHOLD_ONLY = "66666666-6666-4666-8666-666666666666";
		const FACTORY_THRESHOLDS = "77777777-7777-4777-8777-777777777777";
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow(
				{ id: SUB_ID, uid: "12345" },
				{
					overrides: {
						filters: {
							blockForward: true,
							blockDraw: false,
							blockKeywords: ["广告"],
							whitelistKeywords: ["新歌"],
							whitelistRegex: ["^上新"],
						},
					},
				},
			),
			// 只覆盖直播阈值的订阅:一把要改名的键都没写,换名以后也不能多出键(多出 blockImages: false 就会点亮「动态过滤」);
			// 阈值搬走以后 filters 空了,整个删掉(留一个空壳会被面板当成「覆盖着动态过滤」)。
			zeroBiliRow(
				{ id: THRESHOLD_ONLY, uid: "777" },
				{ overrides: { filters: { minScPrice: 50, minGuardLevel: 2 } } },
			),
			// 覆盖里写了出厂值(金额 0、等级 3):照样搬(它的意思是「这个订阅不设门槛」,全局可能不是 0)。
			zeroBiliRow(
				{ id: FACTORY_THRESHOLDS, uid: "888" },
				{ overrides: { filters: { minScPrice: 0, minGuardLevel: 3, blockKeywords: ["x"] } } },
			),
		]);
		await sandbox.placeZero("state/extension-subscriptions.json", [
			zeroExtensionRow(
				{ id: EXT_SUB_ID, extensionId: "douyin", externalId: "sec-uid" },
				{ overrides: { filters: { blockRegex: ["抽奖"], whitelistKeywords: ["开箱"] } } },
			),
		]);

		await sandbox.migrate();

		const overridesOf = async (id: string) => (await subscriptionRow(sandbox, id)).overrides as Obj;
		const filtersOf = async (id: string) => (await overridesOf(id)).filters as Obj;
		const biliFilters = await filtersOf(SUB_ID);
		expect(biliFilters).toEqual({
			blockReposts: true,
			blockImages: false,
			blockKeywords: ["广告"],
			allowKeywords: ["新歌"],
			allowRegex: ["^上新"],
		});
		expect(Object.keys(biliFilters)).toEqual([
			"blockReposts",
			"blockImages",
			"blockKeywords",
			"allowKeywords",
			"allowRegex",
		]);
		const thresholdOverrides = await overridesOf(THRESHOLD_ONLY);
		expect(thresholdOverrides).toEqual({
			superchat: { minAmount: 50 },
			membership: { minRank: { guard: 2 } },
		});
		expect(thresholdOverrides).not.toHaveProperty("filters");
		const factoryOverrides = await overridesOf(FACTORY_THRESHOLDS);
		expect(factoryOverrides).toEqual({
			filters: { blockKeywords: ["x"] },
			superchat: { minAmount: 0 },
			membership: { minRank: { guard: 1 } },
		});
		const extFilters = await filtersOf(EXT_SUB_ID);
		expect(extFilters).toEqual({ blockRegex: ["抽奖"], allowKeywords: ["开箱"] });
		for (const filters of [biliFilters, factoryOverrides.filters as Obj, extFilters]) {
			for (const old of [...OLD_FILTER_KEYS, ...MOVED_FILTER_KEYS]) {
				expect(filters).not.toHaveProperty(old);
			}
		}

		const store = await sandbox.load();
		const loaded = (id: string) => store.getSubscriptions().find((s) => s.id === id)?.overrides;
		expect(loaded(SUB_ID)?.filters).toEqual(biliFilters);
		expect(loaded(THRESHOLD_ONLY)).toEqual(thresholdOverrides);
		expect(loaded(THRESHOLD_ONLY)?.filters).toBeUndefined();
		expect(loaded(FACTORY_THRESHOLDS)).toEqual(factoryOverrides);
		expect(loaded(EXT_SUB_ID)?.filters).toEqual(extFilters);
	});

	it("先 0.x 那一遍、再改名:旧默认原文先回到当前默认,落在新键 post 上;改过的原文照搬", async () => {
		await placeConnectionsAndTargets();
		const globals = makeZeroGlobals();
		// 带链接那代的默认(0.x 的旧默认原文)+ 主人自己写的视频文案。
		globals.defaults.templates.dynamic = "{name}发布了一条动态：{url}";
		globals.defaults.templates.dynamicVideo = "我自己写的视频文案 {name}";
		await sandbox.placeZero("state/globals.json", globals);

		await sandbox.migrate();

		const core = await sandbox.readConfig<{ defaults: { templates: Obj } }>("settings/core.json");
		expect(core.defaults.templates.post).toBe("{name}发布了一条动态");
		expect(core.defaults.templates.postVideo).toBe("我自己写的视频文案 {name}");
	});

	it("第二代的 @全体(atAll / atAllDefaults)先并进附加项、再改名:落在 extraTargets.atAllPost / atAllLiveStart 与覆盖里的 extras", async () => {
		await placeConnectionsAndTargets();
		await sandbox.placeZero("state/globals.json", makeZeroGlobals());
		await sandbox.placeZero("state/subscriptions.json", [
			zeroBiliRow(
				{ id: SUB_ID, uid: "12345" },
				{
					routing: { ...zeroEmptyRouting(), dynamic: [T1], live: [T2] },
					extras: undefined,
					atAllDefaults: { dynamic: true, live: false },
					atAll: { dynamic: { [T1]: true }, live: { [T2]: false } },
				},
			),
		]);

		await sandbox.migrate();

		const row = await subscriptionRow(sandbox, SUB_ID);
		expect(row.extraTargets).toEqual({
			atAllPost: { [T1]: true },
			atAllLiveStart: { [T2]: false },
		});
		expect((row.overrides as Obj).features).toEqual({
			extras: { atAllPost: true, atAllLiveStart: false },
		});
		const store = await sandbox.load();
		expect(store.getSubscriptions().find((s) => s.id === SUB_ID)?.extraTargets.atAllPost).toEqual({
			[T1]: true,
		});
	});
});

describe("0.x 最新 → 1.0 改名 · 函数级", () => {
	/** 一整条 0.x 最新形状的订阅行:每一格要改名的地方都有。 */
	function zeroRow(): Obj {
		return zeroBiliRow(
			{ id: SUB_ID, uid: "12345" },
			{
				routing: {
					...zeroEmptyRouting(),
					dynamic: [T1],
					live: [T1],
					liveGuardBuy: [T2],
				},
				extras: { ...zeroEmptyExtras(), atAllDynamic: { [T1]: true }, atAllLive: { [T1]: false } },
				overrides: {
					features: { live: false, extras: { atAllDynamic: true } },
					filters: {
						blockForward: true,
						blockKeywords: ["k"],
						whitelistRegex: ["r"],
						minScPrice: 20,
					},
					templates: { dynamic: "d", dynamicVideo: "v" },
					messageLayout: {
						version: 1,
						dynamic: { blocks: blocks(true), separator: "\n" },
						live: { blocks: blocks(true), separator: "\n" },
					},
				},
			},
		);
	}

	/** 同一条订阅在 1.0 里的样子(期望值,字面量)。 */
	function newRow(): Obj {
		return {
			id: SUB_ID,
			uid: "12345",
			groups: [],
			enabled: true,
			routing: {
				post: [T1],
				liveStart: [T1],
				liveEnd: [],
				membership: [T2],
				superchat: [],
				specialDanmaku: [],
				specialUserEnter: [],
			},
			extraTargets: {
				atAllPost: { [T1]: true },
				atAllLiveStart: { [T1]: false },
				wordcloud: {},
				liveSummary: {},
			},
			overrides: {
				features: { liveStart: false, extras: { atAllPost: true } },
				filters: { blockReposts: true, blockKeywords: ["k"], allowRegex: ["r"], minScPrice: 20 },
				templates: { post: "d", postVideo: "v" },
				messageLayout: {
					version: 1,
					post: { blocks: blocks(true), separator: "\n" },
					live: { blocks: blocks(true), separator: "\n" },
				},
			},
			roastSchedule: zeroBiliRow({ id: SUB_ID, uid: "12345" }).roastSchedule,
			specialUsers: [],
		};
	}

	it("订阅行:每一格要改名的地方一次改完,值原样", () => {
		expect(renameSubscriptionKeys(zeroRow())).toEqual(newRow());
	});

	it("订阅行:幂等,已经是新键的行再跑一遍不变", () => {
		const once = renameSubscriptionKeys(zeroRow());
		expect(once).toEqual(newRow());
		expect(renameSubscriptionKeys(once)).toEqual(once);
		expect(renameSubscriptionKeys(newRow())).toEqual(newRow());
	});

	it("订阅行:新老键并存时以新键为准,老键丢掉(不看谁排在前)", () => {
		const expected = {
			routing: { post: [T2] },
			extraTargets: { atAllPost: { [T2]: true } },
		};
		// 老键在前:靠「后写的赢」碰巧也对。
		expect(
			renameSubscriptionKeys({
				routing: { dynamic: [T1], post: [T2] },
				extras: { atAllDynamic: { [T1]: true } },
				extraTargets: { atAllPost: { [T2]: true } },
			}),
		).toEqual(expected);
		// 老键在后:只有明说「新键已经在了就跳过老键」才对。
		expect(
			renameSubscriptionKeys({
				routing: { post: [T2], dynamic: [T1] },
				extraTargets: { atAllPost: { [T2]: true } },
				extras: { atAllDynamic: { [T1]: true } },
			}),
		).toEqual(expected);
	});

	it("订阅行:overrides.filters 六个键换名,键序不变,老键不带过去;关键词 / 正则 / 阈值四格原样", () => {
		const out = renameSubscriptionKeys({
			overrides: {
				filters: {
					whitelistRegex: ["r"],
					blockAv: true,
					blockKeywords: ["k"],
					blockForward: false,
					minGuardLevel: 2,
					blockArticle: true,
					blockRegex: ["x"],
					blockDraw: false,
					whitelistKeywords: ["w"],
					minScPrice: 50,
				},
			},
		}) as { overrides: { filters: Obj } };
		expect(out.overrides.filters).toEqual({
			allowRegex: ["r"],
			blockVideos: true,
			blockKeywords: ["k"],
			blockReposts: false,
			minGuardLevel: 2,
			blockArticles: true,
			blockRegex: ["x"],
			blockImages: false,
			allowKeywords: ["w"],
			minScPrice: 50,
		});
		expect(Object.keys(out.overrides.filters)).toEqual([
			"allowRegex",
			"blockVideos",
			"blockKeywords",
			"blockReposts",
			"minGuardLevel",
			"blockArticles",
			"blockRegex",
			"blockImages",
			"allowKeywords",
			"minScPrice",
		]);
		for (const old of OLD_FILTER_KEYS) expect(out.overrides.filters).not.toHaveProperty(old);
	});

	it("订阅行:overrides.filters 是稀疏的覆盖 —— 没写的键不凭空长出来(只覆盖阈值的覆盖一格不多)", () => {
		const thresholdOnly = { overrides: { filters: { minScPrice: 50, minGuardLevel: 2 } } };
		expect(renameSubscriptionKeys(thresholdOnly)).toEqual(thresholdOnly);
		expect(renameSubscriptionKeys({ overrides: { filters: { blockForward: true } } })).toEqual({
			overrides: { filters: { blockReposts: true } },
		});
		expect(renameSubscriptionKeys({ overrides: { filters: {} } })).toEqual({
			overrides: { filters: {} },
		});
	});

	it("订阅行:overrides.filters 新老键并存时以新键为准,老键丢掉(不看谁排在前)", () => {
		const expected = { overrides: { filters: { blockReposts: false, allowKeywords: ["new"] } } };
		expect(
			renameSubscriptionKeys({
				overrides: {
					filters: {
						blockForward: true,
						blockReposts: false,
						whitelistKeywords: ["old"],
						allowKeywords: ["new"],
					},
				},
			}),
		).toEqual(expected);
		expect(
			renameSubscriptionKeys({
				overrides: {
					filters: {
						blockReposts: false,
						blockForward: true,
						allowKeywords: ["new"],
						whitelistKeywords: ["old"],
					},
				},
			}),
		).toEqual(expected);
	});

	it("订阅行:认不得的形状原样放过,不相干的键不动", () => {
		expect(renameSubscriptionKeys("junk")).toBe("junk");
		expect(renameSubscriptionKeys(null)).toBe(null);
		const odd = {
			id: SUB_ID,
			routing: "坏的",
			overrides: {
				features: 5,
				filters: "坏的",
				templates: ["x"],
				messageLayout: null,
				cardSkin: "default",
			},
			specialUsers: [{ uid: "1", kinds: ["enter"] }],
			whatever: { dynamic: 1 },
		};
		expect(renameSubscriptionKeys(odd)).toEqual(odd);
	});

	/** 一份 0.x 最新形状的全局设置里,和这一步有关的那几格(其余原样带过)。 */
	function zeroSettings(): Obj {
		const globals = makeZeroGlobals();
		return globals as unknown as Obj;
	}

	it("全局设置:features / filters / templates / messageLayout / templateDefaultsSeen 五处一次改完", () => {
		const out = renameGlobalSettingsKeys(zeroSettings()) as {
			defaults: {
				features: Obj;
				filters: Obj;
				templates: Obj;
				messageLayout: Obj;
				templateDefaultsSeen: Obj;
				cardStyleByKind: unknown;
			};
		};
		expect(Object.keys(out.defaults.features)).toEqual([
			"post",
			"liveStart",
			"liveEnd",
			"membership",
			"superchat",
			"specialDanmaku",
			"specialUserEnter",
			"extras",
		]);
		expect(out.defaults.features.extras).toEqual({
			atAllPost: false,
			atAllLiveStart: true,
			wordcloud: true,
			liveSummary: true,
		});
		expect(out.defaults.filters).toEqual({
			blockReposts: false,
			blockArticles: false,
			blockImages: false,
			blockVideos: false,
			blockKeywords: [],
			blockRegex: [],
			allowKeywords: [],
			allowRegex: [],
			minScPrice: 0,
			minGuardLevel: 3,
		});
		expect(Object.keys(out.defaults.filters)).toEqual([
			"blockReposts",
			"blockArticles",
			"blockImages",
			"blockVideos",
			"blockKeywords",
			"blockRegex",
			"allowKeywords",
			"allowRegex",
			"minScPrice",
			"minGuardLevel",
		]);
		expect(out.defaults.templates.post).toBe("{name}发布了一条动态");
		expect(out.defaults.templates.postVideo).toBe("{name}发布了新视频");
		expect(Object.keys(out.defaults.messageLayout)).toEqual(["version", "post", "live"]);
		expect(out.defaults.templateDefaultsSeen.post).toBe("7uw5nq");
		expect(out.defaults.templateDefaultsSeen.postVideo).toBe("1omlggn");
		// 卡种键与日志级别键不归这一步(㉔ / 3a)。
		expect(out.defaults.cardStyleByKind).toEqual({});
	});

	it("全局设置:defaults.filters 新老键并存时以新键为准,老键丢掉(不看谁排在前)", () => {
		const expected = { defaults: { filters: { blockReposts: false, allowKeywords: ["new"] } } };
		expect(
			renameGlobalSettingsKeys({
				defaults: {
					filters: {
						blockForward: true,
						blockReposts: false,
						whitelistKeywords: ["old"],
						allowKeywords: ["new"],
					},
				},
			}),
		).toEqual(expected);
		expect(
			renameGlobalSettingsKeys({
				defaults: {
					filters: {
						blockReposts: false,
						blockForward: true,
						allowKeywords: ["new"],
						whitelistKeywords: ["old"],
					},
				},
			}),
		).toEqual(expected);
	});

	it("全局设置:幂等;已经是新键的设置原样;认不得的形状放过", () => {
		const once = renameGlobalSettingsKeys(zeroSettings());
		expect(renameGlobalSettingsKeys(once)).toEqual(once);
		expect(renameGlobalSettingsKeys("junk")).toBe("junk");
		expect(renameGlobalSettingsKeys({ defaults: "坏的" })).toEqual({ defaults: "坏的" });
		const odd = {
			defaults: {
				features: 5,
				filters: null,
				templates: null,
				messageLayout: [],
				templateDefaultsSeen: "x",
			},
		};
		expect(renameGlobalSettingsKeys(odd)).toEqual(odd);
	});

	it("全局设置:app.logLevels 的键(dynamic / live 是日志模块名)不动", () => {
		const globals = zeroSettings();
		(globals.app as Obj).logLevels = { dynamic: "debug", live: "warn" };
		const out = renameGlobalSettingsKeys(globals) as { app: { logLevels: unknown } };
		expect(out.app.logLevels).toEqual({ dynamic: "debug", live: "warn" });
	});
});
