import { createRequire } from "node:module";
import type { BilibiliAPI } from "@bilibili-notify/api";
import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import {
	BILIBILI_NOTIFY_INTERNALS_PROTOCOL,
	type BilibiliNotifyInternalsProbe,
	type BilibiliNotifyInternalsProtocolInfo,
} from "@bilibili-notify/koishi-runtime";
import type { BilibiliPush } from "@bilibili-notify/push";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import type { TargetRegistry } from "./target-registry";

// 该文件刻意只 import type 重型运行时(api / push / store / registry),唯一的运行时
// 值 import 是纯 Symbol 的 BILIBILI_NOTIFY_TOKEN —— 这样 internals-probe.test.ts
// 引入它时不会连带拉起 sink.ts → koishi loader(import 期会抛 Class extends 错)。
// probe 的生产逻辑(token / 四件套就绪顺序)由此得以独立单测。

const require_ = createRequire(import.meta.url);

function readCoreVersion(): string {
	try {
		return (require_("../package.json") as { version?: string }).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

export const CORE_INTERNALS_PROTOCOL: BilibiliNotifyInternalsProtocolInfo = {
	...BILIBILI_NOTIFY_INTERNALS_PROTOCOL,
	coreVersion: readCoreVersion(),
};

/** Shape returned by `BilibiliNotifyServerManager.getInternals(BILIBILI_NOTIFY_TOKEN)`. */
export interface InternalsShape {
	protocol: BilibiliNotifyInternalsProtocolInfo;
	api: BilibiliAPI;
	push: BilibiliPush;
	store: SubscriptionStore;
	/**
	 * Koishi-side PushTarget registry. Friendly plugins (e.g. AI tools that
	 * create subscriptions on the user's behalf) need this to resolve a real
	 * targetId to wire into `Subscription.routing` instead of inventing a
	 * random UUID that points at no target.
	 */
	registry: TargetRegistry;
}

export function buildInternalsProbe(args: {
	token: symbol;
	api: BilibiliAPI | null;
	push: BilibiliPush | null;
	store: SubscriptionStore | null;
	registry: TargetRegistry | null;
}): BilibiliNotifyInternalsProbe<InternalsShape> {
	if (args.token !== BILIBILI_NOTIFY_TOKEN)
		return {
			ok: false,
			protocol: CORE_INTERNALS_PROTOCOL,
			reason: "token-mismatch",
		};
	if (!args.api)
		return {
			ok: false,
			protocol: CORE_INTERNALS_PROTOCOL,
			reason: "api",
		};
	if (!args.push)
		return {
			ok: false,
			protocol: CORE_INTERNALS_PROTOCOL,
			reason: "push",
		};
	if (!args.store)
		return {
			ok: false,
			protocol: CORE_INTERNALS_PROTOCOL,
			reason: "store",
		};
	if (!args.registry)
		return {
			ok: false,
			protocol: CORE_INTERNALS_PROTOCOL,
			reason: "registry",
		};
	return {
		ok: true,
		protocol: CORE_INTERNALS_PROTOCOL,
		internals: {
			protocol: CORE_INTERNALS_PROTOCOL,
			api: args.api,
			push: args.push,
			store: args.store,
			registry: args.registry,
		},
	};
}
