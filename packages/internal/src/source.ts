import type { AuthState } from "./auth-state";
import type { FeatureKey, ImageRef, Result } from "./constants";
import type { MembershipProgram } from "./membership";
import type { Disposable, IntegrationContext } from "./platform";
import type { PostReport } from "./post";

/** 来源的自我介绍。这一片只有有读者的两格;其余(label、叫法、supportedFeatures……)随第 4 期面板改造。 */
export interface SourceDescriptor {
	/** 这个平台管作品叫什么(进 `PostEvent.postNoun`)。 */
	postNoun?: string;
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
	 * `notify: true` 请核心私聊主人一次。没有返回值;形状不对、来源已停下的上报被丢弃。
	 */
	reportProblem(problem: {
		externalId?: string;
		code: string;
		message: string;
		notify?: boolean;
	}): void;
	/**
	 * 清掉一个问题(同 `reportProblem` 的对象规矩)。清掉时核心对私聊过的补一句「已恢复」;
	 * `notify: false` = 这次不是修好了、只是不再适用,不补。没有这一条什么都不做。
	 */
	resolveProblem(problem: { externalId?: string; code: string; notify?: boolean }): void;
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

export interface Source {
	readonly descriptor: SourceDescriptor;
	start(ctx: SourceContext): Promise<void>;
	/** 停下之后不许再上报。 */
	stop(): Promise<void>;
	/** 这个来源要登录才用得了的话交它。 */
	readonly auth?: SourceAuth;
}
