import type { FeatureKey } from "./constants";
import type { Disposable, IntegrationContext } from "./platform";
import type { PostReport } from "./post";

/** 来源的自我介绍。这一片只有有读者的一格;其余(label、叫法、supportedFeatures……)随第 4 期面板改造。 */
export interface SourceDescriptor {
	/** 这个平台管作品叫什么(进 `PostEvent.postNoun`)。 */
	postNoun?: string;
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
}

export interface Source {
	readonly descriptor: SourceDescriptor;
	start(ctx: SourceContext): Promise<void>;
	/** 停下之后不许再上报。 */
	stop(): Promise<void>;
}
