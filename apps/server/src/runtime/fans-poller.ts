import type { BilibiliAPI } from "@bilibili-notify/api";
import {
	type BiliSubscription,
	type CachedProfile,
	type ConfigScope,
	type Disposable,
	type ExtensionSubscription,
	type FansRefreshEntry,
	isBiliSubscription,
	isExtensionSubscription,
	type Logger,
	type MessageBus,
	type ServiceContext,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { CronJob } from "cron";
import type { ConfigStore } from "../config/store.js";
import type { FansStore } from "../fans/store.js";
import { statsFileKey } from "../stats/file-key.js";
import {
	pruneOrphanSubRuntime,
	type SubRuntime,
	type SubRuntimeStore,
} from "./sub-runtime-store.js";

const ONE_HOUR_MS = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;
const SEVEN_DAYS_MS = 7 * 24 * ONE_HOUR_MS;
/** 一个「远未来」时间戳:拿它去 `findNearestBefore` 就退化成「取最近一条」。 */
const FUTURE_ISO = "9999-12-31T00:00:00.000Z";

/**
 * 命中即判定为风控/限流的响应码。-352 风控、-403 越权风控、-412 请求被拦、
 * -799 请求过于频繁。与 packages/api `classifyRefreshCode` 的口径同源、再补上
 * 限流码 —— fans 轮询逐 UP 请求,量最大,熔断口径要更宽。
 */
const RISK_CONTROL_CODES = new Set([-352, -403, -412, -799]);
/** 命中风控后退避多久再让下一 tick 真正跑(对齐 dynamic 引擎 5min 退避)。 */
const FANS_RISK_BACKOFF_MS = 5 * 60_000;
/** 冷刷 name/avatar 的批量端点单次上限(B 站 user/cards 契约:≤50)。 */
const CARDS_BATCH_SIZE = 50;

export interface FansPollerOptions {
	bus: MessageBus;
	logger: Logger;
	/** Only read for `getGlobals().app.fansCron` (cron reconcile). NOT written. */
	configStore: ConfigStore;
	subscriptionStore: SubscriptionStore;
	/**
	 * Per-tick cachedProfile.fans / lastRefreshedAt (+ first-time fansBaseline)
	 * persist here — NOT via configStore.patchSubscription. That decoupling is
	 * the whole point: it stops the `config-changed:subscriptions` fan-out that
	 * re-triggered DynamicEngine every tick (the Logs-Tab `[ops]` flooding bug).
	 */
	subRuntimeStore: SubRuntimeStore;
	fansStore: FansStore;
	api: BilibiliAPI;
	/**
	 * 用于 dispose-safe 延时(首次 tick 等 auth 起来的 3s 窗口)。dispose() 时
	 * runtime 一并清掉 pending timer,避免 stop/restart 期间裸 setTimeout 留 3s
	 * 空跑句柄。同 packages/push / packages/api 的 P1-B 风格。
	 */
	serviceCtx: ServiceContext;
}

export interface FansPollerHandle extends Disposable {
	/**
	 * 首页粉丝面板的快照(一条订阅一条,键是订阅 id):B 站是最近一轮成功采样的,拓展是按它的粉丝时序算的
	 * (ADR-0020 决策 8)。GET /api/fans 直接读这个,免去对 jsonl 的同步查询。Bootstrap 前为空数组;
	 * 开机从盘上恢复一份,之后每轮 tick 更新。
	 */
	getLastEntries(): FansRefreshEntry[];
	/**
	 * 把轮询提前到现在(devtools「现在就跑」)。走的就是 cron 到点调的那个 tick;上一轮
	 * 还在跑就跳过、回 false,与 cron 撞上时的规矩一样。回的 promise 在这一轮结束时落定。
	 */
	pollNow(): Promise<boolean>;
}

/**
 * Per-tick:遍历所有 enabled subs,逐个拉 B 站 `getUserCardInfo` 取 fans;
 *
 *   1. 追加一行样本到 FansStore(<dataDir>/fans/<订阅 id>.jsonl,ADR-0020 决策 2 的 🔗);
 *   2. 第一次见该 sub → 把当前值作为 fansBaseline(订阅起点)写进 SubRuntimeStore;
 *   3. 同步更新 SubRuntimeStore 里该 sub 的 cachedProfile.fans + lastRefreshedAt
 *      (不再走 configStore.patchSubscription —— 见 FansPollerOptions 注释);
 *   4. 计算 24h / 7d 窗口的 delta(从 jsonl 找近似时间点的最近样本);
 *   5. 单次轮询全部完成后 emit `fans-refreshed`(entries);
 *
 * 失败处理:per-uid try/catch,单 UP 失败不阻断剩余轮询。串行 + 200ms 间隔
 * 减小被 B 站风控的概率。cron 用 globals.app.fansCron(默认每 10min 一轮),
 * 用户改 cron 表达式会通过 config-changed 通道触发本 poller reconcile。
 *
 * **拓展订阅**(ADR-0020 决策 8):粉丝轮询**不问**它们(那是 B 站独有的,ADR-0019 决策 64);它们的粉丝时序
 * 由统计的拓展适配按资料上报里的粉丝数写(`stats/extension-source.ts`)。面板上那一行在这里从时序算:
 * 启用着、有时序的才上;当前数取最近报的资料,起点 / 24h / 7d 见 {@link extensionEntry}。每轮 tick 算一遍
 * (B 站风控退避时也算 —— 它不问 B 站),拓展报了新的粉丝数(`subscription-profiles-changed`)时只算报了的那几条。
 *
 * auth-lost / auth-restored:auth 丢失期间任何调用都会失败,所以 poller 不
 * 自己暂停,而是依赖 BilibiliAPI 内部状态;失败的轮次产出全 null delta,前
 * 端面板会显示 "—"。这样 auth 恢复后无需重新初始化 poller。
 */
export function startFansPoller(opts: FansPollerOptions): FansPollerHandle {
	const {
		bus,
		logger,
		configStore,
		subscriptionStore,
		subRuntimeStore,
		fansStore,
		api,
		serviceCtx,
	} = opts;

	let currentCron = configStore.getGlobals().app.fansCron;
	let job: CronJob | undefined;
	let running = false;
	let disposed = false;
	// ② 风控退避:命中风控码后设成 Date.now()+FANS_RISK_BACKOFF_MS,窗口内的 tick
	// 直接跳过(不再逐 UP 敲一遍放大风控)。0 = 无退避。
	let riskBackoffUntil = 0;
	// 订阅 id → 面板上那一行(两支都在这一张表里,ADR-0020 决策 8)。replace,不累加。B 站:每轮跑完
	// 覆盖本轮采到的,跳过本轮没采到的(保留上一轮的值,避免间歇性失败导致 dashboard 数字闪烁);拓展:
	// 每次按时序重算。键是订阅 id 而不是 uid:同一个 uid 配两条订阅时各是各的一行,拓展条目没有 uid。
	const lastBySub = new Map<string, FansRefreshEntry>();
	/**
	 * 这一进程里往哪些粉丝文件(订阅 id)写过样本。清扫按它删「删了订阅之后又被写回来」的那份 ——
	 * 判据是**这条订阅**不在了,不是这个 uid 不在了:同一个人删了重订是另一条订阅、另一份文件,
	 * 旧的那份照样得删。
	 */
	const writtenKeys = new Set<string>();

	/**
	 * 粉丝轮询只问 B 站订阅(ADR-0019 决策 12:粉丝曲线第一版不含拓展订阅)。拓展订阅没有
	 * uid,拿它去问 B 站等于拿别的平台的 id 查一个不相干的人。
	 */
	function biliSubs(): BiliSubscription[] {
		return subscriptionStore.list().filter(isBiliSubscription);
	}

	function enabledBiliSubs(): BiliSubscription[] {
		return biliSubs().filter((s) => s.enabled);
	}

	/** 启用着的拓展订阅 —— 面板上那一行从它们的粉丝时序算,不拿外部 id 去问 B 站。 */
	function enabledExtensionSubs(): ExtensionSubscription[] {
		return subscriptionStore
			.list()
			.filter(isExtensionSubscription)
			.filter((s) => s.enabled);
	}

	/**
	 * 一条拓展订阅在面板上的那一行,从它的粉丝时序算(ADR-0020 决策 8);没有时序(平台不报粉丝数,或还没报过)
	 * 就没有这一行。与 B 站同一个意思:
	 *   - 当前数:它最近一次报的资料里的(比稀释过的样本新,与统计页的「当前粉丝」同一个数);资料没带取时序末值;
	 *   - 起点:时序的**第一条样本** —— B 站的 fansBaseline 是第一次采到的值、开机按时序最早一条自愈,是同一件事。
	 *     拓展的时序停用不删、删订阅才删,第一条就是这条订阅开始被记的那一刻,不另存一份;
	 *   - 24h / 7d:那一刻之前最近的一条样本,同 B 站。
	 */
	async function extensionEntry(
		sub: ExtensionSubscription,
		nowMs: number,
	): Promise<FansRefreshEntry | undefined> {
		const key = statsFileKey(sub);
		const [latest, first, near24h, near7d] = await Promise.all([
			fansStore.findNearestBefore(key, FUTURE_ISO),
			fansStore.findEarliest(key),
			fansStore.findNearestBefore(key, new Date(nowMs - TWENTY_FOUR_HOURS_MS).toISOString()),
			fansStore.findNearestBefore(key, new Date(nowMs - SEVEN_DAYS_MS).toISOString()),
		]);
		if (!latest) return undefined;
		const profile = subRuntimeStore.get(sub.id)?.cachedProfile;
		const reported = profile?.fans;
		const current = reported ?? latest.value;
		return {
			subscriptionId: sub.id,
			extensionId: sub.extensionId,
			externalId: sub.externalId,
			current,
			ts: reported !== undefined && profile ? profile.lastRefreshedAt : latest.ts,
			deltaSubscribed: first ? current - first.value : null,
			delta24h: near24h ? current - near24h.value : null,
			delta7d: near7d ? current - near7d.value : null,
		};
	}

	/**
	 * 把启用着的拓展订阅(给了 `only` 就只看那几条)的那一行按时序重算一遍,回「快照动没动」。算的这会儿
	 * 订阅可能被停用 / 删了:算完再看一眼,别把刚撤下来的又放回去。
	 */
	async function refreshExtensionEntries(only?: ReadonlySet<string>): Promise<boolean> {
		const nowMs = Date.now();
		let changed = false;
		for (const sub of enabledExtensionSubs()) {
			if (only && !only.has(sub.id)) continue;
			if (disposed) return changed;
			try {
				const entry = await extensionEntry(sub, nowMs);
				if (disposed) return changed;
				const stillEnabled = enabledExtensionSubs().some((s) => s.id === sub.id);
				if (entry && stillEnabled) {
					lastBySub.set(sub.id, entry);
					changed = true;
				} else if (lastBySub.delete(sub.id)) {
					changed = true;
				}
			} catch (err) {
				logger.debug(`[fans-poller] 拓展订阅 ${sub.id} 的粉丝条目没算出来: ${String(err)}`);
			}
		}
		return changed;
	}

	function emitSnapshot(): void {
		bus.emit("fans-refreshed", Array.from(lastBySub.values()));
	}

	function tick(): void {
		void tickOnce();
	}

	/** 一轮 tick;回「这次真的跑了没」。在跑 / 已释放都不跑。 */
	function tickOnce(): Promise<boolean> {
		if (disposed) return Promise.resolve(false);
		if (running) {
			logger.debug("[fans-poller] previous tick still running, skipping");
			return Promise.resolve(false);
		}
		running = true;
		return runTick()
			.then(() => true)
			.catch((err) => {
				logger.warn(`[fans-poller] tick failed: ${String(err)}`);
				return true;
			})
			.finally(() => {
				running = false;
			});
	}

	function enterRiskBackoff(code: number): void {
		riskBackoffUntil = Date.now() + FANS_RISK_BACKOFF_MS;
		logger.warn(
			`[fans-poller] 命中风控/限流 code=${code},中止本轮 sweep,退避 ${
				FANS_RISK_BACKOFF_MS / 1000
			}s 后重试(不继续刷剩余 UP,避免放大风控)`,
		);
	}

	async function runTick(): Promise<void> {
		if (disposed) return;
		// Sweep:快照只保留启用着的订阅(两支),emit 出去的就不含停用 / 已删的,前端覆盖式
		// setQueryData 自然把他们的卡片从首页粉丝面板上撤掉。
		//
		// 撤出快照 ≠ 删时序文件(ADR-0020 决策 10):**停用**的 UP 统计页照样列着,文件留着,
		// 再启用接着往里记;只有这条订阅不在了才删(见 pollBili 里的清扫)。
		const enabledIds = new Set(
			subscriptionStore
				.list()
				.filter((s) => s.enabled)
				.map((s) => s.id),
		);
		for (const id of Array.from(lastBySub.keys())) {
			if (!enabledIds.has(id)) lastBySub.delete(id);
		}
		// ② 风控退避窗口内:B 站整轮跳过,不发任何请求。拓展的那几行不问 B 站,照样算。
		if (Date.now() < riskBackoffUntil) {
			logger.debug("[fans-poller] 风控退避中,跳过本轮 B 站采样");
		} else {
			await pollBili();
			if (disposed) return;
		}
		await refreshExtensionEntries();
		// 每轮固定 emit 一次「全部启用订阅的当前快照」(全删光了也 emit 空快照让前端清屏),前端做覆盖式
		// setQueryData,从而正确反映"本轮失败保留旧值"+"停用 / 删除的撤掉"两种语义
		// (删除由 subscription-changed 监听当场撤,停用等这一轮的 sweep)。
		if (disposed) return;
		emitSnapshot();
		logger.debug(`[fans-poller] tick done, snapshot=${lastBySub.size}`);
	}

	/** 一轮 B 站采样:逐个问启用着的 B 站订阅,写样本、写资料缓存、更新快照里那一行。不 emit。 */
	async function pollBili(): Promise<void> {
		const allBili = biliSubs();
		const subs = allBili.filter((s) => s.enabled);
		// 删订阅平时由下面的 subscription-changed 监听当场删文件,这里兜的是它删完之后又被写回来的那种:
		// tick 正在跑时删了订阅,这一轮随后照样 append(文件重新长出来)。只扫这一进程写过的,不扫盘 ——
		// BN 停机期间删掉的订阅留下的文件这里管不到。
		const subscribedKeys = new Set(allBili.map((s) => statsFileKey(s)));
		for (const key of Array.from(writtenKeys)) {
			if (subscribedKeys.has(key)) continue;
			writtenKeys.delete(key);
			void fansStore.drop(key);
		}
		if (subs.length === 0) return;
		logger.debug(`[fans-poller] tick start, ${subs.length} subs`);
		const now = new Date();
		const nowIso = now.toISOString();
		const target24hIso = new Date(now.getTime() - TWENTY_FOUR_HOURS_MS).toISOString();
		const target7dIso = new Date(now.getTime() - SEVEN_DAYS_MS).toISOString();

		for (const sub of subs) {
			// 每个 await 之后必须重新 check disposed,否则 await 期间 dispose 触发,
			// 返回后会继续 append/patch/emit 出残留副作用。
			if (disposed) return;
			try {
				const prev = subRuntimeStore.get(sub.id);
				// ⑥ 稳态用轻量的 relation/stat 取 follower;仅在 cachedProfile 尚未 seed
				// (首见该 UP)时回退 card —— card 一次带回 fans + name/avatar/sign 供 seed。
				let current: number | undefined;
				let seedCard: { name?: string; face?: string; sign?: string } | undefined;
				if (prev?.cachedProfile) {
					const stat = await api.getRelationStat(sub.uid);
					if (disposed) return;
					if (RISK_CONTROL_CODES.has(stat.code)) {
						enterRiskBackoff(stat.code); // ② 中止 sweep
						break;
					}
					if (stat.code !== 0 || !stat.data) {
						logger.warn(`[fans-poller] uid=${sub.uid} relation/stat code=${stat.code}`);
						continue;
					}
					current = stat.data.follower;
				} else {
					const res = await api.getUserCardInfo(sub.uid);
					if (disposed) return;
					if (RISK_CONTROL_CODES.has(res.code)) {
						enterRiskBackoff(res.code); // ② 中止 sweep
						break;
					}
					if (res.code !== 0 || !res.data?.card) {
						logger.warn(
							`[fans-poller] uid=${sub.uid} upstream code=${res.code} msg=${
								(res as { message?: string }).message ?? "?"
							}`,
						);
						continue;
					}
					current = res.data.card.fans;
					seedCard = {
						name: res.data.card.name,
						face: res.data.card.face,
						sign: res.data.card.sign,
					};
				}
				if (typeof current !== "number" || current < 0) continue;

				const key = statsFileKey(sub);
				await fansStore.append(key, { ts: nowIso, value: current });
				writtenKeys.add(key);
				if (disposed) return;

				const [near24h, near7d] = await Promise.all([
					fansStore.findNearestBefore(key, target24hIso),
					fansStore.findNearestBefore(key, target7dIso),
				]);
				if (disposed) return;

				const baseline = prev?.fansBaseline;
				const nextBaseline = baseline ?? { value: current, ts: nowIso };
				const deltaSubscribed = current - nextBaseline.value;

				const delta24h = near24h ? current - near24h.value : null;
				const delta7d = near7d ? current - near7d.value : null;

				// 写进 SubRuntimeStore(独立文件 + 原子写,**不发** config-changed)——
				// fansBaseline 首次写、cachedProfile.fans/lastRefreshedAt 每次写。
				// name/avatar/sign 沿用既有(POST 自 seed / 上一次),缺失才从 card(首见时
				// 的 seedCard)兜底。稳态走 relation/stat 时 seedCard 为空,直接用既有 profile。
				const cachedProfile: CachedProfile = {
					...(prev?.cachedProfile ?? {
						name: seedCard?.name ?? sub.uid,
						avatar: seedCard?.face ?? "",
						sign: seedCard?.sign ?? "",
					}),
					fans: current,
					lastRefreshedAt: nowIso,
				};
				const runtimePatch: SubRuntime = { cachedProfile };
				if (!baseline) runtimePatch.fansBaseline = nextBaseline;
				try {
					await subRuntimeStore.patch(sub.id, runtimePatch);
				} catch (err) {
					logger.warn(`[fans-poller] persist ${sub.uid} failed: ${String(err)}`);
				}
				if (disposed) return;

				const entry: FansRefreshEntry = {
					subscriptionId: sub.id,
					uid: sub.uid,
					current,
					ts: nowIso,
					deltaSubscribed,
					delta24h,
					delta7d,
				};
				lastBySub.set(sub.id, entry);
			} catch (err) {
				logger.warn(`[fans-poller] uid=${sub.uid} failed: ${String(err)}`);
			}
			// 200ms 间隔,串行 + 节流,避免 cookies 风控。
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	// fansCron 是 dashboard 自由文本框,没有格式校验;`new CronJob` 对无法解析的
	// 表达式同步抛错,未捕获会让整个独立端进程在启动/reconcile 期崩溃(见
	// dynamic-engine.ts startJob 同类修复的注释与 `.bugs/sidecar.stderr.log` 复现)。
	function startJob(): void {
		try {
			job = new CronJob(currentCron, tick);
		} catch (err) {
			logger.error(
				`[fans-poller] cron='${currentCron}' 无法解析,fans 轮询未启动：${err instanceof Error ? err.message : String(err)}`,
			);
			job = undefined;
			return;
		}
		job.start();
		logger.info(`[fans-poller] scheduled with cron='${currentCron}'`);
	}

	function reconcileCron(): void {
		const next = configStore.getGlobals().app.fansCron;
		if (next === currentCron) return;
		logger.info(`[fans-poller] cron changed: '${currentCron}' → '${next}'`);
		job?.stop();
		currentCron = next;
		startJob();
	}

	/**
	 * 重启恢复:从每个 enabled B 站 sub 的 fans/<订阅 id>.jsonl 末尾读最近一条样本,填进
	 * lastBySub 并立即 emit 一次。这样 Dashboard 首屏不会因为新一轮 tick 还没跑完
	 * 就空白。B 站的窗口 delta(24h/7d)留给第一次正式 tick 计算;拓展的那几行本来就是从盘上算的,
	 * 这里整行算好。
	 */
	async function restoreFromDisk(): Promise<void> {
		if (disposed) return;
		const subs = enabledBiliSubs();
		for (const sub of subs) {
			if (disposed) return;
			try {
				const last = await fansStore.findNearestBefore(statsFileKey(sub), FUTURE_ISO);
				if (!last) continue;
				// 自愈 baseline:jsonl 是 ground truth(append-only),而 sub-runtime.json
				// 里的 fansBaseline 历史上被批量重写过(c4e9dcd 把 baseline 搬出 Subscription
				// 时旧值没迁过来 → fans-poller 看 baseline 缺失就把当时值当起点写)。
				// 启动时若发现 jsonl earliest 比 baseline 早,以 earliest 校准 baseline。
				let baseline = subRuntimeStore.get(sub.id)?.fansBaseline;
				const earliest = await fansStore.findEarliest(statsFileKey(sub));
				if (earliest && baseline && earliest.ts < baseline.ts) {
					logger.info(
						`[fans-poller] baseline self-heal uid=${sub.uid}: ${baseline.ts}(${baseline.value}) → ${earliest.ts}(${earliest.value})`,
					);
					try {
						await subRuntimeStore.patch(sub.id, { fansBaseline: earliest });
						baseline = earliest;
					} catch (err) {
						logger.warn(`[fans-poller] baseline self-heal ${sub.uid} failed: ${String(err)}`);
					}
				}
				const deltaSubscribed = baseline ? last.value - baseline.value : 0;
				lastBySub.set(sub.id, {
					subscriptionId: sub.id,
					uid: sub.uid,
					current: last.value,
					ts: last.ts,
					deltaSubscribed,
					delta24h: null,
					delta7d: null,
				});
			} catch (err) {
				logger.debug(`[fans-poller] restore ${sub.uid} skipped: ${String(err)}`);
			}
		}
		await refreshExtensionEntries();
		if (lastBySub.size > 0 && !disposed) {
			emitSnapshot();
			logger.info(`[fans-poller] restored ${lastBySub.size} entries from disk`);
		}
	}

	/**
	 * ⑥ name/avatar 批量冷刷:启动时用批量 user/cards(≤50 一发)把已 seed 的
	 * cachedProfile 的昵称/头像刷新一遍,替代「每 tick 逐 UP 拉整张 card」里那份
	 * 从未在稳态被消费的 name/avatar。只更 name/avatar,fans/sign/lastRefreshedAt
	 * 保持不动(fans 由 tick 负责)。命中风控即退避、停止后续分片。
	 */
	async function refreshProfilesBatch(): Promise<void> {
		if (disposed) return;
		const targets = enabledBiliSubs().filter((s) => subRuntimeStore.get(s.id)?.cachedProfile);
		for (let i = 0; i < targets.length; i += CARDS_BATCH_SIZE) {
			if (disposed) return;
			const chunk = targets.slice(i, i + CARDS_BATCH_SIZE);
			try {
				const res = await api.getUserCardsBatch(chunk.map((s) => s.uid));
				if (disposed) return;
				if (RISK_CONTROL_CODES.has(res.code)) {
					enterRiskBackoff(res.code);
					return;
				}
				if (res.code !== 0 || !res.data) continue;
				const data = res.data;
				for (const sub of chunk) {
					const brief = data[sub.uid];
					const prevProfile = subRuntimeStore.get(sub.id)?.cachedProfile;
					if (!brief || !prevProfile) continue;
					const name = brief.name || prevProfile.name;
					const avatar = brief.face || prevProfile.avatar;
					if (name === prevProfile.name && avatar === prevProfile.avatar) continue;
					try {
						await subRuntimeStore.patch(sub.id, {
							cachedProfile: { ...prevProfile, name, avatar },
						});
					} catch (err) {
						logger.warn(`[fans-poller] 冷刷 profile ${sub.uid} 持久化失败: ${String(err)}`);
					}
				}
			} catch (err) {
				logger.warn(`[fans-poller] 批量刷 profile 失败: ${String(err)}`);
			}
		}
	}

	startJob();
	// 先从磁盘恢复历史 entries 给首屏用,然后延后 3s 才发首轮 tick — 给 auth /
	// LoginFlow 起来的窗口期,降低"第一次 tick 撞 auth 未就绪 → 每个 sub 打一行
	// warn + 首屏全 —"的概率。3s 门后先批量冷刷一次 name/avatar,再开轮询。
	void (async () => {
		await restoreFromDisk();
		if (disposed) return;
		await new Promise<void>((resolveFirstTick) => {
			serviceCtx.setTimeout(resolveFirstTick, 3000);
		});
		if (disposed) return;
		await refreshProfilesBatch();
		if (disposed) return;
		tick();
	})();

	const offConfig = bus.on("config-changed", (scope: ConfigScope) => {
		if (scope !== "globals") return;
		reconcileCron();
	});

	// 订阅被删除时立即清理 in-memory entry + jsonl 时序,并 emit 一次空 diff 让
	// dashboard 立刻把该 UP 从面板上撤掉(无需等下一 cron tick)。
	const offSubs = bus.on("subscription-changed", (ops) => {
		let removedAny = false;
		let hadRemove = false;
		for (const op of ops) {
			if (op.type !== "remove") continue;
			// 删掉的是哪一支都要清资料缓存(下面那次 prune)、撤下面板上那一行。
			hadRemove = true;
			if (lastBySub.delete(op.sub.id)) removedAny = true;
			// 粉丝文件:B 站的归这里删;拓展的归统计的拓展适配删(它写的,`stats/extension-source.ts`)。
			if (!isBiliSubscription(op.sub)) continue;
			const key = statsFileKey(op.sub);
			writtenKeys.delete(key);
			void fansStore.drop(key);
		}
		if (hadRemove) {
			// Drop the deleted sub's SubRuntimeStore entry. subscriptionStore
			// already reflects the post-delete set when this fires (config-changed
			// → bridge replaceAll → subscription-changed), so a keep-set prune is
			// precise + idempotent and avoids a dedicated delete(id) API.
			void pruneOrphanSubRuntime(subRuntimeStore, subscriptionStore);
		}
		if (removedAny) emitSnapshot();
	});

	// 拓展报了新的资料(面板看得见的名字 / 头像 / 粉丝数真变了,250ms 窗口合并过)→ 不等下一轮,当场把报了的
	// 那几条拓展订阅的那一行重算一遍。只动那几条、读几次时序,不碰 B 站。B 站的资料是这里自己写的,不经这条。
	// 资料是先落盘、窗口满了才发这一声,所以当前数一定是新的;时序那一条样本可能还在记录器的队里 —— 第一条
	// 样本没落盘之前这一行还上不来,等下一轮 tick。
	const offProfiles = bus.on("subscription-profiles-changed", (ids) => {
		const wanted = new Set(ids);
		if (!enabledExtensionSubs().some((s) => wanted.has(s.id))) return;
		void refreshExtensionEntries(wanted)
			.then((changed) => {
				if (changed && !disposed) emitSnapshot();
			})
			.catch((err) => logger.debug(`[fans-poller] 拓展粉丝条目刷新失败: ${String(err)}`));
	});

	return {
		dispose(): void {
			disposed = true;
			job?.stop();
			offConfig.dispose();
			offSubs.dispose();
			offProfiles.dispose();
			// 不主动 await in-flight tick(Disposable 接口为 void);runTick 内会在每个
			// await 后 check disposed,中途返回,新副作用不会出现。
		},
		getLastEntries(): FansRefreshEntry[] {
			return Array.from(lastBySub.values());
		},
		pollNow: tickOnce,
	};
}
