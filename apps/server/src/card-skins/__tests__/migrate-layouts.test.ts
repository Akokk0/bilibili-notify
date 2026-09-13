/**
 * 开机一次性迁移:旧版式 → 卡片皮肤(ADR-0014 决策 15 / 17)。
 *
 * 这一组钉五件事:**没改过版式的不生成皮肤**(否则人人开机白多一套)、**改过的折一份并把
 * 指针指过去**、**同内容只落一份**、**跑两遍第二遍零变化**、以及**旧键收拾干净**。
 *
 * 用的是**真的 ConfigStore 与真的 CardSkinStore**(各自 mkdtemp),不是替身:这道迁移的
 * 全部难点恰恰在「zod 的 `.default` 会把删掉的键补回来」这类落盘细节上,替身测不出来。
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BiliEvents,
	CardLayout,
	Disposable,
	MessageBus,
	ServiceContext,
	Subscription,
	SubscriptionOverrides,
} from "@bilibili-notify/internal";
import {
	DEFAULT_CARD_LAYOUT,
	DEFAULT_CARD_SKIN_ID,
	makeEmptySubscription,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BootstrapConfig } from "../../config/schema.js";
import { type ConfigStore, createConfigStore } from "../../config/store.js";
import { migrateCardLayoutsToSkins } from "../migrate-layouts.js";
import { CardSkinStore } from "../store.js";

function makeBus(): MessageBus {
	const listeners = new Map<keyof BiliEvents, Set<(...a: unknown[]) => void>>();
	return {
		emit(event, ...args) {
			for (const h of [...(listeners.get(event) ?? [])]) (h as (...a: unknown[]) => void)(...args);
		},
		on(event, handler): Disposable {
			let s = listeners.get(event);
			if (!s) {
				s = new Set();
				listeners.set(event, s);
			}
			const w = (...a: unknown[]) => (handler as (...x: unknown[]) => void)(...a);
			s.add(w);
			return { dispose: () => listeners.get(event)?.delete(w) };
		},
	};
}

function makeCtx(): ServiceContext {
	return {
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		setInterval: () => ({ dispose: vi.fn() }),
		setTimeout: () => ({ dispose: vi.fn() }),
		onDispose: vi.fn(),
	};
}

/** 主人改过的版式:把直播卡的封面藏起来。归一化不会动它,所以与出厂那份确实不同。 */
function customLayout(): CardLayout {
	const layout = structuredClone(DEFAULT_CARD_LAYOUT);
	const cover = layout.live[0];
	if (!cover) throw new Error("默认版式的直播卡是空的?");
	cover.visible = false;
	return layout;
}

/** 另一种改法 —— 用来验「两个 UP 版式不同就各落一份」。 */
function otherLayout(): CardLayout {
	const layout = structuredClone(DEFAULT_CARD_LAYOUT);
	const title = layout.live[2];
	if (!title) throw new Error("默认版式的直播卡块数变了");
	title.marginTop = 42;
	return layout;
}

let dataDir: string;
let config: ConfigStore;
let store: CardSkinStore;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-card-skin-migrate-"));
	const bootstrap: BootstrapConfig = {
		server: { host: "127.0.0.1", port: 8787 },
		dataDir,
		logLevel: "info",
	};
	config = createConfigStore({ bootstrap, bus: makeBus(), serviceCtx: makeCtx() });
	await config.load();
	store = new CardSkinStore({ dir: join(dataDir, "card-skins") });
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

async function setGlobalLayout(layout: CardLayout): Promise<void> {
	const g = config.getGlobals();
	await config.setGlobals({ ...g, defaults: { ...g.defaults, cardLayout: layout } });
}

async function addSub(
	uid: string,
	name: string,
	overrides: SubscriptionOverrides,
): Promise<string> {
	const id = randomUUID();
	const sub: Subscription = { ...makeEmptySubscription({ id, uid }), name, overrides };
	await config.upsertSubscription(sub);
	return id;
}

const subById = (id: string): Subscription => {
	const hit = config.getSubscriptions().find((s) => s.id === id);
	if (!hit) throw new Error(`订阅不见了: ${id}`);
	return hit;
};

/** 库里除内置那份之外还有哪些(按名字,顺序不稳所以排一遍)。 */
const installedNames = (): string[] =>
	store
		.list()
		.filter((s) => !s.builtin)
		.map((s) => s.name)
		.sort();

const rawState = async (file: string): Promise<string> =>
	await readFile(join(dataDir, "state", file), "utf8");

describe("没有存量版式", () => {
	it("出厂默认版式不生成任何皮肤,配置一个字节都不动", async () => {
		const before = await rawState("globals.json");
		const result = await migrateCardLayoutsToSkins({ store, config });
		expect(result).toEqual({ created: 0, global: false, subscriptions: 0, globalKnobs: false });
		expect(installedNames()).toEqual([]);
		expect(config.getGlobals().defaults.cardSkin).toBe(DEFAULT_CARD_SKIN_ID);
		expect(await rawState("globals.json")).toBe(before);
	});
});

describe("全局版式", () => {
	it("改过的全局折成一套皮肤,globals.defaults.cardSkin 指向它", async () => {
		await setGlobalLayout(customLayout());
		const result = await migrateCardLayoutsToSkins({ store, config });

		expect(result).toMatchObject({ created: 1, global: true, subscriptions: 0 });
		expect(installedNames()).toEqual(["自定义(迁移自旧版式)"]);
		const id = store.list().find((s) => !s.builtin)?.id;
		expect(config.getGlobals().defaults.cardSkin).toBe(id);
		// 折出来的确实是「藏起封面」那一版:cover 块没进皮肤。
		const live = store.get(id as string)?.cards.live;
		expect(live?.blocks.map((b) => b.id)).not.toContain("cover");
	});

	it("主人已经自己选过皮肤时不拿旧版式盖掉他的选择", async () => {
		await setGlobalLayout(customLayout());
		const { id } = await store.duplicate(DEFAULT_CARD_SKIN_ID, "主人自己挑的");
		await config.patchGlobals({ defaults: { cardSkin: id } });

		const result = await migrateCardLayoutsToSkins({ store, config });
		expect(result).toMatchObject({ created: 0, global: false });
		expect(config.getGlobals().defaults.cardSkin).toBe(id);
	});
});

describe("per-UP 版式", () => {
	it("折成「<UP 名> 专用」并挂到 overrides.cardSkin 上", async () => {
		const sub = await addSub("111", "阿夸", { cardLayout: customLayout() });
		const result = await migrateCardLayoutsToSkins({ store, config });

		expect(result).toMatchObject({ created: 1, global: false, subscriptions: 1 });
		expect(installedNames()).toEqual(["阿夸 专用"]);
		const id = store.list().find((s) => !s.builtin)?.id;
		expect(subById(sub).overrides.cardSkin).toBe(id);
		expect(subById(sub).overrides.cardLayout).toBeUndefined();
	});

	it("没填昵称就用 uid", async () => {
		const id = randomUUID();
		await config.upsertSubscription({
			...makeEmptySubscription({ id, uid: "222" }),
			overrides: { cardLayout: customLayout() },
		});
		await migrateCardLayoutsToSkins({ store, config });
		expect(installedNames()).toEqual(["222 专用"]);
	});

	it("两个 UP 版式一样 → 只落一份,两边指同一套", async () => {
		const a = await addSub("111", "阿夸", { cardLayout: customLayout() });
		const b = await addSub("222", "小白", { cardLayout: customLayout() });
		const result = await migrateCardLayoutsToSkins({ store, config });

		expect(result).toMatchObject({ created: 1, subscriptions: 2 });
		expect(installedNames()).toHaveLength(1);
		const skin = subById(a).overrides.cardSkin;
		expect(skin).toBeTruthy();
		expect(subById(b).overrides.cardSkin).toBe(skin);
	});

	it("版式不同 → 各落一份", async () => {
		await addSub("111", "阿夸", { cardLayout: customLayout() });
		await addSub("222", "小白", { cardLayout: otherLayout() });
		const result = await migrateCardLayoutsToSkins({ store, config });
		expect(result).toMatchObject({ created: 2, subscriptions: 2 });
		expect(installedNames()).toEqual(["小白 专用", "阿夸 专用"]);
	});

	it("覆盖的内容其实等于全局 → 不派生,退回「跟随全局」(决策 17 的「若与全局不同」)", async () => {
		await setGlobalLayout(customLayout());
		const sub = await addSub("111", "阿夸", { cardLayout: customLayout() });
		const result = await migrateCardLayoutsToSkins({ store, config });

		expect(result).toMatchObject({ created: 1, global: true, subscriptions: 1 });
		expect(installedNames()).toEqual(["自定义(迁移自旧版式)"]);
		expect(subById(sub).overrides.cardSkin).toBeUndefined();
		expect(subById(sub).overrides.cardLayout).toBeUndefined();
	});
});

/**
 * 三个显隐开关(`cardStyle.showPopularity / showArea / showFans`)是**退役中**的:它们画在
 * 「直播数据」一个复合块里面,块级的 `showIf` 管不到块内一行,所以关过开关的存量用户得折成
 * 用原子块拼出来的派生皮肤(ADR-0014 决策 16 的 🔗)。这一组钉的就是那一跳。
 */
describe("三个显隐开关", () => {
	/** 复合数据块换成原子块之后,live 卡里该出现哪些块。 */
	const liveBlockIds = (skinId: string): string[] =>
		store.get(skinId)?.cards.live?.blocks.map((b) => b.id) ?? [];

	it("关过开关 → 派生皮肤的直播卡用原子块拼,关掉的那件压根不生成", async () => {
		const g = config.getGlobals();
		await config.setGlobals({
			...g,
			// 版式没动过,动的只有开关 —— 光这一样就足以让他成为「存量用户」。
			defaults: {
				...g.defaults,
				cardLayout: DEFAULT_CARD_LAYOUT,
				cardStyle: { ...g.defaults.cardStyle, showArea: false },
			},
		});
		const result = await migrateCardLayoutsToSkins({ store, config });

		expect(result).toMatchObject({ created: 1, global: true });
		const id = config.getGlobals().defaults.cardSkin;
		const ids = liveBlockIds(id);
		// 验红:把 installSkin 里 cardLayoutToSkin 的第三个参数(toggles)拿掉,这三条全红 ——
		// 复合块 `data` 会原样留着,而它恒画三项,主人关掉的分区又回来了。
		expect(ids).toContain("popularity");
		expect(ids).toContain("fans");
		expect(ids).not.toContain("area");
		expect(ids).not.toContain("data");
	});

	it("三个都开 → 照旧用复合块,什么都不折(但旧键照样收走)", async () => {
		// 旧键摆上去才算「存量实例」—— 不摆的话迁移一开头就返回了,这条会为了错误的理由变绿。
		await setGlobalLayout(DEFAULT_CARD_LAYOUT);
		const result = await migrateCardLayoutsToSkins({ store, config });
		expect(result).toMatchObject({ created: 0, global: false });
		expect(config.getGlobals().defaults.cardSkin).toBe(DEFAULT_CARD_SKIN_ID);
		expect(config.getGlobals().defaults.cardLayout).toBeUndefined();
	});

	it("per-UP 单独关过开关(版式没动)→ 给他单折一套,不跟着全局那套走", async () => {
		await setGlobalLayout(DEFAULT_CARD_LAYOUT);
		const sub = await addSub("111", "阿夸", {
			cardStyle: { showFans: false },
		} as SubscriptionOverrides);
		const result = await migrateCardLayoutsToSkins({ store, config });

		expect(result).toMatchObject({ subscriptions: 1 });
		const skinId = subById(sub).overrides.cardSkin;
		expect(skinId).toBeDefined();
		// 验红:把 per-UP 那份 toggles 换成 globalToggles,这条红 —— 他的粉丝行会回来。
		expect(liveBlockIds(skinId as string)).not.toContain("fans");
		expect(installedNames()).toEqual(["阿夸 专用"]);
	});
});

describe("收尾", () => {
	it("迁完两侧的 cardLayout 都真的没了(它现在是 optional,删得掉)", async () => {
		await setGlobalLayout(customLayout());
		await addSub("111", "阿夸", { cardLayout: otherLayout() });
		await migrateCardLayoutsToSkins({ store, config });

		// 两侧都是 `.optional()`,删掉就是真的没了 —— 这正是「跑过没有」的判据
		// (键还在 = 还没迁),所以它必须从盘上消失,不能被 zod 的 default 补回来。
		expect(await rawState("subscriptions.json")).not.toContain("cardLayout");
		expect(config.getGlobals().defaults.cardLayout).toBeUndefined();
		const globals = JSON.parse(await rawState("globals.json"));
		expect(Object.hasOwn(globals.defaults, "cardLayout")).toBe(false);
	});

	it("跑两遍 —— 第二遍零变化,不会再折一套出来", async () => {
		await setGlobalLayout(customLayout());
		const sub = await addSub("111", "阿夸", { cardLayout: otherLayout() });
		await migrateCardLayoutsToSkins({ store, config });

		const names = installedNames();
		const activeSkin = config.getGlobals().defaults.cardSkin;
		const subSkin = subById(sub).overrides.cardSkin;
		const rawGlobals = await rawState("globals.json");
		const rawSubs = await rawState("subscriptions.json");

		const second = await migrateCardLayoutsToSkins({ store, config });
		expect(second).toEqual({ created: 0, global: false, subscriptions: 0, globalKnobs: false });
		expect(installedNames()).toEqual(names);
		expect(config.getGlobals().defaults.cardSkin).toBe(activeSkin);
		expect(subById(sub).overrides.cardSkin).toBe(subSkin);
		expect(await rawState("globals.json")).toBe(rawGlobals);
		expect(await rawState("subscriptions.json")).toBe(rawSubs);
	});

	it("重启之后也不会再折 —— 换一份 store / config 实例从盘上重来一遍", async () => {
		await setGlobalLayout(customLayout());
		await migrateCardLayoutsToSkins({ store, config });

		const reborn = createConfigStore({
			bootstrap: { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "info" },
			bus: makeBus(),
			serviceCtx: makeCtx(),
		});
		await reborn.load();
		const rebornStore = new CardSkinStore({ dir: join(dataDir, "card-skins") });
		const again = await migrateCardLayoutsToSkins({ store: rebornStore, config: reborn });

		expect(again).toEqual({ created: 0, global: false, subscriptions: 0, globalKnobs: false });
		expect(rebornStore.list().filter((s) => !s.builtin)).toHaveLength(1);
	});
});

/**
 * 退役的渐变起 / 止色(`cardStyle.cardColorStart / cardColorEnd`,ADR-0014 决策 15 的 🔗)。
 *
 * 与版式同一条迁移、同一套皮肤:改过颜色的存量用户升级时把那对色折进派生皮肤的**外框
 * CSS**,颜色等于出厂 / 等于全局的不派生,迁完两个键从所有位置消失。
 */
describe("退役的渐变色", () => {
	const FACTORY = { start: "#e0c3fc", end: "#8ec5fc" };
	const MINE = { start: "#ff0000", end: "#00ff00" };

	/** 某套皮肤某种卡的外框 CSS。 */
	const frameCss = (skinId: string, kind: "live" | "dynamic" | "roastBoard" | "sc"): string =>
		store.get(skinId)?.cards[kind]?.css ?? "";

	/**
	 * 外框渐变那两端的色。2026-09-14 起它们住在**旋钮的兜底位**里
	 * (`var(--bn-knob-gradient-start,<色>)`)—— 派生皮肤带着渐变旋钮的声明,写死字面量
	 * 的话面板上的取色器就拧不动了。
	 */
	const gradientOf = (css: string): string[] =>
		[...css.matchAll(/var\(--bn-knob-gradient-(?:start|end),([^)]+)\)/g)].map(
			(m) => m[1] as string,
		);

	async function setGlobalColors(start: string, end: string): Promise<void> {
		const g = config.getGlobals();
		await config.setGlobals({
			...g,
			defaults: {
				...g.defaults,
				cardStyle: { ...g.defaults.cardStyle, cardColorStart: start, cardColorEnd: end },
			},
		});
	}

	/**
	 * 2026-09-14 主人拍板改的那条:**只**改过颜色的人不该被派一套皮肤 —— 两个色落成
	 * 默认皮肤的旋钮覆盖,人留在默认皮肤上,以后跟着出厂外观一起升级。
	 */
	it("全局只改过颜色(版式没动)→ 不派皮肤,颜色落成默认皮肤的旋钮覆盖", async () => {
		await setGlobalColors(MINE.start, MINE.end);
		const result = await migrateCardLayoutsToSkins({ store, config });

		expect(result).toMatchObject({ created: 0, global: false, globalKnobs: true });
		expect(installedNames()).toEqual([]);
		const g = config.getGlobals().defaults;
		expect(g.cardSkin).toBe(DEFAULT_CARD_SKIN_ID);
		expect(g.cardSkinKnobs[DEFAULT_CARD_SKIN_ID]).toEqual({
			"gradient-start": MINE.start,
			"gradient-end": MINE.end,
		});
		// 旧键照样收走。
		expect(await rawState("globals.json")).not.toContain("cardColorStart");
	});

	it("按卡种另给一份颜色 → 走不了旋钮那条路(旋钮全局一份),照旧派生皮肤", async () => {
		await setGlobalColors(MINE.start, MINE.end);
		const g0 = config.getGlobals();
		await config.setGlobals({
			...g0,
			defaults: {
				...g0.defaults,
				cardStyleByKind: { live: { cardColorStart: "#111111", cardColorEnd: "#222222" } },
			},
		});
		const result = await migrateCardLayoutsToSkins({ store, config });

		expect(result).toMatchObject({ created: 1, global: true, globalKnobs: false });
		const id = config.getGlobals().defaults.cardSkin;
		expect(id).not.toBe(DEFAULT_CARD_SKIN_ID);
		expect(gradientOf(frameCss(id, "live"))).toEqual(["#111111", "#222222"]);
		expect(gradientOf(frameCss(id, "dynamic"))).toEqual([MINE.start, MINE.end]);
		// SC 的底色按价位档走,与用户颜色无关 —— 档位变量原样留着。
		expect(frameCss(id, "sc")).toContain("--bn-card-tier-color");
		expect(frameCss(id, "sc")).not.toContain(MINE.start);
	});

	it("颜色就是出厂值 → 一套皮肤都不折(但两个旧键照样收走)", async () => {
		await setGlobalColors(FACTORY.start, FACTORY.end);
		const result = await migrateCardLayoutsToSkins({ store, config });

		expect(result).toMatchObject({ created: 0, global: false });
		expect(config.getGlobals().defaults.cardSkin).toBe(DEFAULT_CARD_SKIN_ID);
		expect(await rawState("globals.json")).not.toContain("cardColorStart");
	});

	it("按卡种的颜色(cardStyleByKind.live)只改那一种卡,其余卡吃全局那份", async () => {
		await setGlobalColors(MINE.start, MINE.end);
		const g = config.getGlobals();
		await config.setGlobals({
			...g,
			defaults: {
				...g.defaults,
				cardStyleByKind: { live: { cardColorStart: "#111111", cardColorEnd: "#222222" } },
			},
		});
		await migrateCardLayoutsToSkins({ store, config });

		const id = config.getGlobals().defaults.cardSkin;
		expect(gradientOf(frameCss(id, "live"))).toEqual(["#111111", "#222222"]);
		expect(gradientOf(frameCss(id, "dynamic"))).toEqual([MINE.start, MINE.end]);
	});

	it("per-UP 改过颜色 → 给他单折一套「专用」,全局那套不受影响", async () => {
		const sub = await addSub("111", "阿夸", {
			cardStyle: { cardColorStart: "#abcdef", cardColorEnd: "#fedcba" },
		} as SubscriptionOverrides);
		const result = await migrateCardLayoutsToSkins({ store, config });

		expect(result).toMatchObject({ subscriptions: 1 });
		expect(installedNames()).toEqual(["阿夸 专用"]);
		const skinId = subById(sub).overrides.cardSkin as string;
		expect(skinId).toBeDefined();
		expect(gradientOf(frameCss(skinId, "live"))).toEqual(["#abcdef", "#fedcba"]);
		expect(config.getGlobals().defaults.cardSkin).toBe(DEFAULT_CARD_SKIN_ID);
	});

	it("per-UP 的颜色其实等于全局生效值 → 不派生,跟随全局那套", async () => {
		await setGlobalColors(MINE.start, MINE.end);
		const sub = await addSub("111", "阿夸", {
			cardStyle: { cardColorStart: MINE.start, cardColorEnd: MINE.end },
		} as SubscriptionOverrides);
		const result = await migrateCardLayoutsToSkins({ store, config });

		// 全局那份只改过颜色 → 走旋钮那条路,一套皮肤都不折;这位 UP 的颜色与全局一样,
		// 自然也不用折。
		expect(result).toMatchObject({ created: 0, global: false, globalKnobs: true });
		expect(installedNames()).toEqual([]);
		expect(subById(sub).overrides.cardSkin).toBeUndefined();
		// 跟随全局归跟随全局,那两个退役的键照样得从他的覆盖里消失。
		expect(subById(sub).overrides.cardStyle?.cardColorStart).toBeUndefined();
	});

	it("版式与颜色一起改过 → **只派一套**皮肤,两样都折进去", async () => {
		await setGlobalLayout(customLayout());
		await setGlobalColors(MINE.start, MINE.end);
		const result = await migrateCardLayoutsToSkins({ store, config });

		expect(result).toMatchObject({ created: 1, global: true });
		expect(installedNames()).toEqual(["自定义(迁移自旧版式)"]);
		const id = config.getGlobals().defaults.cardSkin;
		expect(store.get(id)?.cards.live?.blocks.map((b) => b.id)).not.toContain("cover");
		expect(gradientOf(frameCss(id, "live"))).toEqual([MINE.start, MINE.end]);
	});

	it("迁完四个位置的两个键全没了(全局 / per-kind / per-UP / per-UP per-kind)", async () => {
		await setGlobalColors(MINE.start, MINE.end);
		const g = config.getGlobals();
		await config.setGlobals({
			...g,
			defaults: {
				...g.defaults,
				cardStyle: { ...g.defaults.cardStyle, cardColorStart: MINE.start, cardColorEnd: MINE.end },
				cardStyleByKind: { live: { cardColorStart: "#111111" } },
			},
		});
		await addSub("111", "阿夸", {
			cardStyle: { cardColorStart: "#abcdef" },
			cardStyleByKind: { dynamic: { cardColorEnd: "#fedcba" } },
		} as SubscriptionOverrides);
		await migrateCardLayoutsToSkins({ store, config });

		for (const file of ["globals.json", "subscriptions.json"]) {
			const raw = await rawState(file);
			expect(raw).not.toContain("cardColorStart");
			expect(raw).not.toContain("cardColorEnd");
		}
	});

	it("跑两遍 —— 只有颜色的存量实例第二遍一个字节都不写", async () => {
		await setGlobalColors(MINE.start, MINE.end);
		const sub = await addSub("111", "阿夸", {
			cardStyle: { cardColorStart: "#abcdef" },
		} as SubscriptionOverrides);
		await migrateCardLayoutsToSkins({ store, config });

		const names = installedNames();
		const rawGlobals = await rawState("globals.json");
		const rawSubs = await rawState("subscriptions.json");

		const second = await migrateCardLayoutsToSkins({ store, config });
		expect(second).toEqual({ created: 0, global: false, subscriptions: 0, globalKnobs: false });
		expect(installedNames()).toEqual(names);
		expect(await rawState("globals.json")).toBe(rawGlobals);
		expect(await rawState("subscriptions.json")).toBe(rawSubs);
		expect(subById(sub).overrides.cardSkin).toBeTruthy();
	});
});
