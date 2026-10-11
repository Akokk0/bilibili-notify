/**
 * ConfigStore 与核心设置的逐格退默认:读盘时坏格隔离、落盘时原文放回、重存按比值判、密钥袋不被洗。
 *
 * 钉的是仓的行为(纯函数那半在 `core-settings.test.ts`):
 *   - 带坏格开机成功、坏格是默认值、别的格是盘上的值;没发生写时 core.json 逐字节不动
 *   - 发生过写时整份会被重新序列化,只能比那一格的 JSON 值
 *   - 「这次重存了那一格」按值判(新旧在被隔离那一格上比),不按补丁里有没有这个键
 *   - 密钥袋用真的 `SecretStore` 与真文件:被隔离的 `ai` 子格名下的旧袋键不被写入洗掉
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type BusEvents,
	type Disposable,
	type GlobalConfig,
	type MessageBus,
	makeDefaultGlobalConfig,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { createKeyProvider } from "@bilibili-notify/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { InvalidSettingEntry } from "../core-settings.js";
import type { BootstrapConfig } from "../schema.js";
import { createSecretStore, type SecretStore } from "../secret-store.js";
import { CORE_SETTINGS_FILE, type ConfigStore, createConfigStore } from "../store.js";

// biome-ignore lint/suspicious/noExplicitAny: 夹具按路径随手改盘上 JSON,不值得为它逐层写类型
type Json = Record<string, any>;

function makeBus(): MessageBus {
	const listeners = new Map<keyof BusEvents, Set<(...a: unknown[]) => void>>();
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
		signal: new AbortController().signal,
		track: vi.fn(),
	};
}

function bootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "info" };
}

let dataDir: string;
let corePath: string;
beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-store-invalid-"));
	corePath = join(dataDir, ...CORE_SETTINGS_FILE);
	await mkdir(dirname(corePath), { recursive: true });
});
afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

function mkSecretStore(): SecretStore {
	const logger = makeCtx().logger;
	return createSecretStore({
		filePath: join(dataDir, "secrets", "config-secrets.enc"),
		keyProvider: createKeyProvider({
			keyPath: join(dataDir, "secrets", "master.key"),
			saltPath: join(dataDir, "secrets", "kdf.salt"),
			logger,
		}),
		logger,
	});
}

interface MkOptions {
	secret?: SecretStore;
	onInvalid?: (entries: InvalidSettingEntry[]) => void;
}

function mkStore(opts: MkOptions = {}): ConfigStore {
	return createConfigStore({
		bootstrap: bootstrap(dataDir),
		dataRoot: dataDir,
		bus: makeBus(),
		serviceCtx: makeCtx(),
		secretStore: opts.secret,
		onInvalidSettingsChanged: opts.onInvalid,
	});
}

/** 一份盘上长相的核心设置,几格故意取非默认值:断言「别的格是盘上的值」才有分量。 */
function baseDisk(): Json {
	const disk = structuredClone(makeDefaultGlobalConfig()) as Json;
	disk.profileRefreshCron = "*/5 * * * *";
	disk.mutedUntil = 123;
	disk.defaults.imageGroup = { ...disk.defaults.imageGroup, enabled: false };
	disk.ai.dynamicPrompt = "自己写的提示词";
	return disk;
}

async function putDisk(disk: unknown): Promise<string> {
	const text = `${JSON.stringify(disk, null, 2)}\n`;
	await writeFile(corePath, text, "utf8");
	return text;
}

const readDisk = async (): Promise<Json> => JSON.parse(await readFile(corePath, "utf8"));

/** 按路径取值,取不到是 undefined。 */
function at(root: unknown, path: readonly string[]): unknown {
	let cur: unknown = root;
	for (const step of path) {
		if (typeof cur !== "object" || cur === null) return undefined;
		cur = (cur as Json)[step];
	}
	return cur;
}

const paths = (store: ConfigStore) => store.getInvalidSettings().map((e) => e.path);

/** 每类坏法:怎么弄坏、坏的是哪一路径、同一份里用来证明「别的格没动」的另一格。 */
const BAD_KINDS: Array<{
	name: string;
	path: string[];
	spoil: (disk: Json) => void;
	/** 与坏格同一父格下的另一格(两级路径才有),它必须仍是盘上的值。 */
	sibling?: { path: string[]; value: unknown };
	missing?: boolean;
}> = [
	{
		name: "顶层格类型错(history 是字符串)",
		path: ["history"],
		spoil: (d) => {
			d.history = "三十天";
		},
	},
	{
		name: "必填格缺了(logging)",
		path: ["logging"],
		spoil: (d) => {
			delete d.logging;
		},
		missing: true,
	},
	{
		name: "越界(history 的保留天数不在七档里)",
		path: ["history"],
		spoil: (d) => {
			d.history = { retentionDays: 45 };
		},
	},
	{
		name: "defaults.filters 坏",
		path: ["defaults", "filters"],
		spoil: (d) => {
			d.defaults.filters = { blockReposts: "是" };
		},
		sibling: { path: ["defaults", "imageGroup", "enabled"], value: false },
	},
	{
		name: "ai.providers 里一家的 provider 不认识",
		path: ["ai", "providers"],
		spoil: (d) => {
			d.ai.providers = { p1: { provider: "没这家" } };
		},
		sibling: { path: ["ai", "dynamicPrompt"], value: "自己写的提示词" },
	},
	{
		name: "ai 整格是字符串",
		path: ["ai"],
		spoil: (d) => {
			d.ai = "关掉";
		},
	},
	{
		name: "defaults 整格是数组",
		path: ["defaults"],
		spoil: (d) => {
			d.defaults = [1, 2];
		},
	},
];

describe("带坏格开机", () => {
	it.each(BAD_KINDS)(
		"$name:开机成功,那一格是默认值,别的格是盘上的值,core.json 逐字节不动",
		async (kind) => {
			const disk = baseDisk();
			kind.spoil(disk);
			const before = await putDisk(disk);

			const store = mkStore();
			await store.load();

			const settings = store.getGlobals();
			expect(at(settings, kind.path)).toEqual(at(makeDefaultGlobalConfig(), kind.path));
			expect(settings.profileRefreshCron).toBe("*/5 * * * *");
			expect(settings.mutedUntil).toBe(123);
			if (kind.sibling) expect(at(settings, kind.sibling.path)).toEqual(kind.sibling.value);

			const entries = store.getInvalidSettings();
			expect(entries.map((e) => e.path)).toEqual([kind.path]);
			expect(entries[0]?.issues.length).toBeGreaterThan(0);
			expect(entries[0]?.missing).toBe(kind.missing ?? false);

			expect(await readFile(corePath, "utf8")).toBe(before);
		},
	);

	it.each([
		["顶层是 null", "null"],
		["顶层是数组", "[]"],
		["半截 JSON", '{"history": '],
	])("信封坏(%s):load() 仍然抛", async (_name, text) => {
		await writeFile(corePath, text, "utf8");
		await expect(mkStore().load()).rejects.toThrow();
	});

	it("全好的一份:没有坏格", async () => {
		await putDisk(baseDisk());
		const store = mkStore();
		await store.load();
		expect(store.getInvalidSettings()).toEqual([]);
	});

	it("getInvalidSettings 交出去的是拷贝,改它不影响仓里的表", async () => {
		const disk = baseDisk();
		disk.history = "三十天";
		await putDisk(disk);
		const store = mkStore();
		await store.load();
		const copy = store.getInvalidSettings();
		copy[0]?.path.push("乱");
		copy.pop();
		expect(paths(store)).toEqual([["history"]]);
	});
});

describe("onInvalidSettingsChanged", () => {
	it("load() 末尾有坏格叫一次,带着条目", async () => {
		const disk = baseDisk();
		disk.history = "三十天";
		await putDisk(disk);
		const onInvalid = vi.fn();
		await mkStore({ onInvalid }).load();
		expect(onInvalid).toHaveBeenCalledTimes(1);
		expect(onInvalid.mock.calls[0]?.[0].map((e: InvalidSettingEntry) => e.path)).toEqual([
			["history"],
		]);
	});

	it("没有坏格不叫;写了别的格(条目表没变)也不叫", async () => {
		await putDisk(baseDisk());
		const onInvalid = vi.fn();
		const store = mkStore({ onInvalid });
		await store.load();
		await store.patchGlobals({ profileRefreshCron: "*/6 * * * *" });
		expect(onInvalid).not.toHaveBeenCalled();
	});

	it("重存坏格让表变了:写完叫一次,带着新表", async () => {
		const disk = baseDisk();
		disk.history = "三十天";
		await putDisk(disk);
		const onInvalid = vi.fn();
		const store = mkStore({ onInvalid });
		await store.load();
		onInvalid.mockClear();
		await store.patchGlobals({ history: { retentionDays: 7 } });
		expect(onInvalid).toHaveBeenCalledTimes(1);
		expect(onInvalid.mock.calls[0]?.[0]).toEqual([]);
	});
});

describe("落盘时放回原文", () => {
	it.each(BAD_KINDS)("$name:改别的格保存后,盘上那一格仍是原文,内存仍是默认值", async (kind) => {
		const disk = baseDisk();
		kind.spoil(disk);
		await putDisk(disk);
		const store = mkStore();
		await store.load();

		await store.patchGlobals({ profileRefreshCron: "*/9 * * * *" });

		const onDisk = await readDisk();
		expect(onDisk.profileRefreshCron).toBe("*/9 * * * *");
		if (kind.missing) expect(at(onDisk, kind.path)).toBeUndefined();
		else expect(at(onDisk, kind.path)).toEqual(at(disk, kind.path));
		expect(at(store.getGlobals(), kind.path)).toEqual(at(makeDefaultGlobalConfig(), kind.path));
		expect(paths(store)).toEqual([kind.path]);
	});

	it("规则页的真实补丁形状:补丁里带着坏格、值等于默认 → 原文仍在、条目仍在", async () => {
		const disk = baseDisk();
		disk.defaults.filters = { blockReposts: "是" };
		await putDisk(disk);
		const onInvalid = vi.fn();
		const store = mkStore({ onInvalid });
		await store.load();
		onInvalid.mockClear();

		// 规则页每次保存带 defaults 下的整格,没动过的也照发(`buildPatch` 不省略不变的)。
		const current = store.getGlobals();
		const patch = {
			defaults: {
				filters: current.defaults.filters,
				schedule: current.defaults.schedule,
				liveStart: current.defaults.liveStart,
				liveStreaming: current.defaults.liveStreaming,
				superchat: current.defaults.superchat,
				membership: current.defaults.membership,
			},
			profileRefreshCron: "*/9 * * * *",
		};
		await store.patchGlobals(patch);

		expect((await readDisk()).defaults.filters).toEqual({ blockReposts: "是" });
		expect(paths(store)).toEqual([["defaults", "filters"]]);
		expect(onInvalid).not.toHaveBeenCalled();
	});

	it("重存坏格(值不同):盘上是新值,条目没了", async () => {
		const disk = baseDisk();
		disk.history = "三十天";
		disk.defaults.filters = { blockReposts: "是" };
		await putDisk(disk);
		const store = mkStore();
		await store.load();

		await store.patchGlobals({
			history: { retentionDays: 7 },
			defaults: { filters: { blockKeywords: ["广告"] } },
		});

		const onDisk = await readDisk();
		expect(onDisk.history).toEqual({ retentionDays: 7 });
		expect(onDisk.defaults.filters.blockKeywords).toEqual(["广告"]);
		expect(store.getGlobals().history.retentionDays).toBe(7);
		expect(store.getInvalidSettings()).toEqual([]);
	});

	it("defaults 整格被隔离:比的是整格,改里面任何一个子格都算重存", async () => {
		const disk = baseDisk();
		disk.defaults = [1, 2];
		await putDisk(disk);
		const store = mkStore();
		await store.load();

		// 值等于默认(整格)→ 留着。
		await store.patchGlobals({ defaults: { imageGroup: store.getGlobals().defaults.imageGroup } });
		expect((await readDisk()).defaults).toEqual([1, 2]);
		expect(paths(store)).toEqual([["defaults"]]);

		// 改了一个子格 → 整格算重存。
		await store.patchGlobals({ defaults: { imageGroup: { enabled: false } } });
		expect((await readDisk()).defaults.imageGroup.enabled).toBe(false);
		expect(store.getInvalidSettings()).toEqual([]);
	});

	it("removeExtension 也经过放回:卸载一个拓展,别的坏格原文仍在", async () => {
		const disk = baseDisk();
		disk.history = "三十天";
		disk.extensions = { douyin: { enabled: true } };
		await putDisk(disk);
		const store = mkStore();
		await store.load();

		await store.removeExtension("douyin");

		const onDisk = await readDisk();
		expect(onDisk.extensions).toEqual({});
		expect(onDisk.history).toBe("三十天");
		expect(paths(store)).toEqual([["history"]]);
	});

	it("replaceSections 带了 globals:条目全清、不放回,盘上是给的那份(即便那一格等于默认)", async () => {
		const disk = baseDisk();
		disk.history = "三十天";
		await putDisk(disk);
		const onInvalid = vi.fn();
		const store = mkStore({ onInvalid });
		await store.load();
		onInvalid.mockClear();

		const restored: GlobalConfig = { ...store.getGlobals(), profileRefreshCron: "*/7 * * * *" };
		await store.replaceSections({ globals: restored });

		const onDisk = await readDisk();
		expect(onDisk.history).toEqual(makeDefaultGlobalConfig().history);
		expect(onDisk.profileRefreshCron).toBe("*/7 * * * *");
		expect(store.getInvalidSettings()).toEqual([]);
		expect(onInvalid).toHaveBeenCalledTimes(1);
		expect(onInvalid.mock.calls[0]?.[0]).toEqual([]);
	});
});

describe("落盘失败时什么都不变", () => {
	it("重存坏格时 core.json 写不动:条目表、内存、密钥袋都不变,通知不叫", async () => {
		const disk = baseDisk();
		disk.history = "三十天";
		await putDisk(disk);
		const secret = mkSecretStore();
		await secret.save({ aiApiKeys: { deepseek: "sk-keep" } });
		const onInvalid = vi.fn();
		const store = mkStore({ secret, onInvalid });
		await store.load();
		onInvalid.mockClear();
		const memBefore = store.getGlobals();
		const entriesBefore = store.getInvalidSettings();
		const bagBefore = await secret.load();

		// 把 core.json 占成目录,让落盘那一步必败。
		await rm(corePath);
		await mkdir(corePath);

		await expect(store.patchGlobals({ history: { retentionDays: 7 } })).rejects.toThrow();

		expect(store.getGlobals()).toEqual(memBefore);
		expect(store.getInvalidSettings()).toEqual(entriesBefore);
		expect(await secret.load()).toEqual(bagBefore);
		expect(onInvalid).not.toHaveBeenCalled();

		// 盘上没被换成别的:目录还在,换回原文件后新开一个仓,坏格还是同一格。
		await rm(corePath, { recursive: true });
		await putDisk(disk);
		const again = mkStore({ secret });
		await again.load();
		expect(paths(again)).toEqual([["history"]]);
	});
});

describe("密钥袋不被洗(真 SecretStore、真文件)", () => {
	/** 先用一个干净的仓把两家实例与两个搜索后端的 key 存进袋里,回盘上那份(key 已被抠成空串)。 */
	async function seedBag(secret: SecretStore): Promise<Json> {
		const store = mkStore({ secret });
		await store.load();
		await store.patchGlobals({
			ai: {
				activeProfile: "deepseek",
				providers: {
					deepseek: { provider: "deepseek", apiKey: "sk-ds", vision: { apiKey: "sk-ds-v" } },
					openrouter: { provider: "openrouter", apiKey: "sk-or" },
				},
				search: { keys: { bocha: "sk-bocha", tavily: "sk-tavily" } },
			},
		});
		expect((await secret.load()).aiApiKeys).toEqual({
			deepseek: "sk-ds",
			"deepseek:vision": "sk-ds-v",
			openrouter: "sk-or",
			"search:bocha": "sk-bocha",
			"search:tavily": "sk-tavily",
		});
		return readDisk();
	}

	it("ai.providers 被隔离:保存一格无关设置后,把那一格改对再开一个仓,实例的 key 还在,搜索的也在", async () => {
		const secret = mkSecretStore();
		const seeded = await seedBag(secret);

		const broken = structuredClone(seeded);
		broken.ai.providers = { ...seeded.ai.providers, extra: { provider: "没这家" } };
		await putDisk(broken);

		const store = mkStore({ secret });
		await store.load();
		expect(paths(store)).toEqual([["ai", "providers"]]);
		await store.patchGlobals({ profileRefreshCron: "*/9 * * * *" });
		expect((await readDisk()).ai.providers).toEqual(broken.ai.providers);

		// 把盘上那一格改对:另开一个仓。
		const fixed = await readDisk();
		fixed.ai.providers = seeded.ai.providers;
		await putDisk(fixed);
		const reopened = mkStore({ secret: mkSecretStore() });
		await reopened.load();

		expect(reopened.getInvalidSettings()).toEqual([]);
		const g = reopened.getGlobals();
		expect(g.ai.providers.deepseek?.apiKey).toBe("sk-ds");
		expect(g.ai.providers.deepseek?.vision.apiKey).toBe("sk-ds-v");
		expect(g.ai.providers.openrouter?.apiKey).toBe("sk-or");
		expect(g.ai.search.keys.bocha).toBe("sk-bocha");
	});

	it("ai.search 被隔离:搜索的 key 同理还在,实例的 key 照常跟着内存走", async () => {
		const secret = mkSecretStore();
		const seeded = await seedBag(secret);
		// 袋里再放一把 schema 里没有的搜索后端的 key(升降级留下的):被隔离那一格在内存里只有 schema 认得的两个
		// 槽,`applyAiSecrets` 灌不进它,不留的话重算一次就洗掉了。
		const seededBag = await secret.load();
		await secret.save({
			...seededBag,
			aiApiKeys: { ...seededBag.aiApiKeys, "search:future": "sk-future" },
		});

		const broken = structuredClone(seeded);
		broken.ai.search = "坏的";
		await putDisk(broken);

		const store = mkStore({ secret });
		await store.load();
		expect(paths(store)).toEqual([["ai", "search"]]);
		await store.patchGlobals({ profileRefreshCron: "*/9 * * * *" });
		expect((await readDisk()).ai.search).toBe("坏的");
		expect((await secret.load()).aiApiKeys?.["search:future"]).toBe("sk-future");

		const fixed = await readDisk();
		fixed.ai.search = seeded.ai.search;
		await putDisk(fixed);
		const reopened = mkStore({ secret: mkSecretStore() });
		await reopened.load();

		const g = reopened.getGlobals();
		expect(g.ai.search.keys.bocha).toBe("sk-bocha");
		expect(g.ai.search.keys.tavily).toBe("sk-tavily");
		expect(g.ai.providers.deepseek?.apiKey).toBe("sk-ds");
	});

	it("ai 整格被隔离:实例域与搜索域的键都留", async () => {
		const secret = mkSecretStore();
		const seeded = await seedBag(secret);

		const broken = structuredClone(seeded);
		broken.ai = "关掉";
		await putDisk(broken);

		const store = mkStore({ secret });
		await store.load();
		expect(paths(store)).toEqual([["ai"]]);
		await store.patchGlobals({ profileRefreshCron: "*/9 * * * *" });
		expect((await readDisk()).ai).toBe("关掉");
		expect((await secret.load()).aiApiKeys).toEqual({
			deepseek: "sk-ds",
			"deepseek:vision": "sk-ds-v",
			openrouter: "sk-or",
			"search:bocha": "sk-bocha",
			"search:tavily": "sk-tavily",
		});

		const fixed = await readDisk();
		fixed.ai = seeded.ai;
		await putDisk(fixed);
		const reopened = mkStore({ secret: mkSecretStore() });
		await reopened.load();
		expect(reopened.getGlobals().ai.providers.openrouter?.apiKey).toBe("sk-or");
		expect(reopened.getGlobals().ai.search.keys.tavily).toBe("sk-tavily");
	});

	it("重存了被隔离的那一格之后恢复整份重算:袋里对不上号的旧键跟着消失", async () => {
		const secret = mkSecretStore();
		const seeded = await seedBag(secret);
		const broken = structuredClone(seeded);
		broken.ai.providers = "坏的";
		await putDisk(broken);

		const store = mkStore({ secret });
		await store.load();
		await store.patchGlobals({
			ai: { activeProfile: "p2", providers: { p2: { provider: "openrouter", apiKey: "sk-new" } } },
		});

		expect(store.getInvalidSettings()).toEqual([]);
		expect((await secret.load()).aiApiKeys).toEqual({
			p2: "sk-new",
			"search:bocha": "sk-bocha",
			"search:tavily": "sk-tavily",
		});
	});

	it("好格里有明文 key、另一格坏着:开机后明文进袋、盘上那一格被抹、坏格原文还在", async () => {
		const secret = mkSecretStore();
		const disk = baseDisk();
		disk.history = "三十天";
		disk.ai.activeProfile = "deepseek";
		disk.ai.providers = { deepseek: { provider: "deepseek", apiKey: "sk-hand" } };
		await putDisk(disk);

		const store = mkStore({ secret });
		await store.load();

		expect(store.getGlobals().ai.providers.deepseek?.apiKey).toBe("sk-hand");
		expect((await secret.load()).aiApiKeys).toEqual({ deepseek: "sk-hand" });
		const onDisk = await readDisk();
		expect(onDisk.ai.providers.deepseek.apiKey).toBe("");
		expect(onDisk.history).toBe("三十天");
	});

	it("ai.providers 被隔离、另一个好格里有手写明文:开机上提时并进旧袋,被隔离那一格名下的旧 key 还在", async () => {
		const secret = mkSecretStore();
		const seeded = await seedBag(secret);
		const broken = structuredClone(seeded);
		broken.ai.providers = { ...seeded.ai.providers, extra: { provider: "没这家" } };
		// 好格 ai.search 里手写一把换过的明文(搜索后端的 key)。
		broken.ai.search.keys.bocha = "sk-bocha-hand";
		await putDisk(broken);

		const store = mkStore({ secret });
		await store.load();

		expect(paths(store)).toEqual([["ai", "providers"]]);
		expect((await secret.load()).aiApiKeys).toEqual({
			deepseek: "sk-ds",
			"deepseek:vision": "sk-ds-v",
			openrouter: "sk-or",
			"search:bocha": "sk-bocha-hand",
			"search:tavily": "sk-tavily",
		});
	});

	it("这是已定的行为:重存以新值为准。ai.providers 被隔离时经 patchSettings 重存这一格,袋里那一域的旧 key 没了、盘上只剩新写的;问题条目的话因此不许引主人这样做", async () => {
		const secret = mkSecretStore();
		const seeded = await seedBag(secret);
		const broken = structuredClone(seeded);
		broken.ai.providers = { ...seeded.ai.providers, extra: { provider: "没这家" } };
		await putDisk(broken);

		const store = mkStore({ secret });
		await store.load();
		expect(paths(store)).toEqual([["ai", "providers"]]);
		await store.patchSettings({
			core: {
				ai: {
					activeProfile: "p2",
					providers: { p2: { provider: "openrouter", apiKey: "sk-new" } },
				},
			},
		});

		const bag = (await secret.load()).aiApiKeys ?? {};
		expect(bag.deepseek).toBeUndefined();
		expect(bag["deepseek:vision"]).toBeUndefined();
		expect(bag.openrouter).toBeUndefined();
		expect(bag.p2).toBe("sk-new");
		expect(Object.keys((await readDisk()).ai.providers)).toEqual(["p2"]);
	});

	it("坏格原文里带明文 key:盘上原样、袋里没有它(钉现状,防止有人顺手上提)", async () => {
		const secret = mkSecretStore();
		const disk = baseDisk();
		disk.ai.providers = { deepseek: { provider: "deepseek", apiKey: "sk-in-bad-cell" }, x: 1 };
		const before = await putDisk(disk);

		const store = mkStore({ secret });
		await store.load();

		expect(paths(store)).toEqual([["ai", "providers"]]);
		expect(await readFile(corePath, "utf8")).toBe(before);
		expect((await secret.load()).aiApiKeys ?? {}).toEqual({});
	});
});
