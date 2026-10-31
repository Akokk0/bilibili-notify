import { randomUUID } from "node:crypto";
import type {
	AiWritingSettings,
	DeliveryResult,
	Disposable,
	ExtraKey,
	FeatureKey,
	GlobalDefaults,
	Logger,
	NotificationPayload,
	PayloadSegment,
	PushMessageRole,
	PushTarget,
	ServiceContext,
	Subscription,
	TargetDispatcher,
} from "@bilibili-notify/internal";
import {
	aiWritingFor,
	BILIBILI_SOURCE_KEY,
	fail,
	inQuietHours,
	isPrivateTarget,
	resolve,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { packageText } from "@bilibili-notify/internal/texts";
import type { SubscriptionStore } from "@bilibili-notify/subscription";

/**
 * 「@全体单独一条消息」的 payload。atAllTargets 上的发送序列:先发这条独立
 * @全体,再发原 payload(卡片 + 文字)—— 接收端看到的是两条独立消息,@ 提醒
 * 在前、卡片在后,不再把 at-all 段塞进卡片消息里。
 *
 * image-group 同样适用:旧 `prependAtAll` 版本因要把 at-all 段塞进合并转发
 * 节点内部语义不清而沉默忽略,新版本下 @全体 已经是**外层独立一条消息**,跟
 * 合并转发节点不冲突 → 一视同仁照常先发独立 @全体 再发合并转发。
 */
function makeAtAllPayload(): NotificationPayload {
	const at: PayloadSegment = { kind: "at-all" };
	return { kind: "composite", segments: [at] };
}

/**
 * 日志里认得出「是谁」的那一截:B 站 `uid=<uid>`,拓展 `<extensionId>:<externalId>`。
 * 只拿来给人看 —— 推送链认的是订阅自己的 id(ADR-0019 决策 50),查不到订阅时日志就写 `sub=<id>`。
 */
function subscriptionLabel(sub: Subscription): string {
	const identity = subscriptionIdentityOf(sub);
	return identity.sourceKey === BILIBILI_SOURCE_KEY
		? `uid=${identity.externalId}`
		: `${identity.sourceKey}:${identity.externalId}`;
}

/**
 * 这个锚点的消息归 `ai.writing` 的哪一份管:本体且特性是 `post` → `writing.post`,总结附加项 →
 * `writing.liveSummary`,别的锚点没有 AI 版这回事(`undefined`)。和 @全体 的键推导一样,键只在这里认。
 */
function aiWritingEntryOf(
	writing: AiWritingSettings,
	role: PushMessageRole,
	feature: FeatureKey,
	extra: ExtraKey | undefined,
): AiWritingSettings["post"] | undefined {
	if (role === "main") return feature === "post" ? writing.post : undefined;
	return extra === "liveSummary" ? writing.liveSummary : undefined;
}

/** 约定被拒绝的原因,给日志用。 */
function rejectionReason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const INITIAL_RETRY_DELAY_MS = 3000;
const MAX_RETRY_DELAY_MS = INITIAL_RETRY_DELAY_MS * 2 ** 5;

export interface PushMessage {
	payload: NotificationPayload;
	role: PushMessageRole;
}

export interface PushMessageResult extends PushMessage {
	/**
	 * 缺省 = **这条从来没出过网**:同一目标的前一条失败、整段序列就此中止,后面这些
	 * 连 dispatcher 都没进(ADR-0017 决策 17)。它们照样回调,好让历史记全「本来要发几条」——
	 * 从前静默丢掉,一次本该发 3 条的推送在面板上只剩 1 条,少掉的无从查起。
	 *
	 * 与无目标行的每一条同形状(那一整行也都没有结果)。
	 */
	result?: DeliveryResult;
	/**
	 * 这条被全局静音或免扰时段挡下了(ADR-0021 决策 34 的 🔗):本来会发给这个目标,没发,所以没有
	 * `result`(两格互斥)。只在被挡时出现;不区分是静音还是免扰。它不是失败,也不是上面那种
	 * 「前一条失败而没发出去的」—— 宿主据此落 `silenced` 行。
	 */
	isSilenced?: true;
}

interface PushSendBase {
	/**
	 * 一次推送的身份,由 {@link PushRouter.push} 自己生成。一次推送有好几个锚点(下播卡之后是
	 * 词云、总结;作品主卡之后是图集),各锚点的回调带同一个,历史就落在同一行里追加。
	 */
	pushId: string;
	/**
	 * 这次推送属于哪条订阅 —— 订阅自己的 id(uuid),推送链的运行期键(ADR-0019 决策 50)。
	 * B 站 uid 不在这儿:要的话拿这个 id 回查订阅。
	 */
	subscriptionId: string;
	/**
	 * 这次推送属于哪把特性键:管开关与路由,**历史也记它**(⑬f:历史行没有第二套「推送种类」)。
	 * 重启补报走 `liveStart`、周期「正在直播」走 `liveStreaming`,由调用方选哪把键广播。
	 */
	feature: FeatureKey;
}

/**
 * 一个锚点对**每个目标**回调一次(`sendBatch` 收完该目标的整段序列后),带这一段的全部
 * 消息与逐条结果 —— 历史一行 = 一次推送 × 一个目标。@全体 是 fire-and-forget,落地后
 * 以附加项的身份对同一目标再回调一次。
 *
 * 这类推送**没有任何可用目标**(没配,或配的全停用)时以 `target: null` 回调一次,消息
 * 照带、没有结果 —— 宿主据此落「无目标」那一行,面板上才看得见。特性关着、订阅不在的推送
 * 不回调:那不是「无目标」,是本来就不该推。
 *
 * 被全局静音 / 免扰时段挡下的推送**照样按目标回调**,只是一条都没发:每条消息带 `isSilenced`、
 * 没有结果,@全体 那一次没有。
 *
 * TargetDispatcher 拿不到订阅 / feature(它只看 PushTarget),所以历史只能从这一层注入。
 */
export type PushSendResult =
	| (PushSendBase & { target: PushTarget; messages: PushMessageResult[] })
	| (PushSendBase & { target: null; messages: PushMessage[] });

/** 一个锚点在发送层内部带着走的上下文。 */
export interface SendMeta {
	subscriptionId: string;
	feature: FeatureKey;
	pushId: string;
	role: PushMessageRole;
}

/**
 * 一次推送里的一个**锚点**:本体,或一个附加项。锚点在 {@link Push.anchors} 里按先后排好,
 * 发送就按这个先后。
 */
export interface PushAnchor {
	/** 本体(`main`)还是附加项(`extra`)。 */
	role: PushMessageRole;
	/**
	 * 附加项的键(ADR-0016 决策 5):给了就在路由目标上再按那把键的三态表筛一道 —— 谁没订这个
	 * 附加项谁就收不到;不给(图集这种不归附加项表管的)就发给路由里所有启用的目标。只对 `extra` 有意义。
	 */
	extra?: ExtraKey;
	/**
	 * 这个锚点的消息:现成的,或一个「等会儿给」的约定。一串消息是分条序列(同一目标顺序发、
	 * 一条失败中止该目标这个锚点里的后续条)。最后为空(`undefined` / 空数组)就跳过这个锚点;
	 * 约定被拒绝 = 内容没做出来,记一条警告并跳过 —— 没做出来不是没送到,不回调、不记失败。
	 */
	messages: NotificationPayload[] | Promise<NotificationPayload[] | undefined>;
	/**
	 * 同一个锚点的 **AI 写的那一份**(ADR-0032 决策 2),形状同 `messages`。给了,推送层在收窄出该收的目标之后
	 * 逐目标挑:本体(特性 `post`)按 `writing.post`,带 `liveSummary` 键的附加项按 `writing.liveSummary`,
	 * 别的锚点不看它。没给、约定被拒绝、结果为空 = 这个锚点没有 AI 版,所有目标收 `messages`;
	 * `messages` 自己为空或被拒绝仍跳过整个锚点。
	 */
	aiMessages?: NotificationPayload[] | Promise<NotificationPayload[] | undefined>;
}

/**
 * 一次推送(ADR-0021 决策 34 的 🔗,10-08):本体加它的附加项(图集、词云、总结)是同一次,
 * 整个交给 {@link PushRouter.push}。@全体 的锚点不在这里:它由推送层自己插在本体前面。
 */
export interface Push {
	/** 这次推送属于哪条订阅 —— 订阅自己的 id(ADR-0019 决策 50)。 */
	subscriptionId: string;
	/** 这次推送属于哪把特性键:管开关与路由,历史也记它。 */
	feature: FeatureKey;
	/**
	 * 显式不许 @全体(重启补报这类走开播那把键、却不该 @ 的推送)。不给 = 按特性决定
	 * (只有作品与开播有)。
	 */
	allowAtAll?: false;
	/** 按顺序排好的锚点。本体至多一个,有的话必须排第一个。 */
	anchors: PushAnchor[];
}

/** 一个锚点怎么发:哪把附加项键、许不许 @全体;整次推送被静音 / 免扰挡下时只记不发。 */
interface AnchorRound {
	extra?: ExtraKey;
	allowAtAll: boolean;
	isSilenced: boolean;
	/** 这个锚点的 AI 版;没有(没给、做不出来、为空)就是 `undefined`。 */
	aiPayloads?: NotificationPayload[];
}

/** Options for constructing a PushRouter instance. */
export interface PushRouterOptions {
	/** Platform-neutral push dispatcher — translates targetId → platform delivery. */
	dispatcher: Pick<
		TargetDispatcher,
		"send" | "resolve" | "isEnabled" | "isAvailable" | "supportsAtAll"
	>;
	/** Subscription store — used to resolve routing per subscription id + feature. */
	store: SubscriptionStore;
	/** Optional master PushTarget for private error notifications. */
	master?: PushTarget | null;
	/** Logger instance. */
	logger: Logger;
	/**
	 * 宿主的 ServiceContext:retry backoff 的 sleep 走 `serviceCtx.setTimeout`,runtime dispose
	 * 时可被立即 clear,不会留 32s 空跑 timer。stop() 也会唤醒所有 sleeping retry 循环立即收敛。
	 */
	serviceCtx: ServiceContext;
	/**
	 * Latest `GlobalDefaults` provider — used to resolve `EffectiveSubscription`
	 * per push so `features.X` and `schedule.quietHours` gates work against the
	 * current globals state (not a stale snapshot).
	 */
	defaults: () => GlobalDefaults;
	/** 推送落地的回调,契约见 {@link PushSendResult}。独立端接到历史仓。 */
	onSend?: (info: PushSendResult) => void;
	/**
	 * 全局静音 —— 「安静一会儿」。返回 true 时交给 {@link PushRouter.push} 的那次推送
	 * 整次被挡,所有 feature 一起挡:一条都不发,但照样按目标回调(消息带 `isSilenced`)。
	 *
	 * **每次推送交进来时现问一次**,不在构造时快照:静音是有到期时刻的,快照下来就得等下次重启才恢复。
	 *
	 * 发给主人的私聊(`notifyMaster`)**不受它管**,指令的回话(派发器的 `sendToAddress`,
	 * 根本不进 `push`)也不受 —— 连同挡掉的话主人只会看到指令毫无反应。
	 */
	muted: () => boolean;
	/**
	 * 免扰时段按哪一刻判。缺省真时钟;宿主的 devtools 用它做「当作现在是 xx:xx」的单点覆盖 ——
	 * 只影响这一处判定,不是假时钟,延迟 / 超时 / 历史时间戳都还是真的。
	 */
	quietHoursNow?: () => Date;
	/** Current global timezone, read at the quiet-hours gate. */
	timezone: () => string;
	/**
	 * 「AI 写正文」的设置(`ai.writing`,ADR-0032):锚点带了 AI 版时,逐目标按它挑用哪一份。
	 * **每个锚点发出时现取**,不在构造时快照 —— 面板里改了例外,下一次推送就按新的挑。
	 */
	aiWriting: () => AiWritingSettings;
}

/**
 * Platform-neutral push router.
 *
 * The standalone runtime's push router. Routing comes from
 * store.findById(subscriptionId)?.routing[feature] → targetId[] → dispatcher.send(targetId, payload).
 * 键是订阅自己的 id,不是 B 站 uid(ADR-0019 决策 50):B 站引擎那条边在宿主里先把 uid 翻成 id。
 * The old pushArrMap, broadcastToTargets, sendToMaster/sendPrivateMsg/sendErrorMsg are gone —— 主人通知只剩 notifyMaster。
 */
export class PushRouter {
	private readonly dispatcher: PushRouterOptions["dispatcher"];
	private readonly store: SubscriptionStore;
	private master: PushTarget | null;
	/**
	 * 边沿触发用:master 上次已知可达性。`undefined`=未评估;`true/false`=上次判定。
	 * 仅在跳变时打日志(见 {@link refreshMasterReachability}),避免持续不可达时
	 * 在 per-tick 热路径刷 error(Q1 约束)。
	 */
	private masterReachable?: boolean;
	private readonly logger: Logger;
	private readonly defaults: () => GlobalDefaults;
	private readonly muted: () => boolean;
	private readonly quietHoursNow: () => Date;
	private readonly timezone: () => string;
	private readonly aiWriting: () => AiWritingSettings;
	private readonly onSend?: (info: PushSendResult) => void;
	private readonly serviceCtx: ServiceContext;
	private disposed = false;
	/**
	 * Per-lifecycle generation token。每次 `start()` 自增;in-flight retry 循环
	 * 进入时快照本代号,循环条件附加 `generation === myGen`。这样 stop()→start()
	 * 快速重启时,上一生命周期遗留的 in-flight 重试循环(可能正卡在 sleep)被
	 * 唤醒后会因代号不符立即退出,不会"复活"到新生命周期上重发([both]/Codex-P1)。
	 */
	private generation = 0;
	/**
	 * 正在 sleep 等重试的 wake 函数集合 — `stop()` 时全部触发立即返回,避免
	 * retry 循环卡到 32s 才退出。
	 */
	private readonly sleepWakers = new Set<() => void>();

	constructor(opts: PushRouterOptions) {
		this.dispatcher = opts.dispatcher;
		this.store = opts.store;
		this.master = opts.master ?? null;
		this.logger = opts.logger;
		this.defaults = opts.defaults;
		this.timezone = opts.timezone;
		this.muted = opts.muted;
		this.quietHoursNow = opts.quietHoursNow ?? (() => new Date());
		this.aiWriting = opts.aiWriting;
		this.onSend = opts.onSend;
		this.serviceCtx = opts.serviceCtx;
	}

	/**
	 * 热替换 master PushTarget。adapter 在 globals/targets 变化后调用,
	 * 后续 `notifyMaster` 立即用新目标。
	 * `null` 表示"无 master 配置",私聊路径变 no-op。
	 */
	setMaster(target: PushTarget | null): void {
		const prev = this.master?.id;
		this.master = target;
		if (prev !== target?.id) {
			// 目标变了:重置边沿状态,新目标首次不可达应是一次全新 error。
			this.masterReachable = undefined;
			this.logger.info(`[push] master 目标已切换: ${prev ?? "(无)"} → ${target?.id ?? "(无)"}`);
		}
	}

	/**
	 * 边沿触发 master 可达性日志。available→unreachable 跳变(含首次未知→不可达)
	 * 报一次 `error`(告警背channel已断,运维必须立刻知道);unreachable→available
	 * 报一次 `info`;持续不可达不再刷(由调用方各自 `debug` 记录跳过)。同时满足
	 * "运维必须立刻知道" 与 Q1 "error 不得在 per-tick/per-retry 热路径刷" 两约束。
	 */
	private refreshMasterReachability(): boolean {
		if (!this.master) {
			this.masterReachable = undefined;
			return false;
		}
		const available = this.dispatcher.isAvailable(this.master.id);
		if (available) {
			if (this.masterReachable === false) {
				this.logger.info("[push] master 目标已恢复可达");
			}
			this.masterReachable = true;
		} else {
			if (this.masterReachable !== false) {
				this.logger.error("[push] master 目标不可达，运行状态通知将无法送达——告警背channel已断");
			}
			this.masterReachable = false;
		}
		return available;
	}

	start(): void {
		this.generation += 1;
		this.disposed = false;
		if (this.master) this.refreshMasterReachability();
	}

	stop(): void {
		this.disposed = true;
		// 唤醒所有 sleeping retry 循环;snapshot 一份避免迭代中 Set 被 wake 删除。
		for (const wake of [...this.sleepWakers]) wake();
	}

	/**
	 * 发一次推送(见 {@link Push})。订阅按**它自己的 id** 找(ADR-0019 决策 50):同一个 UP 配了
	 * 两条订阅时各推各的路由,拓展订阅(没有 uid)也找得到。B 站引擎说的是 uid,翻译在宿主那条边上做。
	 *
	 * **交进来那一刻判一次**,裁决管整次推送,之后的锚点不再看这四样({@link judgePush}):
	 * - 没有订阅记录、特性总开关关着 → 整次静默丢掉,不发、不回调(这些不是「无目标」);
	 * - 全局静音、免扰时段 → 这次推送是**被挡**的:一条都不发,但每个锚点照常算它该发给哪些目标,
	 *   对每个目标回调一次,消息带 `isSilenced`、没有结果(宿主落 `silenced` 行,之后可以补发);
	 * - 否则放行。
	 * 哪种裁决下锚点里的约定都有人接着,不会留下没人处理的拒绝。只管订阅推送;发给主人的私聊
	 * 不走这里,理由见 `muted` 的注释。
	 *
	 * **锚点按先后发**:内容各做各的(约定是调用方已经启动的),发送按 `anchors` 的顺序 —— 前一个
	 * 锚点对它该发的目标都有了结果才发后一个,后面的早好了也等。空的跳过;锚点之间互不中止(本体
	 * 对某个目标失败不拦它的附加项)。每个锚点发出时现查订阅的路由与附加项表,见 {@link sendAnchor}。
	 * 被挡的推送同样按先后、同样等约定了结,只是到了「发」那一步改成「记」。
	 *
	 * **在本体发完(被挡时:记完)时返回**,回本体那个锚点的投递结果(一个目标一段序列;@全体 是
	 * fire-and-forget,不计入)。没有本体、整次被丢掉或被挡下,回空。其后的锚点在后台接着发,登记进
	 * `serviceCtx.track`,关停会等它们;生命周期翻转(stop / stop→start)时放弃还没发的。
	 *
	 * **唯一会抛的地方**:本体不止一个、或没排在第一个 —— 那是调用方的 bug,不静默纠正。
	 */
	async push(push: Push): Promise<DeliveryResult[]> {
		const { subscriptionId, feature, anchors } = push;
		// 先把每个约定接住:下面任何一条提前返回的路上,做不出来的内容都不会变成没人处理的拒绝。
		const contents = anchors.map((anchor) =>
			Promise.resolve(anchor.messages).then(
				(payloads) => ({ payloads: payloads ?? [] }),
				(error: unknown) => ({ error }),
			),
		);
		// AI 版同样先接住。它是锦上添花:做不出来或为空就当没有,所有目标用模板,不影响锚点本身。
		const aiContents = anchors.map((anchor) =>
			anchor.aiMessages === undefined
				? Promise.resolve(undefined)
				: Promise.resolve(anchor.aiMessages).then(
						(payloads) => (payloads && payloads.length > 0 ? payloads : undefined),
						(error: unknown) => {
							this.logger.warn(
								`[push] ${this.labelOf(subscriptionId)} feature=${feature} AI 版正文没做出来，改用模板：${rejectionReason(error)}`,
							);
							return undefined;
						},
					),
		);
		if (anchors.some((anchor, i) => anchor.role === "main" && i > 0)) {
			throw new Error(packageText("push.router.anchorOrder"));
		}
		if (this.disposed) return [];
		const judged = this.judgePush(subscriptionId, feature);
		if (judged === "dropped") return [];
		const isSilenced = judged === "silenced";

		const myGen = this.generation;
		const pushId = randomUUID();
		const sendAt = async (i: number): Promise<DeliveryResult[]> => {
			const anchor = anchors[i] as PushAnchor;
			const content = await (contents[i] as (typeof contents)[number]);
			if (this.disposed || this.generation !== myGen) return [];
			if ("error" in content) {
				this.logger.warn(
					`[push] ${this.labelOf(subscriptionId)} feature=${feature} 有一个锚点的内容没做出来，跳过：${rejectionReason(content.error)}`,
				);
				return [];
			}
			if (content.payloads.length === 0) return [];
			const isMain = anchor.role === "main";
			const aiPayloads = await (aiContents[i] as (typeof aiContents)[number]);
			return this.sendAnchor(
				{ subscriptionId, feature, pushId, role: anchor.role },
				content.payloads,
				isMain
					? { allowAtAll: push.allowAtAll !== false, isSilenced, aiPayloads }
					: { extra: anchor.extra, allowAtAll: false, isSilenced, aiPayloads },
			);
		};

		const hasMain = anchors[0]?.role === "main";
		const mainResults = hasMain ? await sendAt(0) : [];
		const firstExtra = hasMain ? 1 : 0;
		if (firstExtra < anchors.length) {
			// 附加项在后台按先后发:这条订阅的下一次推送不等它们,关停等。
			this.serviceCtx.track(
				(async () => {
					for (let i = firstExtra; i < anchors.length; i++) {
						if (this.disposed || this.generation !== myGen) return;
						await sendAt(i);
					}
				})().catch((e: unknown) => {
					this.logger.error(`[push] 附加项发送出错: ${e instanceof Error ? e.message : e}`);
				}),
			);
		}
		return mainResults;
	}

	/**
	 * {@link push} 的裁决,只在交进来时问一次。先问「该不该有这次推送」(订阅在不在、总开关),
	 * 不该有就丢掉、什么都不留;该有,再问时间上的挡(全局静音、免扰时段)—— 被挡的照样往下算目标,
	 * 只是不发。
	 */
	private judgePush(
		subscriptionId: string,
		feature: FeatureKey,
	): "allowed" | "silenced" | "dropped" {
		const sub = this.store.findById(subscriptionId);
		if (!sub) {
			this.logger.debug(`[push] sub=${subscriptionId} 无订阅记录，跳过 feature=${feature}`);
			return "dropped";
		}
		const who = subscriptionLabel(sub);
		// 「features 总开关」与「quietHours 免扰时段」:把 sub 折叠成 EffectiveSubscription 后
		// 按此刻的 globals 判定。
		const eff = resolve(sub, this.defaults());
		if (!eff.features[feature]) {
			this.logger.debug(`[push] ${who} feature=${feature} 总开关 OFF，跳过`);
			return "dropped";
		}
		if (this.muted()) {
			this.logger.debug(`[push] ${who} feature=${feature} 处于全局静音，只记不发`);
			return "silenced";
		}
		if (inQuietHours(eff.schedule.quietHours, this.quietHoursNow(), this.timezone())) {
			this.logger.debug(`[push] ${who} feature=${feature} 落在免扰时段，只记不发`);
			return "silenced";
		}
		return "allowed";
	}

	/**
	 * 一次推送的一个锚点:现查订阅的路由与附加项表,逐目标判完再发。订阅、总开关、静音、
	 * 免扰不在这里判 —— 那是交进来时定下的。整次被静音 / 免扰挡下的(`round.isSilenced`)走到
	 * 「目标算完」为止:不发、不插 @全体,对每个该收的目标回调一次,消息带 `isSilenced`。
	 *
	 * 路由里**启用的**(目标启用、所属连接启用)才是候选,停用的既不发也不进可达性重试;一个候选
	 * 都没有就是「无目标」,回调 `onSend` 落一行。交进来之后订阅被删了就没有路由可查,这个锚点静默丢掉。
	 *
	 * @全体 是推送层自己插在本体前面的锚点(仅本体、`feature === "post" | "liveStart"` 且没被显式
	 * 关掉时有),它是唯一「只保证先后、不等结果」的,见 {@link sendAtAllThenCard}。该 @ 哪些目标:
	 * - 全局 + per-UP 合并后的 `eff.features.extras.atAll<Scope>` 决定 inherit-state 的 target 是否 @
	 * - per-target tristate Map `sub.extraTargets.atAll<Scope>[targetId]` 显式覆写:`true` 强 ON、`false` 强 OFF
	 * - Map 里没有该 key → 走上面那个默认
	 * - 目标不能 @全体(问派发器的 `supportsAtAll`,今天只有 QQ 官方机器人那条连接上的)→ 一律不 @,
	 *   默认与覆写都不看 —— 单发的那条只含 at-all 段,到适配器就成了空消息
	 *
	 * `feature === "liveStart"` 的 @全体 只该跟着真开播。重启补报也走 `liveStart` 这把键(目标与
	 * 总开关共用),光看 feature 区分不出:调用方对非开播的那几种必须传 `allowAtAll: false`
	 * 显式抑制,否则每条都会 @全体(修过的 bug)。
	 */
	private async sendAnchor(
		ctx: SendMeta,
		payloads: NotificationPayload[],
		round: AnchorRound,
	): Promise<DeliveryResult[]> {
		const { subscriptionId, feature } = ctx;

		const sub = this.store.findById(subscriptionId);
		if (!sub) {
			this.logger.debug(`[push] sub=${subscriptionId} 推送途中订阅没了，跳过 feature=${feature}`);
			return [];
		}
		const who = subscriptionLabel(sub);
		const eff = resolve(sub, this.defaults());

		// 这个锚点有 AI 版时,每个目标收哪一份由 `ai.writing` 决定(现取);没有 AI 版、或这类锚点不归它管,
		// 恒为 `payloads`。挑的是「用哪份字」,谁收仍由下面的路由与三态表定。
		const { aiPayloads } = round;
		const writingEntry = aiPayloads
			? aiWritingEntryOf(this.aiWriting(), ctx.role, feature, round.extra)
			: undefined;
		const payloadsFor = (targetId: string): NotificationPayload[] =>
			aiPayloads && writingEntry && aiWritingFor(writingEntry, targetId) ? aiPayloads : payloads;

		// 只有启用的目标才是候选:停用的目标 / 停用的连接不进重试、不落历史。
		const routed = (sub.routing[feature] ?? []).filter((id) => this.dispatcher.isEnabled(id));
		if (routed.length === 0) {
			this.logger.debug(`[push] ${who} feature=${feature} 无可用目标`);
			this.onSend?.({
				...ctx,
				target: null,
				// 没有目标可问,记「默认那一份」:默认行开着就是 AI 版(例外只属于具体的目标)。
				messages: (aiPayloads && writingEntry?.isOnByDefault ? aiPayloads : payloads).map((p) => ({
					payload: p,
					role: ctx.role,
				})),
			});
			return [];
		}

		// 附加项再按自己那张三态表筛一道(ADR-0016 决策 5):目标显式写了就听它的,没写就
		// 跟随折叠后(全局 + per-UP)的默认 —— 与下面 @全体 那条分支同一句判定,四把键一视同仁。
		// routing 查找全仓仍然只有上面那一处,这里只是在它的结果上再筛。
		const extraKey = round.extra;
		const targetIds = extraKey
			? routed.filter((id) => sub.extraTargets[extraKey][id] ?? eff.features.extras[extraKey])
			: routed;
		if (targetIds.length === 0) {
			// 收窄成空**不是「无目标」**(决策 7):本体那一行已经在了、而且是「已送达」,
			// 这个附加项只是谁都没订 —— 是配置意图不是故障,不落行、不弹卡、不记失败。
			this.logger.debug(`[push] ${who} feature=${feature} 附加项 ${extraKey} 无人订阅，跳过`);
			return [];
		}

		if (round.isSilenced) {
			// 先算目标、再记被挡:无可用目标与收窄成空在上面已经各走各的了,走到这里的都是
			// 「没有静音的话这个目标本来会收到」的。
			this.logger.debug(`[push] ${who} feature=${feature} 被挡下,记 ${targetIds.length} 个目标`);
			for (const id of targetIds) {
				this.emit(
					ctx,
					id,
					payloadsFor(id).map((payload) => ({ payload, role: ctx.role, isSilenced: true })),
				);
			}
			return [];
		}

		const atAllKey: ExtraKey | null = !round.allowAtAll
			? null
			: feature === "post"
				? "atAllPost"
				: feature === "liveStart"
					? "atAllLiveStart"
					: null;

		this.logger.info(`[push] ${who} feature=${feature} → ${targetIds.length} 个目标`);
		if (!atAllKey) {
			return this.sendBatch(targetIds, payloadsFor, ctx);
		}

		// 默认取**折叠后**那一份(全局 + per-UP 覆盖已合并);per-target 三态表挂在订阅上。
		const defaultOn = eff.features.extras[atAllKey];
		const overrides = sub.extraTargets[atAllKey];
		const atAllTargets: string[] = [];
		const plainTargets: string[] = [];
		for (const id of targetIds) {
			// 平台不支持 @全体的目标不进 @全体 分支:抽屉里它的开关本就显示为关。
			const supported = this.dispatcher.supportsAtAll(id);
			const explicit = overrides[id];
			const shouldAtAll = supported && (explicit ?? defaultOn);
			(shouldAtAll ? atAllTargets : plainTargets).push(id);
		}
		if (atAllTargets.length === 0) {
			return this.sendBatch(plainTargets, payloadsFor, ctx);
		}

		// 「@全体单独一条 → 原 payload」两条独立消息:@ 提醒在前、卡片正文在后。
		// 关键区别:@全体 走 best-effort「即发不 await」(见 sendAtAllThenCard)——
		// 无管理权限的群发 @全体 会被协议端拒绝并触发 adapter 重试,旧版顺序 await
		// 它会把卡片正文连同后续订阅任务一起阻塞(@全体先出、图片隔很久才出、历史
		// 标失败)。现在卡片不再被 @全体 的重试拖住,@全体 失败也只异步落历史。
		const results: DeliveryResult[] = [];
		if (plainTargets.length > 0) {
			results.push(...(await this.sendBatch(plainTargets, payloadsFor, ctx)));
		}
		results.push(...(await this.sendAtAllThenCard(atAllTargets, payloadsFor, ctx)));
		return results;
	}

	/**
	 * atAllTargets 的发送序列:每个目标先「即发」一条独立 @全体(**不 await**,
	 * best-effort),紧接着 await 卡片正文。@全体 落地后以附加项身份再回调一次 onSend ——
	 * 排在本体那次回调之后,历史那一行先由本体建起来,小卡上的首条文案不会是「@全体」。
	 *
	 * 为什么不 await @全体:无管理权限的群发 @全体 会被 onebot/协议端拒绝并触发
	 * adapter 的 retryTimes×retryIntervalMs 重试,顺序 await 会让卡片正文等满整个
	 * 重试周期才发出,并连带阻塞 sendBatch 之后的后续订阅任务(用户报告的
	 * 「@全体先出、图片隔很久才出、推送历史标失败」)。fire-and-forget 后 @全体
	 * 第一时间发出、失败也只异步落历史,卡片正文与后续任务都不再被它拖住。
	 *
	 * 顺序保证:@全体 的 `sendToTarget` 在卡片之前**同步发起**(其内部 `dispatcher.send`
	 * 先于卡片被调用)。保证只到「发起」这一步:接收端谁先到还看传输,每条各走一个独立请求的
	 * (如 webhook)两条并发在路上,卡片可能先到。
	 */
	private async sendAtAllThenCard(
		atAllTargets: string[],
		payloadsFor: (targetId: string) => NotificationPayload[],
		ctx: SendMeta,
	): Promise<DeliveryResult[]> {
		if (this.disposed) return [];
		const myGen = this.generation;
		const routing = { subscriptionId: ctx.subscriptionId, feature: ctx.feature };
		const results: DeliveryResult[] = [];
		for (const id of atAllTargets) {
			if (this.disposed || this.generation !== myGen) break;
			// @全体 best-effort:同步发起(先于序列首条入 dispatcher),不 await。
			const atAllPayload = makeAtAllPayload();
			const atAllJob = this.sendToTarget(id, atAllPayload, { routing });
			const outcomes = await this.sendSequence(id, payloadsFor(id), ctx, myGen);
			if (outcomes === null) break;
			// 被中止的那几条没有结果可报(从没出过网),不进这个数组。
			results.push(...outcomes.flatMap((o) => (o.result ? [o.result] : [])));
			this.emit(ctx, id, outcomes);
			// 本体那次回调已经发出,@全体 的结果再追加 —— 就算它早就落地了也排在后面。
			// 登记进 track:追加的这次回调会把 @全体 那条落进历史,关停得等它交出去再让历史写道关门。
			// (代价:@全体 卡在适配器自己的重试里时,关停最多为它多等到预算耗尽。)
			this.serviceCtx.track(
				atAllJob
					.then((result) => this.emit(ctx, id, [{ payload: atAllPayload, role: "extra", result }]))
					.catch(() => {}),
			);
		}
		return results;
	}

	/**
	 * 把消息序列发给一批目标。失败逐目标捕获,不抛。给函数时每个目标现取它自己那一段(同一锚点的
	 * 模板版 / AI 版按目标挑,见 {@link PushAnchor.aiMessages});给定值则所有目标同一段。
	 *
	 * 每个目标收完整段序列后回调一次 onSend(见 {@link PushSendResult});生命周期翻转
	 * (stop→start)时放弃剩余目标,最后那条已 in-flight 的结果是生命周期 artifact,
	 * 不回调、不计入。
	 */
	async sendBatch(
		targetIds: string[],
		payload:
			| NotificationPayload
			| NotificationPayload[]
			| ((targetId: string) => NotificationPayload | NotificationPayload[]),
		ctx: SendMeta,
	): Promise<DeliveryResult[]> {
		if (this.disposed) return [];
		const myGen = this.generation;
		const results: DeliveryResult[] = [];
		for (const id of targetIds) {
			if (this.disposed || this.generation !== myGen) break;
			const picked = typeof payload === "function" ? payload(id) : payload;
			const payloads = Array.isArray(picked) ? picked : [picked];
			if (payloads.length === 0) continue;
			const outcomes = await this.sendSequence(id, payloads, ctx, myGen);
			if (outcomes === null) break;
			// 被中止的那几条没有结果可报(从没出过网),不进这个数组。
			results.push(...outcomes.flatMap((o) => (o.result ? [o.result] : [])));
			this.emit(ctx, id, outcomes);
		}
		return results;
	}

	/**
	 * 一个目标的一段序列:顺序发,某条失败即中止其后续条(失败后大概率继续失败,且乱序
	 * 补发比缺失更糟)。失败那条留在结果里;**被中止的也留在结果里,但不带 `result`**
	 * —— 它们一次都没进 dispatcher,只是让历史记得住「本来还有几条」(ADR-0017 决策 17)。
	 * 返回 null = 生命周期翻转,这一段作废。
	 */
	private async sendSequence(
		targetId: string,
		payloads: NotificationPayload[],
		ctx: SendMeta,
		myGen: number,
	): Promise<PushMessageResult[] | null> {
		const routing = { subscriptionId: ctx.subscriptionId, feature: ctx.feature };
		const outcomes: PushMessageResult[] = [];
		for (const [i, payload] of payloads.entries()) {
			const result = await this.sendToTarget(targetId, payload, { routing });
			if (this.disposed || this.generation !== myGen) return null;
			outcomes.push({ payload, role: ctx.role, result });
			if (!result.ok) {
				// 中止。剩下的原样记上,没有结果 —— 人工重推要按这个数把它们补齐。
				for (const rest of payloads.slice(i + 1)) {
					outcomes.push({ payload: rest, role: ctx.role });
				}
				break;
			}
		}
		return outcomes;
	}

	/** 把一个目标这一段的结果交给 onSend。target 由 dispatcher 反解 id 得到,反解不到就静默跳过。 */
	private emit(ctx: SendMeta, targetId: string, messages: PushMessageResult[]): void {
		if (!this.onSend) return;
		const target = this.dispatcher.resolve(targetId);
		if (!target) return;
		this.onSend({
			pushId: ctx.pushId,
			subscriptionId: ctx.subscriptionId,
			feature: ctx.feature,
			target,
			messages,
		});
	}

	/**
	 * Send a notification to a single target.
	 * Retries with exponential back-off if the dispatcher indicates the target is temporarily unavailable.
	 *
	 * `opts.routing` re-checks (每次重试前,不只入口一次)`targetId` 是否仍在
	 * `store.findById(subscriptionId).routing[feature]` 里。退避重试窗口最长可达约 190s
	 * (3s→6s→…→96s),这期间用户完全可能编辑订阅、把这个 target 从路由里移除 ——
	 * 若不复检,一次因目标暂时不可达(如 OneBot WS 正在重连)而进入重试的推送,
	 * 会在用户"取消"之后、目标恢复可达时才真正发出,造成"取消了还在推"的错觉
	 * (routing 早已改了,只是这条重试还攥着入口时那份旧 targetId 没放手)。
	 * `notifyMaster` 等非订阅路由的调用不传 `routing`,不受影响。
	 *
	 * 复检认的是**这条推送自己那条订阅**(按订阅 id,ADR-0019 决策 50):同一个 UP 配了
	 * 两条订阅时,另一条还路由着这个目标不算数。
	 */
	async sendToTarget(
		targetId: string,
		payload: NotificationPayload,
		opts?: { routing?: { subscriptionId: string; feature: FeatureKey } },
	): Promise<DeliveryResult> {
		if (this.disposed) return fail("unavailable", "disposed");

		const myGen = this.generation;
		const routing = opts?.routing;
		let delay = INITIAL_RETRY_DELAY_MS;
		while (!this.disposed && this.generation === myGen) {
			if (routing && !this.isStillRouted(routing.subscriptionId, routing.feature, targetId)) {
				const who = this.labelOf(routing.subscriptionId);
				const msg = packageText("push.router.routeRemoved", {
					targetId,
					subscription: who,
					feature: routing.feature,
				});
				this.logger.info(`[push] ${msg}`);
				return fail("conflict", msg);
			}
			if (!this.dispatcher.isAvailable(targetId)) {
				if (delay > MAX_RETRY_DELAY_MS) {
					const msg = packageText("push.router.unreachable", { targetId });
					this.logger.error(`[push] ${msg}`);
					return fail("unavailable", msg);
				}
				this.logger.debug(`[push] target=${targetId} 暂不可达，${delay / 1000}s 后重试`);
				await this.sleep(delay);
				delay *= 2;
				continue;
			}

			try {
				return await this.dispatcher.send(targetId, payload);
			} catch (e) {
				// 抛错只留给 bug(ADR-0026 决策 1):派发器自己不该抛。这是发送,抛之前可能已经发出去了,
				// 按「结果不明」记(回「暂时不可用」会让上面的人再发一遍)。
				const message = e instanceof Error ? e.message : String(e);
				this.logger.error(`[push] target=${targetId} 发送失败: ${message}`);
				return fail("indeterminate", message);
			}
		}
		// ②7:while 退出有两因 —— disposed,或 generation 失配(stop→start)。
		// 此前一律标 "disposed",generation 失配时误导诊断。区分之。
		return fail("unavailable", this.disposed ? "disposed" : "superseded");
	}

	/** `targetId` 当前是否仍在这条订阅该 feature 的 routing 里。查不到订阅视为不再路由。 */
	private isStillRouted(subscriptionId: string, feature: FeatureKey, targetId: string): boolean {
		const sub = this.store.findById(subscriptionId);
		return (sub?.routing[feature] ?? []).includes(targetId);
	}

	/** 日志用:订阅还在就出可读标签,不在了只剩 `sub=<id>`。 */
	private labelOf(subscriptionId: string): string {
		const sub = this.store.findById(subscriptionId);
		return sub ? subscriptionLabel(sub) : `sub=${subscriptionId}`;
	}

	/**
	 * 告诉主人一声。字符串当纯文字消息。只发、不记 error 日志 —— 要记的由调用方自己打。
	 *
	 * 结果码:已销毁 `unavailable`;没配主人 `not_configured`;主人目标不是私聊 `invalid`
	 * (保存时本来就拦了,这里是兜底:盘上读进来的旧值不拒开机);目标不可达 `unavailable`;
	 * 其余照 {@link PushRouter.sendToTarget}。不受静音管(服务端主动告诉主人的话:审批预览、出错告警)。
	 */
	async notifyMaster(payload: string | NotificationPayload): Promise<DeliveryResult> {
		if (this.disposed) return fail("unavailable", "disposed");
		if (!this.master) return fail("not_configured", packageText("push.router.masterMissing"));
		if (!isPrivateTarget(this.master)) {
			return fail(
				"invalid",
				packageText("push.router.masterNotPrivate", { targetId: this.master.id }),
			);
		}
		if (!this.refreshMasterReachability()) {
			this.logger.debug("[push] master 目标不可达，跳过本次私信通知");
			return fail("unavailable", packageText("push.router.masterUnreachable"));
		}
		const message: NotificationPayload =
			typeof payload === "string" ? { kind: "text", text: payload } : payload;
		return this.sendToTarget(this.master.id, message);
	}

	private sleep(ms: number): Promise<void> {
		if (this.disposed) return Promise.resolve();
		return new Promise<void>((resolveSleep) => {
			let release: Disposable | undefined;
			const wake = (): void => {
				release?.dispose();
				release = undefined;
				this.sleepWakers.delete(wake);
				resolveSleep();
			};
			this.sleepWakers.add(wake);
			release = this.serviceCtx.setTimeout(wake, ms);
		});
	}
}
