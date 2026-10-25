/**
 * 内置连接平台注册表 —— 平台名称、颜色、适配器、目标形态与能力相关常量的唯一来源。
 *
 * 零依赖:只许 `import type`,值级 import 只能指向零依赖名单里的同伴。
 * 面板与 contract 经 `@bilibili-notify/internal/platform-registry` 取值。
 */

import type { PushTargetScope } from "./push-target.js";
import type { PlatformSnapshot } from "./schema/targets.js";

/**
 * **连接**能连的平台。词表住零依赖模块,前端也拿得到(与 `features.ts` 的 FEATURE_KEYS 同一套安排)。
 *
 * 这是**闭集**,因为每一档都要有一份 config schema、一个 server adapter、一排面板控件。
 * 它以前叫 `PUSH_TARGET_PLATFORMS`,同时也是推送目标那一格的词表 —— 但**目标那边是开的**:
 * 桥驮进来的平台(telegram、discord…)枚举不了,列进闭集等于要求先改词表才能收到它们。
 * 一个类型糊着开、闭两套词表,总有一边是错的,所以拆了。
 */
export const CONNECTION_PLATFORMS = [
	"onebot",
	"qq-official",
	"feishu",
	"dingtalk",
	"wecom",
	"generic",
] as const;
export type ConnectionPlatform = (typeof CONNECTION_PLATFORMS)[number];

/**
 * 一个平台的全部事实 —— 面板怎么叫它、归哪个适配器、它的目标长什么样、收不收得到回复。
 *
 * 这些事实原先散在**六处**各说各的:连接侧闭集与 webhook 那一族(本文件)、入站能力词表
 * (本文件)、面板的平台选择器(`apps/web/src/types/domain.ts` 的 `KNOWN_PLATFORMS`)、
 * 组件库里的色与短名(`packages/ui` 的 `PLATFORM_META`)、目标表单的会话种类与地址称呼
 * (`apps/web/src/pages/Targets.tsx`)、以及 server 那边每个 adapter 自报的 `adapterKey`。
 * 六份的代价不是重复本身,是**加一个平台要记得改六个地方**,漏掉哪一处都没有编译错 ——
 * 少了色就退灰、少了会话种类就只给通用三档,全都是「能跑但不对」。
 *
 * 所以事实收在这一张表里,那六处改成从它取。色与图标名也在这儿:一个十六进制串是数据、
 * 不是组件,把它留在组件库等于让纯展示件库认识业务平台(那正是 `PlatformIcon` 要改成
 * 注入式的原因)。
 *
 * 每一行是连接上那份 {@link PlatformSnapshot}(见 `schema/targets.ts`)加一格 `adapterKey`
 * (哪个适配器负责它)。
 *
 * 平台注册表。加一个平台从这里开始 —— 少一格是编译错,不是静默的默认值。
 *
 * `feishu` / `dingtalk` / `wecom` / `generic` 这一族原先是 webhook 连接 config 里的一个
 * `provider` 字段 —— 因为「webhook」被当成了平台,真平台只好降级成它的一个属性。可
 * webhook 从来不是平台,它是**怎么连**:飞书和钉钉是两个平台,只是恰好都用「往一个 URL
 * POST 一段 JSON」这种连法。所以 provider 升格成平台,这一族共用 `webhook` 这一个适配器。
 * `generic` 是承认的疤:主人贴的 URL 可能是自建服务,那就没有平台可言 —— 面板上写
 * 「未指明的 HTTP 端点」,不假装它是个什么。
 */
export const PLATFORM_REGISTRY: Readonly<
	Record<ConnectionPlatform, PlatformSnapshot & { adapterKey: string }>
> = {
	onebot: {
		label: "OneBot v11",
		shortLabel: "OneBot",
		color: "#3b82f6",
		icon: "qq",
		adapterKey: "onebot",
		targetKind: "session",
		// OneBot 没有频道概念 —— 只给群与私聊两档。
		scopes: ["group", "private"],
		addressNouns: { group: "群", private: "用户" },
	},
	"qq-official": {
		label: "QQ 官方机器人",
		shortLabel: "QQ官方",
		color: "#14b8a6",
		icon: "qq",
		adapterKey: "qq-official",
		targetKind: "session",
		scopes: ["group", "private", "channel"],
		addressNouns: { group: "群 openid", private: "C2C", channel: "子频道" },
	},
	feishu: {
		label: "飞书机器人",
		shortLabel: "飞书",
		color: "#3370ff",
		icon: "feishu",
		adapterKey: "webhook",
		targetKind: "endpoint",
		scopes: ["channel"],
		addressNouns: {},
	},
	dingtalk: {
		label: "钉钉机器人",
		shortLabel: "钉钉",
		color: "#00c2ff",
		icon: "dingtalk",
		adapterKey: "webhook",
		targetKind: "endpoint",
		scopes: ["channel"],
		addressNouns: {},
	},
	wecom: {
		label: "企业微信机器人",
		shortLabel: "企微",
		color: "#07c160",
		icon: "wecom",
		adapterKey: "webhook",
		targetKind: "endpoint",
		scopes: ["channel"],
		addressNouns: {},
	},
	generic: {
		label: "未指明的 HTTP 端点",
		shortLabel: "HTTP 端点",
		// 没有品牌可借,给一档中性的板岩灰。
		color: "#94a3b8",
		adapterKey: "webhook",
		targetKind: "endpoint",
		scopes: ["channel"],
		addressNouns: {},
	},
};

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

/**
 * 这个平台的这种会话,地址那一格该叫什么。
 *
 * 认不出的平台(桥驮进来的)走通用称呼 —— 不认识不等于说不出话,「群 / 用户 / 子频道」
 * 对任何一个聊天平台都成立。
 */
export function addressNounFor(platform: string, scope: PushTargetScope): string {
	const named = platformDescriptor(platform)?.addressNouns[scope];
	if (named) return named;
	if (scope === "channel") return "子频道";
	return scope === "private" ? "用户" : "群";
}

// ---------------------------------------------------------------------------
// OneBot 慢动作的超时下限
// ---------------------------------------------------------------------------

/**
 * 带图普通消息(`send_group_msg` / `send_private_msg` 里含 image 段)的超时下限。
 *
 * 协议端收到带图消息后要先把图落盘、上传到 QQ 图床、拿回 fileid 才组消息回响应,
 * 这个往返与图多大关系不大(卡片图只有 0.1MB 量级),但稳定压在十几秒 —— 默认的
 * 15s 正好卡在临界点上,于是时好时坏。用户实测(LLOneBot):词云 / 动态卡反复标
 * 失败,服务端日志每一条都恰好停在 `响应超时 (15000ms)`,而同时段纯文字全部秒回。
 *
 * 只作**下限**(取 `max(配置值, 此值)`):主人把超时调得更大是有意为之,别被压低。
 * 纯文字不适用 —— 协议端真挂了的场景,每条文本都多等半分钟只会让失败来得更晚。
 *
 * 两端共享:服务端据它放宽超时(`apps/server/src/platforms/onebot.ts`),前端据它
 * 写超时那栏的说明文案,免得两边各写一个数、改了一处另一处照旧。
 */
export const ONEBOT_IMAGE_MIN_TIMEOUT_MS = 30_000;

/**
 * 合并转发(`send_*_forward_msg`)的超时下限。比单图那档长一倍:forward 要把每张图
 * 逐张下载再上传组装,9 图常要 20~60s。
 */
export const ONEBOT_FORWARD_MIN_TIMEOUT_MS = 60_000;
