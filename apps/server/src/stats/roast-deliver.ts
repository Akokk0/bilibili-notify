import { type SourceNounsInput, sourceNounsOf } from "@bilibili-notify/contract";
import { t } from "../i18n/index.js";
/**
 * 把一份锐评发出去 —— 文案、卡片、降级、多目标。
 *
 * 与 `roast-generate.ts` 一样是两条路共用的:手动推送(`/roast/push`,单目标、内容
 * 由页面回传)和定时推送(调度器,多目标、内容自己生成)最终都落到这里。分成两份写
 * 的话,「渲染挂了降级成文字」这类行为迟早只有一条路上还留着。
 */

import type { RoastCardCreator } from "@bilibili-notify/image";
import {
	colorFromSeed,
	type Failure,
	fail,
	identityColor,
	isTargetPaused,
	type NotificationPayload,
	type Subscription,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { imageDataUrl, readProfileAvatar } from "../images/profile-avatar.js";
import type { RouteDeps } from "../routes/types.js";
import { roastSubjectName } from "./roast-subject.js";

export type RoastDeliverDeps = Pick<RouteDeps, "runtime" | "store">;

/** 榜单结果里推送用得到的部分 —— 与 `StatsRoastResult` 结构兼容。UP 一律按订阅 id 回指(ADR-0020 决策 18)。 */
export interface BoardLike {
	pushText: string;
	pigeon: { subscriptionId: string; reason: string };
	diligent: { subscriptionId: string; reason: string };
	roast: Array<{ subscriptionId: string; comment: string }>;
	scores: Array<{ subscriptionId: string; score: number }>;
}

/** 单人结果里推送用得到的部分 —— 与 `StatsSoloRoastResult` 结构兼容。 */
export interface SoloLike {
	pushText: string;
	subscriptionId: string;
	verdict: string;
	score: number;
	highlights: Array<{ label: string; comment: string }>;
}

export interface RoastDeliveryResult {
	/** 实际发出去的形态。渲染不可用或失败时降级成 text。 */
	mode: "image" | "text";
	/** 成功送达的 targetId。 */
	sent: string[];
	/**
	 * 因为停用而没发的 targetId(目标自己停用,或它的连接停用)。**不算失败**:停用是
	 * 主人自己按的,不该换来一条失败通知;以前把它扔给管线,要退避重试到上限才报「持续
	 * 不可达」。判定与链接解析同一份(internal 的 `isTargetPaused`)。
	 */
	skipped: string[];
	/**
	 * 没送出去的,带着投递那头的失败(标准码、原话、平台自己的码,ADR-0026)。管线自己已经退避重试过了,
	 * 到这里就是彻底失败。
	 */
	failed: Array<{ targetId: string; failure: Failure }>;
	/** 发出去的正文 —— 抄送主人时复用同一份,不另拼一遍。 */
	text: string;
}

/**
 * 卡上的头像:资料里引用的那张图库图转成内嵌图(ADR-0020 决策 15)。面板用的同源地址
 * (`/api/images/<ref>`)截图的浏览器加载不到(同 ADR-0019 决策 68 那个坑)。没存、图已经不在、认不出
 * 类型、读盘抛了都给 `undefined` —— 卡上画首字母圆牌,不因为一张头像让整张卡降级成文字。
 */
async function storedAvatar(deps: RoastDeliverDeps, subscriptionId: string) {
	try {
		const stored = await readProfileAvatar(deps.runtime, subscriptionId);
		return stored ? imageDataUrl(stored.bytes) : undefined;
	} catch {
		return undefined;
	}
}

/** 一条订阅在卡上的样子。颜色跟着人走,与面板同一个算法(`identityColor`,ADR-0020 决策 15)。 */
async function cardUp(
	deps: RoastDeliverDeps,
	subscriptionId: string,
	sub: Subscription | undefined,
): Promise<RoastCardCreator> {
	if (!sub) return { name: t("stats.roast.unknownCreator"), color: colorFromSeed(subscriptionId) };
	const name = roastSubjectName(deps, sub);
	const identity = subscriptionIdentityOf(sub);
	// 宿主保留的描述符在来源未运行时也可读，与面板来源表采用同一规则。
	const descriptor = deps.runtime.sourceRegistry.getRunView(identity.sourceKey)?.descriptor;
	const color = identityColor(identity, descriptor);
	// 头像只认图库里那张(两支订阅一样):还没抓到(新订阅抓不到、或老资料等着开机冷刷补)就没有头像,
	// 卡上画首字母圆牌 —— 渲染页不联网,来源地址交过去也画不出来。
	return { name, avatar: await storedAvatar(deps, sub.id), color };
}

/**
 * 订阅 id → 名称 / 头像 / 配色(两支订阅都行,ADR-0020 决策 18)。名字走 `roast-subject.ts`(与提示词里的
 * 同一份);头像要读盘,所以先把这份锐评提到的人一次备齐,返回的查表是同步的。
 */
export async function makeUpMeta(
	deps: RoastDeliverDeps,
	subscriptionIds: Iterable<string>,
): Promise<(subscriptionId: string) => RoastCardCreator> {
	const subById = new Map(deps.store.getSubscriptions().map((s) => [s.id, s]));
	const metas = new Map<string, RoastCardCreator>();
	await Promise.all(
		[...new Set(subscriptionIds)].map(async (id) => {
			metas.set(id, await cardUp(deps, id, subById.get(id)));
		}),
	);
	return (id) =>
		metas.get(id) ?? { name: t("stats.roast.unknownCreator"), color: colorFromSeed(id) };
}

/** 这份锐评提到的所有订阅 id —— 卡上与兜底文案要画的就是这几位。 */
function mentionedIds(kind: "board" | "solo", result: BoardLike | SoloLike): string[] {
	if (kind === "solo") return [(result as SoloLike).subscriptionId];
	const r = result as BoardLike;
	return [r.pigeon, r.diligent, ...r.roast, ...r.scores].map((x) => x.subscriptionId);
}

/** 推送正文。模型给了 pushText 就用它,否则按类型拼一段兜底。 */
export function roastPushText(
	kind: "board" | "solo",
	result: BoardLike | SoloLike,
	days: number,
	upMeta: (subscriptionId: string) => RoastCardCreator,
	creatorNoun: string,
): string {
	if (result.pushText.trim()) return result.pushText;
	if (kind === "board") {
		const r = result as BoardLike;
		return [
			t("stats.roast.boardHeading", { creatorNoun, days }),
			t("stats.roast.pigeonLine", {
				name: upMeta(r.pigeon.subscriptionId).name,
				reason: r.pigeon.reason,
			}),
			t("stats.roast.diligentLine", {
				creatorNoun,
				name: upMeta(r.diligent.subscriptionId).name,
				reason: r.diligent.reason,
			}),
		].join("\n");
	}
	const s = result as SoloLike;
	return t("stats.roast.soloLine", {
		name: upMeta(s.subscriptionId).name,
		days,
		verdict: s.verdict,
	});
}

/**
 * 渲染 + 投递。
 *
 * **图只渲一次**,多个目标复用同一个 buffer —— 一份周报发三个群不该开三次
 * puppeteer(渲染器本来就是串行队列,那样等于把这条推送拖长三倍)。
 *
 * 渲染路上任何一步出问题都**降级成文字**而不是整条失败:一份已经生成好、甚至已经
 * 过主人眼的周报,不该因为服务器上没装 Chrome 就发不出去。
 *
 * 单个目标失败不影响其他目标 —— 群 A 把机器人踢了,不该连累群 B 收不到。发送本身
 * 的重试由推送管线负责(退避 + routing 复检),这里拿到的已经是终局。
 */
export interface RoastPayload {
	/** 实际形态。渲染不可用或失败时降级成 text。 */
	mode: "image" | "text";
	/** 送出去的消息本体。 */
	payload: NotificationPayload;
	/** 正文。图片形态下它同时是 caption。 */
	text: string;
}

/**
 * 把一份锐评**渲染成待发的消息**,但不发。
 *
 * 从 {@link deliverRoast} 里抽出来的前半段。抽的理由不是复用好看,而是审批预览
 * 必须发**将来真会发出去的那一份** —— 让主人过目一段文字、群里却收到一张信息更
 * 多的卡片,那个「过目」就是假的。
 *
 * 代价是获批的那份会渲染两次(预览一次、真发一次)。周报是周级低频动作,而渲染器
 * 本来就是串行队列,这点开销换「批的就是发的」值得;把 buffer 塞进落盘的草稿里
 * 反而要往 JSON 里塞 base64,还得跟 48 小时 TTL 一起过期。
 */
export async function buildRoastPayload(
	deps: RoastDeliverDeps,
	opts: { kind: "board" | "solo"; result: BoardLike | SoloLike; days: number },
): Promise<RoastPayload> {
	const ids = mentionedIds(opts.kind, opts.result);
	const subById = new Map(deps.store.getSubscriptions().map((sub) => [sub.id, sub]));
	const sources = new Map<string | undefined, SourceNounsInput>();
	for (const id of ids) {
		const sub = subById.get(id);
		const key = sub ? subscriptionIdentityOf(sub).sourceKey : undefined;
		// 失去订阅的参与者也占一个未知来源,不能把混合榜误称成剩下那一家的榜。
		sources.set(
			key,
			key === undefined ? {} : (deps.runtime.sourceRegistry.get(key)?.descriptor ?? {}),
		);
	}
	const { creatorNoun } = sourceNounsOf([...sources.values()], {
		creatorNoun: t("nouns.creator"),
		postNoun: t("nouns.post"),
		sources: t("nouns.sources"),
	});
	const upMeta = await makeUpMeta(deps, ids);
	const text = roastPushText(opts.kind, opts.result, opts.days, upMeta, creatorNoun);

	const renderer = deps.runtime.pipeline?.imageRenderer ?? null;
	const imageWanted = renderer !== null && deps.store.getGlobals().defaults.cards.enabled;
	if (!imageWanted || !renderer) return { mode: "text", payload: { kind: "text", text }, text };

	// 锐评卡与词云卡同源:不属于任何单个 UP,吃的是全局那套皮肤(ADR-0014)。
	const cardSkin = deps.store.getGlobals().defaults.cardSkin;
	try {
		const buffer =
			opts.kind === "board"
				? await renderer.generateRoastBoardCard(
						boardCardData(opts.result as BoardLike, opts.days, upMeta, creatorNoun),
						{ cardSkin },
					)
				: await renderer.generateRoastSoloCard(
						soloCardData(opts.result as SoloLike, opts.days, upMeta),
						{ cardSkin },
					);
		// caption 不是装饰:图挂了 / 客户端不展图时,那段文字是唯一还读得到的东西。
		return {
			mode: "image",
			payload: { kind: "image", image: { buffer, mime: "image/jpeg" }, caption: text },
			text,
		};
	} catch (err) {
		deps.runtime.serviceCtx.logger.warn(
			`[roast] 卡片渲染失败，降级为文字推送: ${err instanceof Error ? err.message : String(err)}`,
		);
		return { mode: "text", payload: { kind: "text", text }, text };
	}
}

export async function deliverRoast(
	deps: RoastDeliverDeps,
	opts: {
		kind: "board" | "solo";
		result: BoardLike | SoloLike;
		days: number;
		targetIds: readonly string[];
	},
): Promise<RoastDeliveryResult> {
	const pipeline = deps.runtime.pipeline;
	const { mode, payload, text } = await buildRoastPayload(deps, opts);

	const targetsById = new Map(deps.store.getTargets().map((target) => [target.id, target]));
	const connections = deps.store.getConnections();
	const sent: string[] = [];
	const skipped: string[] = [];
	const failed: RoastDeliveryResult["failed"] = [];
	for (const targetId of opts.targetIds) {
		const target = targetsById.get(targetId);
		if (target && isTargetPaused(target, connections)) {
			skipped.push(targetId);
			continue;
		}
		if (!pipeline) {
			failed.push({ targetId, failure: fail("unavailable", t("stats.roast.serviceUnavailable")) });
			continue;
		}
		try {
			const delivery = await pipeline.push.sendToTarget(targetId, payload);
			if (delivery.ok) sent.push(targetId);
			else failed.push({ targetId, failure: delivery });
		} catch (err) {
			// 发送层自己不抛;真抛了算 bug(ADR-0026 决策 1),按「暂时不可用」记。
			failed.push({
				targetId,
				failure: fail("unavailable", err instanceof Error ? err.message : String(err)),
			});
		}
	}
	return { mode, sent, skipped, failed, text };
}

function boardCardData(
	r: BoardLike,
	days: number,
	upMeta: (id: string) => RoastCardCreator,
	creatorNoun: string,
) {
	return {
		days,
		creatorNoun,
		pigeon: { ...upMeta(r.pigeon.subscriptionId), reason: r.pigeon.reason },
		diligent: { ...upMeta(r.diligent.subscriptionId), reason: r.diligent.reason },
		roast: r.roast.map((x) => ({ ...upMeta(x.subscriptionId), comment: x.comment })),
		scores: r.scores.map((x) => ({ ...upMeta(x.subscriptionId), score: x.score })),
	};
}

function soloCardData(s: SoloLike, days: number, upMeta: (id: string) => RoastCardCreator) {
	return {
		days,
		creator: upMeta(s.subscriptionId),
		verdict: s.verdict,
		score: s.score,
		highlights: s.highlights,
	};
}
