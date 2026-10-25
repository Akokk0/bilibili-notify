import type {
	ExtensionBlock,
	ExtensionContext,
	ExtensionRichText,
	Identity,
	LiveStatusResult,
	SourceContext,
	SourceSubscriptionView,
} from "@bilibili-notify/extension";
import { fail, ok } from "@bilibili-notify/extension";
import {
	type createFakeProfiles,
	type FakeLiveSession,
	fakeLiveDetails,
	fakeLiveUrl,
	fakePost,
	fakePostWithBadImage,
	fakePostWithExtraField,
	fakeProfile,
	fakeRichPost,
	pictureStore,
	type StorePicture,
} from "./reports.js";

/**
 * 假源页面上的上报按钮(ADR-0019 决策 62):开发时拿它造事件,把「拓展报 → BN 收」那条路在真机上走一遍。
 *
 * 视图里的按钮带不了「点的是哪一行」(决策 42:handler 只收一个 `AbortSignal`),所以每颗都**一次作用于
 * 名下所有开着的订阅** —— 按外部 id 报,同一个人两条订阅也只报一次(宿主自己按身份扇出)。停用的不报:
 * 来源的名单(`ctx.subscriptions()`)本来就只列启用中的,事件与直播状态宿主本来也不往停用的发。
 *
 * 序号只在真报出去时才往前走:没有开着的订阅时按的那一下什么都不报,也不占号。
 *
 * 上报都在 `start` 拿到的那份来源上下文上交(第 3 版契约:没有返回值,被拒了拓展不知道)。来源没在跑
 * (还没 `start`、或者 `stop` 之后)时按钮照实回「来源没在跑」。
 */

/** 一颗按钮:清单 `actions` 里的动作名 + 视图里那行字(按钮上的字只认视图里这一份,决策 42)。 */
interface ReportButton {
	action: string;
	label: string;
}

const POST: ReportButton = { action: "report.post", label: "报一条作品" };
const RICH_POST: ReportButton = {
	action: "report.richPost",
	label: "报一条五种片段的作品",
};
const LIVE_START: ReportButton = { action: "report.liveStart", label: "开播" };
const LIVE_END: ReportButton = { action: "report.liveEnd", label: "下播" };
const PROFILE: ReportButton = { action: "report.profile", label: "报资料" };
const LIVE_STATUS: ReportButton = { action: "report.liveStatus", label: "报直播状态" };
const REPORT_PROBLEM: ReportButton = { action: "report.problem", label: "报问题" };
const RESOLVE_PROBLEM: ReportButton = { action: "resolve.problem", label: "清问题" };
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

/** 来源没在跑时按钮回的那句话。 */
const NOT_RUNNING = "来源没在跑(还没起来,或者已经停下了),什么都没报";

/**
 * 按一下要做的事:`each` 给每个开着的人报一次,`note` 是报完之后页上那行字的括号里那句。除允许空名单的
 * 问题按钮外,**只在有人可报时才叫** —— 序号与直播那一场都在这里往前走。`each` 里要存图(异步),
 * 报上去是同步的、没有返回值。
 */
type Prepare = (
	now: number,
	source: SourceContext,
) => {
	each: (externalId: string, store: StorePicture) => Promise<void>;
	note: string;
};

interface PressOptions {
	/** 拓展级与来源级的问题不依赖名单;没有开着的人时两颗问题按钮也要照报 / 照清。 */
	allowNoPeople?: boolean;
	/** 页上结果句在人数前用哪个动作。 */
	personVerb?: string;
}

/** 开着的订阅指向的人,按先出现的次序、每人一次(名单本来就只列启用中的)。 */
function openPeople(people: readonly SourceSubscriptionView[]): string[] {
	return [...new Set(people.map((one) => one.externalId))];
}

/**
 * 接上十颗按钮,交回页上那几块积木(按钮 + 上一下的结果)与拉取式直播状态。视图每取一次叫一次 `blocks()`。
 * `running()` 回此刻在跑的那份来源上下文,没在跑是 `undefined`。
 */
export function wireReportButtons(
	ctx: ExtensionContext,
	running: () => SourceContext | undefined,
	profiles: ReturnType<typeof createFakeProfiles>,
): {
	blocks(): ExtensionBlock[];
	liveStatusOf(identity: Identity, signal: AbortSignal): Promise<LiveStatusResult>;
} {
	let postSeq = 0;
	let liveSeq = 0;
	/** 假源手里正在播的那一场;下播后清掉。 */
	let live: FakeLiveSession | undefined;
	/**
	 * 每个人此刻在不在播(拉取式直播状态答的就是它):开播与报直播状态记上,下播清掉。存的是按下那一刻的
	 * 快照,与上报出去的人数一致。
	 */
	const liveOf = new Map<string, FakeLiveSession>();
	/** 上一下按了什么、结果如何 —— 页上那一行。 */
	let lastPress: { tone: "info" | "warn" | "error"; text: ExtensionRichText } | undefined;

	function on(button: ReportButton, prepare: Prepare, options: PressOptions = {}): void {
		ctx.onAction(button.action, async (signal) => {
			signal.throwIfAborted();
			const source = running();
			const at = Date.now();
			if (!source) {
				lastPress = {
					tone: "error",
					text: [{ b: button.label }, `:${NOT_RUNNING} · `, { time: at }],
				};
				ctx.statusChanged();
				throw new Error(NOT_RUNNING);
			}
			const people = openPeople(source.subscriptions());
			if (people.length === 0 && !options.allowNoPeople) {
				lastPress = {
					tone: "warn",
					text: [{ b: button.label }, ":还没有开着的订阅,什么都没报 · ", { time: at }],
				};
				ctx.statusChanged();
				return;
			}
			const { each, note } = prepare(at, source);
			const store = pictureStore(source, signal);
			const failures: string[] = [];
			for (const externalId of people) {
				signal.throwIfAborted();
				try {
					await each(externalId, store);
				} catch (err) {
					failures.push(`${externalId}:${(err as Error).message}`);
				}
			}
			lastPress =
				failures.length === 0
					? {
							tone: "info",
							text: [
								{ b: button.label },
								`:${options.personVerb ?? "报给了"} ${people.length} 个人(${note})· `,
								{ time: at },
							],
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
			each: async (externalId, store) =>
				running()?.reportPost(externalId, await fakePost(externalId, n, now, store)),
			note: `第 ${n} 条 · ${n % 2 === 1 ? "图文" : "视频"}`,
		};
	});

	on(RICH_POST, (now) => {
		const n = ++postSeq;
		return {
			each: async (externalId, store) =>
				running()?.reportPost(externalId, await fakeRichPost(externalId, n, now, store)),
			note: `第 ${n} 条 · 五种正文片段`,
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
		return {
			each: async (externalId, store) => {
				liveOf.set(externalId, session);
				running()?.reportLive(externalId, {
					kind: "start",
					startedAt: session.startedAt,
					details: await fakeLiveDetails(externalId, session, store),
				});
			},
			note: `第 ${session.n} 场`,
		};
	});

	on(LIVE_STATUS, (now) => {
		// 没开播就报(演 BN 重启过、开播没见着):从这一刻算一场新的。
		live ??= { n: ++liveSeq, startedAt: now, viewers: 0, totalViewers: 0 };
		live.viewers += VIEWERS_STEP;
		live.totalViewers += TOTAL_VIEWERS_STEP;
		// 按下这一刻就定下来:`live` 之后会被下一次报直播状态改(人数),报到一半时别让后面的人沾上。
		const session = { ...live };
		return {
			each: async (externalId, store) => {
				liveOf.set(externalId, session);
				running()?.reportLive(externalId, {
					kind: "status",
					isLive: true,
					startedAt: session.startedAt,
					details: await fakeLiveDetails(externalId, session, store),
				});
			},
			note: `第 ${session.n} 场 · 在线 ${session.viewers} · 累计 ${session.totalViewers}`,
		};
	});

	on(
		REPORT_PROBLEM,
		(_now, source) => {
			ctx.reportProblem({
				code: "fake_extension_problem",
				message: ctx.i18n.t("problem.extension"),
				notify: true,
				recoveryMessage: ctx.i18n.t("problem.recovery"),
			});
			source.reportProblem({
				code: "fake_source_problem",
				message: ctx.i18n.t("problem.source"),
			});
			return {
				each: async (externalId) => {
					running()?.reportProblem({
						externalId,
						code: "fake_creator_problem",
						message: ctx.i18n.t("problem.creator"),
					});
				},
				note: "拓展、来源和每个人的三层问题",
			};
		},
		{ allowNoPeople: true },
	);

	on(
		RESOLVE_PROBLEM,
		(_now, source) => {
			ctx.resolveProblem({ code: "fake_extension_problem", notify: true });
			source.resolveProblem({ code: "fake_source_problem" });
			return {
				each: async (externalId) => {
					running()?.resolveProblem({
						externalId,
						code: "fake_creator_problem",
					});
				},
				note: "拓展、来源和每个人的三层问题",
			};
		},
		{ allowNoPeople: true, personVerb: "清了" },
	);

	on(LIVE_END, () => {
		const session = live && { ...live };
		live = undefined;
		return {
			each: async (externalId, store) => {
				liveOf.delete(externalId);
				// 开播时刻补上 —— BN 中途重启过的话,它靠这一格算这场播了多久(决策 56)。
				running()?.reportLive(externalId, {
					kind: "end",
					...(session ? { startedAt: session.startedAt } : {}),
					details: session
						? await fakeLiveDetails(externalId, session, store)
						: { url: fakeLiveUrl(externalId) },
				});
			},
			note: session ? `第 ${session.n} 场` : "之前没开播",
		};
	});

	on(PROFILE, () => {
		const n = profiles.nextVersion();
		return {
			each: async (externalId, store) => {
				const profile = await fakeProfile(externalId, n, store);
				const source = running();
				if (!source) return;
				source.reportProfile(externalId, profile);
				profiles.record(externalId, profile);
			},
			note: `第 ${n} 版`,
		};
	});

	on(BAD_IMAGE, (now) => {
		const n = ++postSeq;
		return {
			each: async (externalId, store) =>
				running()?.reportPost(externalId, await fakePostWithBadImage(externalId, n, now, store)),
			note: `第 ${n} 条 · BN 应只丢那个坏引用,去「上报出入」看`,
		};
	});

	on(EXTRA_FIELD, (now) => {
		const n = ++postSeq;
		return {
			// 第 3 版契约里上报没有返回值:BN 拒没拒拓展这一侧看不到,「竟然收下了」只能去「上报出入」看
			// 有没有那一条「拒了」(`fake-source-buttons-e2e` 在真 BN 上钉着)。
			each: async (externalId) => {
				running()?.reportPost(externalId, fakePostWithExtraField(externalId, n, now));
			},
			note: `第 ${n} 条 · BN 应整条拒,去「上报出入」看`,
		};
	});

	const button = (b: ReportButton): ExtensionBlock => ({
		type: "button",
		button: { kind: "action", label: b.label, action: b.action },
	});
	/** 报坏的两颗挂在一句说明上:按了该在「上报出入」里看见什么。 */
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
				button(RICH_POST),
				button(LIVE_START),
				button(LIVE_END),
				button(PROFILE),
				button(LIVE_STATUS),
				button(REPORT_PROBLEM),
				button(RESOLVE_PROBLEM),
				explained(BAD_IMAGE, "第 2 张图交一个不合形状的引用 —— BN 应只丢那一格、其余照收"),
				explained(EXTRA_FIELD, "多带一格 BN 不认识的「弹幕数」—— BN 应整条拒"),
			];
			if (lastPress) blocks.push({ type: "notice", ...lastPress });
			return blocks;
		},

		/** 拉取式直播状态:按「记着的谁在播」答。周期「正在直播」卡问的就是它。 */
		async liveStatusOf(identity, signal) {
			const source = running();
			if (!source) return fail("unavailable", NOT_RUNNING);
			const session = liveOf.get(identity.externalId);
			if (!session) return ok({ kind: "offline" as const });
			try {
				return ok({
					kind: "live" as const,
					startedAt: session.startedAt,
					details: await fakeLiveDetails(
						identity.externalId,
						session,
						pictureStore(source, signal),
					),
				});
			} catch (err) {
				return fail("unavailable", (err as Error).message);
			}
		},
	};
}
