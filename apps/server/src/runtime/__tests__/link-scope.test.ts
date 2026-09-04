/**
 * 链接解析的生效范围 —— 把配置里的白名单(引用推送目标 id)解析成「哪些群算数」。
 *
 * 缝在 `resolveLinkParsingScope`:配置 + 目标表 + 适配器表进,允许集(或「不限」)出。
 * 它是纯函数,所有决定都在这儿:哪些目标算群、停用算不算、悬空 id 怎么办。解析器
 * (link-parser)只拿结果做一次查表,不再各自判一遍。
 */

import type { PushAdapter, PushTarget } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { linkScopeKey, resolveLinkParsingScope } from "../link-scope.js";

const ONEBOT_ADAPTER = "11111111-1111-4111-8111-111111111111";
const QQ_ADAPTER = "22222222-2222-4222-8222-222222222222";
const T_GROUP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T_GROUP_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T_PRIVATE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const T_QQ_GROUP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T_GONE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function adapter(id: string, platform: "onebot" | "qq-official", enabled = true): PushAdapter {
	return { id, name: platform, enabled, platform, config: {} } as unknown as PushAdapter;
}

function onebotGroup(id: string, groupId: string, over: Partial<PushTarget> = {}): PushTarget {
	return {
		id,
		name: `群 ${groupId}`,
		adapterId: ONEBOT_ADAPTER,
		scope: "group",
		enabled: true,
		platform: "onebot",
		session: { groupId },
		...over,
	} as PushTarget;
}

function onebotPrivate(id: string, userId: string): PushTarget {
	return {
		id,
		name: `私聊 ${userId}`,
		adapterId: ONEBOT_ADAPTER,
		scope: "private",
		enabled: true,
		platform: "onebot",
		session: { userId },
	} as PushTarget;
}

function qqGroup(id: string, groupOpenid: string, over: Partial<PushTarget> = {}): PushTarget {
	return {
		id,
		name: `官机群 ${groupOpenid}`,
		adapterId: QQ_ADAPTER,
		scope: "group",
		enabled: true,
		platform: "qq-official",
		session: { groupOpenid },
		...over,
	} as PushTarget;
}

const ADAPTERS = [adapter(ONEBOT_ADAPTER, "onebot"), adapter(QQ_ADAPTER, "qq-official")];

describe("resolveLinkParsingScope", () => {
	it("范围是「所有群」→ 不限(null),白名单里写了什么都不看", () => {
		expect(
			resolveLinkParsingScope({
				config: { scope: "all", targets: [{ targetId: T_GROUP }] },
				targets: [onebotGroup(T_GROUP, "123")],
				adapters: ADAPTERS,
			}),
		).toBeNull();
	});

	it("「仅以下群」→ 只有勾了的群目标进允许集,键 = 平台:adapterId:群地址", () => {
		const allowed = resolveLinkParsingScope({
			config: { scope: "selected", targets: [{ targetId: T_GROUP }, { targetId: T_QQ_GROUP }] },
			targets: [
				onebotGroup(T_GROUP, "123"),
				onebotGroup(T_GROUP_2, "456"),
				qqGroup(T_QQ_GROUP, "openid-xyz"),
			],
			adapters: ADAPTERS,
		});
		expect(allowed).toEqual(
			new Set([
				linkScopeKey("onebot", ONEBOT_ADAPTER, "123"),
				linkScopeKey("qq-official", QQ_ADAPTER, "openid-xyz"),
			]),
		);
		// 没勾的那个群不在里面 —— 「在推送目标里」不等于「在白名单里」。
		expect(allowed?.has(linkScopeKey("onebot", ONEBOT_ADAPTER, "456"))).toBe(false);
	});

	it("官机群的地址是 groupOpenid,与入站帧里的 groupId 同一个值", () => {
		const allowed = resolveLinkParsingScope({
			config: { scope: "selected", targets: [{ targetId: T_QQ_GROUP }] },
			targets: [qqGroup(T_QQ_GROUP, "openid-xyz")],
			adapters: ADAPTERS,
		});
		expect([...(allowed ?? [])]).toEqual([`qq-official:${QQ_ADAPTER}:openid-xyz`]);
	});

	// 「停用」在链接解析与周报里是同一个意思:目标暂停,勾着也不生效(主人定的,两处要一致)。
	it("勾了的目标已停用 → 不进允许集", () => {
		const allowed = resolveLinkParsingScope({
			config: { scope: "selected", targets: [{ targetId: T_GROUP }] },
			targets: [onebotGroup(T_GROUP, "123", { enabled: false })],
			adapters: ADAPTERS,
		});
		expect(allowed?.size).toBe(0);
	});

	it("目标所属的适配器已停用、或适配器已不存在 → 不进允许集", () => {
		const disabledAdapter = resolveLinkParsingScope({
			config: { scope: "selected", targets: [{ targetId: T_GROUP }] },
			targets: [onebotGroup(T_GROUP, "123")],
			adapters: [adapter(ONEBOT_ADAPTER, "onebot", false)],
		});
		expect(disabledAdapter?.size).toBe(0);

		const missingAdapter = resolveLinkParsingScope({
			config: { scope: "selected", targets: [{ targetId: T_GROUP }] },
			targets: [onebotGroup(T_GROUP, "123")],
			adapters: [],
		});
		expect(missingAdapter?.size).toBe(0);
	});

	it("勾了一个私聊目标 → 不进允许集(链接解析只在群里响应)", () => {
		const allowed = resolveLinkParsingScope({
			config: { scope: "selected", targets: [{ targetId: T_PRIVATE }] },
			targets: [onebotPrivate(T_PRIVATE, "10001")],
			adapters: ADAPTERS,
		});
		expect(allowed?.size).toBe(0);
	});

	it("白名单里引用的目标已经删掉 → 静默忽略,其余照常", () => {
		const allowed = resolveLinkParsingScope({
			config: { scope: "selected", targets: [{ targetId: T_GONE }, { targetId: T_GROUP }] },
			targets: [onebotGroup(T_GROUP, "123")],
			adapters: ADAPTERS,
		});
		expect([...(allowed ?? [])]).toEqual([linkScopeKey("onebot", ONEBOT_ADAPTER, "123")]);
	});

	it("「仅以下群」但一个都没勾 → 空集,不是「不限」", () => {
		const allowed = resolveLinkParsingScope({
			config: { scope: "selected", targets: [] },
			targets: [onebotGroup(T_GROUP, "123")],
			adapters: ADAPTERS,
		});
		expect(allowed).not.toBeNull();
		expect(allowed?.size).toBe(0);
	});
});
