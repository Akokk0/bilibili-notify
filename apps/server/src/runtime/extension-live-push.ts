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
	liveEndGraceMinutes,
	pushLiveNotify,
	renderLiveText,
	type SerialGate,
} from "@bilibili-notify/live";
import type { SubscriptionReportProblem } from "../extensions/context.js";
import type { LiveWorkSettings } from "./engines.js";
import type { ExtensionLiveRow, ExtensionLiveTable } from "./extension-live.js";
import {
	type ExtensionSourceLookups,
	extensionCardAuthor,
	extensionSubscriptionPushable,
	imageDataUrl,
} from "./extension-push-common.js";

/**
 * **拓展订阅的直播接进推送链**(ADR-0019 决策 53 / 56–58 / 61 / 67):bus 上 `subscription-reported` 里的三种
 * 直播上报,逐条订阅推开播 / 正在直播 / 下播卡,外加 BN 为拓展订阅另写的那个小计时器。
 *
 * **推什么、怎么推与 B 站共用**:直播装配(`pushLiveNotify`)、中立的文案渲染(`renderLiveText`)、按 UP
 * 折好的直播设置(`liveWorkSettings`)、特性键与推送类型的映射(`boundLivePush`)。**什么时候推是这里自己的**
 * (决策 67):B 站那套计时器每次触发都现问 B 站,搬不过来;拓展这边只认它报的事件与状态。
 *
 * - **开播 / 下播卡只由事件触发**(决策 53):BN 不拿直播状态的翻转自己猜开播 / 下播。
 * - **开播**:记下这一场(开播时刻取事件的、开播时资料里的粉丝数),推开播卡,挂上周期「正在直播」。
 *   正处在断流等待里时 → 取消等待、沿用第一次的开播时刻与粉丝基线、两张卡都不发(决策 58)。
 * - **直播状态**:最新一份住在播表里(`extension-live.ts`),这里只记「上次推送之后收到过新状态」。BN 起来后
 *   第一次见到这条订阅在播、又没见过这一场的开播事件 → 重启补推开着就补推一张「正在直播」卡(决策 57),
 *   并挂上周期推送;拓展停过又跑起来时靠它接上(不再补推)。
 * - **周期「正在直播」**:到点时上次推送之后收到过新状态才推(拿在播表里最新那一份出卡),否则这一轮跳过、
 *   记进上报问题框(决策 60 / 61)—— 不管拓展多久查一次都不误伤。
 * - **下播**:断流接续开着就先压着,等待期满才推下播卡;没开立刻推。下播卡的时长从这一场的开播时刻算到下播
 *   事件到达那一刻(等的那几分钟不算);BN 中途重启过、没记着开播时刻时用事件带的。粉丝数变化 = 推的那一刻
 *   资料里的粉丝数 − 开播时记下的(决策 56),哪头没有就空着;默认卡不画它,文案与皮肤契约有(决策 76)。
 * - **作废**(决策 61):拓展停了(停用、卸载、换代码、崩了)→ 它名下所有订阅的计时器、等着的下播全部作废,
 *   等着的下播卡**不补推**;订阅删了 / 停用了 / 直播两个特性都关了 → 这条订阅同样作废。停用的订阅事件收下
 *   不推(决策 62)。
 * - **同一条订阅的推送按发起顺序送到**(每条订阅一道串行闸):秒级断流重开时,前一场的下播卡还在出卡,
 *   新一场的开播卡不会抢先送到(同 B 站的 `enqueuePush`)。
 *
 * 只在内存:BN 重启之后靠拓展开机第一轮报的直播状态接上(决策 57 / 8)。
 */

type LiveStart = SubscriptionReportValue<"liveStart">;
type LiveEnd = SubscriptionReportValue<"liveEnd">;
type LiveStatus = SubscriptionReportValue<"liveStatus">;

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

/** BN 手里一条订阅正在播的这一场。 */
interface LiveRun {
	extensionId: string;
	/**
	 * 这一场的开播时刻(毫秒)。开播事件必带;只见过直播状态时拓展报了才有。断流接续时沿用第一次的。
	 */
	startedAt?: number;
	/** 开播时(或 BN 起来后第一次见到这一场时)资料里的粉丝数 —— 下播算粉丝数变化的基线(决策 56)。 */
	fansAtStart?: number;
	/** 上次推送之后收到过新的直播状态(决策 61)。推一张卡就清。 */
	fresh: boolean;
	/**
	 * 在播表里这一场最后一份。下播事件一到那一行就出表了,下播卡没带的格(标题、累计观看……)从这里补;
	 * 只是拿着那一行,不是另存的一份状态。
	 */
	lastRow?: ExtensionLiveRow;
	/** 周期「正在直播」。 */
	periodic?: { handle: Disposable; hours: number };
	/** 断流接续正在等的那次下播:下播事件到达的时刻与它带的格。 */
	pendingEnd?: { handle: Disposable; endedAt: number; value: LiveEnd };
}

export interface BindExtensionLivePushOptions {
	bus: MessageBus;
	logger: Logger;
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
	/** 周期推送与断流等待的定时器 —— 宿主的 ServiceContext(关机时一起清)。 */
	timers: Pick<ServiceContext, "setTimeout" | "setInterval">;
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
}

export function bindExtensionLivePush(opts: BindExtensionLivePushOptions): Disposable {
	const log = opts.logger;
	const now = opts.now ?? Date.now;
	const runs = new Map<string, LiveRun>();
	/** 每条订阅一道闸。订阅删了就扔掉(还排着的照跑完,跑到时发现订阅不在了就不推)。 */
	const gates = new Map<string, SerialGate>();
	/** BN 起来之后见过在播的订阅 —— 重启补推只给第一次(决策 57)。 */
	const seenLive = new Set<string>();
	let disposed = false;

	/** 这条订阅现在还该推吗:还在、启用着、拓展在跑。关机之后一律不推。 */
	const pushable = (id: string): ExtensionSubscription | undefined => {
		if (disposed) return undefined;
		const sub = opts.subscription(id);
		return extensionSubscriptionPushable(sub, opts.sources.running) ? sub : undefined;
	};

	/** 这一场作废:周期推送与等着的下播都拆掉,不补推。 */
	function dropRun(id: string, why: string): void {
		const run = runs.get(id);
		if (!run) return;
		run.periodic?.handle.dispose();
		run.pendingEnd?.handle.dispose();
		runs.delete(id);
		log.debug(
			`[ext-live] 订阅 ${id} 的这一场作废(${why})${run.pendingEnd ? ",等着的下播卡不补推" : ""}`,
		);
	}

	/**
	 * 周期「正在直播」挂成设置里那个频率:直播特性关着、频率是 0、正在断流等待里就不挂。频率没变不动它。
	 */
	function armPeriodic(id: string, run: LiveRun, settings: LiveWorkSettings): void {
		const hours = settings.live && !run.pendingEnd ? settings.pushTime : 0;
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
					await send(groups, type, o);
				},
				logger: log,
			},
		);
	}

	/** 「正在直播」卡:在播表里最新那一份(跑到时现取),时长算到此刻,粉丝数是资料里现在的。 */
	function pushOngoing(id: string, run: LiveRun): Promise<void> {
		const row = opts.table.get(id) ?? run.lastRow;
		if (!row) {
			log.debug(`[ext-live] 订阅 ${id} 已经不在在播表里,这张「正在直播」卡不推`);
			return Promise.resolve();
		}
		const startedAt = run.startedAt ?? row.startedAt;
		return pushCard(id, {
			status: "streaming",
			pushType: LivePushType.Live,
			textKind: "liveOngoing",
			facts: row,
			startedAt,
			time: startedAt === undefined ? "" : liveDuration(startedAt, now()),
			fans: opts.profile(id)?.fans,
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
		if (!run.fresh) {
			const reason = "上次推送之后没收到新的直播状态,这一轮周期「正在直播」没推";
			log.info(`[ext-live] 订阅 ${id}:${reason}`);
			opts.reportProblem({
				extensionId: run.extensionId,
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

	function onLiveStart(id: string, value: LiveStart): void {
		const sub = pushable(id);
		if (!sub) {
			log.debug(`[ext-live] 订阅 ${id} 已停用 / 已删 / 它的拓展没在跑,开播不推`);
			return;
		}
		const settings = opts.settings(sub);
		if (!settings.live && !settings.liveEnd) {
			dropRun(id, "开播与下播推送都关了");
			return;
		}
		seenLive.add(id);
		const current = runs.get(id);
		if (current?.pendingEnd) {
			// 断流接续(决策 58):同一场。取消等待,开播时刻与粉丝基线沿用第一次的,两张卡都不发。
			current.pendingEnd.handle.dispose();
			current.pendingEnd = undefined;
			current.lastRow = opts.table.get(id) ?? current.lastRow;
			armPeriodic(id, current, settings);
			log.info(`[ext-live] 订阅 ${id} 断流后重新开播,接续为同一场(开播卡、下播卡都不发)`);
			return;
		}
		// 新的一场。上一场没报下播的话,它的计时器在这儿收掉。
		dropRun(id, "新的一场开播了");
		const at = now();
		const run: LiveRun = {
			extensionId: sub.extensionId,
			startedAt: value.startedAt,
			fansAtStart: opts.profile(id)?.fans,
			fresh: false,
			lastRow: opts.table.get(id),
		};
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
					fans: run.fansAtStart,
				}),
			);
		}
		armPeriodic(id, run, settings);
	}

	function onLiveStatus(id: string, value: LiveStatus): void {
		// 报了不在播:BN 不拿它猜下播(决策 53),在播表自己出表;这一场的计时器等下播事件来收。
		if (!value.live) return;
		const sub = pushable(id);
		if (!sub) return;
		const settings = opts.settings(sub);
		if (!settings.live && !settings.liveEnd) return;
		const current = runs.get(id);
		if (current) {
			current.fresh = true;
			current.lastRow = opts.table.get(id) ?? current.lastRow;
			current.startedAt ??= value.startedAt;
			return;
		}
		// 这一场没见过开播事件:BN 起来之前就开播了,或者拓展停过又跑起来了。
		const first = !seenLive.has(id);
		seenLive.add(id);
		const run: LiveRun = {
			extensionId: sub.extensionId,
			startedAt: value.startedAt,
			fansAtStart: opts.profile(id)?.fans,
			fresh: false,
			lastRow: opts.table.get(id),
		};
		runs.set(id, run);
		if (first && settings.restartPush && settings.live) {
			log.info(`[ext-live] 订阅 ${id} 在 BN 起来之前就开播了,补推一张「正在直播」`);
			enqueue(id, "「正在直播」(重启补推)", () => pushOngoing(id, run));
		} else {
			log.debug(`[ext-live] 订阅 ${id} 正在播,接上这一场(不补推)`);
		}
		armPeriodic(id, run, settings);
	}

	/** 推下播卡、清掉这一场。`run` 没有 = BN 手里没有这一场(中途重启过、拓展没报过状态)。 */
	function finishEnd(id: string, run: LiveRun | undefined, endedAt: number, value: LiveEnd): void {
		if (run && runs.get(id) === run) runs.delete(id);
		const sub = pushable(id);
		if (!sub) return;
		if (!opts.settings(sub).liveEnd) {
			log.debug(`[ext-live] 订阅 ${id} 的下播推送关着,下播卡不推`);
			return;
		}
		// 事件没带的格用这一场最后一份状态补;开播时刻先认 BN 自己记着的(决策 56)。
		const facts: LiveFacts = { ...defined(run?.lastRow), ...defined(value) };
		const startedAt = run?.startedAt ?? value.startedAt ?? run?.lastRow?.startedAt;
		enqueue(id, "下播", () => {
			const fansNow = opts.profile(id)?.fans;
			const fansChanged =
				fansNow !== undefined && run?.fansAtStart !== undefined
					? fansNow - run.fansAtStart
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

	function onLiveEnd(id: string, value: LiveEnd): void {
		const sub = pushable(id);
		if (!sub) {
			log.debug(`[ext-live] 订阅 ${id} 已停用 / 已删 / 它的拓展没在跑,下播不推`);
			return;
		}
		const settings = opts.settings(sub);
		if (!settings.live && !settings.liveEnd) {
			dropRun(id, "开播与下播推送都关了");
			return;
		}
		const endedAt = now();
		const run = runs.get(id);
		if (run?.pendingEnd) {
			log.debug(`[ext-live] 订阅 ${id} 已经在断流等待里,这次下播忽略`);
			return;
		}
		if (run) {
			run.lastRow = opts.table.get(id) ?? run.lastRow;
			run.periodic?.handle.dispose();
			run.periodic = undefined;
			if (settings.liveEndGrace) {
				// 断流接续(决策 58):先压着,期满才推;期间再开播就当同一场。
				const minutes = liveEndGraceMinutes(settings.liveEndGraceMinutes);
				run.pendingEnd = {
					endedAt,
					value,
					handle: opts.timers.setTimeout(() => {
						const waiting = runs.get(id);
						if (waiting !== run || !run.pendingEnd) return;
						const pending = run.pendingEnd;
						run.pendingEnd = undefined;
						log.info(`[ext-live] 订阅 ${id} 等了 ${minutes} 分钟没重新开播,推下播`);
						finishEnd(id, run, pending.endedAt, pending.value);
					}, minutes * MINUTE),
				};
				log.info(`[ext-live] 订阅 ${id} 下播,进入 ${minutes} 分钟断流接续等待`);
				return;
			}
		}
		finishEnd(id, run, endedAt, value);
	}

	const watches: Disposable[] = [
		opts.bus.on("subscription-reported", (delivery) => {
			const { report } = delivery;
			for (const id of delivery.subscriptionIds) {
				switch (report.kind) {
					case "liveStart":
						onLiveStart(id, report.value);
						break;
					case "liveStatus":
						onLiveStatus(id, report.value);
						break;
					case "liveEnd":
						onLiveEnd(id, report.value);
						break;
					default:
						// 作品、资料更新不归这里。
						return;
				}
			}
		}),
		// 拓展停了(决策 61):它名下的全部作废,等着的下播卡不补推。重新跑起来后靠直播状态接上。
		opts.bus.on("extension-stopped", (extensionId) => {
			for (const [id, run] of [...runs]) {
				if (run.extensionId === extensionId) dropRun(id, `拓展 ${extensionId} 停了`);
			}
		}),
		opts.bus.on("subscription-changed", (ops) => {
			for (const op of ops) {
				if (op.type === "remove") {
					dropRun(op.sub.id, "订阅删了");
					gates.delete(op.sub.id);
					seenLive.delete(op.sub.id);
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
