import type { PlatformSnapshot } from "@bilibili-notify/internal";
import { t } from "../i18n/index.js";

export const PLATFORM_REGISTRY = {
	get onebot(): PlatformSnapshot & { adapterKey: string } {
		return {
			label: "OneBot v11",
			shortLabel: "OneBot",
			color: "#3b82f6",
			icon: "qq",
			adapterKey: "onebot",
			targetKind: "session",
			// OneBot 没有频道概念 —— 只给群与私聊两档。
			scopes: ["group", "private"],
			addressNouns: {
				group: t("platforms.candidates.group"),
				private: t("platforms.candidates.private"),
			},
		};
	},
	get "qq-official"(): PlatformSnapshot & { adapterKey: string } {
		return {
			label: t("platforms.candidates.qq.label"),
			shortLabel: t("platforms.candidates.qq.shortLabel"),
			color: "#14b8a6",
			icon: "qq",
			adapterKey: "qq-official",
			targetKind: "session",
			scopes: ["group", "private", "channel"],
			addressNouns: {
				group: t("platforms.candidates.qq.group"),
				private: "C2C",
				channel: t("platforms.candidates.channel"),
			},
		};
	},
	get feishu(): PlatformSnapshot & { adapterKey: string } {
		return {
			label: t("platforms.candidates.feishu.label"),
			shortLabel: t("platforms.candidates.feishu.shortLabel"),
			color: "#3370ff",
			icon: "feishu",
			adapterKey: "webhook",
			targetKind: "endpoint",
			scopes: ["channel"],
			addressNouns: {},
		};
	},
	get dingtalk(): PlatformSnapshot & { adapterKey: string } {
		return {
			label: t("platforms.candidates.dingtalk.label"),
			shortLabel: t("platforms.candidates.dingtalk.shortLabel"),
			color: "#00c2ff",
			icon: "dingtalk",
			adapterKey: "webhook",
			targetKind: "endpoint",
			scopes: ["channel"],
			addressNouns: {},
		};
	},
	get wecom(): PlatformSnapshot & { adapterKey: string } {
		return {
			label: t("platforms.candidates.wecom.label"),
			shortLabel: t("platforms.candidates.wecom.shortLabel"),
			color: "#07c160",
			icon: "wecom",
			adapterKey: "webhook",
			targetKind: "endpoint",
			scopes: ["channel"],
			addressNouns: {},
		};
	},
	get generic(): PlatformSnapshot & { adapterKey: string } {
		return {
			label: t("platforms.candidates.generic.label"),
			shortLabel: t("platforms.candidates.generic.shortLabel"),
			// 没有品牌可借,给一档中性的板岩灰。
			color: "#94a3b8",
			adapterKey: "webhook",
			targetKind: "endpoint",
			scopes: ["channel"],
			addressNouns: {},
		};
	},
} satisfies Record<string, PlatformSnapshot & { adapterKey: string }>;

/** 认不认识这个平台 —— 认识就把它的那一行交出来。目标侧的平台是开放词表,常常认不出。 */
export function platformDescriptor(
	platform: string,
): (PlatformSnapshot & { adapterKey: string }) | undefined {
	return (PLATFORM_REGISTRY as Record<string, PlatformSnapshot & { adapterKey: string }>)[platform];
}

/**
 * 出站 webhook 那一族平台。
 *
 * 它是注册表的一个**投影**,写成字面量只因为 `z.enum` 与类型都要求可枚举的元组 ——
 * 两边会不会漂由 `platform-registry.test.ts` 钉着。判据本身在注册表:走 webhook 连的
 * 就是这一族,别在各处手写四个平台名。
 */
export const WEBHOOK_PLATFORMS = ["feishu", "dingtalk", "wecom", "generic"] as const;
export type WebhookPlatform = (typeof WEBHOOK_PLATFORMS)[number];

/** 这个平台是不是靠 webhook 连的。 */
export function isWebhookPlatform(platform: string): platform is WebhookPlatform {
	return platformDescriptor(platform)?.adapterKey === "webhook";
}
