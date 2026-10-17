import type { AuthState } from "./auth-state";
import type { FeatureKey, ImageRef, Result } from "./constants";
import type { LinkResolver } from "./link-preview";
import type { MembershipProgram } from "./membership";
import type { Disposable, IntegrationContext } from "./platform";
import type { PostReport } from "./post";

/** 来源的自我介绍。这一片只有有读者的三格;其余(叫法、supportedFeatures……)随第 4 期面板改造。 */
export interface SourceDescriptor {
	/** 平台名(「B 站」)。`status` 指令的那一行、以后的徽章与平台列都取它。 */
	label: string;
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
}

export interface SourceContext extends IntegrationContext {
	/** 名单,现读:只列启用中的;同一个人遗留的重复订阅合成一条、features 取并集。别缓存。 */
	subscriptions(): readonly SourceSubscriptionView[];
	/** 名单可能变了就叫一声(不保证真变了);要做事自己对比新旧名单。来源停下时自动摘掉。 */
	onSubscriptionsChanged(fn: () => void): Disposable;
	/** 交一条作品。没有返回值;判新、去重、限流归来源。 */
	reportPost(externalId: string, report: PostReport): void;
	/**
	 * 报一个问题(登录失效了、某个人不再监听了……)。不带 `externalId` 是来源自己的问题;带了由宿主换成
	 * 这个人名下的每一条订阅。`code` 是 snake 风格,同一个对象下同一个 code 只有一条,再报只换文案。
	 * `notify: true` 请核心私聊主人一次。没有返回值;形状不对(含空白的 `message` / `recoveryMessage`)、
	 * 来源已停下的上报被丢弃。
	 *
	 * `recoveryMessage`:这件事清掉、且当初真私聊过时核心发的那一句(发的是私聊出去那一刻的那句);
	 * 不给就用核心的通用说法(接当初私聊的原文)。
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
 * `searchCreators` 交的一个候选(最多 10 个)。`externalId` 就是选中后新建订阅用的外部 id;
 * 头像此刻不带(候选头像抓进图库的事等第一个要显示它的读者,第 4 期面板)。
 *
 * 字段照 `docs/1.0/data-model.md`:将来资料上报也要这几格,到时它们收成 `CreatorProfileReport`、
 * 本类型 `extends` 它;现在没有第二个读者,先不造那个类型。
 */
export interface CreatorCandidate {
	externalId: string;
	name: string;
	avatar?: ImageRef;
	bio?: string;
	followers?: number;
	/** 粉丝团名;平台没有就缺键。 */
	fanClubName?: string;
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
	/** 此刻的健康状况,同步、不出网(与 `auth.state()` 同一种读口)。不交 = 这个来源在 `status` 里不占行。 */
	health?(): SourceHealth;
	start(ctx: SourceContext): Promise<void>;
	/** 停下之后不许再上报。 */
	stop(): Promise<void>;
	/** 这个来源要登录才用得了的话交它。 */
	readonly auth?: SourceAuth;
}
