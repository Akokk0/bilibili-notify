/**
 * 0.x 的平台表,冻住。直连连接迁成新形状时照它填 `adapterKey` 与 `platformSnapshot`。
 *
 * 活的平台表(`@bilibili-notify/internal` 的 `PLATFORM_REGISTRY`)以后还要删,迁移只写一次,
 * 所以这个文件**不 import 它、也不 import `platforms/`**:值逐格抄自当年的表,和活表之间由
 * `platforms/__tests__/zero-platforms.test.ts` 对拍(那条测试把这份冻结副本钉在今天的活表上)。
 */

export interface ZeroPlatformRow {
	/** 哪个适配器负责它。 */
	readonly adapterKey: string;
	/** 0.x v1 → v2 那一步补 `connector` 用的默认连法(不进快照)。 */
	readonly connector: string;
	readonly snapshot: {
		readonly label: string;
		readonly shortLabel: string;
		readonly color: string;
		readonly icon?: string;
		readonly targetKind: "session" | "endpoint";
		readonly scopes: readonly ("group" | "private" | "channel")[];
		readonly addressNouns: {
			readonly group?: string;
			readonly private?: string;
			readonly channel?: string;
		};
	};
}

export const ZERO_PLATFORMS: Readonly<Record<string, ZeroPlatformRow>> = {
	onebot: {
		adapterKey: "onebot",
		connector: "http",
		snapshot: {
			label: "OneBot v11",
			shortLabel: "OneBot",
			color: "#3b82f6",
			icon: "qq",
			targetKind: "session",
			scopes: ["group", "private"],
			addressNouns: { group: "群", private: "用户" },
		},
	},
	"qq-official": {
		adapterKey: "qq-official",
		connector: "ws",
		snapshot: {
			label: "QQ 官方机器人",
			shortLabel: "QQ官方",
			color: "#14b8a6",
			icon: "qq",
			targetKind: "session",
			scopes: ["group", "private", "channel"],
			addressNouns: { group: "群 openid", private: "C2C", channel: "子频道" },
		},
	},
	feishu: {
		adapterKey: "webhook",
		connector: "webhook",
		snapshot: {
			label: "飞书机器人",
			shortLabel: "飞书",
			color: "#3370ff",
			icon: "feishu",
			targetKind: "endpoint",
			scopes: ["channel"],
			addressNouns: {},
		},
	},
	dingtalk: {
		adapterKey: "webhook",
		connector: "webhook",
		snapshot: {
			label: "钉钉机器人",
			shortLabel: "钉钉",
			color: "#00c2ff",
			icon: "dingtalk",
			targetKind: "endpoint",
			scopes: ["channel"],
			addressNouns: {},
		},
	},
	wecom: {
		adapterKey: "webhook",
		connector: "webhook",
		snapshot: {
			label: "企业微信机器人",
			shortLabel: "企微",
			color: "#07c160",
			icon: "wecom",
			targetKind: "endpoint",
			scopes: ["channel"],
			addressNouns: {},
		},
	},
	generic: {
		adapterKey: "webhook",
		connector: "webhook",
		snapshot: {
			label: "未指明的 HTTP 端点",
			shortLabel: "HTTP 端点",
			color: "#94a3b8",
			targetKind: "endpoint",
			scopes: ["channel"],
			addressNouns: {},
		},
	},
};

/** 0.x 连接的四种连法。 */
export const ZERO_CONNECTORS: readonly string[] = ["http", "ws", "ws-reverse", "webhook"];

/** 认得的 0.x 平台回它的那一行;认不得回 undefined。 */
export function zeroPlatform(platform: unknown): ZeroPlatformRow | undefined {
	return typeof platform === "string" && Object.hasOwn(ZERO_PLATFORMS, platform)
		? ZERO_PLATFORMS[platform]
		: undefined;
}

/** 这个平台是不是靠 webhook 连的(0.x 的那四个名字)。 */
export function isZeroWebhookPlatform(platform: unknown): boolean {
	return zeroPlatform(platform)?.connector === "webhook";
}

/**
 * 拓展借来的 bot:迁移问不到适配器,填中性占位(与 internal 的 `neutralPlatformSnapshot`
 * 逐格相等,有测试钉着)。
 */
export function zeroNeutralSnapshot(platform: string) {
	return {
		label: platform,
		shortLabel: platform,
		color: "#94a3b8",
		targetKind: "session" as const,
		scopes: ["group", "private", "channel"] as const,
		addressNouns: {},
	};
}
