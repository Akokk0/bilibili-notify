/**
 * 0.x 全局设置里剩下的老形状 → 最新形状:兼容逻辑住在迁移器里(`migration/ai.ts`、`link-parsing.ts`、`templates.ts`,
 * 由 `settings.ts` 组合),这一份是走接缝的那一头 —— 每个迁移函数各自的判定见 `./settings.test.ts`。
 * 推送特性那一项在 `./zero-generation-features.test.ts`。
 *
 * 接缝是「第 0 代 → `migrateZeroGeneration` → 新的一代上配置仓开机」:在临时的第 0 代里摆 0.x 的
 * `state/globals.json`(扁平的 AI 连接字段、历代旧默认模板、0.9.1 的链接解析范围 + 白名单……),迁一代,再在新代上开配置仓。
 * 摆放与开机的辅助见 `./support.ts`。
 *
 * 这批用例原先住在配置仓的测试里(`config-store.test.ts` 的模板迁移三条、`secret-store.test.ts` 的明文 apiKey 抬进加密袋),
 * 当时老数据的兜底挂在配置仓开机上。兜底搬到迁移器(配置仓里那块随后删掉)以后它们跟着搬过来,
 * **读出来的值与写回盘上的值,期望一个字没改**。
 *
 * 钉三件事:
 * - **迁移器自己把活干完了**:每条都在 `migrate()` 之后、`load()` 之前先读新代 `config/settings/core.json` 这个文件本身 ——
 *   盘上这份是配置仓开机唯一认的形状,文件没迁好,开机读出来的就是老值(或直接拒收),失败的地方不好认,
 *   所以先直接看盘上这份;
 * - 配置仓开机读出来的值(原用例断言的东西);
 * - 第 0 代那份逐字节没变(迁移写的是新代里的文件),`rewritten` 里有 `config/settings/core.json`;已经是新形状的不改写。
 *
 * 另有一组「全新安装」的用例不经迁移器:空的数据根上开机,人格指针指着第一份内置预设。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { builtinPresetsFor } from "@bilibili-notify/internal/builtin-texts";
import { DEFAULT_LOCALE } from "@bilibili-notify/internal/i18n";
import { createKeyProvider } from "@bilibili-notify/storage";
import { describe, expect, it } from "vite-plus/test";
import type { BiliSettings } from "../../bilibili/settings.js";
import { createSecretStore } from "../../config/secret-store.js";
import { type ConfigStore, createConfigStore } from "../../config/store.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { makeServiceCtx, useZeroSandbox, type ZeroSandbox } from "./support.js";
import { makeZeroGlobals, withoutZeroBilibiliApp } from "./zero-fixtures.js";

const FACTORY_PRESETS = builtinPresetsFor(DEFAULT_LOCALE);

/** 仓里内存那一份 B 站设置。 */
const bili = (store: ConfigStore) => store.getAllIntegrationSettings().bilibili as BiliSettings;

const GROUP_ID = "22222222-2222-4222-8222-222222222222";

/** 新代 `config/settings/core.json` 里模板这一格读出来的形状(上舰文案是 `membership.guard`,㉓d)。 */
type DiskTemplates = Record<string, unknown> & {
	membership: {
		guard: { enabled: boolean; default: { template: string; imageUrl: string }; tiers: Obj };
	};
};
type Obj = Record<string, unknown>;
interface DiskGlobals {
	defaults: { templates: DiskTemplates };
	/** AI 设置在核心设置的顶层(3a-38 ④);`defaults` 里不再有。 */
	ai: Record<string, unknown>;
	linkPreview: Record<string, unknown>;
}

/** 两个路径的内容是不是逐字节一样 —— 没被改写过的文件,新代里是从第 0 代原样复制过来的那一份。 */
async function sameBytes(a: string, b: string): Promise<boolean> {
	return (await readFile(a)).equals(await readFile(b));
}

/** 第 0 代的 `state/globals.json` 逐字节没变。 */
async function expectZeroGlobalsUntouched(sandbox: ZeroSandbox, original: string): Promise<void> {
	expect(await readFile(join(sandbox.zero, "state", "globals.json"), "utf8")).toBe(original);
}

// ── B 站的两格搬进它自己的设置文件,自定义 UA 丢掉(ADR-0021 决策 42 下 10-01 的 🔗、ADR-0025 决策 7)──────

describe("0.x 设置里 B 站的格 → settings/bilibili.json(userAgent 丢掉)", () => {
	const sandbox = useZeroSandbox("bn-bilibili-settings-");

	/** 一份 0.x 的设置,`app` 里带着给出的几格。 */
	function oldGlobalsWithApp(app: Record<string, unknown>): string {
		// 从「B 站那几格一格都没写过」起步、只带上给出的几格(0.12 出厂的 `app` 里其实是有 dynamicCron / healthCheckMinutes 的)。
		const old = withoutZeroBilibiliApp(makeZeroGlobals());
		old.app = { ...old.app, ...app };
		return JSON.stringify(old);
	}

	it("dynamicCron / healthCheckMinutes 原样搬进 settings/bilibili.json,键名不改;userAgent 丢掉:两处都没有;核心那份不再有这几格", async () => {
		const original = oldGlobalsWithApp({
			userAgent: "UA/1.0",
			dynamicCron: "*/5 * * * *",
			healthCheckMinutes: 45,
		});
		await sandbox.placeZeroText("state/globals.json", original);

		const report = await sandbox.migrate();

		expect(report.rewritten).toEqual(
			expect.arrayContaining(["config/settings/core.json", "config/settings/bilibili.json"]),
		);
		await expectZeroGlobalsUntouched(sandbox, original);
		const moved = { dynamicCron: "*/5 * * * *", healthCheckMinutes: 45 };
		expect(await sandbox.readConfig("settings/bilibili.json")).toEqual(moved);
		// `app` 整个拆掉了:B 站两格进了 bilibili.json,UA 丢掉,日志等级进了 logging(别的格照样跟着走)。
		const core = await sandbox.readConfig<Record<string, unknown>>("settings/core.json");
		expect(core).not.toHaveProperty("app");
		expect(core.logging).toMatchObject({ level: "info" });
		for (const key of ["userAgent", ...Object.keys(moved)]) {
			expect(JSON.stringify(core), key).not.toContain(key);
		}

		expect(bili(await sandbox.load())).toEqual(moved);
	});

	it("`app` 里五格同在(日志等级、userAgent、dynamicCron、healthCheckMinutes、fansCron)→ bilibili.json 有那两格,core.json 没有 app、有 logging 与 profileRefreshCron", async () => {
		await sandbox.placeZeroText(
			"state/globals.json",
			oldGlobalsWithApp({
				logLevel: "warn",
				userAgent: "UA/1.0",
				dynamicCron: "*/5 * * * *",
				healthCheckMinutes: 45,
				fansCron: "*/7 * * * *",
			}),
		);

		await sandbox.migrate();

		// 次序钉:先拆 B 站两格、再拆 `app`。倒过来的话 bilibili.json 不会建、开机按默认值跑,什么都不报。
		expect(await sandbox.readConfig("settings/bilibili.json")).toEqual({
			dynamicCron: "*/5 * * * *",
			healthCheckMinutes: 45,
		});
		const core = await sandbox.readConfig<Record<string, unknown>>("settings/core.json");
		expect(core).not.toHaveProperty("app");
		expect(core.profileRefreshCron).toBe("*/7 * * * *");
		expect(core.logging).toMatchObject({ level: "warn" });
		const store = await sandbox.load();
		expect(store.getGlobals().profileRefreshCron).toBe("*/7 * * * *");
		expect(store.getGlobals().logging.level).toBe("warn");
	});

	it("`app` 里 logLevels 的 dynamic / live 并成 logging.levels.bilibili(取更详细的);memoryLog 布尔变成 { enabled }", async () => {
		await sandbox.placeZeroText(
			"state/globals.json",
			oldGlobalsWithApp({
				logLevels: { core: "warn", dynamic: "debug", live: "warn" },
				memoryLog: true,
				logRetentionDays: 14,
			}),
		);

		await sandbox.migrate();

		const core = await sandbox.readConfig<{ logging: Record<string, unknown> }>(
			"settings/core.json",
		);
		expect(core.logging).toMatchObject({
			levels: { core: "warn", bilibili: "debug" },
			memoryLog: { enabled: true },
			retentionDays: 14,
		});
		expect(core.logging.levels).not.toHaveProperty("dynamic");
		expect(core.logging.levels).not.toHaveProperty("live");
		expect((await sandbox.load()).getGlobals().logging.levels).toEqual({
			core: "warn",
			bilibili: "debug",
		});
	});

	it("`app` 里只有 userAgent 这一格 → 核心那份照样改写(去掉它),不为它建 settings/bilibili.json", async () => {
		await sandbox.placeZeroText("state/globals.json", oldGlobalsWithApp({ userAgent: "UA/1.0" }));

		const report = await sandbox.migrate();

		expect(report.rewritten).toContain("config/settings/core.json");
		expect(report.rewritten).not.toContain("config/settings/bilibili.json");
		const core = await sandbox.readConfig<Record<string, unknown>>("settings/core.json");
		expect(core).not.toHaveProperty("app");
		expect(JSON.stringify(core)).not.toContain("userAgent");
		expect(bili(await sandbox.load())).toEqual({
			dynamicCron: "30 */2 * * * *",
			healthCheckMinutes: 30,
		});
	});

	it("一条解析不了的老 cron 原样搬过去,开机照读 —— 读盘宽松,只有写入才核", async () => {
		await sandbox.placeZeroText("state/globals.json", oldGlobalsWithApp({ dynamicCron: "坏的" }));

		await sandbox.migrate();

		expect(bili(await sandbox.load()).dynamicCron).toBe("坏的");
	});

	it("0.x 一格都没写过 → 不建 settings/bilibili.json;开机时按默认值建一份", async () => {
		await sandbox.placeZeroText("state/globals.json", oldGlobalsWithApp({}));

		const report = await sandbox.migrate();

		expect(report.rewritten).not.toContain("config/settings/bilibili.json");
		const settings = bili(await sandbox.load());
		expect(settings).toEqual({ dynamicCron: "30 */2 * * * *", healthCheckMinutes: 30 });
		expect(await sandbox.readConfig("settings/bilibili.json")).toEqual(settings);
	});
});

// ── 各拓展的设置搬进它自己的文件(ADR-0021 决策 42 下 10-01 的 🔗)────────────────────────────

describe("0.x 设置里各拓展的 settings → settings/extensions/<id>.json", () => {
	const sandbox = useZeroSandbox("bn-extension-settings-");

	function oldGlobalsWithExtensions(extensions: Record<string, unknown>): string {
		const old = makeZeroGlobals() as unknown as Record<string, unknown>;
		old.extensions = extensions;
		return JSON.stringify(old);
	}

	it("每个拓展的 settings 原样搬进 settings/extensions/<id>.json;开关留在核心那份", async () => {
		const original = oldGlobalsWithExtensions({
			douyin: { enabled: true, settings: { cookie: "c", list: [{ id: "a" }] } },
			"acme.tiktok": { enabled: false, settings: { token: "t" } },
			kuaishou: { enabled: true },
		});
		await sandbox.placeZeroText("state/globals.json", original);

		const report = await sandbox.migrate();

		expect(report.rewritten).toEqual(
			expect.arrayContaining([
				"config/settings/core.json",
				"config/settings/extensions/douyin.json",
				"config/settings/extensions/acme.tiktok.json",
			]),
		);
		await expectZeroGlobalsUntouched(sandbox, original);
		expect(await sandbox.readConfig("settings/extensions/douyin.json")).toEqual({
			cookie: "c",
			list: [{ id: "a" }],
		});
		expect(await sandbox.readConfig("settings/extensions/acme.tiktok.json")).toEqual({
			token: "t",
		});
		const core = await sandbox.readConfig<{ extensions: Record<string, unknown> }>(
			"settings/core.json",
		);
		expect(core.extensions).toEqual({
			douyin: { enabled: true },
			"acme.tiktok": { enabled: false },
			kuaishou: { enabled: true },
		});

		const store = await sandbox.load();
		expect(store.getExtensionSettings("douyin")).toEqual({ cookie: "c", list: [{ id: "a" }] });
		expect(store.getExtensionSettings("kuaishou")).toBeUndefined();
		expect(store.getGlobals().extensions.douyin).toEqual({ enabled: true });
	});

	it("拓展 id 不合 id 的形状(手改过的配置)→ 不拆、不写文件:它要拼进文件名", async () => {
		await sandbox.placeZeroText(
			"state/globals.json",
			oldGlobalsWithExtensions({ "../evil": { enabled: true, settings: { x: 1 } } }),
		);

		const report = await sandbox.migrate();

		expect(report.rewritten.some((path) => path.includes("evil"))).toBe(false);
		expect((await sandbox.load()).getAllExtensionSettings()).toEqual({});
	});
});

// ── 历代旧默认模板(原 config-store.test.ts)────────────────────────────────────────

describe("0.x 历代旧默认模板 → 迁移器接缝", () => {
	const sandbox = useZeroSandbox("bn-legacy-templates-");

	/** 整份默认 globals 的 JSON 副本,就地改成老形状。 */
	function oldGlobals() {
		return makeZeroGlobals() as unknown as {
			defaults: {
				templates: Record<string, unknown> & {
					guardBuy: { captain: { template: string }; commander: { template: string } };
				};
			};
		};
	}

	it("一次性迁移:老 globals.json 旧默认直播/上舰模板 → 改写为当前默认,自定义值保留", async () => {
		const old = oldGlobals();
		// 占位符语法统一前的旧默认(用 {title}/{duration}/{user}/{mastername})
		old.defaults.templates.liveStart = "{name} 开播了！\n直播间标题：{title}\n直播间链接：{link}";
		old.defaults.templates.liveOngoing =
			"{name} 仍在直播中（已直播 {duration}）\n标题：{title}\n看过：{watched}";
		// liveEnd 改成用户自定义 → 迁移必须保留
		old.defaults.templates.liveEnd = "我自定义的下播文案 {name}";
		old.defaults.templates.guardBuy.captain.template = "{user} 成为了 {mastername} 的舰长！";
		// 消息版式引入前「链接内嵌模板」那代的动态默认 → 也要迁移成当前无链接默认
		old.defaults.templates.dynamic = "{name}发布了一条动态：{url}";
		const original = JSON.stringify(old);
		await sandbox.placeZeroText("state/globals.json", original);

		const report = await sandbox.migrate();

		// 新代里的**文件本身**已经是当前默认(开机读之前)。
		expect(report.rewritten).toContain("config/settings/core.json");
		expect(
			await sameBytes(
				join(sandbox.zero, "state", "globals.json"),
				sandbox.configPath("settings/core.json"),
			),
		).toBe(false);
		await expectZeroGlobalsUntouched(sandbox, original);
		const onDisk = (await sandbox.readConfig<DiskGlobals>("settings/core.json")).defaults.templates;
		expect(onDisk.liveStart).toBe("{name} 开播啦，当前粉丝数：{follower}");
		expect(onDisk.liveStreaming).toBe("{name} 正在直播，已播 {time}，累计观看：{watched}");
		expect(onDisk.liveEnd).toBe("我自定义的下播文案 {name}"); // 自定义保留,不被迁移覆盖
		// 带链接那代的默认 → 无链接新默认;0.x 那一遍先认出它(认的是 `dynamic` 这个键),再过 1.0 的改名落在 `post` 上。
		expect(onDisk.post).toBe("{name}发布了一条动态");
		expect(onDisk).not.toHaveProperty("dynamic");
		// 更早一代的上舰默认(`{user}` / `{mastername}`)先被 0.x 那一遍认成当前默认,再随上舰文案搬成 `membership.guard`:
		// 舰长这档没动过,不进 tiers,跟随体系默认「{viewer} 成为了 {name} 的{tier}！」(推出去的字与今天一样)。
		expect(onDisk).not.toHaveProperty("guardBuy");
		expect(onDisk.membership.guard).toEqual({
			enabled: false,
			default: { template: "{viewer} 成为了 {name} 的{tier}！", imageUrl: "" },
			tiers: {},
		});

		const store = await sandbox.load();
		const t = store.getGlobals().defaults.templates;
		expect(t.liveStart).toBe("{name} 开播啦，当前粉丝数：{follower}");
		expect(t.liveStreaming).toBe("{name} 正在直播，已播 {time}，累计观看：{watched}");
		expect(t.liveEnd).toBe("我自定义的下播文案 {name}"); // 自定义保留,不被迁移覆盖
		expect(t.post).toBe("{name}发布了一条动态"); // 带链接那代的默认 → 无链接新默认
		expect(t.membership.guard?.tiers).toEqual({});
		expect(t.membership.guard?.default.template).toBe("{viewer} 成为了 {name} 的{tier}！");
	});

	it("累积迁移:真 alpha.x globals.json(有 liveMsgEnabled、无 dynamic/dynamicVideo、旧 {title} liveStart)经 load() 自洽", async () => {
		// 跨三笔改动的兜底:① liveMsgEnabled 已从 schema 删除 → safeParse 须 strip 不报错;
		// ② dynamic/dynamicVideo 字段是新加的 → .default() 回填;③ 旧 {title} 默认 liveStart
		// → 一次性迁移成新默认。三件事叠加后顺序/交互不能互相打架。
		// 从当前默认起步,再"退化"成 alpha.x 磁盘形态:抹掉 dynamic/dynamicVideo(老数据
		// 没这俩字段)、塞 liveMsgEnabled(schema 已删的旧键)、写回旧 {title}/{duration}
		// 直播默认 + 旧 {user} 上舰默认。用 JSON 往返 + 析构剔除,不用 delete。
		const base = oldGlobals();
		const { dynamic: _d, dynamicVideo: _dv, ...restTpl } = base.defaults.templates;
		const legacy = {
			...base,
			defaults: {
				...base.defaults,
				templates: {
					...restTpl,
					liveMsgEnabled: false, // schema 已无此键 → 须被 strip
					liveStart: "{name} 开播了！\n直播间标题：{title}\n直播间链接：{link}",
					liveOngoing: "{name} 仍在直播中（已直播 {duration}）\n标题：{title}\n看过：{watched}",
					liveEnd: "{name} 下播了，直播时长 {duration}",
					guardBuy: {
						...base.defaults.templates.guardBuy,
						captain: {
							...base.defaults.templates.guardBuy.captain,
							template: "{user} 成为了 {mastername} 的舰长！",
						},
					},
				},
			},
		};
		const original = JSON.stringify(legacy);
		await sandbox.placeZeroText("state/globals.json", original);

		const report = await sandbox.migrate();

		// 迁移器只动它认得的那几格:盘上这份里旧默认已是当前默认。strip `liveMsgEnabled` 与回填 dynamic / dynamicVideo
		// 是配置仓开机时 schema 的事(迁移器不碰),所以这两件只在下面开机读出来的值上看。
		expect(report.rewritten).toContain("config/settings/core.json");
		await expectZeroGlobalsUntouched(sandbox, original);
		const onDisk = (await sandbox.readConfig<DiskGlobals>("settings/core.json")).defaults.templates;
		expect(onDisk.liveStart).toBe("{name} 开播啦，当前粉丝数：{follower}");
		expect(onDisk.liveStreaming).toBe("{name} 正在直播，已播 {time}，累计观看：{watched}");
		expect(onDisk.liveEnd).toBe("{name} 下播啦，本次直播了 {time}，粉丝变化 {follower_change}");
		expect(onDisk.membership.guard.tiers).toEqual({});

		// ① 不报错(strip 未知键,不抛 ConfigValidationError)
		const store = await sandbox.load();
		const t = store.getGlobals().defaults.templates as Record<string, unknown>;
		// ① liveMsgEnabled 被 strip
		expect(t.liveMsgEnabled).toBeUndefined();
		// ② dynamic/dynamicVideo 回填成当前默认(链接不再进模板),新代里它们叫 post / postVideo
		expect(t.post).toBe("{name}发布了一条{postNoun}");
		expect(t.postVideo).toBe("{name}发布了新视频");
		// ③ 旧 {title}/{duration} 直播默认 + 旧 {user} 上舰默认迁移成当前默认
		expect(t.liveStart).toBe("{name} 开播啦，当前粉丝数：{follower}");
		expect(t.liveStreaming).toBe("{name} 正在直播，已播 {time}，累计观看：{watched}");
		expect(t.liveEnd).toBe("{name} 下播啦，本次直播了 {time}，粉丝变化 {follower_change}");
		expect((t.membership as { guard: { tiers: Obj } }).guard.tiers).toEqual({});
	});

	it("加载缺 templates.dynamic/dynamicVideo 的老 globals.json → schema 回填默认(新键 post / postVideo),不抛", async () => {
		// 回归:dynamic/dynamicVideo 字段加入前写入的 globals.json 没有这两项。
		// 若 TemplateBundleSchema 把它们(今天叫 post / postVideo)设为 required 无默认,旧用户升级后 load() 会
		// ConfigValidationError 直接拒绝启动。.default(...) 兜底保证旧配置仍可加载。
		// 迁移器这一头:键缺着的对不上任何旧默认、也没有要改名的键,原样放过,不替它们凭空造出来(回填是开机时 schema 的事);
		// 整份里别的 0.x 键(特性键、版式键、账本)照样要过 1.0 的改名,所以设置文件是改写过的。
		// 去掉 B 站那三格,再抹掉那两项。
		const old = withoutZeroBilibiliApp(makeZeroGlobals()) as unknown as {
			defaults: { templates: Record<string, unknown> };
		};
		delete old.defaults.templates.dynamic;
		delete old.defaults.templates.dynamicVideo;
		const original = JSON.stringify(old);
		await sandbox.placeZeroText("state/globals.json", original);

		const report = await sandbox.migrate();

		expect(report.rewritten).toContain("config/settings/core.json");
		await expectZeroGlobalsUntouched(sandbox, original);
		const onDisk = (await sandbox.readConfig<DiskGlobals>("settings/core.json")).defaults.templates;
		expect(onDisk).not.toHaveProperty("dynamic");
		expect(onDisk).not.toHaveProperty("dynamicVideo");
		expect(onDisk).not.toHaveProperty("post");
		expect(onDisk).not.toHaveProperty("postVideo");
		const store = await sandbox.load();
		const tpl = store.getGlobals().defaults.templates;
		expect(tpl.post).toBe("{name}发布了一条{postNoun}");
		expect(tpl.postVideo).toBe("{name}发布了新视频");
	});
});

// ── 明文 apiKey 抬进加密袋(原 secret-store.test.ts)─────────────────────────────────

describe("0.x 扁平 AI 连接 + 明文 apiKey → 迁移器接缝 → 加密袋", () => {
	const sandbox = useZeroSandbox("bn-legacy-ai-secret-");

	/** 接了加密袋的配置仓,袋子放在新代的 `secrets/` 里(和开机时 `dataPath(dataRoot, "secrets", …)` 同处)。 */
	async function loadWithSecrets() {
		const logger = makeServiceCtx().logger;
		const secret = createSecretStore({
			filePath: join(sandbox.target, "secrets", "config-secrets.enc"),
			keyProvider: createKeyProvider({
				keyPath: join(sandbox.target, "secrets", "master.key"),
				saltPath: join(sandbox.target, "secrets", "kdf.salt"),
				logger,
			}),
			logger,
		});
		const store = createConfigStore({
			bootstrap: {
				server: { host: "127.0.0.1", port: 8787 },
				dataDir: sandbox.zero,
				logLevel: "info",
			},
			dataRoot: sandbox.target,
			bus: createNodeMessageBus(),
			serviceCtx: makeServiceCtx(),
			secretStore: secret,
		});
		await store.load();
		return { store, secret };
	}

	/**
	 * 写一份**上一版形状**的 globals.json:AI 连接是一套扁平字段,密钥明文在盘上。
	 * 这是升级路径的起点 —— 迁移会把它整份搬进 `providers.custom`,
	 * 密钥则该被抬进加密袋的 `custom` 槽。刻意绕过类型:新 schema 已经没有这些字段了。
	 */
	function legacyPlaintextGlobals(apiKey: string): string {
		const g = makeZeroGlobals() as unknown as Record<string, unknown>;
		const defaults = g.defaults as Record<string, unknown>;
		const ai = { ...(defaults.ai as Record<string, unknown>) };
		delete ai.providers;
		ai.apiKey = apiKey;
		ai.baseUrl = "https://api.deepseek.com";
		ai.model = "deepseek-v4-pro";
		defaults.ai = ai;
		return JSON.stringify(g, null, 2);
	}

	it("一次性 lift:上一版明文 apiKey 迁进 custom 桶 + 加密袋,settings/core.json 抹掉", async () => {
		const original = legacyPlaintextGlobals("sk-legacy-plain");
		await sandbox.placeZeroText("state/globals.json", original);

		const report = await sandbox.migrate();

		// 第一段:迁移器只搬形状 —— 新代里的文件是改写过的,扁平字段整份进了 custom 桶,明文原样还在桶里(抬密钥是配置仓的事)。
		expect(report.rewritten).toContain("config/settings/core.json");
		await expectZeroGlobalsUntouched(sandbox, original);
		const migratedFile = await sandbox.readConfig<DiskGlobals>("settings/core.json");
		// AI 设置已上提到顶层,老位置 `defaults.ai` 不留空壳。
		expect(migratedFile.defaults).not.toHaveProperty("ai");
		const migrated = migratedFile.ai;
		for (const key of ["apiKey", "baseUrl", "model", "provider"]) {
			expect(migrated, `迁出来的 ai 顶层还留着老键 ${key}`).not.toHaveProperty(key);
		}
		expect(migrated.providers).toMatchObject({
			custom: {
				provider: "custom",
				apiKey: "sk-legacy-plain",
				baseUrl: "https://api.deepseek.com",
				model: "deepseek-v4-pro",
			},
		});

		// 第二段:配置仓开机,把明文抬进加密袋。
		const { store, secret } = await loadWithSecrets();
		// 扁平配置整份进 custom 桶(迁移器),密钥注水回内存。
		expect(store.getGlobals().ai.providers.custom?.apiKey).toBe("sk-legacy-plain");
		expect(store.getGlobals().ai.providers.custom?.model).toBe("deepseek-v4-pro");
		// 磁盘上那把被抠成空串 —— 不留明文,也不动键序。
		const afterLift = (await sandbox.readConfig<DiskGlobals>("settings/core.json")).ai;
		expect((afterLift.providers as Record<string, { apiKey?: string }>).custom?.apiKey).toBe("");
		// 整个文件里都没有明文(不只是 custom 桶那一格)。
		expect(await readFile(sandbox.configPath("settings/core.json"), "utf8")).not.toContain(
			"sk-legacy-plain",
		);
		// 加密文件持有,键是 custom(与迁移的去处一致)。
		expect((await secret.load()).aiApiKeys).toEqual({ custom: "sk-legacy-plain" });
	});
});

// ── 三处老形状一起走接缝 ─────────────────────────────────────────────────────────────
//
// 这一组没有配置仓测试里的对应用例:三个迁移函数各自的判定在 `./settings.test.ts` 钉过了,这里钉它们经 `migrateSettingsFile`
// 组合到同一份 `settings/core.json` 上、配置仓照着最新的形状开机。

describe("0.x 三处老形状一起走迁移器接缝", () => {
	const sandbox = useZeroSandbox("bn-legacy-settings-all-");

	it("扁平 AI 连接 + 旧默认模板 + 0.9.1 的范围 / 白名单:新代里是最新的形状,第 0 代那份一个字节没变", async () => {
		const g = makeZeroGlobals() as unknown as {
			defaults: { ai: Record<string, unknown>; templates: Record<string, unknown> };
			linkParsing: Record<string, unknown>;
		};
		const { providers: _providers, activeProfile: _activeProfile, ...flatAi } = g.defaults.ai;
		const old = {
			...g,
			defaults: {
				...g.defaults,
				ai: { ...flatAi, baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" },
				templates: { ...g.defaults.templates, liveEnd: "{name} 下播了，直播时长 {duration}" },
			},
			linkParsing: {
				enabled: true,
				cooldownSeconds: 30,
				scope: "selected",
				targets: [{ targetId: GROUP_ID }],
			},
		};
		const original = JSON.stringify(old);
		await sandbox.placeZeroText("state/globals.json", original);

		const report = await sandbox.migrate();

		expect(report.rewritten).toContain("config/settings/core.json");
		await expectZeroGlobalsUntouched(sandbox, original);
		const onDisk = await sandbox.readConfig<DiskGlobals>("settings/core.json");
		for (const key of ["baseUrl", "model", "provider"]) {
			expect(onDisk.ai, `迁出来的 ai 顶层还留着老键 ${key}`).not.toHaveProperty(key);
		}
		expect(onDisk.defaults).not.toHaveProperty("ai");
		expect(onDisk.ai).toMatchObject({
			activeProfile: "custom",
			providers: { custom: { provider: "custom", model: "deepseek-v4-pro" } },
		});
		expect(onDisk.defaults.templates.liveEnd).toBe(
			"{name} 下播啦，本次直播了 {time}，粉丝变化 {follower_change}",
		);
		expect(onDisk).not.toHaveProperty("linkParsing");
		expect(onDisk.linkPreview).toEqual({
			enabled: true,
			cooldownSec: 30,
			isOnByDefault: false,
			replyForm: "image",
			byTarget: { [GROUP_ID]: { isOn: true } },
		});

		// 配置仓开机读出来的也是最新的形状。
		const globals = (await sandbox.load()).getGlobals();
		expect(globals.ai.activeProfile).toBe("custom");
		expect(globals.ai.providers.custom).toMatchObject({
			provider: "custom",
			model: "deepseek-v4-pro",
		});
		expect(globals.defaults.templates.liveEnd).toBe(
			"{name} 下播啦，本次直播了 {time}，粉丝变化 {follower_change}",
		);
		expect(globals.linkPreview).toEqual({
			enabled: true,
			cooldownSec: 30,
			isOnByDefault: false,
			replyForm: "image",
			byTarget: { [GROUP_ID]: { isOn: true } },
		});
	});

	// 0.10–0.12 的面板在总开关关着时默认行与例外表照样能改(开关不锁下面的表),所以「总开关关、默认行开」
	// 不只是 0.9.1 迁出来的那批。0.x 的门先看总开关、再看逐群答案:关着一张不回。迁过来总开关必须仍是单独
	// 的一格(`enabled`),没被折进默认行(也没跟默认行接反),否则关着的功能会被迁成开着。
	// 两格故意取不同的值(总开关关、默认行开):取一样的值,接反了也看不出来。
	it("总开关关、默认回、群显式关、形式原生分享:新代里是 linkPreview 五格,enabled 仍关,没有 linkParsing", async () => {
		const g = makeZeroGlobals() as unknown as Record<string, unknown>;
		const old = {
			...g,
			linkParsing: {
				enabled: false,
				cooldownSeconds: 45,
				defaults: { parse: true, form: "miniapp" },
				groups: { [GROUP_ID]: { parse: false, form: "image" } },
			},
		};
		await sandbox.placeZeroText("state/globals.json", JSON.stringify(old));

		await sandbox.migrate();

		const expected = {
			enabled: false,
			cooldownSec: 45,
			isOnByDefault: true,
			replyForm: "nativeShare",
			byTarget: { [GROUP_ID]: { isOn: false, replyForm: "image" } },
		};
		const onDisk = await sandbox.readConfig<DiskGlobals>("settings/core.json");
		expect(onDisk).not.toHaveProperty("linkParsing");
		expect(onDisk.linkPreview).toEqual(expected);
		expect((await sandbox.load()).getGlobals().linkPreview).toEqual(expected);
	});
});

// ── 全新安装(不经迁移器)────────────────────────────────────────────────────────────

describe("全新安装的人格指针", () => {
	const sandbox = useZeroSandbox("bn-fresh-persona-");

	// 全新安装没有老数据可迁,活 schema 也不再按内容去补指针:这根指针得由出厂默认值自己带
	// (`DEFAULT_AI.activePreset`)。全新安装开机之后,「当前这份人格」必须有着落 —— 指着第一份内置预设。
	it("空的数据根上开机:activePreset 指着第一份内置人格", async () => {
		const store = await sandbox.load();
		expect(store.getGlobals().ai.activePreset).toBe(FACTORY_PRESETS[0]?.id);
	});
});
