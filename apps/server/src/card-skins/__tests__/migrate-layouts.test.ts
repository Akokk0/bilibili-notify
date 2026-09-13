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
		expect(result).toEqual({ created: 0, global: false, subscriptions: 0 });
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

describe("收尾", () => {
	it("迁完订阅里不再有 cardLayout,全局那份回到出厂版式", async () => {
		await setGlobalLayout(customLayout());
		await addSub("111", "阿夸", { cardLayout: otherLayout() });
		await migrateCardLayoutsToSkins({ store, config });

		// 订阅那侧 `overrides.cardLayout` 是 optional,删掉就是真的没了。
		expect(await rawState("subscriptions.json")).not.toContain("cardLayout");
		// 全局那侧 `.default(DEFAULT_CARD_LAYOUT)` 会把键补回来(见 migrate-layouts.ts 文件头),
		// 所以「删掉」等价于回到出厂版式 —— 值必须是默认那份,不能还是主人改过的。
		expect(config.getGlobals().defaults.cardLayout).toEqual(DEFAULT_CARD_LAYOUT);
		const globals = JSON.parse(await rawState("globals.json"));
		expect(globals.defaults.cardLayout).toEqual(DEFAULT_CARD_LAYOUT);
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
		expect(second).toEqual({ created: 0, global: false, subscriptions: 0 });
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

		expect(again).toEqual({ created: 0, global: false, subscriptions: 0 });
		expect(rebornStore.list().filter((s) => !s.builtin)).toHaveLength(1);
	});
});
