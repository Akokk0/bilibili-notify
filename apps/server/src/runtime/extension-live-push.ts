import { type ImageRenderer, type LiveCardInput, liveDuration } from "@bilibili-notify/image";
import type {
	Disposable,
	ExtensionSubscription,
	Logger,
	MessageBus,
	ServiceContext,
	Subscription,
	SubscriptionReportValue,
} from "@bilibili-notify/internal";
import {
	type CustomCardStyleLike,
	createSerialGate,
	type LiveNotifyPushType,
	type LiveNotifySend,
	LivePushType,
	type LiveTextKind,
	pushLiveNotify,
	renderLiveText,
	type SerialGate,
} from "@bilibili-notify/live";
import type { SubscriptionReportProblem } from "../extensions/context.js";
import type { LiveWorkSettings } from "./engines.js";
import type { ExtensionLiveRow, ExtensionLiveTable } from "./extension-live.js";
import type {
	ExtensionLiveSession,
	ExtensionLiveSessionChange,
	ExtensionLiveSessions,
} from "./extension-live-sessions.js";
import {
	type ExtensionSourceLookups,
	extensionCardAuthor,
	extensionSubscriptionPushable,
	imageDataUrl,
} from "./extension-push-common.js";

/**
 * **拓展订阅的直播接进推送链**(ADR-0019 决策 53 / 56–58 / 61 / 67):照场次(`extension-live-sessions.ts`)
 * 的变化逐条订阅推开播 / 正在直播 / 下播卡,外加 BN 为拓展订阅另写的那个小计时器(周期「正在直播」)。
 *
 * **推什么、怎么推与 B 站共用**:直播装配(`pushLiveNotify`)、中立的文案渲染(`renderLiveText`)、按 UP
 * 折好的直播设置(`liveWorkSettings`)、特性键与推送类型的映射(`boundLivePush`)。**什么时候推是这里自己的**
 * (决策 67):B 站那套计时器每次触发都现问 B 站,搬不过来;拓展这边只认它报的事件与状态。
 *
 * **场次不在这里**(ADR-0020 决策 6):这一场从哪开始、到哪结束、断流接续等不等,由场次那一份算,推送与统计
 * 共用;这里只管推送自己的几样 —— 挂在哪一场上、上次推送之后收到过新状态没有、周期计时器、重启补推要的
 * 「见过」、每条订阅的串行闸。
 *
 * - **开播 / 下播卡只由事件触发**(决策 53):BN 不拿直播状态的翻转自己猜开播 / 下播。
 * - **开播**:场次开了一场 → 推开播卡(开播时刻取事件的、粉丝数取这一场开播时记下的),挂上周期「正在直播」。
 *   断流等待里又开播(场次说「接着播」)→ 两张卡都不发、周期推送接着挂(决策 58)。
 * - **直播状态**:最新一份住在播表里(`extension-live.ts`),这里只记「上次推送之后收到过新状态」。BN 开始看
 *   这条订阅之后**收到的第一份状态**就是在播、又没见过这一场的开播事件 → 重启补推开着就补推一张「正在直播」
 *   卡(决策 57 的 09-24 🔗),并挂上周期推送。报「不在播」也算见过:契约不规定状态与事件谁先报,一场刚开
 *   的直播不能先补推一张「正在直播」、紧跟着又推开播卡。拓展停了「见过」一并作废,它重新跑起来收到的第一
 *   份状态照开机那样判 —— 它停着的时候开的播照样补推。
 * - **周期「正在直播」**:到点时上次推送之后收到过新状态才推(拿在播表里最新那一份出卡),否则这一轮跳过、
 *   记进上报问题框(决策 60 / 61)—— 不管拓展多久查一次都不误伤。在播表里没有这一行(最新状态说不在播,
 *   拓展没报下播或下播被拒收)→ 这一轮悄悄跳过,不记问题、也不替拓展判下播(决策 53);又报在播就接着推。
 * - 排着队的「正在直播」卡(补推或周期)**这一场已经不是当前那场**就不发:开始跑时认一次,出完卡发送前
 *   再认一次 —— 出卡的那几秒里开播事件到了,也不会在开播卡前面多一张。
 * - **下播**:场次说这一场因为下播结束了(断流接续开着的,等满了才算)才推下播卡。时长从这一场的开播时刻算到
 *   下播事件到达那一刻(等的那几分钟不算);BN 中途重启过、手里没有这一场时用事件带的开播时刻。粉丝数变化 =
 *   推的那一刻资料里的粉丝数 − 这一场开播时记下的(决策 56),哪头没有就空着;默认卡不画它,文案与皮肤契约有
 *   (决策 76)。
 * - **作废**(决策 61):场次因为拓展停了(停用、卸载、换代码、崩了)、订阅删了 / 停用了、关机而结束 → 计时器
 *   拆掉,等着的下播卡**不补推**。直播两个特性都关了 → 推送这头放下这一场。停用的订阅事件收下不推(决策 62)。
 * - **同一条订阅的推送按发起顺序送到**(每条订阅一道串行闸):秒级断流重开时,前一场的下播卡还在出卡,
 *   新一场的开播卡不会抢先送到(同 B 站的 `enqueuePush`)。
 *
 * 只在内存:BN 重启之后靠拓展开机第一轮报的直播状态接上(决策 57 / 8)。
 */

type LiveStart = SubscriptionReportValue<"liveStart">;
type LiveEnd = SubscriptionReportValue<"liveEnd">;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 卡上与文案要的直播那几格 —— 事件与在播表那一行长得一样。 */
type LiveFacts = Partial<
	Pick<
		ExtensionLiveRow,
		| "title"
		| "cover"
		| "category"
		| "description"
		| "viewers"
		| "totalViewers"
		| "likes"
		| "author"
		| "url"
	>
>;

/**
 * 推送这头挂在一场上的那几样。开播时刻、粉丝基线、最后一份状态、断流等待都是这一场的(`session`),不在这里。
 */
interface LiveRun {
	session: ExtensionLiveSession;
	/** 上次推送之后收到过新的直播状态(决策 61)。推一张卡就清。 */
	fresh: boolean;
	/** 周期「正在直播」。 */
	periodic?: { handle: Disposable; hours: number };
}

export interface BindExtensionLivePushOptions {
	bus: MessageBus;
	logger: Logger;
	/** 场次 —— 这一场从哪开始、到哪结束、断流接续等不等,都听它的。 */
	sessions: Pick<ExtensionLiveSessions, "onChange">;
	/** 在播表 —— 「最新状态」只从这里取(拓展报的直播状态合并好的那一份)。 */
	table: Pick<ExtensionLiveTable, "get">;
	/** 此刻的这条订阅(现取)。 */
	subscription(id: string): Subscription | undefined;
	/** 订阅资料里的名字与粉丝数(资料缓存,现取)。 */
	profile(id: string): { name?: string; fans?: number } | undefined;
	/** 这条订阅折好的直播设置(现折,与 B 站那头同一份,见 `liveWorkSettings`)。 */
	settings(sub: ExtensionSubscription): LiveWorkSettings;
	/** 这一张直播卡的生效样式(按种类 ?? 基准,再轮一张自定义封面)。每推一张调一次。 */
	cardStyle(
		sub: ExtensionSubscription,
		settings: LiveWorkSettings,
	): CustomCardStyleLike | undefined;
	/** 拓展在不在跑、存下的头像。 */
	sources: Pick<ExtensionSourceLookups, "running" | "readAvatar">;
	/** 绑到这条订阅上的直播发送(`boundLivePush(bindSubscriptionPush(push, id))`)。 */
	sendFor(subscriptionId: string): LiveNotifySend;
	/** 出卡的渲染器 —— 会被热换、关了出图时是 null,现取。 */
	renderer(): Pick<ImageRenderer, "generateNeutralLiveCard"> | null | undefined;
	/** 上报问题框(决策 60):周期「正在直播」因为没有新状态跳过的那一轮记进去。 */
	reportProblem(problem: SubscriptionReportProblem): void;
	/** 周期推送的定时器 —— 宿主的 ServiceContext(关机时一起清)。 */
	timers: Pick<ServiceContext, "setInterval">;
	/** 只有测试会换。 */
	now?: () => number;
}

/** 值是 `undefined` 的键去掉 —— 合并时「没报」不盖掉已有的。 */
function defined<T extends object>(value: T | undefined): Partial<T> {
	if (!value) return {};
	return Object.fromEntries(
		Object.entries(value).filter(([, cell]) => cell !== undefined),
	) as Partial<T>;
}

/** 三句文案各自的模板(按 UP 折好的;没有就是默认那句)。 */
function templateOf(settings: LiveWorkSettings, kind: LiveTextKind): string | undefined {
	const msg = settings.customLiveMsg;
	switch (kind) {
		case "liveStart":
			return msg.customLiveStart;
		case "liveOngoing":
			return msg.customLive;
		case "liveEnd":
			return msg.customLiveEnd;
	}
}

/** 一张要推的卡。 */
interface CardJob {
	status: LiveCardInput["status"];
	pushType: LiveNotifyPushType;
	textKind: LiveTextKind;
	facts: LiveFacts;
	startedAt?: number;
	/** `{time}`:已经算好的时长(没有开播时刻就空着)。 */
	time: string;
	/** 卡上的「当前粉丝数」与开播文案的 `{follower}`。 */
	fans?: number;
	/** 本场粉丝数变化(下播)。 */
	fansChanged?: number;
	/** 「正在直播」卡属于哪一场:发送前推送这头已经不挂在它上面了(开播 / 下播事件到了)就不发。 */
	run?: LiveRun;
}

export function bindExtensionLivePush(opts: BindExtensionLivePushOptions): Disposable {
	const log = opts.logger;
	const now = opts.now ?? Date.now;
	/** 推送这头挂着的那一场,按订阅。与场次那边此刻那一场是同一场,或者没挂(推送都关着时)。 */
	const runs = new Map<string, LiveRun>();
	/** 每条订阅一道闸。订阅删了就扔掉(还排着的照跑完,跑到时发现订阅不在了就不推)。 */
	const gates = new Map<string, SerialGate>();
	/**
	 * BN 开始看之后见过状态的订阅(在播、不在播、开播事件都算)→ 它的拓展 id。重启补推只给「收到的第一份
	 * 就是在播」(决策 57);拓展停了,它名下的一并作废。
	 */
	const seen = new Map<string, string>();
	let disposed = false;

	/** 这条订阅现在还该推吗:还在、启用着、拓展在跑。关机之后一律不推。 */
	const pushable = (id: string): ExtensionSubscription | undefined => {
		if (disposed) return undefined;
		const sub = opts.subscription(id);
		return extensionSubscriptionPushable(sub, opts.sources.running) ? sub : undefined;
	};

	/** 推送这头放下这一场:周期推送拆掉。这一场本身在场次那边,不归这里收。 */
	function dropRun(id: string, why: string): void {
		const run = runs.get(id);
		if (!run) return;
		run.periodic?.handle.dispose();
		runs.delete(id);
		log.debug(`[ext-live] 订阅 ${id} 的这一场推送这头放下了(${why})`);
	}

	/**
	 * 周期「正在直播」挂成设置里那个频率:直播特性关着、频率是 0、正在断流等待里就不挂。频率没变不动它。
	 */
	function armPeriodic(id: string, run: LiveRun, settings: LiveWorkSettings): void {
		const hours = settings.live && !run.session.pendingEnd ? settings.pushTime : 0;
		if (run.periodic?.hours === hours) return;
		run.periodic?.handle.dispose();
		run.periodic = undefined;
		if (hours <= 0) return;
		run.periodic = {
			hours,
			handle: opts.timers.setInterval(() => tick(id), hours * HOUR),
		};
	}

	/** 设置可能变了(订阅改了、全局改了):对着现折的设置把这一场的计时器理一遍。 */
	function reconcile(id: string): void {
		const run = runs.get(id);
		if (!run) return;
		const sub = pushable(id);
		if (!sub) {
			dropRun(id, "订阅停用 / 删了,或拓展没在跑");
			return;
		}
		const settings = opts.settings(sub);
		if (!settings.live && !settings.liveEnd) {
			dropRun(id, "开播与下播推送都关了");
			return;
		}
		armPeriodic(id, run, settings);
	}

	function enqueue(id: string, what: string, job: () => Promise<void>): void {
		let gate = gates.get(id);
		if (!gate) {
			gate = createSerialGate();
			gates.set(id, gate);
		}
		void gate.run(job).catch((err) => {
			// 与拓展作品同一条规矩(决策 77):不重试,记错误日志;发不出去的目标推送层自己接住、落历史「失败」。
			log.error(
				`[ext-live] 订阅 ${id} 的${what}卡推送途中出错(不重试): ${err instanceof Error ? err.message : String(err)}`,
			);
		});
	}

	/** 出卡 → 套文案 → 按版式分组 → 发送。发送那一刻再核一次还该推(出卡要几秒,期间可能停了拓展)。 */
	async function pushCard(id: string, job: CardJob): Promise<void> {
		const sub = pushable(id);
		if (!sub) return;
		const settings = opts.settings(sub);
		const profile = opts.profile(id);
		const author = await extensionCardAuthor(sub, {
			event: job.facts.author,
			profileName: profile?.name,
			readStoredAvatar: () => opts.sources.readAvatar(id),
		});
		const { facts } = job;
		const input: LiveCardInput = {
			status: job.status,
			author: { name: author.name, face: author.avatarUrl },
			title: facts.title,
			area: facts.category,
			description: facts.description,
			cover: facts.cover ? imageDataUrl(facts.cover) : undefined,
			startedAt: job.startedAt,
			online: facts.viewers,
			likes: facts.likes,
			totalViewers: facts.totalViewers,
			fans: job.fans,
			fansChanged: job.fansChanged,
		};
		const text = renderLiveText(job.textKind, templateOf(settings, job.textKind), {
			// `{name}` 与卡上的作者名同一条链(决策 77):事件里的 → 资料里的 → 别名 → 外部 id。
			name: author.name,
			time: job.time,
			follower: job.fans,
			watched: facts.totalViewers,
			followerChange: job.fansChanged,
		});
		const send = opts.sendFor(id);
		await pushLiveNotify(
			{
				input,
				text,
				link: facts.url ?? "",
				layout: settings.messageLayout,
				cardStyle: opts.cardStyle(sub, settings),
				cardSkin: settings.cardSkin,
				cardSkinKnobs: settings.cardSkinKnobs,
				pushType: job.pushType,
				label: `sub=${id}`,
			},
			{
				renderer: opts.renderer(),
				send: async (groups, type, o) => {
					if (!pushable(id)) {
						log.debug(`[ext-live] 订阅 ${id} 在出卡途中停用 / 删了 / 拓展停了,这张卡不发`);
						return;
					}
					if (job.run && runs.get(id) !== job.run) {
						log.debug(`[ext-live] 订阅 ${id} 在出卡途中换了一场,这张「正在直播」卡不发`);
						return;
					}
					await send(groups, type, o);
				},
				logger: log,
			},
		);
	}

	/**
	 * 「正在直播」卡:在播表里最新那一份(跑到时现取),时长算到此刻,粉丝数是资料里现在的。排队期间这一场
	 * 已经不是当前那场(开播事件把它换掉了、下播收掉了)就不推。
	 */
	function pushOngoing(id: string, run: LiveRun): Promise<void> {
		if (runs.get(id) !== run) {
			log.debug(`[ext-live] 订阅 ${id} 排队期间换了一场,这张「正在直播」卡不推`);
			return Promise.resolve();
		}
		const row = opts.table.get(id) ?? run.session.lastRow;
		if (!row) {
			log.debug(`[ext-live] 订阅 ${id} 已经不在在播表里,这张「正在直播」卡不推`);
			return Promise.resolve();
		}
		const startedAt = run.session.startedAt ?? row.startedAt;
		return pushCard(id, {
			status: "streaming",
			pushType: LivePushType.Live,
			textKind: "liveOngoing",
			facts: row,
			startedAt,
			time: startedAt === undefined ? "" : liveDuration(startedAt, now()),
			fans: opts.profile(id)?.fans,
			run,
		});
	}

	function tick(id: string): void {
		const run = runs.get(id);
		if (!run) return;
		const sub = pushable(id);
		if (!sub) {
			dropRun(id, "订阅停用 / 删了,或拓展没在跑");
			return;
		}
		const settings = opts.settings(sub);
		if (!settings.live) {
			armPeriodic(id, run, settings);
			return;
		}
		if (!opts.table.get(id)) {
			// 最新状态说不在播,下播事件却没来(拓展没报、或被拒收了)。拓展在报,记「没收到新状态」是冤枉它;
			// 也不替它判下播(决策 53)—— 这一轮不推,计时器留着,又报在播就接着推。
			log.debug(`[ext-live] 订阅 ${id} 最新状态不在播,这一轮周期「正在直播」不推`);
			return;
		}
		if (!run.fresh) {
			const reason = "上次推送之后没收到新的直播状态,这一轮周期「正在直播」没推";
			log.info(`[ext-live] 订阅 ${id}:${reason}`);
			opts.reportProblem({
				extensionId: run.session.extensionId,
				at: now(),
				kind: "liveStatus",
				externalId: sub.externalId,
				subscriptionIds: [id],
				outcome: "skipped",
				reasons: [reason],
			});
			return;
		}
		run.fresh = false;
		enqueue(id, "「正在直播」", () => pushOngoing(id, run));
	}

	/** 这一场该推送了吗:订阅还该推、开播与下播推送没全关。全关着的放下这一场。 */
	function pushSettings(
		id: string,
	): { sub: ExtensionSubscription; settings: LiveWorkSettings } | undefined {
		const sub = pushable(id);
		if (!sub) return undefined;
		const settings = opts.settings(sub);
		if (!settings.live && !settings.liveEnd) {
			dropRun(id, "开播与下播推送都关了");
			return undefined;
		}
		return { sub, settings };
	}

	/** 开播事件开了新的一场:推开播卡,挂上周期推送。 */
	function onStart(session: ExtensionLiveSession, value: LiveStart): void {
		const id = session.subscriptionId;
		const ready = pushSettings(id);
		if (!ready) return;
		const { sub, settings } = ready;
		seen.set(id, sub.extensionId);
		dropRun(id, "新的一场开播了");
		const at = session.detectedAt;
		const run: LiveRun = { session, fresh: false };
		runs.set(id, run);
		if (settings.live) {
			enqueue(id, "开播", () =>
				pushCard(id, {
					status: "start",
					pushType: LivePushType.StartBroadcasting,
					textKind: "liveStart",
					facts: value,
					startedAt: value.startedAt,
					time: liveDuration(value.startedAt, at),
					fans: session.fansAtStart,
				}),
			);
		}
		armPeriodic(id, run, settings);
	}

	/** 断流等待里又开播(决策 58):同一场,两张卡都不发,周期推送接着挂。 */
	function onResume(session: ExtensionLiveSession): void {
		const id = session.subscriptionId;
		const ready = pushSettings(id);
		if (!ready) return;
		const { sub, settings } = ready;
		seen.set(id, sub.extensionId);
		let run = runs.get(id);
		if (run?.session !== session) {
			run = { session, fresh: false };
			runs.set(id, run);
		}
		armPeriodic(id, run, settings);
		log.info(`[ext-live] 订阅 ${id} 断流后重新开播,接续为同一场(开播卡、下播卡都不发)`);
	}

	/** 一份直播状态(认出一场的那一份也是):记「见过」、「收到过新状态」,必要时补推。 */
	function onStatus(id: string, live: boolean, session: ExtensionLiveSession | undefined): void {
		const sub = pushable(id);
		if (!sub) return;
		const settings = opts.settings(sub);
		if (!settings.live && !settings.liveEnd) return;
		// 在播、不在播都算见过(决策 57 的 09-24 🔗):之后再报在播就不是「BN 看到的第一份」了。
		const first = !seen.has(id);
		seen.set(id, sub.extensionId);
		// 报了不在播:BN 不拿它猜下播(决策 53),在播表自己出表;这一场的计时器等下播事件来收。
		if (!live || !session) return;
		const current = runs.get(id);
		if (current?.session === session) {
			current.fresh = true;
			return;
		}
		// 推送这头没挂着这一场:BN 起来之前就开播了,或者拓展停过又跑起来了。
		const run: LiveRun = { session, fresh: false };
		runs.set(id, run);
		if (first && settings.restartPush && settings.live) {
			log.info(`[ext-live] 订阅 ${id} 在 BN 起来之前就开播了,补推一张「正在直播」`);
			enqueue(id, "「正在直播」(重启补推)", () => pushOngoing(id, run));
		} else {
			log.debug(`[ext-live] 订阅 ${id} 正在播,接上这一场(不补推)`);
		}
		armPeriodic(id, run, settings);
	}

	/** 下播进了断流等待:周期推送先停。 */
	function onEnding(session: ExtensionLiveSession): void {
		const id = session.subscriptionId;
		const ready = pushSettings(id);
		if (!ready) return;
		const run = runs.get(id);
		if (run?.session === session) armPeriodic(id, run, ready.settings);
	}

	/**
	 * 推下播卡。`session` 没有 = BN 手里没有这一场(中途重启过、拓展没报过状态):时长用事件带的开播时刻。
	 */
	function finishEnd(
		id: string,
		session: ExtensionLiveSession | undefined,
		endedAt: number,
		value: LiveEnd,
	): void {
		const sub = pushable(id);
		if (!sub) return;
		if (!opts.settings(sub).liveEnd) {
			log.debug(`[ext-live] 订阅 ${id} 的下播推送关着,下播卡不推`);
			return;
		}
		// 事件没带的格用这一场最后一份状态补;开播时刻先认 BN 自己记着的(决策 56)。
		const facts: LiveFacts = { ...defined(session?.lastRow), ...defined(value) };
		const startedAt = session?.startedAt ?? value.startedAt ?? session?.lastRow?.startedAt;
		enqueue(id, "下播", () => {
			const fansNow = opts.profile(id)?.fans;
			const fansChanged =
				fansNow !== undefined && session?.fansAtStart !== undefined
					? fansNow - session.fansAtStart
					: undefined;
			return pushCard(id, {
				status: "end",
				pushType: LivePushType.LiveEnd,
				textKind: "liveEnd",
				facts,
				startedAt,
				time: startedAt === undefined ? "" : liveDuration(startedAt, endedAt),
				fansChanged,
			});
		});
	}

	function onChange(change: ExtensionLiveSessionChange): void {
		switch (change.type) {
			case "start":
				if (change.trigger === "liveStart") onStart(change.session, change.value);
				else onStatus(change.subscriptionId, true, change.session);
				return;
			case "resume":
				onResume(change.session);
				return;
			case "status":
				onStatus(change.subscriptionId, change.live, change.session);
				return;
			case "ending":
				onEnding(change.session);
				return;
			case "end":
				// 为什么结束场次那边的日志写了。
				dropRun(change.subscriptionId, "这一场结束了");
				// 只有拓展报的下播推下播卡;拓展停了、订阅停用 / 删了、关机的,等着的下播卡不补推(决策 61)。
				if (change.reason === "ended" && change.value) {
					finishEnd(change.subscriptionId, change.session, change.at, change.value);
				}
				return;
			case "unmatched-end":
				finishEnd(change.subscriptionId, undefined, change.at, change.value);
				return;
		}
	}

	const watches: Disposable[] = [
		opts.sessions.onChange(onChange),
		// 拓展停了(决策 61):「见过」一并作废 —— 重新跑起来后靠直播状态接上,收到的第一份就是在播的照开机那样
		// 补推(它停着的时候开的播)。它名下的场次由场次那边收掉,推送这头跟着放下。
		opts.bus.on("extension-stopped", (extensionId) => {
			for (const [id, owner] of [...seen]) {
				if (owner === extensionId) seen.delete(id);
			}
		}),
		opts.bus.on("subscription-changed", (ops) => {
			for (const op of ops) {
				if (op.type === "remove") {
					dropRun(op.sub.id, "订阅删了");
					gates.delete(op.sub.id);
					seen.delete(op.sub.id);
				} else if (op.type === "update") {
					if (op.sub.enabled) reconcile(op.sub.id);
					else dropRun(op.sub.id, "订阅停用了");
				}
			}
		}),
		// 全局设置改了(推送频率、特性开关……):每一场对着现折的设置理一遍。
		opts.bus.on("config-changed", (scope) => {
			if (scope !== "globals") return;
			for (const id of [...runs.keys()]) reconcile(id);
		}),
	];

	return {
		dispose() {
			disposed = true;
			for (const watch of watches) watch.dispose();
			for (const id of [...runs.keys()]) dropRun(id, "关机");
			gates.clear();
		},
	};
}
