/**
 * 0.x 的推送特性老形状(ADR-0016)→ 最新形状:兼容逻辑住在迁移器里(`migration/features.ts`、`settings.ts`、
 * `subscriptions.ts`),这一份是走接缝的那一头 —— 每条迁移函数各自的判定见 `./features.test.ts`。
 *
 * 接缝是「第 0 代 → `migrateZeroGeneration` → 新的一代上配置仓开机」:在临时的第 0 代里摆 0.x 的
 * `state/globals.json`(`defaults.features` 是第一代 / 第二代)、`state/subscriptions.json`(第一代 routing +
 * `atAll` + `atAllDefaults` + 第一代的 `overrides.features`)、`state/extension-subscriptions.json`(第二代
 * `overrides.features`),迁一代,再在新代上开配置仓。摆放与开机的辅助见 `./support.ts`。
 *
 * 钉三件事:
 * - 迁出来的是新代 `config/` 里的**文件本身**(配置仓开机只认最新的形状,文件没迁好开机就直接拒收),
 *   globals 与订阅都进了 `rewritten`;两份订阅(B 站与拓展)合成了新代里的**一个** `subscriptions.json`
 *   (ADR-0021 决策 15),拓展那份自己不进新代;
 * - 配置仓开机读出来的值是最新的形状;
 * - 第 0 代那三份一个字节没变(迁移写的是新文件,不是原地改那条硬链接);已经是新形状的设置不改写。
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	type Connection,
	makeDefaultGlobalConfig,
	type PushTarget,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { useZeroSandbox } from "./support.js";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const T1 = "22222222-2222-4222-8222-222222222222";
const T2 = "44444444-4444-4444-8444-444444444444";
const SUB_ID = "33333333-3333-4333-8333-333333333333";
const EXT_SUB_ID = "55555555-5555-4555-8555-555555555555";

/** 新形状的连接与目标 —— 这一份夹具只关心订阅与设置,它们不该被改写。 */
const CONNECTION: Connection = {
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

function sessionTarget(id: string, name: string, address: string): PushTarget {
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
const TARGETS: PushTarget[] = [sessionTarget(T1, "主群", "111"), sessionTarget(T2, "副群", "222")];

/** 整份 globals,`defaults.features` 换成给定的(老形状)。 */
function globalsWithFeatures(features: unknown): unknown {
	const base = makeDefaultGlobalConfig();
	return { ...base, defaults: { ...base.defaults, features } };
}

/** 第一代:9 把平铺布尔,下播关着、只开了词云。 */
const GEN1_FEATURES = {
	dynamic: true,
	live: true,
	liveEnd: false,
	liveGuardBuy: false,
	superchat: false,
	wordcloud: true,
	liveSummary: false,
	specialDanmaku: false,
	specialUserEnter: false,
};

/** 第二代:`liveEndExtras` 小对象,下播关着。 */
const GEN2_FEATURES = {
	dynamic: true,
	live: true,
	liveEnd: false,
	liveGuardBuy: false,
	superchat: false,
	specialDanmaku: false,
	specialUserEnter: false,
	liveEndExtras: { wordcloud: false, liveSummary: true },
};

/** 第一代 routing(词云 / 总结各有一份目标)+ 第二代 @全体(`atAll` / `atAllDefaults`)+ 第一代的 features 覆盖。 */
const LEGACY_SUBSCRIPTION = {
	id: SUB_ID,
	uid: "12345",
	name: "老UP",
	enabled: true,
	groups: [],
	routing: {
		dynamic: [T1],
		live: [T1, T2],
		liveEnd: [T1],
		liveGuardBuy: [],
		superchat: [],
		wordcloud: [T2],
		liveSummary: [],
		specialDanmaku: [],
		specialUserEnter: [],
	},
	// `atAllDefaults` 里 dynamic 不是出厂默认(出厂关),要落进 per-UP 覆盖;live 是出厂默认(开),不写。
	atAllDefaults: { dynamic: true, live: true },
	atAll: { dynamic: { [T1]: true }, live: { [T2]: false } },
	overrides: { features: { liveEnd: false, wordcloud: true } },
	specialUsers: [],
};

/** 拓展订阅:第二代的 features 覆盖(没有 @全体,也没有第一代 routing)。 */
const LEGACY_EXTENSION_SUBSCRIPTION = {
	kind: "extension",
	id: EXT_SUB_ID,
	extensionId: "douyin",
	externalId: "MS4wLjABAAAA-sec_uid",
	enabled: true,
	groups: [],
	routing: {
		dynamic: [],
		live: [T1],
		liveEnd: [T1],
		liveGuardBuy: [],
		superchat: [],
		specialDanmaku: [],
		specialUserEnter: [],
	},
	overrides: { features: { liveEnd: false, liveEndExtras: { wordcloud: false } } },
};

/** 订阅文件里的行,按 id 取。 */
type Row = Record<string, unknown>;
function rowById(rows: Row[], id: string): Row {
	const row = rows.find((r) => r.id === id);
	if (!row) throw new Error(`no subscription row ${id}`);
	return row;
}

/** 两个路径是不是同一个文件(硬链接)—— 没被改写过的文件,新代里还是从第 0 代搬过来的那一份。 */
async function sameFile(a: string, b: string): Promise<boolean> {
	return (await stat(a)).ino === (await stat(b)).ino;
}

describe("0.x 推送特性老形状 → 迁移器接缝", () => {
	const sandbox = useZeroSandbox("bn-legacy-features-");

	async function placeConnectionsAndTargets(): Promise<void> {
		await sandbox.placeZero("state/connections.json", [CONNECTION]);
		await sandbox.placeZero("state/targets.json", TARGETS);
	}

	it("第一代的全局 features、老订阅与拓展订阅一起迁:新代里是最新的形状(订阅合成一个文件),第 0 代那三份一个字节没变", async () => {
		await placeConnectionsAndTargets();
		const originals = {
			"globals.json": JSON.stringify(globalsWithFeatures(GEN1_FEATURES)),
			"subscriptions.json": JSON.stringify([LEGACY_SUBSCRIPTION]),
			"extension-subscriptions.json": JSON.stringify([LEGACY_EXTENSION_SUBSCRIPTION]),
		};
		for (const [name, text] of Object.entries(originals)) {
			await sandbox.placeZeroText(`state/${name}`, text);
		}

		const report = await sandbox.migrate();

		// globals 与订阅都是迁移器改写的(不是搬过来的那个文件);拓展那份只作输入,新代里没有它。
		expect(report.rewritten).toEqual(
			expect.arrayContaining(["config/globals.json", "config/subscriptions.json"]),
		);
		expect(report.rewritten).not.toContain("config/extension-subscriptions.json");
		for (const name of ["globals.json", "subscriptions.json"]) {
			expect(
				await sameFile(join(sandbox.zero, "state", name), sandbox.configPath(name)),
				name,
			).toBe(false);
		}
		await expect(stat(sandbox.configPath("extension-subscriptions.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		// 第 0 代那三份一个字节没变。
		for (const [name, text] of Object.entries(originals)) {
			expect(await readFile(join(sandbox.zero, "state", name), "utf8"), name).toBe(text);
		}

		// 新代里的**文件本身**已经是最新的形状(不只是开机读得进来)。
		const globalsOnDisk = await sandbox.readConfig<{ defaults: { features: unknown } }>(
			"globals.json",
		);
		expect(globalsOnDisk.defaults.features).toEqual({
			dynamic: true,
			live: true,
			liveEnd: true,
			liveGuardBuy: false,
			superchat: false,
			specialDanmaku: false,
			specialUserEnter: false,
			extras: { atAllDynamic: false, atAllLive: true, wordcloud: true, liveSummary: false },
		});
		const subRows = await sandbox.readConfig<Row[]>("subscriptions.json");
		// 两份订阅合成一个文件:B 站的在前、拓展的在后,行行带 identity。
		expect(subRows.map((r) => r.id)).toEqual([SUB_ID, EXT_SUB_ID]);
		const subRow = rowById(subRows, SUB_ID);
		expect(subRow.identity).toEqual({ sourceKey: "bilibili", externalId: "12345" });
		expect(subRow).not.toHaveProperty("uid");
		expect(subRow).not.toHaveProperty("atAll");
		expect(subRow).not.toHaveProperty("atAllDefaults");
		expect(subRow.routing).not.toHaveProperty("wordcloud");
		expect(subRow.routing).not.toHaveProperty("liveSummary");
		expect((subRow.routing as Record<string, unknown>).liveEnd).toEqual([T1, T2]);
		expect(subRow.extras).toEqual({ atAllDynamic: { [T1]: true }, atAllLive: { [T2]: false } });
		expect((subRow.overrides as Record<string, unknown>).features).toEqual({
			liveEnd: true,
			extras: { wordcloud: true, atAllDynamic: true },
		});
		const extRow = rowById(subRows, EXT_SUB_ID);
		expect(extRow.identity).toEqual({ sourceKey: "douyin", externalId: "MS4wLjABAAAA-sec_uid" });
		expect(extRow).not.toHaveProperty("kind");
		expect(extRow).not.toHaveProperty("extensionId");
		expect(extRow).not.toHaveProperty("externalId");
		expect((extRow.overrides as Record<string, unknown>).features).toEqual({
			liveEnd: false,
			extras: { wordcloud: false },
		});

		// 配置仓开机读出来的也是最新的形状。
		const store = await sandbox.load();
		expect(store.getGlobals().defaults.features).toEqual(globalsOnDisk.defaults.features);
		const subs = store.getSubscriptions();
		expect(subs.map((s) => s.id).sort()).toEqual([SUB_ID, EXT_SUB_ID].sort());
		const sub = subs.find((s) => s.id === SUB_ID);
		expect(sub).toMatchObject({
			identity: { sourceKey: "bilibili", externalId: "12345" },
			// 下播目标 = 下播 ∪ 词云 ∪ 总结;老键不留。
			routing: { dynamic: [T1], live: [T1, T2], liveEnd: [T1, T2] },
			extras: {
				atAllDynamic: { [T1]: true },
				atAllLive: { [T2]: false },
				wordcloud: {},
				liveSummary: {},
			},
			overrides: { features: { liveEnd: true, extras: { wordcloud: true, atAllDynamic: true } } },
		});
		expect(Object.keys(sub?.routing ?? {}).sort()).toEqual([
			"dynamic",
			"live",
			"liveEnd",
			"liveGuardBuy",
			"specialDanmaku",
			"specialUserEnter",
			"superchat",
		]);
		expect(subs.find((s) => s.id === EXT_SUB_ID)).toMatchObject({
			identity: { sourceKey: "douyin", externalId: "MS4wLjABAAAA-sec_uid" },
			overrides: { features: { liveEnd: false, extras: { wordcloud: false } } },
		});
	});

	it("第二代的全局 features(liveEndExtras)只改名搬进 extras,下播开关不动", async () => {
		await placeConnectionsAndTargets();
		const original = JSON.stringify(globalsWithFeatures(GEN2_FEATURES));
		await sandbox.placeZeroText("state/globals.json", original);

		const report = await sandbox.migrate();

		expect(report.rewritten).toContain("config/globals.json");
		const onDisk = await sandbox.readConfig<{ defaults: { features: unknown } }>("globals.json");
		expect(onDisk.defaults.features).toEqual({
			dynamic: true,
			live: true,
			liveEnd: false,
			liveGuardBuy: false,
			superchat: false,
			specialDanmaku: false,
			specialUserEnter: false,
			extras: { atAllDynamic: false, atAllLive: true, wordcloud: false, liveSummary: true },
		});
		expect(await readFile(join(sandbox.zero, "state", "globals.json"), "utf8")).toBe(original);

		const store = await sandbox.load();
		expect(store.getGlobals().defaults.features).toEqual(onDisk.defaults.features);
	});

	it("已经是新形状的设置不改写(新代里还是搬过来的那个文件);订阅的新形状字段原样过去,只有身份收进 identity", async () => {
		await placeConnectionsAndTargets();
		const fresh = {
			id: SUB_ID,
			uid: "12345",
			name: "新UP",
			enabled: true,
			groups: [],
			routing: {
				dynamic: [],
				live: [T1],
				liveEnd: [T1],
				liveGuardBuy: [],
				superchat: [],
				specialDanmaku: [],
				specialUserEnter: [],
			},
			extras: { atAllDynamic: {}, atAllLive: { [T1]: true }, wordcloud: {}, liveSummary: {} },
			overrides: { features: { extras: { wordcloud: false } } },
			specialUsers: [],
		};
		await sandbox.placeZero("state/globals.json", makeDefaultGlobalConfig());
		await sandbox.placeZero("state/subscriptions.json", [fresh]);
		await sandbox.placeZero("state/extension-subscriptions.json", [
			{
				...LEGACY_EXTENSION_SUBSCRIPTION,
				overrides: { features: { extras: { wordcloud: false } } },
			},
		]);

		const report = await sandbox.migrate();

		expect(report.rewritten).not.toContain("config/globals.json");
		expect(
			await sameFile(
				join(sandbox.zero, "state", "globals.json"),
				sandbox.configPath("globals.json"),
			),
		).toBe(true);
		// 订阅:身份换了位置(0.x 的 uid / extensionId / externalId → identity)、退役的别名 `name` 丢掉,别的格一个都
		// 没被当老形状再改一遍。
		const { id: _freshId, uid: _uid, name: _name, ...freshRest } = fresh;
		const {
			id: _extId,
			kind: _kind,
			extensionId: _e,
			externalId: _x,
			...extRest
		} = LEGACY_EXTENSION_SUBSCRIPTION;
		expect(await sandbox.readConfig<Row[]>("subscriptions.json")).toEqual([
			{ id: SUB_ID, identity: { sourceKey: "bilibili", externalId: "12345" }, ...freshRest },
			{
				...extRest,
				id: EXT_SUB_ID,
				identity: { sourceKey: "douyin", externalId: "MS4wLjABAAAA-sec_uid" },
				overrides: { features: { extras: { wordcloud: false } } },
			},
		]);
		const store = await sandbox.load();
		expect(store.getSubscriptions().map((s) => s.id)).toEqual([SUB_ID, EXT_SUB_ID]);
	});
});
