import type {
	ExtensionBlock,
	ExtensionContext,
	ExtensionOwnSubscription,
	ExtensionRichText,
	SubscriptionSourceHandle,
} from "@bilibili-notify/extension";
import {
	type FakeLiveSession,
	fakeLiveDetails,
	fakeLiveUrl,
	fakePost,
	fakePostWithBadImage,
	fakePostWithExtraField,
	fakeProfile,
} from "./reports.js";

/**
 * 假源页面上的上报按钮(ADR-0019 决策 62):开发时拿它造事件,把「拓展报 → BN 收」那条路在真机上走一遍。
 *
 * 视图里的按钮带不了「点的是哪一行」(决策 42:handler 只收一个 `AbortSignal`),所以每颗都**一次作用于
 * 名下所有开着的订阅** —— 按外部 id 报,同一个人两条订阅也只报一次(宿主自己按 `(拓展, 外部 id)` 扇出)。
 * 停用的不报:事件与直播状态宿主本来也不往停用的发。
 *
 * 序号只在真报出去时才往前走:没有开着的订阅时按的那一下什么都不报,也不占号。
 */

/** 一颗按钮:清单 `actions` 里的动作名 + 视图里那行字(按钮上的字只认视图里这一份,决策 42)。 */
interface ReportButton {
	action: string;
	label: string;
}

const POST: ReportButton = { action: "report.post", label: "报一条作品" };
const LIVE_START: ReportButton = { action: "report.liveStart", label: "开播" };
const LIVE_END: ReportButton = { action: "report.liveEnd", label: "下播" };
const PROFILE: ReportButton = { action: "report.profile", label: "报资料" };
const LIVE_STATUS: ReportButton = { action: "report.liveStatus", label: "报直播状态" };
const BAD_IMAGE: ReportButton = { action: "report.badImage", label: "报一条带坏图的作品" };
const EXTRA_FIELD: ReportButton = { action: "report.extraField", label: "报一条多一格的作品" };

/**
 * 报直播状态每按一次,此刻在线涨这么多;开播时就是这个数。
 *
 * 累计观看每次涨十倍这么多 —— 两个数差一个数量级,首页那一列(画的是累计观看,决策 75)一眼认得出
 * 不是在线。
 */
const VIEWERS_STEP = 100;
const TOTAL_VIEWERS_STEP = VIEWERS_STEP * 10;

/**
 * 按一下要做的事:`each` 给每个开着的人报一次,`note` 是报完之后页上那行字的括号里那句。**只在有人可报时
 * 才叫** —— 序号与直播那一场都在这里往前走。
 */
type Prepare = (now: number) => { each: (externalId: string) => Promise<void>; note: string };

/** 开着的订阅指向的人,按先出现的次序、每人一次。 */
function openPeople(subs: readonly ExtensionOwnSubscription[]): string[] {
	return [...new Set(subs.filter((one) => one.enabled).map((one) => one.externalId))];
}

/**
 * 接上七颗按钮,交回页上那几块积木(按钮 + 上一下的结果)。视图每取一次叫一次 `blocks()`。
 */
export function wireReportButtons(
	ctx: ExtensionContext,
	source: SubscriptionSourceHandle,
): { blocks(): ExtensionBlock[] } {
	let postSeq = 0;
	let liveSeq = 0;
	let profileSeq = 0;
	/** 假源手里正在播的那一场;下播后清掉。 */
	let live: FakeLiveSession | undefined;
	/** 上一下按了什么、结果如何 —— 页上那一行。 */
	let lastPress: { tone: "info" | "warn" | "error"; text: ExtensionRichText } | undefined;

	function on(button: ReportButton, prepare: Prepare): void {
		ctx.onAction(button.action, async (signal) => {
			signal.throwIfAborted();
			const people = openPeople(source.subscriptions());
			const at = Date.now();
			if (people.length === 0) {
				lastPress = {
					tone: "warn",
					text: [{ b: button.label }, ":还没有开着的订阅,什么都没报 · ", { time: at }],
				};
				ctx.statusChanged();
				return;
			}
			const { each, note } = prepare(at);
			const failures: string[] = [];
			for (const externalId of people) {
				signal.throwIfAborted();
				try {
					await each(externalId);
				} catch (err) {
					failures.push(`${externalId}:${(err as Error).message}`);
				}
			}
			lastPress =
				failures.length === 0
					? {
							tone: "info",
							text: [{ b: button.label }, `:报给了 ${people.length} 个人(${note})· `, { time: at }],
						}
					: {
							tone: "error",
							text: [
								{ b: button.label },
								`:${people.length} 个人里 ${failures.length} 个没报成(原因在按钮底下)· `,
								{ time: at },
							],
						};
			ctx.statusChanged();
			// 原话交给面板:按钮底下那句就是它。
			if (failures.length > 0) throw new Error(failures.join(";"));
		});
	}

	on(POST, (now) => {
		const n = ++postSeq;
		return {
			each: (externalId) => source.reportPost(externalId, fakePost(externalId, n, now)),
			note: `第 ${n} 条 · ${n % 2 === 1 ? "图文" : "视频"}`,
		};
	});

	on(LIVE_START, (now) => {
		const session = {
			n: ++liveSeq,
			startedAt: now,
			viewers: VIEWERS_STEP,
			totalViewers: TOTAL_VIEWERS_STEP,
		};
		live = session;
		// 按下这一刻就定下来:`live` 之后会被报直播状态改(人数),报到一半时别让后面的人沾上。
		const details = fakeLiveDetails(session);
		return {
			each: (externalId) =>
				source.reportLiveStart(externalId, { url: fakeLiveUrl(externalId), ...details }),
			note: `第 ${session.n} 场`,
		};
	});

	on(LIVE_STATUS, (now) => {
		// 没开播就报(演 BN 重启过、开播没见着):从这一刻算一场新的。
		live ??= { n: ++liveSeq, startedAt: now, viewers: 0, totalViewers: 0 };
		live.viewers += VIEWERS_STEP;
		live.totalViewers += TOTAL_VIEWERS_STEP;
		const { n, viewers, totalViewers } = live;
		const details = fakeLiveDetails(live);
		return {
			each: (externalId) =>
				source.reportLiveStatus(externalId, {
					live: true,
					url: fakeLiveUrl(externalId),
					...details,
				}),
			note: `第 ${n} 场 · 在线 ${viewers} · 累计 ${totalViewers}`,
		};
	});

	on(LIVE_END, () => {
		const session = live;
		live = undefined;
		// 开播时刻补上 —— BN 中途重启过的话,它靠这一格算这场播了多久(决策 56)。
		const details = session ? fakeLiveDetails(session) : {};
		return {
			each: (externalId) =>
				source.reportLiveEnd(externalId, { url: fakeLiveUrl(externalId), ...details }),
			note: session ? `第 ${session.n} 场` : "之前没开播",
		};
	});

	on(PROFILE, () => {
		const n = ++profileSeq;
		return {
			each: (externalId) => source.reportProfile(externalId, fakeProfile(externalId, n)),
			note: `第 ${n} 版`,
		};
	});

	on(BAD_IMAGE, (now) => {
		const n = ++postSeq;
		return {
			each: (externalId) => source.reportPost(externalId, fakePostWithBadImage(externalId, n, now)),
			note: `第 ${n} 条 · BN 应只丢那张 SVG,去「上报问题」看`,
		};
	});

	on(EXTRA_FIELD, (now) => {
		const n = ++postSeq;
		return {
			each: async (externalId) => {
				try {
					await source.reportPost(externalId, fakePostWithExtraField(externalId, n, now));
				} catch {
					// 意料之中:原因宿主已经记进「上报问题」了。
					return;
				}
				throw new Error("BN 收下了这条多一格的作品 —— 它本该整条拒(决策 59)");
			},
			note: `第 ${n} 条 · BN 应整条拒,去「上报问题」看`,
		};
	});

	const button = (b: ReportButton): ExtensionBlock => ({
		type: "button",
		button: { kind: "action", label: b.label, action: b.action },
	});
	/** 报坏的两颗挂在一句说明上:按了该在「上报问题」里看见什么。 */
	const explained = (b: ReportButton, text: string): ExtensionBlock => ({
		type: "notice",
		tone: "info",
		text,
		button: { kind: "action", label: b.label, action: b.action },
	});

	return {
		blocks() {
			const blocks: ExtensionBlock[] = [
				button(POST),
				button(LIVE_START),
				button(LIVE_END),
				button(PROFILE),
				button(LIVE_STATUS),
				explained(BAD_IMAGE, "混进一张 SVG(第 2 张)—— BN 应只丢那一张、其余照收"),
				explained(EXTRA_FIELD, "多带一格 BN 不认识的「弹幕数」—— BN 应整条拒"),
			];
			if (lastPress) blocks.push({ type: "notice", ...lastPress });
			return blocks;
		},
	};
}
