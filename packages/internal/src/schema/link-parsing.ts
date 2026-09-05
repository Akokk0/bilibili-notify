import { z } from "zod";
import { LINK_REPLY_FORMS, type LinkReplyForm } from "../constants";

/**
 * 链接解析(独立端专有):群里有人贴 B 站视频链接,机器人自动回一张卡。
 *
 * - `enabled` —— 总开关,**默认关**。开着就意味着同群任何人都能让机器人出图
 *   (指令文档里「不做群内指令」的顾虑同源),这得是主人自己按下去的。
 * - `cooldownSeconds` —— 同一个群里同一个视频多久内只出一次。0 = 不节流。
 *   上限一小时:再长就不是节流而是「第二次永远不出」,主人会以为坏了。
 * - `defaults` —— **默认行**:所有群解不解析(`parse`)、回什么(`form`)。「所有群」不是
 *   一种模式,它就是这一行。
 * - `groups` —— **逐群例外**,键是推送目标 id(`PushTarget.id`),值只存显式写了的字段,
 *   没写的字段跟默认行(与 per-UP 覆写同一套写法:每格三态)。不是推送目标的群没有 id,
 *   只能跟默认行。悬空的 id(目标后来删了)不在这里校验,运行时直接忽略。
 *
 * 0.9.1 存的是 `scope: all | selected` + `targets: [{ targetId }]`,读的时候按形状迁:
 * 所有群 = 默认行解析开;仅以下群 = 默认行解析关 + 列出的群显式开。「解析」与「形式」
 * 两条轴各配一套「所有群 / 指定群」会有四种形态,主人嫌乱,收成一张表。
 */
export const LinkReplyFormSchema = z.enum(LINK_REPLY_FORMS);

export const LinkParsingDefaultsSchema = z.object({
	parse: z.boolean().default(true),
	form: LinkReplyFormSchema.default("image"),
});
export type LinkParsingDefaults = z.infer<typeof LinkParsingDefaultsSchema>;

export const LinkParsingGroupOverrideSchema = z.object({
	parse: z.boolean().optional(),
	form: LinkReplyFormSchema.optional(),
});
export type LinkParsingGroupOverride = z.infer<typeof LinkParsingGroupOverrideSchema>;

const LinkParsingConfigObjectSchema = z.object({
	enabled: z.boolean().default(false),
	cooldownSeconds: z.number().int().min(0).max(3600).default(60),
	defaults: LinkParsingDefaultsSchema.default({ parse: true, form: "image" }),
	// 例外只存显式值:一个字段都没写的条目等于没写,剥掉。幂等 transform 而不是 refine:
	// 归一化数据,不让既有配置在 parse 时直接被拒(与订阅路由那份去重同一条理由)。
	groups: z
		.record(z.uuid(), LinkParsingGroupOverrideSchema)
		.default({})
		.transform((groups) =>
			Object.fromEntries(
				Object.entries(groups).filter(([, o]) => o.parse !== undefined || o.form !== undefined),
			),
		),
});
export type LinkParsingConfig = z.infer<typeof LinkParsingConfigObjectSchema>;

/**
 * 0.9.1 的「范围 + 白名单」→ 默认行 + 例外。只在老键在、新键不在时迁;新旧键同时出现
 * (补丁合并进老数据)认新的,老键丢掉。all 下的 `targets` 本来就不起作用,不带过来。
 */
function migrateLegacyLinkParsing(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
	const r = raw as Record<string, unknown>;
	if (!("scope" in r) && !("targets" in r)) return raw;
	const { scope, targets, ...rest } = r;
	if ("defaults" in rest || "groups" in rest) return rest;
	const selected = scope === "selected";
	const groups: Record<string, { parse: true }> = {};
	if (selected && Array.isArray(targets)) {
		for (const t of targets) {
			const id = (t as { targetId?: unknown } | null)?.targetId;
			if (typeof id === "string") groups[id] = { parse: true };
		}
	}
	return { ...rest, defaults: { parse: !selected, form: "image" }, groups };
}

export const LinkParsingConfigSchema = z.preprocess(
	migrateLegacyLinkParsing,
	LinkParsingConfigObjectSchema,
);

export const DEFAULT_LINK_PARSING: LinkParsingConfig = {
	enabled: false,
	cooldownSeconds: 60,
	defaults: { parse: true, form: "image" },
	groups: {},
};

/** 一个群折叠后的答案:解不解析、回什么。 */
export interface LinkParsingPolicy {
	parse: boolean;
	form: LinkReplyForm;
}

/**
 * 折叠出某个群的答案:例外里写了的字段覆盖默认行,没写的跟默认行。`targetId` 为空
 * (这个群不是推送目标)就是默认行本身。
 */
export function linkParsingFor(
	config: Pick<LinkParsingConfig, "defaults" | "groups">,
	targetId: string | undefined,
): LinkParsingPolicy {
	const o = targetId === undefined ? undefined : config.groups[targetId];
	return { parse: o?.parse ?? config.defaults.parse, form: o?.form ?? config.defaults.form };
}
