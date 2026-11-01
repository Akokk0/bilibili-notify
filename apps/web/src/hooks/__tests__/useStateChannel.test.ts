/**
 * 单元测试 — `handleStateEnvelope` 纯函数(WS `state` 频道 hydrate + config-changed)。
 *
 * 守护契约:
 *   - hydrate → 同步 invalidate 每一张会被服务端改的表(含订阅标签表 ["subscription-tags"] 与各来源的登录状态 ["source-auth"])
 *   - config-changed scope=globals       → invalidate ["settings"]、拓展表 ["extensions"] 与跟着它走的来源表 ["sources"]
 *     (不碰各拓展的设置)
 *   - config-changed scope=integration-settings → invalidate ["settings"](各集成的设置挂在 /api/settings 下发的那一份里)
 *     与各拓展的设置(拓展的设置各在自己的文件,改了发这一档);不碰拓展表
 *   - extension-status-changed          → 那个拓展的 status 与 bots
 *   - extension-settings-changed        → 那个拓展的设置与视图(状态)
 *   - extension-report-discrepancies-changed → 仅拓展表(上报出入框住在那一行上)
 *   - subscription-profiles-changed     → 仅 invalidate ["subscriptions"](拓展报的资料落盘了)
 *   - problems-changed                  → 仅 invalidate ["subscriptions"](订阅卡带着挂在它上面的问题)
 *   - config-changed scope=subscriptions → invalidate ["subscriptions"] 与 ["subscription-tags"](标签表与订阅同一档)
 *   - config-changed scope=targets       → 仅 invalidate ["targets"]
 *   - config-changed scope=secrets       → 一律不动(前端无对应缓存)
 *   - 非 state 频道帧 silent-drop
 */

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WsEnvelope } from "../../services/ws";
import { handleStateEnvelope } from "../useStateChannel";
import { eventFrameMaker } from "./ws-frames";

const TS = "2026-05-16T00:00:00.000Z";

/** 服务端发来的一帧合法事件帧:形状按 contract 的事件表写全,缺 `ts` 补上。 */
const env = eventFrameMaker(TS);

/** 故意违反类型的坏帧(`data` 缺格、事件名不存在、频道与事件名对不上),测 hook 的防御。 */
const malformed = (frame: object) => ({ ts: TS, ...frame }) as WsEnvelope;

interface SpyClient {
	qc: QueryClient;
	invalidate: ReturnType<typeof vi.fn>;
}

function spyClient(): SpyClient {
	const qc = new QueryClient();
	const invalidate = vi.fn(qc.invalidateQueries.bind(qc));
	qc.invalidateQueries = invalidate;
	return { qc, invalidate };
}

function keysOf(invalidate: ReturnType<typeof vi.fn>): unknown[][] {
	return invalidate.mock.calls.map((args) => (args[0] as { queryKey: unknown[] }).queryKey);
}

describe("handleStateEnvelope — state 频道分发", () => {
	let sc: SpyClient;
	beforeEach(() => {
		sc = spyClient();
	});

	it("非 state 频道:不 invalidate", () => {
		handleStateEnvelope(malformed({ type: "auth", event: "subscription-auth-changed" }), sc.qc);
		expect(sc.invalidate).not.toHaveBeenCalled();
	});

	/**
	 * 🔴 hydrate 是 WS 重连之后**唯一**的「赶上错过的变化」机制(不重放历史帧)。清单漏一
	 * 张表,那张表就一直停在断线那一刻:拓展页的装 / 卸 / 开关、连接表的增删,都得靠切页
	 * 或刷新才回来,而界面看上去一切正常。
	 */
	it("hydrate:每一张会被服务端改的表都在清单里 —— 漏一张就停在断线那一刻", () => {
		handleStateEnvelope(env({ type: "state", event: "hydrate", data: null }), sc.qc);
		const keys = keysOf(sc.invalidate).map((k) => k[0]);
		expect(new Set(keys)).toEqual(
			new Set([
				"settings",
				"subscriptions",
				"subscription-tags",
				"targets",
				"connections",
				"extensions",
				// 来源表跟着拓展表走:拓展的那几行照的是同一份清单。
				"sources",
				"adapters",
				"extension-status",
				"extension-bots",
				"ext-settings",
				"source-auth",
			]),
		);
	});

	/**
	 * 设置经 `/api/ext/:id/settings` 写进去了(ADR-0019 决策 35):失效那个拓展的设置与视图 ——
	 * 视图可能跟着设置变(停用了一条接入),宿主不替拓展判它变没变。帧里只有 id(设置里有密钥)。
	 */
	it("extension-settings-changed:只失效那个拓展的设置与状态", () => {
		handleStateEnvelope(
			env({ type: "state", event: "extension-settings-changed", data: { extensionId: "bridge" } }),
			sc.qc,
		);
		expect(keysOf(sc.invalidate)).toEqual([
			["ext-settings", "bridge"],
			["extension-status", "bridge"],
		]);
	});

	it("extension-settings-changed 没带 extensionId:不动", () => {
		handleStateEnvelope(
			env({ type: "state", event: "extension-settings-changed", data: { extensionId: "" } }),
			sc.qc,
		);
		expect(sc.invalidate).not.toHaveBeenCalled();
	});

	it("extension-status-changed:只失效那个拓展的 status 与 bots", () => {
		handleStateEnvelope(
			env({ type: "state", event: "extension-status-changed", data: { extensionId: "bridge" } }),
			sc.qc,
		);
		expect(keysOf(sc.invalidate)).toEqual([
			["extension-status", "bridge"],
			["extension-bots", "bridge"],
		]);
	});

	it("extension-status-changed 没带 extensionId:不动", () => {
		handleStateEnvelope(
			malformed({ type: "state", event: "extension-status-changed", data: {} }),
			sc.qc,
		);
		expect(sc.invalidate).not.toHaveBeenCalled();
	});

	/**
	 * 服务端给某个拓展新记了「上报出入」(ADR-0019 决策 60):那个框住在拓展表的那一行上,**只**让拓展表
	 * 过期 —— 视图没变,不去重读它。
	 */
	it("extension-report-discrepancies-changed:只失效拓展表", () => {
		handleStateEnvelope(
			env({
				type: "state",
				event: "extension-report-discrepancies-changed",
				data: { extensionId: "douyin" },
			}),
			sc.qc,
		);
		expect(keysOf(sc.invalidate)).toEqual([["extensions"]]);
	});

	/**
	 * 拓展的设置不在 globals 里了(各在自己的文件),`globals` 这一档只管核心设置与拓展的开关:
	 * 失效 [globals] 与拓展表,**不**再碰拓展设置那一口(设置的写发的是 `integration-settings`)。
	 */
	it("config-changed scope=globals:invalidate [globals]、[extensions] 与 [sources],不碰各拓展的设置", () => {
		handleStateEnvelope(
			env({ type: "state", event: "config-changed", data: { scope: "globals" } }),
			sc.qc,
		);
		expect(keysOf(sc.invalidate)).toEqual([
			["settings"],
			["extensions"],
			["sources"],
			["adapters"],
		]);
		expect(keysOf(sc.invalidate)).not.toContainEqual(["ext-settings"]);
	});

	/**
	 * 🔴 拓展的开关(`enabled`)住在 globals 里,拓展页 / 详情页吃的却是拓展表那一口。别的标签页
	 * 把拓展关了,这一页只重读 globals 的话,还把它画成「跑着」—— 状态那一口回 404 被当成
	 * 「没交视图」,卡上一片空白。
	 */
	it("config-changed scope=globals:拓展表那一口也过期了(别处拨了拓展开关)", () => {
		sc.qc.setQueryData(["extensions"], { extensions: [] });
		handleStateEnvelope(
			env({ type: "state", event: "config-changed", data: { scope: "globals" } }),
			sc.qc,
		);
		expect(sc.qc.getQueryState(["extensions"])?.isInvalidated).toBe(true);
	});

	/**
	 * 拓展报的资料更新落进了资料缓存(ADR-0019 决策 7 / 62):服务端不发 `config-changed`(资料不是配置),
	 * 发这一帧。不接的话订阅页上的名字 / 头像 / 粉丝要等切页才换。
	 */
	it("subscription-profiles-changed:仅 invalidate [subscriptions]", () => {
		handleStateEnvelope(
			env({
				type: "state",
				event: "subscription-profiles-changed",
				data: { subscriptionIds: ["a"] },
			}),
			sc.qc,
		);
		expect(keysOf(sc.invalidate)).toEqual([["subscriptions"]]);
	});

	/** 问题表变了:订阅列表每条订阅带着自己的问题,所以重取订阅列表(不必看是谁报的)。 */
	it("problems-changed:仅 invalidate [subscriptions]", () => {
		handleStateEnvelope(
			env({ type: "state", event: "problems-changed", data: { reporter: "bilibili" } }),
			sc.qc,
		);
		expect(keysOf(sc.invalidate)).toEqual([["subscriptions"]]);
	});

	/**
	 * 各集成(今天只有 B 站)的设置一个集成一个文件,服务端改了它们发的是**自己的一档**
	 * (`integration-settings`),不是 `globals` —— 而面板吃的是 `/api/settings` 下发的那一份(B 站的动态 cron /
	 * UA / 登录心跳间隔挂在它的 `bilibili` 键下)。这一档没人接的话,别处(另一个标签页、备份恢复)改了 B 站的
	 * 设置,系统页要等切页或刷新才知道。拓展表没变(开关不在这一档里),所以不失效它。
	 *
	 * 各拓展的设置也各在自己的文件里,改了发的同样是这一档 —— 备份恢复、卸载这类不经设置口的写只发它,
	 * 拓展设置那一口得跟着过期,否则这一页照旧画着旧名单,直到下一发撞 409。
	 */
	it("config-changed scope=integration-settings:invalidate [globals] 与各拓展的设置,不碰拓展表", () => {
		handleStateEnvelope(
			env({ type: "state", event: "config-changed", data: { scope: "integration-settings" } }),
			sc.qc,
		);
		expect(keysOf(sc.invalidate)).toEqual([["settings"], ["ext-settings"]]);
	});

	it("config-changed scope=integration-settings:拓展设置那一口真的过期了(按前缀,各拓展一起)", () => {
		sc.qc.setQueryData(["ext-settings", "bridge"], { revision: "r1" });
		sc.qc.setQueryData(["ext-settings", "douyin"], { revision: "r2" });
		sc.qc.setQueryData(["extensions"], { extensions: [] });
		handleStateEnvelope(
			env({ type: "state", event: "config-changed", data: { scope: "integration-settings" } }),
			sc.qc,
		);
		expect(sc.qc.getQueryState(["ext-settings", "bridge"])?.isInvalidated).toBe(true);
		expect(sc.qc.getQueryState(["ext-settings", "douyin"])?.isInvalidated).toBe(true);
		expect(sc.qc.getQueryState(["extensions"])?.isInvalidated).toBe(false);
	});

	/**
	 * 🔴 标签表与订阅**同一个 scope**(ADR-0034):服务端 PUT 标签表删掉某个标签时,所有订阅上的这个 id
	 * 在同一次写里被去掉,发的就是 `subscriptions` 这一档。只失效订阅的话,别的标签页删了标签,这一页
	 * 的筛选胶囊还停在旧表上;只失效标签表的话,卡片角标 / 计数还认着已经被去掉的 id。
	 */
	it("config-changed scope=subscriptions:invalidate [subscriptions] 与 [subscription-tags],不碰别的", () => {
		handleStateEnvelope(
			env({ type: "state", event: "config-changed", data: { scope: "subscriptions" } }),
			sc.qc,
		);
		expect(keysOf(sc.invalidate)).toEqual([["subscriptions"], ["subscription-tags"]]);
	});

	it("config-changed scope=subscriptions:标签表那一口真的过期了", () => {
		sc.qc.setQueryData(["subscription-tags"], [{ id: "t1", name: "重点" }]);
		handleStateEnvelope(
			env({ type: "state", event: "config-changed", data: { scope: "subscriptions" } }),
			sc.qc,
		);
		expect(sc.qc.getQueryState(["subscription-tags"])?.isInvalidated).toBe(true);
	});

	it("config-changed scope=targets:仅 invalidate [targets]", () => {
		handleStateEnvelope(
			env({ type: "state", event: "config-changed", data: { scope: "targets" } }),
			sc.qc,
		);
		expect(keysOf(sc.invalidate)).toEqual([["targets"]]);
	});

	/**
	 * 🔴 服务端**真的会发**这一档(`config/store.ts` 三处 `emit("config-changed", "connections")`)
	 * —— 建 / 改 / 删连接各一处。前端整条没人接,于是别处(另一个标签页、私聊指令、拓展
	 * 热装卸连带的清理)改了连接,这一页要等 staleTime 过去或切页才知道。
	 */
	it("config-changed scope=connections:仅 invalidate [connections]", () => {
		handleStateEnvelope(
			env({ type: "state", event: "config-changed", data: { scope: "connections" } }),
			sc.qc,
		);
		expect(keysOf(sc.invalidate)).toEqual([["connections"]]);
	});

	it("config-changed scope=secrets:不 invalidate(前端无对应 query)", () => {
		handleStateEnvelope(
			env({ type: "state", event: "config-changed", data: { scope: "secrets" } }),
			sc.qc,
		);
		expect(sc.invalidate).not.toHaveBeenCalled();
	});

	it("config-changed 但缺 scope:不 invalidate", () => {
		handleStateEnvelope(malformed({ type: "state", event: "config-changed", data: {} }), sc.qc);
		expect(sc.invalidate).not.toHaveBeenCalled();
	});

	it("不识别的 event:不 invalidate", () => {
		handleStateEnvelope(malformed({ type: "state", event: "subscribed" }), sc.qc);
		expect(sc.invalidate).not.toHaveBeenCalled();
	});
});
