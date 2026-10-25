/**
 * `@bilibili-notify/extension` —— **宿主给拓展的那一面**。
 *
 * 拓展住在仓里的 `extensions/<id>/`(ADR-0012 决策 4),写的是 TypeScript,所以它需要
 * 「ctx 上有哪几格」「一个平台适配器要交哪几样」这些类型。它们的本体住核心的
 * `@bilibili-notify/internal`;拓展经这一道门拿,核心不 import 门。
 *
 * 🔴 **拓展只从这一个包拿 BN 的东西。** ctx、挂载点、upgrade 的本体住
 * `@bilibili-notify/internal/extension`,面板要画的 wire 形状住
 * `@bilibili-notify/internal/extension/wire`;平台适配器契约与 adapter 签名要用的域类型住
 * `@bilibili-notify/internal`(那是**核心也在实现**的业务词汇),由这里**转出一道** ——
 * 拓展不直接依赖 internal。
 *
 * 为什么转一道而不是让拓展自己去拿:`internal` 导出的是**整个域模型**(globals、
 * subscriptions、patch……),拓展依赖了它就能伸手拿全部,那面太宽。**这里列出来的这些就是
 * 契约的全部** —— 加一格是一次明确的加宽决定(决策 13:契约的宽度不可逆),而不是
 * 「反正 internal 里有」。
 *
 * ⚠️ **只放类型,不放实现。** 拓展会被打成自包含的 `index.mjs`,从这里 import 一个运行时
 * 值等于把一份宿主代码的拷贝塞进拓展包里。真有非放不可的值,先想清楚再破例。
 * 破的两例:造结果的 `ok()` / `fail()`(ADR-0026 决策 6)与造中性平台描述的
 * `neutralPlatformDescriptor()`(ADR-0024 决策 4)—— 都是不带状态的纯函数,
 * 拷一份进拓展包不会与宿主那份打架。
 *
 * ⛔ 一格都别多给:`ExtensionRuntime`(谁来收摊)、`ExtensionMounts` / `ExtensionUpgrades`
 * (两张宿主的分发表)、`InboundHandlers`(绕过归属校验的那条管子)刻意都不在这儿 ——
 * **契约的宽度是不可逆的**(决策 13),窄面加宽容易,反过来不行。
 */

/**
 * 实现推送源用得着的域类型 —— `send` / `probe` / `reconcile` 的签名就是拿它们拼的。
 *
 * devtools 场景的中立词汇(`DevtoolsProvider` / `DevScenarioDef` 那一族,核心、B 站与拓展共用)
 * 也从这里转:开发入口交的东西就拿它们拼,见 {@link ExtensionDevtoolsContext};面板另经
 * `@bilibili-notify/contract` 拿同一份。
 *
 * ⛔ 域模型的其余部分(globals / subscriptions / 订阅与推送的落盘形状……)**刻意不转** ——
 * 拓展碰不着配置的写路径,那条路在这仓里只有一条。
 */
export type {
	CapabilitySupport,
	Connection,
	ConnectionCandidate,
	ConnectionCapabilities,
	CreatorCandidate,
	CreatorProfileReport,
	DeliveryResult,
	DestinationRef,
	DevInjection,
	DevParamField,
	DevParamValues,
	DevScenarioDef,
	DevScenarioDescriptor,
	DevScenarioGroup,
	DevtoolsProvider,
	Disposable,
	Failure,
	FailureCode,
	FeatureKey,
	/** `ctx.http` 的请求选项(对外那份,不含宿主自用的拦内网口)。 */
	FetchOptions,
	/** 重定向时即将发出的一跳,`beforeHop` 的参数。 */
	Hop,
	HopHandler,
	/** 每个集成一个的请求客户端(`ctx.http`)。 */
	HttpClient,
	HttpResponse,
	Identity,
	ImageRef,
	InboundGroupMessage,
	InboundMeta,
	InboundPrivateMessage,
	/**
	 * 每个集成(内置的、拓展的)拿到的公共那一面。`ExtensionContext` 继承它:新成员加在它身上,
	 * 拓展当场就有,类型逼着宿主那头一并接上。
	 */
	IntegrationContext,
	Json,
	KeyValueOp,
	KeyValueStore,
	Logger,
	NotificationPayload,
	PayloadSegment,
	/**
	 * 平台适配器契约 —— 一个出口长什么样。核心的 onebot / 官机 / webhook 与每个推送拓展实现的
	 * 都是这一套,所以它的本体住 `@bilibili-notify/internal`;这里转出来给拓展用。
	 */
	PlatformAdapter,
	PlatformAdapterContext,
	PlatformDescriptor,
	ProbeResult,
	PushTarget,
	PushTargetScope,
	Result,
	/**
	 * 一个集成读自己设置的把手。拓展的 `ctx.settings(schema)` 回的就是它(与内置集成同一个口)。
	 */
	SettingsReader,
	SourceHealth,
	SourceSubscriptionView,
	WebSocketLike,
	WebSocketOptions,
} from "@bilibili-notify/internal";
/** ctx、挂载点、upgrade 与来源契约的本体;门只逐个转给拓展。 */
export type {
	ExtensionContext,
	ExtensionDevtoolsContext,
	ExtensionFetchHandler,
	ExtensionI18n,
	ExtensionLiveDetails,
	ExtensionLiveSignalReport,
	ExtensionLiveStatusResult,
	ExtensionPostReport,
	ExtensionRichText,
	ExtensionRichTextSegment,
	ExtensionSourceContext,
	ExtensionUpgrade,
	ExtensionUpgradeHandler,
	PlatformAdapterDef,
	PlatformAdapterHandle,
	SourceDef,
	SourceHandle,
	SubscriptionCreator,
} from "@bilibili-notify/internal/extension";
/**
 * 面板也要认的那几个形状的本体住 `@bilibili-notify/internal/extension/wire`,这里**转出来**
 * —— 拓展照旧只认这一扇门。
 */
export type {
	ExtensionBlock,
	ExtensionButton,
	ExtensionField,
	ExtensionItemView,
	ExtensionListField,
	ExtensionScalarField,
	ExtensionSubscriptionView,
	ExtensionTableCell,
	ExtensionTableColumn,
	ExtensionTone,
	ExtensionView,
	ExtensionViewSummary,
	ExtensionViewText,
	ExtensionViewTextSegment,
	PlatformAdapterDescriptor,
} from "@bilibili-notify/internal/extension/wire";
/** `ctx.i18n.t` 的占位符取值;`count` 同时决定挑哪个单复数类别。只转类型。 */
export type { TextValues } from "@bilibili-notify/internal/i18n";
/**
 * 造「认不出的平台」用的中性平台描述(3b-40,ADR-0024 决策 4):连接候选里的 `platform` 拓展自己造,
 * 不必抄一份取值。第二处运行时值,理由同 `ok` / `fail`。
 */
export { neutralPlatformDescriptor } from "@bilibili-notify/internal/platform-descriptor";
/**
 * 造结果的两个函数(ADR-0026 决策 6)。`send` / `probe` 回的 `DeliveryResult` / `ProbeResult`
 * 就是 `Result`,一律拿它们造,不手写 `{ ok: false, … }`。
 */
export { fail, ok } from "@bilibili-notify/internal/result";
