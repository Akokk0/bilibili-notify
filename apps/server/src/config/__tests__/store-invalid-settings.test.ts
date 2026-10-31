/**
 * ConfigStore 与核心设置的逐格退默认:读盘时坏格隔离、落盘时原文放回、重存按比值判、密钥袋不被洗。
 *
 * 钉的是仓的行为(纯函数那半在 `core-settings.test.ts`):
 *   - 带坏格开机成功、坏格是默认值、别的格是盘上的值;没发生写时 core.json 逐字节不动
 *   - 发生过写时整份会被重新序列化,只能比那一格的 JSON 值
 *   - 「这次重存了那一格」按值判(新旧在被隔离那一格上比),不按补丁里有没有这个键
 *   - 密钥袋用真的 `SecretStore` 与真文件:被隔离的 `ai` 子格名下的旧袋键不被写入洗掉
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { z } from "zod";
import type { InvalidSettingEntry } from "../core-settings.js";
import type { BootstrapConfig } from "../schema.js";
import { createSecretStore, type SecretStore } from "../secret-store.js";
import {
	CORE_SETTINGS_FILE,
	type ConfigStore,
	createConfigStore,
	type IntegrationSettingsSegment,
	integrationSettingsFile,
} from "../store.js";
import { ConfigValidationError } from "../validation-error.js";

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
	onInvalid?: (entries: Pick<InvalidSettingEntry, "path" | "issues">[]) => void;
	integrations?: IntegrationSettingsSegment[];
}

function mkStore(opts: MkOptions = {}): ConfigStore {
	return createConfigStore({
		bootstrap: bootstrap(dataDir),
		dataRoot: dataDir,
		bus: makeBus(),
		serviceCtx: makeCtx(),
		secretStore: opts.secret,
		onInvalidSettingsChanged: opts.onInvalid,
		integrationSettings: opts.integrations,
	});
}

/** 只在这里用的一个小集成:同一发补丁里带它,用来看「拒收时它的文件没被碰」。 */
const pokeSegment: IntegrationSettingsSegment = {
	key: "poke",
	schema: z.object({ label: z.string().default("hello") }),
};
const pokeFile = () => join(dataDir, ...integrationSettingsFile("poke"));

/** 一份盘上长相的核心设置,几格故意取非默认值:断言「别的格是盘上的值」才有分量。 */
function baseDisk(): Json {
	const disk = structuredClone(makeDefaultGlobalConfig()) as Json;
	disk.profileRefreshCron = "*/5 * * * *";
	disk.mutedUntil = 123;
	disk.defaults.imageGroup = { ...disk.defaults.imageGroup, enabled: false };
	disk.ai.activePreset = "analyst";
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
		// 坏的一家放在表的中间:放回的位置、别家不受牵连都藏不住。
		name: "ai.providers 里一家的 provider 不认识",
		path: ["ai", "providers", "p1"],
		spoil: (d) => {
			d.ai.providers = {
				p0: { provider: "openrouter", model: "m0" },
				p1: { provider: "没这家" },
				p2: { provider: "deepseek", model: "m2" },
			};
		},
		sibling: { path: ["ai", "providers", "p2", "model"], value: "m2" },
	},
	{
		name: "ai.providers 表本身是数组",
		path: ["ai", "providers"],
		spoil: (d) => {
			d.ai.providers = [{ provider: "openrouter" }];
		},
		sibling: { path: ["ai", "activePreset"], value: "analyst" },
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
			if (entries[0]?.secret) expect(entries[0]).not.toHaveProperty("missing");
			else expect(entries[0]?.missing).toBe(kind.missing ?? false);

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
	it("projects public raw values but never a secret-bearing parent cell", async () => {
		const disk = baseDisk();
		disk.history = { retentionDays: 45, nested: [null, 7] };
		disk.ai.search = { keys: { bocha: "private-token", tavily: "" }, backend: 123 };
		const before = await putDisk(disk);
		const onInvalid = vi.fn();
		const store = mkStore({ onInvalid });
		await store.load();
		expect(store.getInvalidSettings()).toEqual([
			expect.objectContaining({
				path: ["history"],
				secret: false,
				raw: disk.history,
				missing: false,
			}),
			expect.objectContaining({ path: ["ai", "search"], secret: true }),
		]);
		const secret = store.getInvalidSettings().find((entry) => entry.path[0] === "ai");
		expect(secret).not.toHaveProperty("raw");
		expect(secret).not.toHaveProperty("missing");
		expect(JSON.stringify(secret)).not.toContain("private-token");
		expect(onInvalid.mock.calls[0]?.[0][0]).not.toHaveProperty("raw");
		expect(await readFile(corePath, "utf8")).toBe(before);
	});

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

	it("ai.providers 整张表被隔离(表是数组):保存一格无关设置后,把那一格改对再开一个仓,实例的 key 还在,搜索的也在", async () => {
		const secret = mkSecretStore();
		const seeded = await seedBag(secret);

		const broken = structuredClone(seeded);
		broken.ai.providers = [seeded.ai.providers];
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

	// N5:坏的一家(有主副两把袋键)在表中间,另一个好格里手写一把明文 → 开机上提并进旧袋,不重算,坏家的键还在。
	it("一家坏着、另一个好格里有手写明文:开机上提时并进旧袋,坏的那一家名下的两把旧 key 还在", async () => {
		const secret = mkSecretStore();
		const seeded = await seedThree(secret);
		const broken = structuredClone(seeded);
		broken.ai.providers.mid.model = 7;
		// 好格 ai.search 里手写一把换过的明文(搜索后端的 key)。
		broken.ai.search.keys.bocha = "sk-bocha-hand";
		await putDisk(broken);

		const store = mkStore({ secret });
		await store.load();

		expect(paths(store)).toEqual([["ai", "providers", "mid"]]);
		expect((await secret.load()).aiApiKeys).toEqual({
			...THREE_BAG,
			"search:bocha": "sk-bocha-hand",
		});
	});

	it("这是已定的行为:重存以新值为准。ai.providers 整张表被隔离时经 patchSettings 重存这一格,袋里那一域的旧 key 没了、盘上只剩新写的;问题条目的话因此不许引主人这样做", async () => {
		const secret = mkSecretStore();
		const seeded = await seedBag(secret);
		const broken = structuredClone(seeded);
		broken.ai.providers = [seeded.ai.providers];
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

	it("坏的那一家原文里带明文 key:盘上原样、袋里没有它(钉现状,防止有人顺手上提)", async () => {
		const secret = mkSecretStore();
		const disk = baseDisk();
		disk.ai.providers = {
			deepseek: { provider: "deepseek", apiKey: "sk-in-bad-cell", model: 1 },
		};
		const before = await putDisk(disk);

		const store = mkStore({ secret });
		await store.load();

		expect(paths(store)).toEqual([["ai", "providers", "deepseek"]]);
		expect(await readFile(corePath, "utf8")).toBe(before);
		expect((await secret.load()).aiApiKeys ?? {}).toEqual({});
	});

	it("坏的一家旁边的好的一家手写了明文:开机上提进袋、盘上那一家被抹,坏的那一家原文放回、一个字不变", async () => {
		const secret = mkSecretStore();
		const disk = baseDisk();
		disk.ai.providers = {
			good: { provider: "deepseek", apiKey: "sk-hand" },
			bad: { provider: "没这家", apiKey: "sk-in-bad-cell" },
		};
		await putDisk(disk);

		const store = mkStore({ secret });
		await store.load();

		expect(store.getGlobals().ai.providers.good?.apiKey).toBe("sk-hand");
		expect((await secret.load()).aiApiKeys).toEqual({ good: "sk-hand" });
		const onDisk = await readDisk();
		expect(onDisk.ai.providers.good.apiKey).toBe("");
		expect(onDisk.ai.providers.bad).toEqual({ provider: "没这家", apiKey: "sk-in-bad-cell" });
	});
});

// ---------------------------------------------------------------------------
// ai.providers 按每一家隔离:一家写坏只退那一家,别家与各自的密钥照常,坏的那家原文放回
// ---------------------------------------------------------------------------

const THREE_BAG = {
	first: "sk-first",
	mid: "sk-mid",
	"mid:vision": "sk-mid-v",
	last: "sk-last",
	"search:bocha": "sk-bocha",
};

/**
 * 三家实例,**中间**那家(mid)带主副两把 key:先用干净的仓存进真袋,回盘上那份(key 已抠成空串)。
 * 坏家放中间 + 坏家名下有袋键:放在表末或没有袋键时,键序与袋的毛病都藏得住(两种假绿)。
 */
async function seedThree(secret: SecretStore): Promise<Json> {
	const store = mkStore({ secret });
	await store.load();
	await store.patchGlobals({
		ai: {
			activeProfile: "first",
			providers: {
				first: { provider: "deepseek", model: "m-first", apiKey: "sk-first" },
				mid: {
					provider: "openrouter",
					model: "m-mid",
					apiKey: "sk-mid",
					vision: { apiKey: "sk-mid-v" },
				},
				last: { provider: "openrouter", model: "m-last", apiKey: "sk-last" },
			},
			search: { keys: { bocha: "sk-bocha" } },
		},
	});
	expect((await secret.load()).aiApiKeys).toEqual(THREE_BAG);
	const disk = await readDisk();
	expect(Object.keys(disk.ai.providers)).toEqual(["first", "mid", "last"]);
	return disk;
}

/** 把 mid 弄坏(`model` 是数字)并落盘,回弄坏后的盘上那份。 */
async function breakMid(seeded: Json): Promise<Json> {
	const broken = structuredClone(seeded);
	broken.ai.providers.mid.model = 7;
	broken.extensions = { douyin: { enabled: true } };
	await putDisk(broken);
	return broken;
}

const MID_PATH = ["ai", "providers", "mid"];

/** 逐个写口:坏的 mid 在表中间,做一次写之后盘上那一家一个字不变。`changesLast` 是这次写动了 last。 */
const WRITE_PORTS: Array<{
	name: string;
	changesLast: boolean;
	act: (store: ConfigStore) => Promise<unknown>;
}> = [
	{
		name: "patchGlobals 改静音",
		changesLast: false,
		act: (s) => s.patchGlobals({ mutedUntil: 999 }),
	},
	{
		name: "patchSettings 的核心补丁",
		changesLast: false,
		act: (s) => s.patchSettings({ core: { mutedUntil: 5 } }),
	},
	{
		name: "面板那种整段 ai 补丁(整段带着别家)",
		changesLast: true,
		act: (s) => {
			const ai = structuredClone(s.getGlobals().ai) as Json;
			ai.providers.last.model = "changed";
			return s.patchGlobals({ ai } as never);
		},
	},
	{
		name: "updateGlobals",
		changesLast: true,
		act: (s) =>
			s.updateGlobals((g) => {
				(g as unknown as Json).ai.providers.last.model = "changed";
				return g;
			}),
	},
	{
		name: "setGlobals",
		changesLast: true,
		act: (s) => {
			const g = structuredClone(s.getGlobals());
			(g as unknown as Json).ai.providers.last.model = "changed";
			return s.setGlobals(g);
		},
	},
	{ name: "removeExtension", changesLast: false, act: (s) => s.removeExtension("douyin") },
];

describe("ai.providers 一家坏只隔离那一家", () => {
	// N3
	it.each(WRITE_PORTS)(
		"$name:坏的 mid 在表中间,盘上那一家仍是原文,别家是新值,条目仍在",
		async ({ act, changesLast }) => {
			const secret = mkSecretStore();
			const broken = await breakMid(await seedThree(secret));
			const store = mkStore({ secret });
			await store.load();
			expect(paths(store)).toEqual([MID_PATH]);

			await act(store);

			const onDisk = await readDisk();
			expect(onDisk.ai.providers.mid).toEqual(broken.ai.providers.mid);
			expect(onDisk.ai.providers.first.model).toBe("m-first");
			expect(onDisk.ai.providers.last.model).toBe(changesLast ? "changed" : "m-last");
			expect(paths(store)).toEqual([MID_PATH]);
			expect(Object.keys(store.getGlobals().ai.providers)).toEqual(["first", "last"]);
			// 密钥照常:明文没落盘,袋里三家都在。
			expect(onDisk.ai.providers.first.apiKey).toBe("");
			expect((await secret.load()).aiApiKeys).toEqual(THREE_BAG);
		},
	);

	it("开机抹明文也经过放回:好的一家手写明文被抹,坏的 mid 原文一个字不变", async () => {
		const secret = mkSecretStore();
		const broken = await breakMid(await seedThree(secret));
		broken.ai.providers.first.apiKey = "sk-first-hand";
		await putDisk(broken);

		const store = mkStore({ secret });
		await store.load();

		const onDisk = await readDisk();
		expect(onDisk.ai.providers.first.apiKey).toBe("");
		expect(onDisk.ai.providers.mid).toEqual(broken.ai.providers.mid);
		expect((await secret.load()).aiApiKeys).toEqual({ ...THREE_BAG, first: "sk-first-hand" });
	});

	// N4:坏家名下的主副两把键,在各种写之后都在;改对重启回得来。
	it("坏的 mid 名下的主副两把 key:保存别的页、保存别家之后都在,把它改对再开一个仓,两把都回来", async () => {
		const secret = mkSecretStore();
		const seeded = await seedThree(secret);
		const broken = await breakMid(seeded);

		const store = mkStore({ secret });
		await store.load();
		await store.patchGlobals({ profileRefreshCron: "*/9 * * * *" });
		expect((await secret.load()).aiApiKeys).toEqual(THREE_BAG);
		await store.patchGlobals({ ai: { providers: { last: { model: "again" } } } });
		expect((await secret.load()).aiApiKeys).toEqual(THREE_BAG);

		const fixed = await readDisk();
		expect(fixed.ai.providers.mid).toEqual(broken.ai.providers.mid);
		fixed.ai.providers.mid.model = "m-mid";
		await putDisk(fixed);
		const reopened = mkStore({ secret: mkSecretStore() });
		await reopened.load();

		expect(reopened.getInvalidSettings()).toEqual([]);
		const g = reopened.getGlobals();
		expect(g.ai.providers.mid?.apiKey).toBe("sk-mid");
		expect(g.ai.providers.mid?.vision.apiKey).toBe("sk-mid-v");
		expect(g.ai.providers.first?.apiKey).toBe("sk-first");
		expect(g.ai.providers.last?.model).toBe("again");
	});

	// N6:这条是「isolatedSecrets 按路径长度分档」的守卫 —— 只改解析不改袋,别的测试照样全绿。
	it("一家坏着,在面板删掉另一家好的:被删那家的袋键没了,坏家的还在", async () => {
		const secret = mkSecretStore();
		await breakMid(await seedThree(secret));
		const store = mkStore({ secret });
		await store.load();

		await store.patchSettings({ core: { ai: { providers: { last: null } } } as never });

		expect(Object.keys(store.getGlobals().ai.providers)).toEqual(["first"]);
		const { last: _gone, ...rest } = THREE_BAG;
		expect((await secret.load()).aiApiKeys).toEqual(rest);
		expect(paths(store)).toEqual([MID_PATH]);
	});

	// N7
	it("一家坏着,写别的格、保存别家:不通知,条目表不变", async () => {
		const secret = mkSecretStore();
		await breakMid(await seedThree(secret));
		const onInvalid = vi.fn();
		const store = mkStore({ secret, onInvalid });
		await store.load();
		onInvalid.mockClear();
		const before = store.getInvalidSettings();

		await store.patchGlobals({ mutedUntil: 1 });
		await store.patchGlobals({ ai: { providers: { last: { model: "x" } } } });

		expect(onInvalid).not.toHaveBeenCalled();
		expect(store.getInvalidSettings()).toEqual(before);
	});

	// N8
	it("一家坏着、core.json 写不动:盘、内存、条目表、袋都不变,通知不叫", async () => {
		const secret = mkSecretStore();
		const seeded = await seedThree(secret);
		await breakMid(seeded);
		const onInvalid = vi.fn();
		const store = mkStore({ secret, onInvalid });
		await store.load();
		onInvalid.mockClear();
		const memBefore = store.getGlobals();
		const entriesBefore = store.getInvalidSettings();
		const bagBefore = await secret.load();

		await rm(corePath);
		await mkdir(corePath);

		await expect(
			store.patchGlobals({ ai: { providers: { last: { model: "x" } } } }),
		).rejects.toThrow();

		expect(store.getGlobals()).toEqual(memBefore);
		expect(store.getInvalidSettings()).toEqual(entriesBefore);
		expect(await secret.load()).toEqual(bagBefore);
		expect(onInvalid).not.toHaveBeenCalled();
	});

	// N10:恢复备份以给的这份为准,本机坏的那一家的原文与袋键一起没了(已定)。
	it("一家坏着时恢复备份:条目清空、盘上是备份那份、坏家的袋键没了", async () => {
		const secret = mkSecretStore();
		await breakMid(await seedThree(secret));
		const store = mkStore({ secret });
		await store.load();

		const restored = structuredClone(store.getGlobals());
		(restored as unknown as Json).ai.providers.last.model = "from-backup";
		await store.replaceSections({ globals: restored });

		expect(store.getInvalidSettings()).toEqual([]);
		const onDisk = await readDisk();
		expect(Object.keys(onDisk.ai.providers)).toEqual(["first", "last"]);
		expect(onDisk.ai.providers.last.model).toBe("from-backup");
		const { mid: _m, "mid:vision": _mv, ...rest } = THREE_BAG;
		expect((await secret.load()).aiApiKeys).toEqual(rest);
	});

	// N11:面板新加一家,id 撞上坏着的那一家 → 这次保存拒收,写任何东西之前。
	describe("新加的一家 id 撞上坏着的那一家", () => {
		async function setup() {
			const secret = mkSecretStore();
			await breakMid(await seedThree(secret));
			const onInvalid = vi.fn();
			const store = mkStore({ secret, onInvalid, integrations: [pokeSegment] });
			await store.load();
			onInvalid.mockClear();
			return { secret, store, onInvalid };
		}

		it("patchSettings:抛 ConfigValidationError,路径挂在这一家上;盘、内存、袋、条目表都没变,同一发里的集成文件没被碰", async () => {
			const { secret, store, onInvalid } = await setup();
			const diskBefore = await readFile(corePath, "utf8");
			const pokeBefore = await stat(pokeFile());
			const memBefore = store.getGlobals();
			const entriesBefore = store.getInvalidSettings();
			const bagBefore = await secret.load();

			const err = await store
				.patchSettings({
					core: { ai: { providers: { mid: { provider: "deepseek" } } } } as never,
					integrations: { poke: { label: "changed" } },
				})
				.catch((e: unknown) => e);

			expect(err).toBeInstanceOf(ConfigValidationError);
			const e = err as ConfigValidationError;
			expect(e.code).toBe("invalid");
			expect(e.issues.map((i) => i.path)).toEqual([MID_PATH]);
			expect(e.issues[0]?.message).toContain("mid");
			expect(await readFile(corePath, "utf8")).toBe(diskBefore);
			expect(store.getGlobals()).toEqual(memBefore);
			expect(store.getInvalidSettings()).toEqual(entriesBefore);
			expect(await secret.load()).toEqual(bagBefore);
			expect(onInvalid).not.toHaveBeenCalled();
			// 集成的文件连「写了又退回」都没有:同一个 inode、同一个修改时间。
			const pokeAfter = await stat(pokeFile());
			expect(pokeAfter.ino).toBe(pokeBefore.ino);
			expect(pokeAfter.mtimeMs).toBe(pokeBefore.mtimeMs);
			expect(JSON.parse(await readFile(pokeFile(), "utf8")).label).toBe("hello");
		});

		it("updateGlobals 与 setGlobals 同样拒收,什么都没写", async () => {
			const { secret, store } = await setup();
			const diskBefore = await readFile(corePath, "utf8");
			const bagBefore = await secret.load();
			const withMid = (g: GlobalConfig): GlobalConfig => {
				const next = structuredClone(g) as unknown as Json;
				next.ai.providers.mid = { provider: "deepseek" };
				return next as unknown as GlobalConfig;
			};

			await expect(store.updateGlobals((g) => withMid(g))).rejects.toBeInstanceOf(
				ConfigValidationError,
			);
			await expect(store.setGlobals(withMid(store.getGlobals()))).rejects.toBeInstanceOf(
				ConfigValidationError,
			);

			expect(await readFile(corePath, "utf8")).toBe(diskBefore);
			expect(await secret.load()).toEqual(bagBefore);
			expect(paths(store)).toEqual([MID_PATH]);
		});

		it("id 不同的新一家照常存进去,坏的那一家原文仍在", async () => {
			const { store } = await setup();
			await store.patchGlobals({ ai: { providers: { mid2: { provider: "deepseek" } } } });
			const onDisk = await readDisk();
			expect(Object.keys(onDisk.ai.providers).sort()).toEqual(["first", "last", "mid", "mid2"]);
			expect(onDisk.ai.providers.mid.model).toBe(7);
			expect(paths(store)).toEqual([MID_PATH]);
		});
	});

	// 题 2:保存补丁里带 __proto__ 键仍静默丢(zod 在把键交给规则之前就跳过它),这一片不做。这里钉两件事:
	// deepMerge 遇到补丁自己的 __proto__ 键不会把表的原型换掉,盘上坏的那一家(键叫 __proto__)写别的格后仍在。
	// N12(仓这一半)
	it("盘上有一家键叫 __proto__:记成坏格,写别的格后盘上那一家还在、内容不变", async () => {
		const disk = baseDisk();
		disk.ai.providers = JSON.parse(
			'{"good":{"provider":"deepseek","model":"mg"},"__proto__":{"provider":"deepseek","model":"evil"}}',
		);
		await putDisk(disk);
		const store = mkStore();
		await store.load();
		expect(paths(store)).toEqual([["ai", "providers", "__proto__"]]);
		expect(Object.keys(store.getGlobals().ai.providers)).toEqual(["good"]);
		expect(Object.getPrototypeOf(store.getGlobals().ai.providers)).toBe(Object.prototype);

		await store.patchGlobals({ mutedUntil: 77 });
		await store.patchGlobals({ ai: { providers: { good: { model: "mg2" } } } });

		const text = await readFile(corePath, "utf8");
		const onDisk = JSON.parse(text);
		expect(Object.hasOwn(onDisk.ai.providers, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(onDisk.ai.providers, "__proto__")?.value).toEqual({
			provider: "deepseek",
			model: "evil",
		});
		expect(onDisk.ai.providers.good.model).toBe("mg2");
		expect(Object.getPrototypeOf(store.getGlobals().ai.providers)).toBe(Object.prototype);
		expect(paths(store)).toEqual([["ai", "providers", "__proto__"]]);
	});

	it("补丁里带自己的 __proto__ 键:不换掉表的原型,也不触发拒收(那一键静默丢,这一片不处理)", async () => {
		await putDisk(baseDisk());
		const store = mkStore();
		await store.load();
		const patch = JSON.parse(
			'{"ai":{"providers":{"__proto__":{"provider":"deepseek","model":"evil"},"ok":{"provider":"deepseek"}}}}',
		);
		await store.patchGlobals(patch);
		const providers = store.getGlobals().ai.providers;
		expect(Object.getPrototypeOf(providers)).toBe(Object.prototype);
		expect(Object.keys(providers)).toEqual(["ok"]);
	});
});

// ---------------------------------------------------------------------------
// 题 4 的前提:`ai` 的其余子格坏着时,到面板重存那一格不碰密钥;`ai.search` 则不然(留在「别在面板上改」)
// ---------------------------------------------------------------------------

describe("ai 的子格坏着、到面板重存(真 SecretStore、真文件)", () => {
	const SEEDED_BAG = {
		deepseek: "sk-ds",
		"deepseek:vision": "sk-ds-v",
		openrouter: "sk-or",
		"search:bocha": "sk-bocha",
		"search:tavily": "sk-tavily",
	};

	/** 每一格:怎么弄坏、面板重存时发的合法新值(要与内存里的默认值不同,才算「重存了那一格」)。 */
	const OTHER_CELLS: Array<[cell: string, broken: unknown, fixed: () => unknown]> = [
		["enabled", "开", () => !makeDefaultGlobalConfig().ai.enabled],
		["removedBuiltinPresets", "坏的", () => ["genki"]],
		["activeProfile", 5, () => "openrouter"],
		["activePreset", 5, () => "some-preset"],
		[
			"presets",
			"坏的",
			() => [
				{
					id: "mine",
					label: "我的",
					persona: {
						name: "阿绫",
						addressUser: "老板",
						addressSelf: "我",
						traits: "",
						catchphrase: "",
						baseRole: "",
						extraSystemPrompt: "",
					},
				},
			],
		],
		["chat", "坏的", () => ({ thinkingLevel: "high" })],
	];

	async function seed(secret: SecretStore): Promise<Json> {
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
		expect((await secret.load()).aiApiKeys).toEqual(SEEDED_BAG);
		return readDisk();
	}

	it.each(OTHER_CELLS)(
		"ai.%s 坏着:面板整段 ai 重存那一格,问题清掉,袋里实例域与搜索域的键一把不少",
		async (cell, broken, fixed) => {
			const secret = mkSecretStore();
			const disk = await seed(secret);
			disk.ai[cell] = broken;
			await putDisk(disk);
			const store = mkStore({ secret });
			await store.load();
			expect(paths(store)).toEqual([["ai", cell]]);

			// 面板发的是整段 ai(带着别的页的内容),把这一格换成合法新值。
			const ai = structuredClone(store.getGlobals().ai) as Json;
			ai[cell] = fixed();
			await store.patchSettings({ core: { ai } as never });

			expect(store.getInvalidSettings()).toEqual([]);
			expect((await secret.load()).aiApiKeys).toEqual(SEEDED_BAG);
			expect((await readDisk()).ai[cell]).toEqual(fixed());
			const reopened = mkStore({ secret: mkSecretStore() });
			await reopened.load();
			expect(reopened.getGlobals().ai.providers.deepseek?.apiKey).toBe("sk-ds");
			expect(reopened.getGlobals().ai.search.keys.tavily).toBe("sk-tavily");
		},
	);

	it("ai.search 坏着:面板重存它,袋里搜索域与实例域的键还在,但盘上原文里手写的明文 key 没了(所以它仍留在「别在面板上改」)", async () => {
		const secret = mkSecretStore();
		const disk = await seed(secret);
		disk.ai.search = { backend: "没这个后端", keys: { bocha: "sk-hand-bocha" } };
		await putDisk(disk);
		const store = mkStore({ secret });
		await store.load();
		expect(paths(store)).toEqual([["ai", "search"]]);
		// 坏着时那把手写的明文在盘上、没进袋。
		expect(await readFile(corePath, "utf8")).toContain("sk-hand-bocha");

		const ai = structuredClone(store.getGlobals().ai) as Json;
		ai.search.backend = "tavily";
		await store.patchSettings({ core: { ai } as never });

		expect(store.getInvalidSettings()).toEqual([]);
		expect((await secret.load()).aiApiKeys).toEqual(SEEDED_BAG);
		expect(await readFile(corePath, "utf8")).not.toContain("sk-hand-bocha");
	});
});

// ---------------------------------------------------------------------------
// 实例 id 本身以 `search:` 开头:袋键长得像搜索域,但先问是不是坏家名下的,再分域
// ---------------------------------------------------------------------------

describe("实例 id 以 search: 开头", () => {
	const MINE_BAG = {
		"search:mine": "sk-mine",
		"search:mine:vision": "sk-mine-v",
		ok: "sk-ok",
		"search:bocha": "sk-bocha",
	};

	async function seedMine(secret: SecretStore): Promise<Json> {
		const store = mkStore({ secret });
		await store.load();
		await store.patchGlobals({
			ai: {
				activeProfile: "ok",
				providers: {
					"search:mine": {
						provider: "deepseek",
						model: "m-mine",
						apiKey: "sk-mine",
						vision: { apiKey: "sk-mine-v" },
					},
					ok: { provider: "openrouter", model: "m-ok", apiKey: "sk-ok" },
				},
				search: { keys: { bocha: "sk-bocha" } },
			},
		});
		expect((await secret.load()).aiApiKeys).toEqual(MINE_BAG);
		return readDisk();
	}

	it("这一家坏着:写一次别的设置,它的主副两把 key 还在;改对重启后回来", async () => {
		const secret = mkSecretStore();
		const seeded = await seedMine(secret);
		seeded.ai.providers["search:mine"].model = 7;
		await putDisk(seeded);

		const store = mkStore({ secret });
		await store.load();
		expect(paths(store)).toEqual([["ai", "providers", "search:mine"]]);
		await store.patchGlobals({ mutedUntil: 5 });

		expect((await secret.load()).aiApiKeys).toEqual(MINE_BAG);

		const fixed = await readDisk();
		fixed.ai.providers["search:mine"].model = "m-mine";
		await putDisk(fixed);
		const reopened = mkStore({ secret: mkSecretStore() });
		await reopened.load();
		expect(reopened.getInvalidSettings()).toEqual([]);
		const g = reopened.getGlobals();
		expect(g.ai.providers["search:mine"]?.apiKey).toBe("sk-mine");
		expect(g.ai.providers["search:mine"]?.vision.apiKey).toBe("sk-mine-v");
	});

	it("没有哪一家坏着时,搜索域自己的键仍按搜索域走:只有 ai.search 坏着才留下内存里没有的搜索键", async () => {
		const secret = mkSecretStore();
		const seeded = await seedMine(secret);
		await secret.save({ aiApiKeys: { ...MINE_BAG, "search:stale": "sk-stale" } });

		// 没有任何坏格:内存里没有的 search:stale 写一次就洗掉了。
		const clean = mkStore({ secret });
		await clean.load();
		await clean.patchGlobals({ mutedUntil: 5 });
		expect((await secret.load()).aiApiKeys).toEqual(MINE_BAG);

		// ai.search 坏着、没有哪一家坏着:搜索域整域留下,不因为有 search: 开头的实例而变。
		await secret.save({ aiApiKeys: { ...MINE_BAG, "search:stale": "sk-stale" } });
		seeded.ai.search = { backend: "没这个后端", keys: {} };
		await putDisk(seeded);
		const broken = mkStore({ secret });
		await broken.load();
		expect(paths(broken)).toEqual([["ai", "search"]]);
		await broken.patchGlobals({ mutedUntil: 6 });
		expect((await secret.load()).aiApiKeys).toEqual({ ...MINE_BAG, "search:stale": "sk-stale" });
	});
});

describe("search scene rename preserves the raw ledger and search secrets", () => {
	it("keeps invalid search through normal writes and preserves explicit restore replacement", async () => {
		const secret = mkSecretStore();
		await secret.save({ aiApiKeys: { "search:bocha": "bag-b", "search:tavily": "bag-t" } });
		const disk = baseDisk();
		disk.ai.search = {
			backend: "tavily",
			keys: { bocha: "raw-private-b", tavily: "raw-private-t" },
			scenes: { post: null, live: true, roast: false },
		};
		await putDisk(disk);
		const store = mkStore({ secret });
		await store.load();
		const bag = await secret.load();
		expect(store.getGlobals().ai.search.scenes).toEqual({ post: false, live: false, roast: false });
		expect(store.getInvalidSettings()).toEqual([
			expect.objectContaining({ path: ["ai", "search"], secret: true }),
		]);
		const view = store.getInvalidSettings()[0];
		expect(view).not.toHaveProperty("raw");
		expect(view).not.toHaveProperty("missing");
		expect(JSON.stringify(view)).not.toContain("raw-private");
		await store.patchGlobals({ history: { retentionDays: 7 } });
		expect((await readDisk()).ai.search).toEqual(disk.ai.search);
		await store.setGlobals({ ...store.getGlobals(), timezone: "UTC" });
		expect((await readDisk()).ai.search).toEqual(disk.ai.search);
		await store.replaceSections({ subscriptions: store.getSubscriptions() });
		expect((await readDisk()).ai.search).toEqual(disk.ai.search);
		expect(await secret.load()).toEqual(bag);
		// Explicit globals restoration is a replacement, unlike a normal settings save.
		await store.replaceSections({
			globals: { ...store.getGlobals(), profileRefreshCron: "*/6 * * * *" },
		});
		expect(store.getInvalidSettings()).toEqual([]);
		expect((await readDisk()).ai.search).toEqual({
			backend: "bocha",
			keys: { bocha: "", tavily: "" },
			scenes: { post: false, live: false, roast: false },
		});
	});
	it.each(["full", "sanitized"] as const)(
		"restores %s scene switches with real ConfigStore and encrypted secrets",
		async (kind) => {
			const { createBackupService } = await import("../../backup/service.js");
			const { fakeIntegrationSecrets } = await import(
				"../../__tests__/support/backup-integration-secrets.js"
			);
			const secret = mkSecretStore();
			const store = mkStore({ secret });
			await store.load();
			await store.patchGlobals({
				ai: {
					search: {
						backend: "tavily",
						keys: { bocha: "private-search-bocha", tavily: "private-search-tavily" },
						scenes: { post: true, live: false, roast: true },
					},
				},
			});
			const service = createBackupService({
				configStore: store,
				integrationSecrets: fakeIntegrationSecrets(),
			});
			const env = await service.exportBackup({ kind, pin: "123456" });
			expect(env.schemaVersion).toBe(23);
			expect(env.sections.globals?.ai.search.scenes).toEqual({
				post: true,
				live: false,
				roast: true,
			});
			expect(JSON.stringify(env.sections)).not.toContain("private-search");
			await store.patchGlobals({
				ai: {
					search: {
						keys: { bocha: "changed-b", tavily: "changed-t" },
						scenes: { post: false, live: true, roast: false },
					},
				},
			});
			await service.importBackup({ envelope: env, pin: "123456", mode: "overwrite" });
			expect(store.getGlobals().ai.search.scenes).toEqual({ post: true, live: false, roast: true });
			expect(store.getGlobals().ai.search.keys).toEqual(
				kind === "full"
					? { bocha: "private-search-bocha", tavily: "private-search-tavily" }
					: { bocha: "", tavily: "" },
			);
			const reopened = mkStore({ secret: mkSecretStore() });
			await reopened.load();
			expect(reopened.getGlobals().ai.search).toEqual(store.getGlobals().ai.search);
		},
	);
});
