/**
 * 最老的单文件 `targets.json`(0.x 早期:连接参数和会话捆在一条目标的 `config` 里,没有 `connections.json`
 * 也没有 `adapters.json`)迁成「连接 + 目标」。
 *
 * ⑥c 第 0 步先补的刻画测试:这条路原本一条测试都没有。接缝是「第 0 代 → 迁移器 → 新的一代上配置仓开机」,
 * 拆法从配置仓开机时搬进迁移器(`migration/connections.ts`)前后,这几条原样都绿。拆出来的连接 id 由第一条用到
 * 它的老目标算出来(确定的),这里只比关系、不比值。
 */

import { type Connection, makeEmptySubscription, type PushTarget } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { legacyBiliRow } from "../../__tests__/support/legacy-subscription.js";
import { useZeroSandbox } from "./support.js";

/** 0.x 的目标 id 本来就是 UUID(订阅的路由表只收 UUID)。 */
const ID = {
	group: "00000000-0000-4000-8000-000000000001",
	private: "00000000-0000-4000-8000-000000000002",
	other: "00000000-0000-4000-8000-000000000003",
	hook1: "00000000-0000-4000-8000-000000000004",
	hook2: "00000000-0000-4000-8000-000000000005",
	dash: "00000000-0000-4000-8000-000000000006",
	fresh: "00000000-0000-4000-8000-000000000007",
	missingConnection: "00000000-0000-4000-8000-000000000008",
};

const ONEBOT = { baseUrl: "http://127.0.0.1:5700", accessToken: "tok" };
const HOOK = { url: "https://hooks.example.com/a", secret: "s" };

/** 0.x 早期的目标:平台 + 会话范围 + 一个把连接参数与会话捆在一起的 `config`。 */
const LEGACY_TARGETS = [
	{
		id: ID.group,
		name: "主群",
		platform: "onebot",
		scope: "group",
		enabled: true,
		config: { ...ONEBOT, groupId: "111" },
	},
	// 同一个 OneBot(地址 + token 都一样):并进同一条连接。私聊取 userId,不取 groupId。
	{
		id: ID.private,
		name: "主人私聊",
		platform: "onebot",
		scope: "private",
		enabled: false,
		config: { ...ONEBOT, userId: "222", groupId: "999" },
	},
	// 另一个 OneBot,没有 token:单开一条。
	{
		id: ID.other,
		name: "副号",
		platform: "onebot",
		scope: "group",
		enabled: true,
		config: { baseUrl: "http://10.0.0.2:3000", groupId: "333" },
	},
	{
		id: ID.hook1,
		name: "飞书",
		platform: "webhook",
		scope: "channel",
		enabled: true,
		config: HOOK,
	},
	// 同一个 webhook(地址 + secret 都一样):并进同一条连接,这条目标并到第一条上。
	{
		id: ID.hook2,
		name: "飞书二",
		platform: "webhook",
		scope: "channel",
		enabled: true,
		config: HOOK,
	},
	// 已经撤下的平台:静默丢掉。
	{
		id: ID.dash,
		name: "看板",
		platform: "web-dashboard",
		scope: "channel",
		enabled: true,
		config: {},
	},
];

describe("0.x 最老的单文件 targets.json → 连接 + 目标", () => {
	const { placeZero, migrateAndLoad, readConfig } = useZeroSandbox("bn-legacy-targets-");

	it("同一个 OneBot 的群与私聊并进一条连接,另一个 OneBot 单开;地址按会话范围取", async () => {
		await placeZero("state/targets.json", LEGACY_TARGETS);

		const store = await migrateAndLoad();

		const onebot = store.getConnections().filter((c) => c.platform === "onebot");
		expect(onebot).toHaveLength(2);
		const [shared, other] = onebot as Extract<Connection, { platform: "onebot" }>[];
		expect(shared).toMatchObject({
			name: "主群 · 127.0.0.1:5700",
			enabled: true,
			kind: "direct",
			connector: "http",
			config: {
				transport: "http",
				baseUrl: ONEBOT.baseUrl,
				accessToken: "tok",
				protocolVersion: "v11",
			},
		});
		expect(other).toMatchObject({
			name: "副号 · 10.0.0.2:3000",
			config: { baseUrl: "http://10.0.0.2:3000" },
		});
		expect(other?.config.accessToken).toBeUndefined();

		const byId = new Map(store.getTargets().map((t) => [t.id, t]));
		expect(byId.get(ID.group)).toMatchObject({
			name: "主群",
			connectionId: shared?.id,
			kind: "session",
			platform: "onebot",
			scope: "group",
			enabled: true,
			address: "111",
		});
		expect(byId.get(ID.private)).toMatchObject({
			connectionId: shared?.id,
			scope: "private",
			enabled: false,
			address: "222",
		});
		expect(byId.get(ID.other)).toMatchObject({ connectionId: other?.id, address: "333" });
	});

	it("同一个 webhook 的两条目标并成连接的托管目标(留第一条的 id),平台落 generic", async () => {
		await placeZero("state/targets.json", LEGACY_TARGETS);

		const store = await migrateAndLoad();

		const hooks = store.getConnections().filter((c) => c.platform === "generic");
		expect(hooks).toHaveLength(1);
		expect(hooks[0]).toMatchObject({
			name: "飞书 · hooks.example.com",
			kind: "direct",
			platform: "generic",
			config: { url: HOOK.url, secret: "s", headers: {} },
		});
		const endpoints = store.getTargets().filter((t) => t.kind === "endpoint");
		expect(endpoints).toEqual([
			expect.objectContaining({
				id: ID.hook1,
				name: "飞书 · hooks.example.com",
				connectionId: hooks[0]?.id,
				platform: "generic",
				scope: "channel",
				managedBy: "connection",
			}),
		]);
	});

	it("认不得的老平台丢掉;迁出来的两份文件落在新的一代里", async () => {
		await placeZero("state/targets.json", LEGACY_TARGETS);

		const store = await migrateAndLoad();

		expect(
			store
				.getTargets()
				.map((t) => t.id)
				.sort(),
		).toEqual([ID.group, ID.private, ID.other, ID.hook1]);
		expect(await readConfig<Connection[]>("connections.json")).toEqual(store.getConnections());
		expect(await readConfig<PushTarget[]>("targets.json")).toEqual(store.getTargets());
	});

	it("订阅里引用被并掉的那条 webhook 目标的,改指托管目标,重复的去掉", async () => {
		await placeZero("state/targets.json", LEGACY_TARGETS);
		const sub = makeEmptySubscription({
			id: "5c9c3a8e-2f4f-4a51-9d57-1f2a3b4c5d6e",
			identity: { sourceKey: "bilibili", externalId: "12345" },
		});
		sub.routing.dynamic = [ID.hook2, ID.group];
		sub.routing.live = [ID.hook1, ID.hook2];
		await placeZero("state/subscriptions.json", [legacyBiliRow(sub)]);

		const store = await migrateAndLoad();

		const [loaded] = store.getSubscriptions();
		expect(loaded?.routing.dynamic).toEqual([ID.hook1, ID.group]);
		expect(loaded?.routing.live).toEqual([ID.hook1]);
	});

	it("targets.json 已是新格式、却没有 connections.json:拒绝开机,不凭空造连接", async () => {
		await placeZero("state/targets.json", [
			{
				id: ID.fresh,
				name: "新格式",
				connectionId: ID.missingConnection,
				kind: "session",
				platform: "onebot",
				scope: "group",
				enabled: true,
				address: "111",
			},
		]);

		await expect(migrateAndLoad()).rejects.toThrow(/connections\.json 不见了/);
	});
});
