import { z } from "zod";

/**
 * 消息版式(发送侧结构)schema 版本。v1:动态 / 直播两套,块 = card(卡片图) /
 * text(文本:AI 点评 ?? 模板) / link(链接) / split(分条符),外加同条内文本类
 * 相邻部件的连接符 separator。结构演进时递增,配合 `normalizeMessageLayout`。
 *
 * 与卡片版式(card-layout)的关系:卡片版式管「一张图内部长什么样」,消息版式管
 * 「一次推送由哪些消息、每条消息装哪些部件」。@全体不进消息版式 —— 它保持
 * per-UP 默认 + per-target 覆写、独立成条 fire-and-forget 的既有机制
 * (见 packages/push 的 sendAtAllThenCard)。
 */
export const MESSAGE_LAYOUT_VERSION = 1;

/** 分条符块的 type。可插入多个、可删除;每个分条符把版式切成前后两条消息。 */
export const MESSAGE_SPLIT_TYPE = "split";

/** 消息部件语义类型(不含分条符)。 */
export type MessagePartType = "card" | "text" | "link";

/**
 * 单个消息块。`type` 是语义(内容块 card/text/link;分条符为 "split"),`id` 是实例
 * 唯一标识(内容块 id===type 各一份;分条符可多份,各有唯一 id)。`visible` 控显隐,
 * 顺序由数组位置决定。
 */
export const MessageBlockSchema = z.object({
	id: z.string(),
	type: z.string(),
	visible: z.boolean(),
});
export type MessageBlock = z.infer<typeof MessageBlockSchema>;

/** 单一推送类型的消息版式:有序块列表 + 同条内文本类相邻部件的连接符。 */
export const MessageKindLayoutSchema = z.object({
	blocks: z.array(MessageBlockSchema),
	separator: z.string(),
});
export type MessageKindLayout = z.infer<typeof MessageKindLayoutSchema>;

/**
 * 两种带消息版式的推送:动态(视频投稿共用同一套结构,仅模板文案不同)与直播
 * (开播 / 直播中 / 下播共用同一套结构,仅模板文案不同)。SC / 上舰 / 词云等维持
 * 现状,不进版式。
 */
export const MessageLayoutSchema = z.object({
	version: z.number().int().default(MESSAGE_LAYOUT_VERSION),
	dynamic: MessageKindLayoutSchema,
	live: MessageKindLayoutSchema,
});
export type MessageLayout = z.infer<typeof MessageLayoutSchema>;

const part = (type: MessagePartType): MessageBlock => ({ id: type, type, visible: true });

/**
 * 默认版式:复刻现状 —— 卡片 + 文本 + 链接合并一条消息、无分条符、分隔符换行。
 * (链接此前内嵌在模板 `{url}`/`{link}` 里;版式化后链接独立成部件,默认紧跟文本,
 * 同条内以换行连接,视觉上与旧默认模板等价。)
 */
export const DEFAULT_MESSAGE_LAYOUT: MessageLayout = {
	version: MESSAGE_LAYOUT_VERSION,
	dynamic: { blocks: [part("card"), part("text"), part("link")], separator: "\n" },
	live: { blocks: [part("card"), part("text"), part("link")], separator: "\n" },
};

/**
 * 取某推送类型的默认版式深拷贝,`opts.link` 控制链接部件显隐(缺省 true)。
 * 供不提供版式编辑 UI 的端(koishi 插件 config 的「附带链接」开关)按开关值
 * 生成引擎 config 级版式。
 */
export function defaultMessageKindLayout(
	kind: "dynamic" | "live",
	opts?: { link?: boolean },
): MessageKindLayout {
	const base = structuredClone(DEFAULT_MESSAGE_LAYOUT[kind]);
	if (opts?.link === false) {
		for (const b of base.blocks) {
			if (b.type === "link") b.visible = false;
		}
	}
	return base;
}

/**
 * 把一份(可能陈旧的)块数组对齐到当前已知内容块集(按 `type`):保留已知内容块与
 * **全部分条符**的顺序 / 显隐;丢弃未知内容块与重复内容块;缺失的已知内容块按
 * `defaults` 顺序追加到末尾。分条符由用户自由增删,不参与「补齐」。
 */
function reconcileBlocks(stored: MessageBlock[], defaults: MessageBlock[]): MessageBlock[] {
	const knownTypes = new Set(
		defaults.filter((b) => b.type !== MESSAGE_SPLIT_TYPE).map((b) => b.type),
	);
	const seen = new Set<string>();
	const kept: MessageBlock[] = [];
	for (const b of stored) {
		if (b.type === MESSAGE_SPLIT_TYPE) {
			kept.push(b);
			continue;
		}
		if (!knownTypes.has(b.type) || seen.has(b.type)) continue;
		seen.add(b.type);
		kept.push(b);
	}
	const appended = defaults.filter((b) => b.type !== MESSAGE_SPLIT_TYPE && !seen.has(b.type));
	return [...kept, ...appended];
}

/**
 * 向前兼容迁移:把持久化的消息版式对齐到当前内置块集。未知内容块丢弃、缺失的
 * 内置内容块追加(默认显示)、已知内容块与分条符保留用户的顺序 / 显隐。
 * version 归一到 `MESSAGE_LAYOUT_VERSION`。
 */
export function normalizeMessageLayout(
	stored: MessageLayout,
	defaults: MessageLayout,
): MessageLayout {
	return {
		version: MESSAGE_LAYOUT_VERSION,
		dynamic: {
			blocks: reconcileBlocks(stored.dynamic.blocks, defaults.dynamic.blocks),
			separator: stored.dynamic.separator ?? defaults.dynamic.separator,
		},
		live: {
			blocks: reconcileBlocks(stored.live.blocks, defaults.live.blocks),
			separator: stored.live.separator ?? defaults.live.separator,
		},
	};
}

/**
 * 纯规划器:把块列表按「可见性 + 分条符 + 实际可用部件」折算成消息组。
 * 每组 = 一条消息内按序的部件类型;`present` 是本次推送**实际产出**的部件集
 * (如卡片渲染失败则无 "card"),不在集合里的部件被剔除;空组(整条消息没内容)
 * 被丢弃。隐藏的分条符视同不存在(不切组)。返回 [] = 本次无任何可发内容。
 */
export function planMessageGroups(
	blocks: MessageBlock[],
	present: ReadonlySet<string>,
): MessagePartType[][] {
	const groups: MessagePartType[][] = [];
	let current: MessagePartType[] = [];
	const flush = (): void => {
		if (current.length > 0) groups.push(current);
		current = [];
	};
	for (const b of blocks) {
		if (!b.visible) continue;
		if (b.type === MESSAGE_SPLIT_TYPE) {
			flush();
			continue;
		}
		if (present.has(b.type)) current.push(b.type as MessagePartType);
	}
	flush();
	return groups;
}
