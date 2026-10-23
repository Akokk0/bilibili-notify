import type { AiToolProvider } from "./ai-tool";
import type { AuthState } from "./auth-state";
import type { FeatureKey, Identity, ImageRef, Result } from "./constants";
import type { LinkResolver } from "./link-preview";
import type { LiveInteractionReport, LiveSignalReport, LiveStatusResult } from "./live";
import type { MembershipProgram } from "./membership";
import type { Disposable, IntegrationContext } from "./platform";
import type { PostReport } from "./post";

/** 来源的自我介绍。这里只放已经有读者的格子;其余叫法随第 4 期面板改造。 */
export interface SourceDescriptor {
	/** 平台名(「B 站」)。`status` 指令的那一行、以后的徽章与平台列都取它。 */
	label: string;
	/** 这个平台管外部 id 叫什么(「UID」)。身份标签由 contract 的函数拼,描述符里只放词。 */
	externalIdNoun?: string;
	/** 这个平台管作品叫什么(进 `PostEvent.postNoun`)。 */
	postNoun?: string;
	/**
	 * 外部 id 长什么样:正则的源码字符串,宿主按整串匹配(自带 `^` 与 `$` 也照常能用)。核心用它核新建订阅的
	 * 外部 id,不在核心里写哪个平台的 id 是什么样。不写 = 只做中立校验(非空、限长)。
	 */
	externalIdRegex?: string;
	/** 会员体系:卡片预览按它找档、示例卡取最低一档。没有会员体系的来源不写。 */
	membershipPrograms?: MembershipProgram[];
}

/** 名单里的一条:只认人、不带订阅 id。 */
export interface SourceSubscriptionView {
	externalId: string;
	/** 这个人开着的特性(只看开关,不看有没有目标)。 */
	features: ReadonlySet<FeatureKey>;
	/** 宿主按 {@link needsLiveMonitor} 算好:这个人有没有哪条启用中的订阅要监听直播间。 */
	monitorsLive: boolean;
}

export interface SourceContext extends IntegrationContext {
	/** 名单,现读:只列启用中的;同一个人遗留的重复订阅合成一条、features 取并集。别缓存。 */
	subscriptions(): readonly SourceSubscriptionView[];
	/** 名单可能变了就叫一声(不保证真变了);要做事自己对比新旧名单。来源停下时自动摘掉。 */
	onSubscriptionsChanged(fn: () => void): Disposable;
	/** 交一条作品。没有返回值;判新、去重、限流归来源。 */
	reportPost(externalId: string, report: PostReport): void;
	/**
	 * 交一条直播信号(开播、直播状态、下播),发生了就报。没有返回值;宿主按身份展开成这个人名下每一条订阅的一份,
	 * 判场次、断流接续、出卡、推送都归核心。图一律先 `storeImage` 存进图库再带引用。时刻写 ISO;`startedAt` /
	 * `endedAt` 解析不出、下播没带 `endedAt`、来源已停下的上报被丢弃并记错误。
	 */
	reportLive(externalId: string, report: LiveSignalReport): void;
	/**
	 * 交一条观众互动(特别关注名单上的人发了弹幕、进了场……)。没有返回值;宿主按身份展开成这个人名下每一条订阅
	 * 的一份,名单、特性开关、文案都按那条订阅现折的设置判,来源只管如实报「谁说了什么、谁进场了」。观众的 `id`
	 * 是名单比对用的,要和名单里写的同一种 id。来源已停下的上报被丢弃并记错误。
	 */
	reportLiveInteraction(externalId: string, report: LiveInteractionReport): void;
	/**
	 * 报一个问题(某个人不再监听了……)。句子写平实、只说事:不称呼主人、不自称女仆、不写宿主的界面与操作;
	 * 私聊时宿主按口吻补完整。有登录口的来源不要报登录,宿主看登录状态报与清。
	 * 不带 `externalId` 是来源自己的问题;带了由宿主换成
	 * 这个人名下的每一条订阅。`code` 是 snake 风格,同一个对象下同一个 code 只有一条,再报只换文案。
	 * `notify: true` 请核心私聊主人一次。没有返回值;形状不对(含空白的 `message` / `recoveryMessage`)、
	 * 来源已停下的上报被丢弃。
	 *
	 * `recoveryMessage`:这件事清掉、且当初真私聊过时核心发的那一句(发的是私聊出去那一刻的那句);
	 * 不给就用宿主带来源名的通用说法(接当初私聊的原文)。
	 */
	reportProblem(problem: {
		externalId?: string;
		code: string;
		message: string;
		notify?: boolean;
		recoveryMessage?: string;
	}): void;
	/**
	 * 清掉一个问题(同 `reportProblem` 的对象规矩)。清掉时核心对私聊过的补一句「已恢复」;
	 * `notify: false` = 这次不是修好了、只是不再适用,不补。没有这一条什么都不做。
	 */
	resolveProblem(problem: { externalId?: string; code: string; notify?: boolean }): void;
	/**
	 * 登记这个来源的链接解析器(群里贴链接时核心问它认不认)。在自己的 `start(ctx)` 里登;键就是这个来源
	 * 的键,不用来源自己给。来源停下时宿主自动撤掉,不必在 `stop()` 里记得摘。来源已停下之后再登不生效
	 * (交回一个什么都不做的把手,与「来源已停下的上报被丢弃」同一个待遇)。同一个来源登第二个会抛
	 * (一个键一个主人);自己撤了之后可以重登。
	 */
	registerLinkResolver(resolver: LinkResolver): Disposable;
	/**
	 * 登记这个来源的 AI 工具提供方。在自己的 `start(ctx)` 里登;键就是这个来源的键,不用来源自己给。
	 * 工具名是提供方自己的本名,宿主统一加命名空间,模型看到的是 `<命名空间>__<本名>`(命名空间由
	 * 来源键换成工具名允许的字符而来,所以不会和核心工具或别家的撞);本名不合 `[A-Za-z0-9_-]`、
	 * 同一组里重名、全名超过 64 个字符、或命名空间与别家相撞时抛。来源停下时宿主自动撤掉,
	 * 不必在 `stop()` 里记得摘。来源已停下
	 * 之后再登不生效(交回一个什么都不做的把手)。同一个来源登第二个会抛(一个键一个主人);
	 * 自己撤了之后可以重登。
	 */
	registerAiToolProvider(provider: AiToolProvider): Disposable;
}

/** 来源登录着的账号:名字必有;头像抓进图库之后才有 `avatar`(图库引用,不是平台的图片地址)。 */
export interface SourceAccount {
	name: string;
	avatar?: ImageRef;
}

/**
 * 要登录才用得了的来源交的登录口(ADR-0021 决策 45)。只有扫码这一种登录办法;等第一个有两种登录办法的来源
 * 再加 `methods` 与 `beginLogin` 的参数。没有「刷新」:续期是来源自己的事。
 */
export interface SourceAuth {
	/** 发起一次扫码登录。成功后二维码在 `state()` 里;已有一次在进行时重新开始、换一张新码。 */
	beginLogin(): Promise<Result>;
	/** 忘掉登录。没登录时也能调。不碰主密钥。 */
	logout(): Promise<Result>;
	/** 此刻的状态,同步、不出网。 */
	state(): AuthState;
	/** 登录着的账号;没登录或还没取到是 `null`。头像抓进图库之后才有 `avatar`。 */
	account?(): SourceAccount | null;
	/** 状态或账号可能变了就叫一声;要做事自己再读 `state()` / `account()`。 */
	onChange(fn: () => void): Disposable;
}

/** 来源此刻的健康状况:给 `status` 指令(以后还有健康卡)的一行字。 */
export interface SourceHealth {
	summary: string;
}

/**
 * 来源交的一份创作者资料(`fetchProfile` 交的就是它,字段照 `docs/1.0/data-model.md`)。核心把它写进资料缓存;
 * 没给的格沿用缓存里原来的。搜人的候选在它上面加一个 `externalId`。
 */
export interface CreatorProfileReport {
	/** 创作者的名字。 */
	name: string;
	/** 图库引用;来源先把平台头像抓进图库,再交引用。 */
	avatar?: ImageRef;
	/** 简介或签名。 */
	bio?: string;
	/** 粉丝数。 */
	followers?: number;
	/** 粉丝团名;只有有粉丝团的平台才给。 */
	fanClubName?: string;
}

/**
 * `searchCreators` 交的一个候选(最多 10 个)。`externalId` 就是选中后新建订阅用的外部 id;
 * 头像此刻不带(候选头像抓进图库的事等第一个要显示它的读者,第 4 期面板)。
 */
export interface CreatorCandidate extends CreatorProfileReport {
	externalId: string;
}

/**
 * 互动的懒取口(ADR-0021 决策 56 / S1):来源交给核心一份,核心到**确定要出卡**那一刻才问 —— 门槛没过、
 * 出图关着都不该为此走一趟网络。观众头像与会员档位图标两个取法。
 */
export interface LiveInteractionReader {
	/**
	 * 取观众的头像(图库引用)。`viewerId` 是来源自己报上来的观众 id,`identity` 是这位主播在来源里的身份
	 * (与 `reportLiveInteraction` 的第一参同一个);`signal` 中止(宿主不等了)后来源应尽快收手。
	 * 取不到回结果形状、不抛;核心拿不到只是卡上没有观众头像。同一来源串行调用。
	 */
	fetchViewerAvatar(
		identity: Identity,
		viewerId: string,
		signal: AbortSignal,
	): Promise<Result<{ ref: ImageRef }>>;
	/**
	 * 取一档的徽章(图库引用)。`program` 是会员体系 id、`tierKey` 是档在这个体系里的 key。
	 * 取不到回结果形状、不抛;核心拿不到只是卡上没有徽章。同一来源串行调用。
	 */
	fetchTierIcon(
		identity: Identity,
		program: string,
		tierKey: string,
		signal: AbortSignal,
	): Promise<Result<{ ref: ImageRef }>>;
}

export interface Source {
	readonly descriptor: SourceDescriptor;
	/**
	 * 搜人(「解析门」):输入框里是链接、id 还是名字都原样交进来,来源自己认;最多回 10 个候选。
	 * 查无此人是成功的空数组;失败回结果形状、不抛:风控 `rate_limited`、没登录 `unauthorized`,
	 * 原话进 `message`。`signal` 中止(宿主不等了)后来源应尽快收手。同一来源串行调用。
	 */
	searchCreators(
		query: string,
		signal: AbortSignal,
	): Promise<Result<{ candidates: CreatorCandidate[] }>>;
	/**
	 * 取一个人的资料(必备)。核心按资料刷新 cron 定时调,按 id 取人(女仆查没订阅的人)也是它。头像先抓进图库
	 * 再交引用;失败回结果形状、不抛:平台上没有这个人了回 `not_found`(核心记成关于那条订阅的问题),其余失败
	 * 当一时的、下一轮照问;撞了风控整轮刹车是来源自己的事。`signal` 中止(宿主不等了)后来源应尽快收手。
	 * 核心对同一来源串行调用。
	 */
	fetchProfile(identity: Identity, signal: AbortSignal): Promise<Result<CreatorProfileReport>>;
	/**
	 * 此刻这个人在不在播(拉取式)。实现了它,核心就按每一场的开播时刻各自起算、定时问它:确认还在播、
	 * 发现已下播(当漏收的下播处理)、重启后认出已经在播的一场、断流等待到期时再核一次。失败回结果形状、
	 * 不抛:这一轮没取到核心只记日志、跳过,问题由来源自己经 `ctx.reportProblem` 报。`signal` 中止
	 * (宿主不等了)后来源应尽快收手。同一来源串行调用。不实现 = 只靠 `ctx.reportLive` 推送式上报。
	 */
	fetchLiveStatus?(identity: Identity, signal: AbortSignal): Promise<LiveStatusResult>;
	/**
	 * 互动的懒取口。给了,核心就能在确定要出卡时补取观众头像;不给 = 卡照出,只是没有观众头像。
	 */
	liveInteractions?: LiveInteractionReader;
	/** 此刻的健康状况,同步、不出网(与 `auth.state()` 同一种读口)。不交 = 这个来源在 `status` 里不占行。 */
	health?(): SourceHealth;
	start(ctx: SourceContext): Promise<void>;
	/** 停下之后不许再上报。 */
	stop(): Promise<void>;
	/** 这个来源要登录才用得了的话交它。 */
	readonly auth?: SourceAuth;
}
