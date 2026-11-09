import { OnebotConnectionSettingsSchema } from "../../platforms/onebot-settings.js";
/**
 * 0.x 各个版本留下的连接与目标 → 0.x 最新的形状:兼容逻辑住在迁移器里(`migration/connections.ts`),
 * 配置仓开机只认最新的形状。这批测试原先钉在配置仓开机上(`config-store.test.ts`),兼容逻辑搬走之后跟着搬过来。
 *
 * 接缝是「第 0 代 → `migrateZeroGeneration` → 新的一代上配置仓开机」:在临时的第 0 代里摆 0.x 的文件
 * (`state/connections.json`、`state/adapters.json`、`state/targets.json`……),迁一代,再在新代上开配置仓,
 * 断言配置仓读出来的连接 / 目标,以及新代 `config/` 里的文件。摆放与开机的辅助见 `./support.ts`
 * (和 `zero-generation-legacy-targets.test.ts` 共用)。
 *
 * 钉四件事:
 * - `adapters.json` 是 `connections.json` 的旧名,只作输入:没有 `connections.json` 时读它、写出新代的
 *   `connections.json`,它自己不进新代,第 0 代那份一个字节不动;两个都在时只认 `connections.json`。
 * - v1 形状(连接没有 kind / connector,目标没有 kind、还叫 adapterId / session)改写成 1.0 的形状
 *   (连接是 `adapterKey` / `platform` / `settings` / `platformSnapshot`):写的是新代里的新文件、第 0 代那份
 *   不动;本来就是 1.0 形状的不改写(新代里还是搬过来的那个文件)。输入夹具是 0.x 的旧形状,不许改 —— 这批测试
 *   只改对产出的断言。
 * - 已撤下平台(astrbot / koishi-bot / web-dashboard,和没有 platform 的老拓展连接)的存量在迁移时丢掉,开机不抛。
 * - 上一条的判据只在 parse 失败之后才问:桥借来的 onebot bot、桥驮来的 telegram 目标要活下来;认得的平台上、
 *   桥驮来的平台上的真损坏,迁移器不丢,开机时配置仓照旧抛。
 *
 * 「第 0 代一个字节不变」整体由 `zero-generation.test.ts` 钉着,这里对具体的那几份再逐字节比一次,让每条用例自己读得懂。
 * 连接 id 在这几条路径里都是夹具自己给的(只有最老的单文件 targets.json 才由迁移器造 id,那一条在
 * `zero-generation-legacy-targets.test.ts`)。
 */

import { randomUUID } from "node:crypto";
import { chmod, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	type Connection,
	deterministicUuid,
	neutralPlatformSnapshot,
	type PushTarget,
} from "@bilibili-notify/internal";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import { ConfigValidationError } from "../../config/store.js";
import { i18n } from "../../i18n/index.js";
import { resolveSettings } from "../../push/connection-settings.js";
import { useZeroSandbox } from "./support.js";

/** 0.x 的 webhook 连接(旧形状:kind / connector / config)—— 迁移的输入,不是 1.0 的 Connection。 */
function makeWebhookConnection(overrides: Record<string, unknown> = {}) {
	return {
		id: randomUUID(),
		name: "团队 Webhook",
		platform: "feishu" as const,
		enabled: true,
		kind: "direct" as const,
		connector: "webhook" as const,
		config: { url: "https://example.com/hook", headers: {} },
		...overrides,
	};
}

/** 0.x 的 OneBot 连接(旧形状:kind / connector / config / retryTimes)—— 迁移的输入。 */
function makeOnebotConnection(overrides: Record<string, unknown> = {}) {
	return {
		id: randomUUID(),
		name: "NapCat",
		platform: "onebot" as const,
		enabled: true,
		kind: "direct" as const,
		connector: "http" as const,
		config: {
			transport: "http" as const,
			baseUrl: "http://127.0.0.1:3000",
			protocolVersion: "v11" as const,
			headers: {},
			timeoutMs: 15_000,
			imageMinTimeoutMs: 30_000,
			mergeForwardMinTimeoutMs: 60_000,
			retryTimes: 0,
			retryIntervalMs: 1_000,
		},
		...overrides,
	};
}

/** 托管端点目标的 id 种子 —— 落在盘上、被订阅的路由表引用着,不许跟着改名。 */
function managedEndpointTargetId(connectionId: string): string {
	return deterministicUuid(`push-target:webhook-adapter:${connectionId}`);
}

/** 两个路径的内容是不是逐字节一样 —— 没被改写过的文件,新代里是从第 0 代原样复制过来的那一份。 */
async function sameBytes(a: string, b: string): Promise<boolean> {
	return (await readFile(a)).equals(await readFile(b));
}

/** 新代里(任何一层)名字带 adapters 的东西。 */
async function adaptersUnder(dir: string): Promise<string[]> {
	return (await readdir(dir, { recursive: true })).filter((path) => path.includes("adapters"));
}

describe("0.x 连接 / 目标 → 迁移器接缝", () => {
	const sandbox = useZeroSandbox("bn-legacy-connections-");
	afterEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

	it.each([
		["en", "Generation 0 state/adapters.json is not a JSON array; connections cannot be migrated."],
		["ja", "第0世代のstate/adapters.jsonがJSON配列ではないため、接続を移行できません。"],
		["zh-TW", "第 0 代的 state/adapters.json 不是 JSON 陣列，無法移轉連線。"],
	] as const)("%s：旧连接坏文件明确拒绝，第0代原文保留", async (locale, message) => {
		const original = "{not an array}";
		await sandbox.placeZeroText("state/adapters.json", original);
		i18n.set({ locale, voice: "plain" });
		await expect(sandbox.migrate()).rejects.toThrow(message);
		expect(await readFile(join(sandbox.zero, "state/adapters.json"), "utf8")).toBe(original);
	});

	// 连接那份从 adapters.json 改叫 connections.json。搬法是「读老的、写新的、老的一动不动」:第 0 代那份原样留着,
	// 让回退到旧载荷仍然开得了机 —— 旧构建找的正是它,且它还是迁移前的形状。所以这几条盯的是「新的写出来了」
	// 「老的没被动、也没进新代」这两件事。
	describe("连接文件改名 adapters.json → connections.json", () => {
		it("只有老文件名时照样读得到连接,并写出一份 connections.json", async () => {
			const connection = makeOnebotConnection();
			await sandbox.placeZero("state/adapters.json", [connection]);
			await sandbox.placeZero("state/targets.json", []);

			const report = await sandbox.migrate();
			const store = await sandbox.load();

			expect(store.getConnections()).toEqual([expect.objectContaining({ id: connection.id })]);
			expect(await sandbox.readConfig("connections.json")).toEqual([
				expect.objectContaining({ id: connection.id }),
			]);
			expect(report.rewritten).toContain("config/connections.json");
			// 老文件名只作输入,新代里没有它。
			expect(await adaptersUnder(sandbox.target)).toEqual([]);
		});

		it("老文件原地不动 —— 它就是回退那条路要读的东西,新代里没有它", async () => {
			// 刻意用**老形状**:回退回去的旧构建认得的正是这个形状。
			const legacy = {
				id: randomUUID(),
				name: "老连接",
				platform: "onebot",
				enabled: true,
				config: { transport: "http", baseUrl: "http://127.0.0.1:5700" },
			};
			const original = JSON.stringify([legacy]);
			await sandbox.placeZeroText("state/adapters.json", original);
			await sandbox.placeZero("state/targets.json", []);

			const store = await sandbox.migrateAndLoad();

			// 先证明这一趟真的走了老文件名那条路 —— 否则「老文件没被动」是空过的。
			expect(store.getConnections().map((c) => c.id)).toEqual([legacy.id]);
			expect(await sandbox.readConfig<unknown[]>("connections.json")).toEqual([
				expect.objectContaining({ id: legacy.id, adapterKey: "onebot", platform: "onebot" }),
			]);
			expect(await readFile(join(sandbox.zero, "state", "adapters.json"), "utf8")).toBe(original);
			expect(await adaptersUnder(sandbox.target)).toEqual([]);
		});

		it("两个文件都在时只认新的 —— 老的是快照,不该再被读", async () => {
			const current = makeOnebotConnection();
			const stale = makeOnebotConnection({ id: randomUUID(), name: "升级前那份" });
			await sandbox.placeZero("state/connections.json", [current]);
			await sandbox.placeZero("state/adapters.json", [stale]);
			await sandbox.placeZero("state/targets.json", []);

			const store = await sandbox.migrateAndLoad();

			expect(store.getConnections().map((c) => c.id)).toEqual([current.id]);
			expect(await adaptersUnder(sandbox.target)).toEqual([]);
		});
	});

	// 迁移改写的是新代里的**新文件**(原子换名),第 0 代那两份不动。
	describe("v1 形状改写成最新的形状", () => {
		it("老形状的 connections.json 改写进新代 —— 主人盘上那份没有 kind/connector", async () => {
			// 这是这次形状变更**唯一真会炸主人机器**的路径:schema 一旦要求 kind/connector,
			// 存量连接就 parse 不过、开机直接 ConfigValidationError。夹具刻意写成
			// 「史前」形状(连 transport 都没有),走的是与 schema `.default("http")` 同一个回落。
			const legacy = {
				id: randomUUID(),
				name: "老 NapCat",
				platform: "onebot",
				enabled: true,
				config: { baseUrl: "http://127.0.0.1:3000", accessToken: "tok" },
			};
			const original = JSON.stringify([legacy]);
			await sandbox.placeZeroText("state/connections.json", original);
			await sandbox.placeZero("state/targets.json", []);

			const store = await sandbox.migrateAndLoad();

			expect(store.getConnections()).toEqual([
				expect.objectContaining({ id: legacy.id, adapterKey: "onebot", platform: "onebot" }),
			]);
			// 新代里那份本身就是 1.0 形状,而不是每次开机都在内存里补一遍 —— 否则任何一次 upsert 都会把
			// 没迁移的那份原样写回去。史前的连接没写 transport,迁移补成显式的 http;kind / connector / config 没有了。
			const onDisk = await sandbox.readConfig<Array<Record<string, unknown>>>("connections.json");
			expect(onDisk[0]).toMatchObject({
				adapterKey: "onebot",
				platform: "onebot",
				settings: { transport: "http", baseUrl: "http://127.0.0.1:3000", accessToken: "tok" },
				platformSnapshot: snapshotFor("onebot"),
			});
			for (const gone of ["kind", "connector", "config"])
				expect(onDisk[0], gone).not.toHaveProperty(gone);
			// 第 0 代那份一个字节没变(迁移写的是新代里的文件)。
			expect(await readFile(join(sandbox.zero, "state", "connections.json"), "utf8")).toBe(
				original,
			);
		});

		it("老形状的 targets.json 改写进新代 —— 主人盘上那份没有 kind", async () => {
			// 与连接侧同一条路径:schema 一旦要求 kind,存量 targets.json 就 parse 不过、
			// 开机直接炸。两支各验一条 —— webhook 那条要落到 endpoint(见下一条)、群这条要落到 session。
			const connection = makeOnebotConnection();
			const legacyTarget = {
				id: randomUUID(),
				name: "老群目标",
				adapterId: connection.id,
				platform: "onebot",
				scope: "group",
				enabled: true,
				session: { groupId: "10001" },
			};
			const original = JSON.stringify([legacyTarget]);
			await sandbox.placeZero("state/connections.json", [connection]);
			await sandbox.placeZeroText("state/targets.json", original);

			const report = await sandbox.migrate();
			const store = await sandbox.load();

			expect(store.getTargets()).toEqual([
				expect.objectContaining({ id: legacyTarget.id, kind: "session" }),
			]);
			const onDisk = await sandbox.readConfig<unknown[]>("targets.json");
			expect(onDisk[0]).toMatchObject({ kind: "session" });
			// 第 0 代那份一个字节没变。
			expect(await readFile(join(sandbox.zero, "state", "targets.json"), "utf8")).toBe(original);
			// 连接那份是 0.x 最新形状(有 kind / connector),这一版也要改成 1.0 的形状 —— 进改写清单,不再是原样复制。
			expect(report.rewritten).toContain("config/connections.json");
			expect(await sandbox.readConfig("connections.json")).toEqual([
				expect.objectContaining({ id: connection.id, adapterKey: "onebot" }),
			]);
		});

		it("老 webhook 目标迁成 endpoint —— 托管同步认的是形态,迁错就会重造一张", async () => {
			const connection = makeWebhookConnection();
			const legacyId = managedEndpointTargetId(connection.id);
			const legacyTarget = {
				id: legacyId,
				name: connection.name,
				adapterId: connection.id,
				platform: "webhook",
				scope: "channel",
				enabled: true,
				managedBy: "adapter",
				session: {},
			};
			await sandbox.placeZero("state/connections.json", [connection]);
			await sandbox.placeZero("state/targets.json", [legacyTarget]);

			const store = await sandbox.migrateAndLoad();

			expect(store.getTargets()).toEqual([
				expect.objectContaining({ id: legacyId, kind: "endpoint", managedBy: "connection" }),
			]);
		});

		it("3a-16:连接 config 的 `forwardMinTimeoutMs` → `mergeForwardMinTimeoutMs`,键留在原位、值照搬;迁完配置仓读得进", async () => {
			// 0.x 的连接:合并转发的超时下限还叫旧名字,主人改过值。
			const zero = {
				id: randomUUID(),
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
					forwardMinTimeoutMs: 90_000,
					retryTimes: 0,
					retryIntervalMs: 1_000,
				},
			};
			await sandbox.placeZero("state/connections.json", [zero]);
			await sandbox.placeZero("state/targets.json", []);

			const report = await sandbox.migrate();

			expect(report.rewritten).toContain("config/connections.json");
			const [onDisk] =
				await sandbox.readConfig<{ settings: Record<string, unknown> }[]>("connections.json");
			expect(Object.keys(onDisk?.settings ?? {})).toEqual([
				"transport",
				"baseUrl",
				"protocolVersion",
				"headers",
				"timeoutMs",
				"imageMinTimeoutMs",
				"mergeForwardMinTimeoutMs",
				"maxRetries",
				"retryIntervalMs",
			]);
			expect(onDisk?.settings.mergeForwardMinTimeoutMs).toBe(90_000);
			// 重试次数也换了名(retryTimes → maxRetries),键留在原位。
			expect(onDisk?.settings).not.toHaveProperty("retryTimes");
			// 连接的 schema 是 strict 的:老键留着的话这条连接整条被隔离。迁出来的 settings 必须过得了 OneBot 的规则。
			expect(resolveSettings(OnebotConnectionSettingsSchema, onDisk?.settings).ok).toBe(true);
			const store = await sandbox.load();
			const [loaded] = store.getConnections();
			expect(loaded?.adapterKey).toBe("onebot");
			expect(loaded?.settings).toMatchObject({ mergeForwardMinTimeoutMs: 90_000 });
		});

		it("已经是 1.0 形状的连接与目标不改写 —— 新代里还是搬过来的那个文件", async () => {
			// 夹具换成 1.0 形状(这条钉的是「新形状原样放行」,不是迁移输入)。
			const connection: Connection = {
				id: randomUUID(),
				name: "NapCat",
				platform: "onebot",
				enabled: true,
				adapterKey: "onebot",
				platformSnapshot: snapshotFor("onebot"),
				settings: {
					transport: "http",
					baseUrl: "http://127.0.0.1:3000",
					protocolVersion: "v11",
					headers: {},
					timeoutMs: 15_000,
					imageMinTimeoutMs: 30_000,
					mergeForwardMinTimeoutMs: 60_000,
					maxRetries: 0,
					retryIntervalMs: 1_000,
				},
			};
			const target: PushTarget = {
				id: randomUUID(),
				name: "主群",
				connectionId: connection.id,
				kind: "session",
				scope: "group",
				enabled: true,
				address: "111",
			};
			await sandbox.placeZero("state/connections.json", [connection]);
			await sandbox.placeZero("state/targets.json", [target]);

			const report = await sandbox.migrate();

			expect(report.rewritten).not.toContain("config/connections.json");
			expect(report.rewritten).not.toContain("config/targets.json");
			// 没改写 = 和第 0 代那份逐字节一样。
			for (const name of ["connections.json", "targets.json"]) {
				expect(
					await sameBytes(join(sandbox.zero, "state", name), sandbox.configPath(name)),
					name,
				).toBe(true);
			}
			const store = await sandbox.load();
			expect(store.getConnections().map((c) => c.id)).toEqual([connection.id]);
			expect(store.getTargets().map((t) => t.id)).toEqual([target.id]);
		});
	});

	// 已撤下的平台(web-dashboard 早先、koishi-bot / astrbot 随宿主一起)留下的存量条目:
	// 当年的 schema 是收它们的(dashboard 不给建,但直调 API / 旧备份都能留下)。迁移器一律静默丢掉 —— 留到
	// 开机 safeParse 一失败就是启动期 throw,没有面板可以进去改,boot 三振回落也救不回来。
	describe("已撤下平台的存量", () => {
		it.each([
			{ platform: "web-dashboard", config: {}, session: {} },
			{ platform: "koishi-bot", config: { botPlatform: "onebot" }, session: { channelId: "1" } },
			{ platform: "astrbot", config: {}, session: {} },
		])("静默丢弃已撤下平台 $platform 的存量 adapter 与 target", async (stale) => {
			const webhook = makeWebhookConnection();
			const connection = {
				id: randomUUID(),
				name: stale.platform,
				platform: stale.platform,
				enabled: true,
				config: stale.config,
			};
			const target = {
				id: randomUUID(),
				name: "stale",
				adapterId: connection.id,
				platform: stale.platform,
				scope: "group",
				enabled: true,
				session: stale.session,
			};
			await sandbox.placeZero("state/connections.json", [connection, webhook]);
			await sandbox.placeZero("state/targets.json", [target]);

			await sandbox.migrate();

			// 迁移器把它们丢了:新代里活下来的只剩那条 webhook 直连,撤下平台的目标一条不剩。
			expect(await sandbox.readConfig<Connection[]>("connections.json")).toEqual([
				expect.objectContaining({ id: webhook.id }),
			]);
			expect(await sandbox.readConfig<PushTarget[]>("targets.json")).toEqual([]);

			const store = await sandbox.load(); // 不应抛错
			// 活下来的只剩那条 webhook 直连(webhook 那一族的分发键是 "webhook")。
			expect(store.getConnections().map((a) => a.adapterKey)).toEqual(["webhook"]);
			// 撤下平台的 target 被丢弃;只剩 webhook 自动托管 target
			const targets = store.getTargets();
			expect(targets).toHaveLength(1);
			expect(targets.every((t) => t.kind === "endpoint")).toBe(true);
		});

		it("迁移最后一步摘 platform / 端点的 scope,且排在「认已撤下平台」之后 —— 同一份文件里撤下的丢掉、新形状的摘净", async () => {
			const onebot = makeOnebotConnection();
			const webhook = makeWebhookConnection();
			const session = {
				id: randomUUID(),
				name: "主群",
				connectionId: onebot.id,
				kind: "session",
				platform: "onebot",
				scope: "group",
				enabled: true,
				address: "111",
			};
			const endpoint = {
				id: randomUUID(),
				name: "飞书",
				connectionId: webhook.id,
				kind: "endpoint",
				platform: "feishu",
				scope: "channel",
				enabled: true,
				managedBy: "connection",
			};
			// 撤下平台的存量(没有 kind、parse 不过):只有读得到原始的 platform 才认得出它该丢。
			const retired = {
				id: randomUUID(),
				name: "stale",
				adapterId: onebot.id,
				platform: "web-dashboard",
				scope: "group",
				enabled: true,
				session: {},
			};
			await sandbox.placeZero("state/connections.json", [onebot, webhook]);
			await sandbox.placeZero("state/targets.json", [session, endpoint, retired]);

			await sandbox.migrate();

			const out = await sandbox.readConfig<Array<Record<string, unknown>>>("targets.json");
			expect(out.map((t) => t.id)).toEqual([session.id, endpoint.id]);
			for (const t of out) expect(t).not.toHaveProperty("platform");
			expect(out[0]).toMatchObject({ kind: "session", scope: "group", address: "111" });
			expect(out[1]).not.toHaveProperty("scope");
			expect(out[1]).toMatchObject({ kind: "endpoint", managedBy: "connection" });
			await sandbox.load(); // 不应抛错
		});

		/**
		 * 拓展连接曾经没有 `platform`(那时它是「一条桥接入」);改成「一个 bot」之后必填。
		 * 老形状没发过版、不写迁移 —— 当作已撤下的形状丢掉;新形状(带开放词表的 platform)
		 * 必须活下来。两条一起才把那个判据钉住:只丢老形状,不丢桥借来的 telegram bot。
		 */
		it("丢掉没有 platform 的老拓展连接,留下带 platform 的新形状", async () => {
			const stale = {
				id: randomUUID(),
				name: "家里那台(老形状)",
				enabled: true,
				kind: "extension",
				extensionId: "bridge",
				config: { token: "t0ken", bridgeKind: "koishi" },
			};
			const bot = {
				id: randomUUID(),
				name: "阿库娅",
				enabled: true,
				kind: "extension",
				extensionId: "bridge",
				platform: "telegram",
				config: { link: stale.id, botId: "telegram:42" },
			};
			await sandbox.placeZero("state/connections.json", [stale, bot]);
			await sandbox.placeZero("state/targets.json", []);

			await sandbox.migrate();
			expect(
				(await sandbox.readConfig<{ id: string }[]>("connections.json")).map((c) => c.id),
			).toEqual([bot.id]);

			const store = await sandbox.load();
			expect(store.getConnections().map((c) => c.id)).toEqual([bot.id]);
		});
	});

	// 「已撤下平台」的判据只在 parse 失败之后才问、目标那侧只认显式的撤下名单 —— 下面几条是它**不许误伤**的:
	// 桥借来的 bot 与桥驮来的目标要活下来,认得的平台上(以及桥驮来的平台上)的真损坏迁移器不丢、留给配置仓报。
	describe("不许误伤的存量", () => {
		/**
		 * 桥借来的 bot 平台抄到 `onebot` 时,形状迁移不许把它当成「没有 connector 的史前直连」
		 * 去戴 `kind: "direct"` —— 戴上就过不了 schema,开机直接挂;上一组的用例用的 telegram
		 * 恰好躲开了这一枪(迁移不认得的平台原样放行),所以这里非用 onebot 不可。
		 */
		it("不把桥借来的 onebot bot 当成史前直连去迁移", async () => {
			const bot = {
				id: randomUUID(),
				name: "koishi 上那只 onebot",
				enabled: true,
				kind: "extension",
				extensionId: "bridge",
				platform: "onebot",
				config: { link: "link-home", botId: "onebot:10086" },
			};
			const written = JSON.stringify([bot]);
			await sandbox.placeZeroText("state/connections.json", written);
			await sandbox.placeZero("state/targets.json", []);

			const report = await sandbox.migrate();
			const store = await sandbox.load();

			expect(store.getConnections().map((c) => c.id)).toEqual([bot.id]);
			// 它是拓展连接:不是史前直连 —— adapterKey 是拓展 id(不是 "onebot"),快照是中性占位,
			// 不把它的平台名当成内置 OneBot(那张脸与会话种类属于内置连接)。
			expect(report.rewritten).toContain("config/connections.json");
			const [saved] = await sandbox.readConfig<Array<Record<string, unknown>>>("connections.json");
			expect(saved).toMatchObject({
				id: bot.id,
				adapterKey: "bridge",
				platform: "onebot",
				settings: { link: "link-home", botId: "onebot:10086" },
				platformSnapshot: neutralPlatformSnapshot("onebot"),
			});
			for (const gone of ["kind", "connector", "extensionId", "config"]) {
				expect(saved, gone).not.toHaveProperty(gone);
			}
			// 第 0 代那份一个字节没动。
			expect(await readFile(join(sandbox.zero, "state", "connections.json"), "utf8")).toBe(written);
		});

		/**
		 * 迁出来的文件**开机不挡在外壳上**:认得的平台、外壳完好但 `config` 坏掉的直连连接,从前原样留着、开机抛错;
		 * 现在被改成 1.0 形状,开机照读,`settings` 过不过得了适配器的规则要等适配器在场才知道(此刻没有适配器 ——
		 * 它会被隔离,不挡开机)。
		 */
		it("认得的平台上 config 坏掉的直连连接:迁得过去、开机不抛、settings 原文留着(会被隔离)", async () => {
			const broken = makeOnebotConnection({
				config: { transport: "http", baseUrl: 42, accessToken: "tok-SECRET" },
			});
			await sandbox.placeZero("state/connections.json", [broken]);
			await sandbox.placeZero("state/targets.json", []);

			const store = await sandbox.migrateAndLoad();

			const [loaded] = store.getConnections();
			expect(loaded).toMatchObject({ id: broken.id, adapterKey: "onebot", platform: "onebot" });
			expect(loaded?.settings).toMatchObject({ baseUrl: 42, accessToken: "tok-SECRET" });
			// 它确实过不了 OneBot 的规则 —— 有适配器在场时会被隔离。
			expect(resolveSettings(OnebotConnectionSettingsSchema, loaded?.settings).ok).toBe(false);
		});

		it("拓展连接没被丢:迁出来的文件开机读得进,适配器键是拓展 id", async () => {
			const onebot = makeOnebotConnection();
			const bot = {
				id: randomUUID(),
				name: "阿库娅",
				enabled: true,
				kind: "extension",
				extensionId: "bridge",
				platform: "telegram",
				config: { link: "l", botId: "telegram:42" },
			};
			await sandbox.placeZero("state/connections.json", [onebot, bot]);
			await sandbox.placeZero("state/targets.json", []);

			const store = await sandbox.migrateAndLoad();

			expect(store.getConnections().map((c) => [c.id, c.adapterKey])).toEqual([
				[onebot.id, "onebot"],
				[bot.id, "bridge"],
			]);
		});

		it("目标与连接上 0.x 的 testStatus 都不带过来(新的 reachability / probeState 开机后重记)", async () => {
			const connection = makeOnebotConnection({
				testStatus: { ok: true, lastCheckedAt: "2026-06-06T00:00:00.000Z", latencyMs: 9 },
			});
			const target = {
				id: randomUUID(),
				name: "主群",
				connectionId: connection.id,
				kind: "session",
				scope: "group",
				enabled: true,
				address: "111",
				testStatus: { ok: false, lastCheckedAt: "2026-06-06T00:00:00.000Z", err: "连不上" },
			};
			await sandbox.placeZero("state/connections.json", [connection]);
			await sandbox.placeZero("state/targets.json", [target]);

			const report = await sandbox.migrate();

			expect(report.rewritten).toEqual(
				expect.arrayContaining(["config/connections.json", "config/targets.json"]),
			);
			const [savedConnection] =
				await sandbox.readConfig<Array<Record<string, unknown>>>("connections.json");
			const [savedTarget] =
				await sandbox.readConfig<Array<Record<string, unknown>>>("targets.json");
			expect(savedConnection).not.toHaveProperty("testStatus");
			expect(savedConnection).not.toHaveProperty("probeState");
			expect(savedTarget).not.toHaveProperty("testStatus");
			expect(savedTarget).not.toHaveProperty("reachability");
			// 开得了机
			await sandbox.load();
		});

		it("同一份数据走两遍,第二遍没有任何文件被改写", async () => {
			await sandbox.placeZero("state/connections.json", [
				makeOnebotConnection(),
				makeWebhookConnection(),
			]);
			await sandbox.placeZero("state/targets.json", []);
			await sandbox.migrate();
			const first = await readFile(sandbox.configPath("connections.json"), "utf8");

			const { migrateConnectionFiles } = await import("../connections.js");
			const rewritten = await migrateConnectionFiles({
				configDir: join(sandbox.target, "config"),
				adaptersPath: join(sandbox.zero, "state", "adapters.json"),
			});

			expect(rewritten).toEqual([]);
			expect(await readFile(sandbox.configPath("connections.json"), "utf8")).toBe(first);
		});

		it("留下形状正确、平台却不认得的 target —— 桥驮来的就长这样", async () => {
			// 目标的平台开放之后,「认不认识」不能再靠词表答:telegram 不在任何词表里,
			// 但它是合法的。判据换成「认不得的平台**又** parse 不过才是存量」,所以这一条
			// 必须活下来 —— 上一组的「已撤下平台」与这一条一起才把那个判据钉住。
			const connection = makeOnebotConnection();
			const bridged = {
				id: randomUUID(),
				name: "桥上的 telegram 群",
				connectionId: connection.id,
				kind: "session",
				platform: "telegram",
				scope: "group",
				enabled: true,
				address: "-1001234567890",
			};
			await sandbox.placeZero("state/connections.json", [connection]);
			await sandbox.placeZero("state/targets.json", [bridged]);

			const store = await sandbox.migrateAndLoad();

			expect(store.getTargets()).toEqual([expect.objectContaining({ id: bridged.id })]);
			// 目标不再自带平台:它在连接上,迁移最后一步把盘上这一格摘掉了。
			expect(store.getTargets()[0]).not.toHaveProperty("platform");
		});

		it("认得的平台上坏掉的 target 迁移器不丢、开机照旧抛错 —— 别把真损坏当存量吃掉", async () => {
			const connection = makeOnebotConnection();
			const broken = {
				id: randomUUID(),
				name: "坏的",
				connectionId: connection.id,
				kind: "session",
				platform: "onebot",
				scope: "群",
				enabled: true,
				address: "1",
			};
			await sandbox.placeZero("state/connections.json", [connection]);
			await sandbox.placeZero("state/targets.json", [broken]);

			await sandbox.migrate();
			// 迁移器不丢它、也不动它(认不得的内容原样留着),由开机的配置仓报出来。
			expect(await sandbox.readConfig("targets.json")).toEqual([broken]);
			await expect(sandbox.load()).rejects.toBeInstanceOf(ConfigValidationError);
		});

		/**
		 * 🔴 **目标的平台是开放词表,不许拿连接那份闭集去判「认不认得」。**
		 *
		 * 判据从前是连接与目标共用的一条:「平台不在 `CONNECTION_PLATFORMS` 里 + parse 不过
		 * = 已撤下的存量」。桥借来的 telegram 目标本来就不在那份闭集里,于是它上面**任何**
		 * 真实损坏都被当成存量静默丢掉,而且下一次任何写入会把这个丢弃永久写实到盘上 ——
		 * 同样的损坏在 onebot 目标上是照旧抛错(上一条用例)。两条一起才把判据钉住。
		 */
		it("桥驮来的 telegram 目标上的真损坏迁移器不丢、开机照旧抛错 —— 别拿连接的闭集判目标", async () => {
			const connection = makeOnebotConnection();
			const broken = {
				id: randomUUID(),
				name: "坏的桥目标",
				connectionId: connection.id,
				kind: "session",
				platform: "telegram",
				scope: "群",
				enabled: true,
				address: "1",
			};
			await sandbox.placeZero("state/connections.json", [connection]);
			await sandbox.placeZero("state/targets.json", [broken]);

			await sandbox.migrate();
			expect(await sandbox.readConfig("targets.json")).toEqual([broken]);
			await expect(sandbox.load()).rejects.toBeInstanceOf(ConfigValidationError);
		});
	});

	describe("改写这一跳本身", () => {
		// 连接里有 token:主人收紧过权限的文件,迁移改写出来的新文件不能放宽(POSIX 才有这回事)。
		it.skipIf(process.platform === "win32")("改写出来的新文件沿用原件的权限", async () => {
			// v1 的连接(没有 kind / connector),迁移会改写它。
			await sandbox.placeZero("state/connections.json", [
				{
					id: randomUUID(),
					name: "NapCat",
					enabled: true,
					platform: "onebot",
					config: { transport: "http", baseUrl: "http://127.0.0.1:3000", accessToken: "tok" },
				},
			]);
			await chmod(join(sandbox.zero, "state", "connections.json"), 0o600);

			const result = await sandbox.migrate();

			expect(result.rewritten).toContain("config/connections.json");
			expect((await stat(sandbox.configPath("connections.json"))).mode & 0o777).toBe(0o600);
		});

		it("只有旧名 adapters.json、而它不是 JSON 数组:迁移当场报出是它坏了", async () => {
			await sandbox.placeZeroText("state/adapters.json", "{ not json");

			await expect(sandbox.migrate()).rejects.toThrow(/state\/adapters\.json/);
		});
	});
});
