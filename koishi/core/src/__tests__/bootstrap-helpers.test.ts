import {
	deterministicUuid,
	FEATURE_KEYS,
	type FeatureKey,
	makeEmptySubscription,
	type Subscription,
} from "@bilibili-notify/internal";
import type { BilibiliPush } from "@bilibili-notify/push";
import type { Context, Logger } from "koishi";
import { describe, expect, it, vi } from "vitest";
import { warnMissingPlugins } from "../bootstrap-helpers";

const TARGET_ID = deterministicUuid("missing-plugin-target");
const LIVE_FEATURE_KEYS = FEATURE_KEYS.filter((feature) => feature !== "dynamic");

function makeCtx(services: Record<string, unknown> = {}): Context {
	return {
		get: vi.fn((name: string) => services[name]),
	} as unknown as Context;
}

function makePush(): BilibiliPush & { sendPrivateMsg: ReturnType<typeof vi.fn> } {
	return {
		sendPrivateMsg: vi.fn().mockResolvedValue(undefined),
	} as unknown as BilibiliPush & { sendPrivateMsg: ReturnType<typeof vi.fn> };
}

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
	return { warn: vi.fn() } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

function makeSub(feature: FeatureKey, opts: { enabled?: boolean; featureEnabled?: boolean } = {}) {
	const sub = makeEmptySubscription({ id: deterministicUuid(`sub-${feature}`), uid: "10000" });
	sub.enabled = opts.enabled ?? true;
	sub.routing[feature] = [TARGET_ID];
	if (opts.featureEnabled !== undefined) {
		sub.overrides.features = {
			[feature]: opts.featureEnabled,
		} as Subscription["overrides"]["features"];
	}
	return sub;
}

describe("warnMissingPlugins", () => {
	it("动态路由启用且 dynamic 插件缺失时告警", async () => {
		const push = makePush();
		const logger = makeLogger();

		await warnMissingPlugins(makeCtx(), push, logger, [makeSub("dynamic")]);

		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(1);
		expect(push.sendPrivateMsg.mock.calls[0]?.[0]).toContain("动态插件");
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it("disabled 订阅不触发缺插件告警", async () => {
		const push = makePush();

		await warnMissingPlugins(makeCtx(), push, makeLogger(), [makeSub("live", { enabled: false })]);

		expect(push.sendPrivateMsg).not.toHaveBeenCalled();
	});

	it("feature override=false 不触发对应缺插件告警", async () => {
		const push = makePush();

		await warnMissingPlugins(makeCtx(), push, makeLogger(), [
			makeSub("dynamic", { featureEnabled: false }),
			makeSub("live", { featureEnabled: false }),
		]);

		expect(push.sendPrivateMsg).not.toHaveBeenCalled();
	});

	it("默认关闭的 live 细分特性只有显式 override=true 才触发告警", async () => {
		const push = makePush();

		await warnMissingPlugins(makeCtx(), push, makeLogger(), [
			makeSub("liveGuardBuy"),
			makeSub("superchat"),
			makeSub("specialDanmaku"),
			makeSub("specialUserEnter"),
		]);

		expect(push.sendPrivateMsg).not.toHaveBeenCalled();
	});

	it.each(LIVE_FEATURE_KEYS)("%s 路由启用且 live 插件缺失时告警", async (feature) => {
		const push = makePush();
		const logger = makeLogger();

		await warnMissingPlugins(makeCtx(), push, logger, [makeSub(feature, { featureEnabled: true })]);

		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(1);
		expect(push.sendPrivateMsg.mock.calls[0]?.[0]).toContain("直播插件");
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it("对应插件已注册时不告警", async () => {
		const push = makePush();

		await warnMissingPlugins(
			makeCtx({ "bilibili-notify-dynamic": {}, "bilibili-notify-live": {} }),
			push,
			makeLogger(),
			[makeSub("dynamic"), makeSub("live")],
		);

		expect(push.sendPrivateMsg).not.toHaveBeenCalled();
	});
});
