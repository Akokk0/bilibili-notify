/**
 * 把一份锐评发出去 —— 文案、卡片、降级、多目标。
 *
 * 与 `roast-generate.ts` 一样是两条路共用的:手动推送(`/roast/push`,单目标、内容
 * 由页面回传)和定时推送(调度器,多目标、内容自己生成)最终都落到这里。分成两份写
 * 的话,「渲染挂了降级成文字」这类行为迟早只有一条路上还留着。
 */

import type { RoastCardUp } from "@bilibili-notify/image";
import { colorFromUid, type NotificationPayload } from "@bilibili-notify/internal";
import { isTargetPaused } from "../config/target-pause.js";
import type { RouteDeps } from "../routes/types.js";

export type RoastDeliverDeps = Pick<RouteDeps, "runtime" | "store">;

/** 榜单结果里推送用得到的部分 —— 与 `StatsRoastResult` 结构兼容。 */
export interface BoardLike {
	pushText: string;
	pigeon: { uid: string; reason: string };
	diligent: { uid: string; reason: string };
	roast: Array<{ uid: string; comment: string }>;
	scores: Array<{ uid: string; score: number }>;
}

/** 单人结果里推送用得到的部分 —— 与 `StatsSoloRoastResult` 结构兼容。 */
export interface SoloLike {
	pushText: string;
	uid: string;
	verdict: string;
	score: number;
	highlights: Array<{ label: string; comment: string }>;
}

export interface DeliverOutcome {
	/** 实际发出去的形态。渲染不可用或失败时降级成 text。 */
	mode: "image" | "text";
	/** 成功送达的 targetId。 */
	sent: string[];
	/**
	 * 因为停用而没发的 targetId(目标自己停用,或它的适配器停用)。**不算失败**:停用是
	 * 主人自己按的,不该换来一条失败通知;以前把它扔给管线,要退避重试到上限才报「持续
	 * 不可达」。判定与链接解析白名单同一份(`config/target-pause.ts`)。
	 */
	skipped: string[];
	/** 没送出去的,带原因。管线自己已经退避重试过了,到这里就是彻底失败。 */
	failed: Array<{ targetId: string; err: string }>;
	/** 发出去的正文 —— 抄送主人时复用同一份,不另拼一遍。 */
	text: string;
}

/** uid → 名称 / 头像 / 配色。配色走 colorFromUid,与 dashboard 上同一位 UP 一致。 */
export function makeUpMeta(deps: RoastDeliverDeps): (uid: string) => RoastCardUp {
	const subByUid = new Map(deps.store.getSubscriptions().map((s) => [s.uid, s]));
	return (uid: string) => {
		const sub = subByUid.get(uid);
		const profile = sub ? deps.runtime.subRuntimeStore.get(sub.id)?.cachedProfile : undefined;
		return {
			name: profile?.name?.trim() || `UID ${uid}`,
			avatar: profile?.avatar || undefined,
			color: colorFromUid(uid),
		};
	};
}

/** 推送正文。模型给了 pushText 就用它,否则按类型拼一段兜底。 */
export function roastPushText(
	kind: "board" | "solo",
	result: BoardLike | SoloLike,
	days: number,
	upMeta: (uid: string) => RoastCardUp,
): string {
	if (result.pushText.trim()) return result.pushText;
	if (kind === "board") {
		const r = result as BoardLike;
		return [
			`📊 UP 主周报（近 ${days} 天）`,
			`🕊️ 本期鸽王：${upMeta(r.pigeon.uid).name} —— ${r.pigeon.reason}`,
			`🏆 勤奋 UP：${upMeta(r.diligent.uid).name} —— ${r.diligent.reason}`,
		].join("\n");
	}
	const s = result as SoloLike;
	return `📊 ${upMeta(s.uid).name}（近 ${days} 天）：${s.verdict}`;
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
	const upMeta = makeUpMeta(deps);
	const text = roastPushText(opts.kind, opts.result, opts.days, upMeta);

	const renderer = deps.runtime.engines?.imageRenderer ?? null;
	const imageWanted = renderer !== null && deps.store.getGlobals().defaults.cardStyle.enabled;
	if (!imageWanted || !renderer) return { mode: "text", payload: { kind: "text", text }, text };

	try {
		const buffer =
			opts.kind === "board"
				? await renderer.generateRoastBoardCard(
						boardCardData(opts.result as BoardLike, opts.days, upMeta),
					)
				: await renderer.generateRoastSoloCard(
						soloCardData(opts.result as SoloLike, opts.days, upMeta),
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
): Promise<DeliverOutcome> {
	const engines = deps.runtime.engines;
	const { mode, payload, text } = await buildRoastPayload(deps, opts);

	const targetsById = new Map(deps.store.getTargets().map((t) => [t.id, t]));
	const adapters = deps.store.getAdapters();
	const sent: string[] = [];
	const skipped: string[] = [];
	const failed: DeliverOutcome["failed"] = [];
	for (const targetId of opts.targetIds) {
		const target = targetsById.get(targetId);
		if (target && isTargetPaused(target, adapters)) {
			skipped.push(targetId);
			continue;
		}
		if (!engines) {
			failed.push({ targetId, err: "服务尚未就绪" });
			continue;
		}
		try {
			const delivery = await engines.push.sendToTarget(targetId, payload);
			if (delivery.ok) sent.push(targetId);
			else failed.push({ targetId, err: delivery.err ?? "推送失败" });
		} catch (err) {
			failed.push({ targetId, err: err instanceof Error ? err.message : String(err) });
		}
	}
	return { mode, sent, skipped, failed, text };
}

function boardCardData(r: BoardLike, days: number, upMeta: (uid: string) => RoastCardUp) {
	return {
		days,
		pigeon: { ...upMeta(r.pigeon.uid), reason: r.pigeon.reason },
		diligent: { ...upMeta(r.diligent.uid), reason: r.diligent.reason },
		roast: r.roast.map((x) => ({ ...upMeta(x.uid), comment: x.comment })),
		scores: r.scores.map((x) => ({ ...upMeta(x.uid), score: x.score })),
	};
}

function soloCardData(s: SoloLike, days: number, upMeta: (uid: string) => RoastCardUp) {
	return {
		days,
		up: upMeta(s.uid),
		verdict: s.verdict,
		score: s.score,
		highlights: s.highlights,
	};
}
