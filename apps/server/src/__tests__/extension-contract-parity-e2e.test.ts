/**
 * 🔴 **守卫 21a 与推送守卫③:假拓展把契约的每个成员走一遍,走不通的在「不开」名单里写明理由。**
 *
 * 仓里的假源(`extensions/fake-source/`)一个包里开了两口:订阅源(`contributes.subscription`)与平台适配器
 * (`contributes.push`)。这条把它的**构建产物**装进真 BN(同 `fake-source-buttons-e2e`),**开机以后才拨开**
 * (「登记即 start,晚登记的也收得到」要的就是这个次序),然后经公开口逐成员驱动:
 *
 * - 21a:`Source` 的每个成员、清单订阅段的每一格、拓展来源上下文自己的成员、问题上报(拓展 / 来源 / 订阅三层,
 *   外加适配器那一层的连接);
 * - ③:`PlatformAdapter` 的每个成员、清单推送段的每一格、适配器上下文自己的成员。
 *
 * **这份文件自己是清单**:六张行表全是类型级棘轮(`satisfies Record<keyof …, Row>`)—— 接口上多一个成员,
 * 这里类型检查就过不去,必须来补一行;`Row` 不是「走通」(`driven`)就得写明理由与证据(`closed` / `hostFilled`),
 * 或指给另一份已经管着它的 e2e(`elsewhere`)。末尾的自检核:`driven` 的行真被驱动过、引用的文件与 `it` 标题真有、
 * 理由非空、开放的行与宿主那张成员表对得上。
 *
 * 零外连:推送内容读假适配器记在拓展页视图里的发送账(它收到什么只经这一页给人看),历史读 `/api/history`;
 * 出卡的浏览器是替身(灌进去的 HTML 留下来);AI 不开。联网守卫对每条用例自动查账,只许回环。
 *
 * 不 import `extensions/` 底下的源码(`extension-import-boundary` 钉着):记号 id、连接 id、动作名这些值在这里写死,
 * 旁边注明出自假源的哪个文件。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AdaptersResponse,
	ConnectionCapabilitiesMap,
	CreatorsResponse,
	ExtensionsResponse,
	HistoryEntryView,
	HistoryResponse,
	LiveListeningEntry,
	ProblemsResponse,
	SourcesResponse,
	SubscriptionDTO,
} from "@bilibili-notify/contract";
import type {
	ExtensionManifest,
	IntegrationContext,
	PlatformAdapter,
	PlatformAdapterContext,
	PostEvent,
	Source,
} from "@bilibili-notify/internal";
import type {
	ExtensionSourceContext,
	PlatformAdapterDef,
} from "@bilibili-notify/internal/extension";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { SOURCE_DEF_MEMBERS } from "../extensions/extension-source.js";
import { isValidImageRef } from "../images/image-store.js";
import { type ServerHandle, startServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { installRepoExtensionInto } from "./support/install-repo-extension.js";

/** 出卡浏览器替身灌进去的每一份 HTML(链接图标那一行要看出图器吃到了什么)。 */
const renderedHtml = vi.hoisted(() => [] as string[]);
/** 总线上看到的 `post-detected`(拓展作品经来源登记表进核心入口后,核心对每条订阅发的中立事件)。 */
const heard = vi.hoisted(() => [] as PostEvent[]);
/** 总线上看到的 `extension-status-changed`(拓展喊「面板数据变了」,按拓展合并过)。 */
const statusChanged = vi.hoisted(() => [] as string[]);

vi.mock("../runtime/puppeteer.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../runtime/puppeteer.js")>();
	const page = () => ({
		setContent: async (html: string) => {
			renderedHtml.push(html);
		},
		waitForFunction: async () => undefined,
		$: async () => ({
			boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 400 }),
			dispose: async () => {},
		}),
		screenshot: async () => Buffer.from("fake-card-jpeg"),
		close: async () => {},
		// 适配层给每一页开请求闸(只放行 data:);替身页不发请求,两样都是空操作。
		on: () => {},
		setRequestInterception: async () => {},
	});
	const browser = () => ({
		connected: true,
		newPage: async () => page(),
		close: async () => {},
		disconnect: () => {},
		process: () => null,
	});
	return {
		...real,
		createPuppeteerAdapter: (opts: Parameters<typeof real.createPuppeteerAdapter>[0]) =>
			real.createPuppeteerAdapter({
				...opts,
				launcher: { launch: async () => browser(), connect: async () => browser() },
			}),
	};
});

vi.mock("../runtime/message-bus.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../runtime/message-bus.js")>();
	return {
		...real,
		createNodeMessageBus: () => {
			const bus = real.createNodeMessageBus();
			bus.on("post-detected", (event) => {
				heard.push(event);
			});
			bus.on("extension-status-changed", (change) => {
				statusChanged.push(change.extensionId);
			});
			return bus;
		},
	};
});

// ---------------------------------------------------------------------------
// 这份文件认得的假源的值(出自 `extensions/fake-source/`,不 import,写死在这里)
// ---------------------------------------------------------------------------

const FAKE = "fake-source";
/** 仓库根(从本文件往上数四层)。读清单与被引用的测试文件用。 */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const THIS_FILE = "apps/server/src/__tests__/extension-contract-parity-e2e.test.ts";
/** 出自假源 `src/buttons.ts` 的 `FORGED_CONNECTION_ID`:写死的、不存在的连接 id。 */
const FORGED_CONNECTION_ID = "00000000-0000-4000-8000-00000000f0f0";
/** 出自假源 `src/index.ts` 的 `MISSING_PROFILE_EXTERNAL_ID`:合外部 id 格式、解析门永远不会现编出的那个。 */
const MISSING_EXTERNAL_ID = "fake-0000000000000000-z";
/** 主人的会话地址:既是主人私聊目标的地址,也填进甲连接的 `inboundFrom`(入站按钮以它发 `/status`)。 */
const OWNER = "fake-owner-1";
/** 解析门对这句话现编三个候选(`-a` / `-b` / `-c`)。 */
const LOOKUP_QUERY = "对拍探针";

const ID = {
	chatA: "f4600000-0000-4000-8000-000000000c0a",
	chatB: "f4600000-0000-4000-8000-000000000c0b",
	hook: "f4600000-0000-4000-8000-000000000c0c",
	groupA: "f4600000-0000-4000-8000-000000000a01",
	privateOwner: "f4600000-0000-4000-8000-000000000a02",
	channelA: "f4600000-0000-4000-8000-000000000a03",
	emptyGroupA: "f4600000-0000-4000-8000-000000000a04",
	groupB: "f4600000-0000-4000-8000-000000000b01",
	subA: "f4600000-0000-4000-8000-0000000005a1",
	subB: "f4600000-0000-4000-8000-0000000005a2",
	subB2: "f4600000-0000-4000-8000-0000000005a3",
	subExtra: "f4600000-0000-4000-8000-0000000005b1",
	subMissing: "f4600000-0000-4000-8000-0000000005b2",
} as const;

// ---------------------------------------------------------------------------
// 清单自己:行、状态、六张表
// ---------------------------------------------------------------------------

/** 一条证据:哪个文件里的哪个 `it` 标题(整串,逐字)。 */
interface Evidence {
	file: string;
	title: string;
}

/**
 * 一行的状态:
 * - `driven`:这份文件里有一条 `it` 驱动了它;
 * - `elsewhere`:所引用的公共边界测试已经按内容管着它;
 * - `closed`:这一版不开,写明理由与证据;
 * - `hostFilled`:不由拓展给,宿主填(只给 `adapterKey`),写明理由与证据。
 */
type Row =
	| { state: "driven"; it: string }
	| { state: "elsewhere"; file: string; it: string }
	| { state: "closed"; reason: string; evidence: readonly Evidence[] }
	| { state: "hostFilled"; reason: string; evidence: readonly Evidence[] };

const driven = (it: string): Row => ({ state: "driven", it });
const closed = (reason: string, ...evidence: Evidence[]): Row => ({
	state: "closed",
	reason,
	evidence,
});

/** 被引用的单测与另一份 e2e(逐字抄它们的 `it` 标题;自检会核文件在、标题在)。 */
const EXTENSION_SOURCE_TEST = "apps/server/src/extensions/__tests__/extension-source.test.ts";
const CONTEXT_GRANTS_TEST = "apps/server/src/extensions/__tests__/context-grants.test.ts";
const CONTEXT_I18N_TEST = "apps/server/src/extensions/__tests__/context-i18n.test.ts";
const MANIFEST_TEST = "packages/internal/src/schema/__tests__/extension-manifest.test.ts";
const ROAST_E2E = "apps/server/src/__tests__/extension-roast-e2e.test.ts";
const ROAST_TITLE =
	"榜单:两行都进提示词(平台列 = 假源清单里的「假源」),结果按订阅 id 回指,pushText 里的下标换回名字";

/** 本文件里每条 `it` 的标题。行表与用例共用这一份,标题写错在类型层就看得出。 */
const TITLE = {
	lifecycle: "登记即 `start`（晚登记的也收得到）",
	endpoint: "`endpoint` 目标由连接托管",
	fixture: "夹具:四个目标、主人、两条订阅",
	searchCreators: "searchCreators:解析门回三个候选,空 / 坏 / 乱三种失败各有各的样子",
	externalIdRegex: "清单 externalIdRegex:不合形状的外部 id 建不了订阅",
	subscriptionCells: "清单订阅段的外观格:面板读到的与清单逐格相等,没写的格也没有",
	pushCells: "清单推送段的每一格:面板读到的与清单逐格相等",
	settingsAndCandidates:
		"settingsSchema 与 listConnectionCandidates:设置过 zod,新建只认候选里的平台",
	adapterKey: "adapterKey 由宿主填:拓展自报的 onebot 不顶替内置",
	closedPorts: "不开的口:带了也不认,三个读口都回 unsupported",
	capabilities: "能力接口列得出拓展连接",
	probe: "probe 与 probeCapabilities:手动测试通了,补探只补这一条连接的「还不知道」",
	atAll: "`atAll` 为 false 时不 @全体",
	sendAndAvailable:
		"send 与 isAvailable:每个目标一条、去向与载荷对得上;地址为空的群不往里发,补上地址后接着发",
	nouns: "清单的叫法:作品叫「假帖」、没有资料名的作者落「假号 外部 id」",
	subscriptions: "ctx.subscriptions 与 onSubscriptionsChanged:订阅一动,人数当场变、面板被喊一声",
	reportPost: "reportPost:五种正文片段进总线,链接图标是图库里的图、出图器画在链接字前",
	parentAddress: "两层地址这一版只能手填",
	inbound: "`inbound`",
	health: "health:/status 里有假源那一行",
	forged: "内置与拓展的入站都经宿主校验",
	problems: "reportProblem 与 resolveProblem:四层问题进问题表、拓展级私聊一次、清掉补恢复句",
	reportLive: "reportLive:开播、直播状态、下播进在播表",
	fetchLiveStatus: "fetchLiveStatus:核心对要监听又没有场次的订阅问来源,在播就认出这一场",
	fetchProfile: "fetchProfile:没报过的人交拉取版,记号那位记成 creator_not_found",
	reportProfile: "reportProfile:报的资料进订阅,之后拉取交回的是同一版",
} as const;

const THIS = (title: string): Evidence => ({ file: THIS_FILE, title });

const SOURCE_ROWS = {
	descriptor: closed(
		"外观以清单为准、由宿主填:描述符取自 `contributes.subscription`,拓展自己交的不认(契约「订阅源」表里 `descriptor` 一行)。",
		THIS(TITLE.subscriptionCells),
		{
			file: EXTENSION_SOURCE_TEST,
			title:
				"描述符取自清单订阅那一口写了的格(平台名、短名、颜色、作品叫法、外部 id 格式、特性),不取拓展自己交的",
		},
	),
	searchCreators: driven(TITLE.searchCreators),
	fetchProfile: driven(TITLE.fetchProfile),
	fetchLiveStatus: driven(TITLE.fetchLiveStatus),
	liveInteractions: closed(
		"这一版不开直播互动类特性:1.0 的拓展声明不了会员与直播互动(ADR-0021 决策 38 下 09-28 的 🔗),契约「订阅源」表里 `liveInteractions` 一行写「不开」。核心没有读口能看见拓展塞进来的这一格,证据只有单测(假源在运行时故意塞了它)。",
		{
			file: EXTENSION_SOURCE_TEST,
			title:
				"不开的成员带了也不认:auth、liveInteractions、descriptor、fetchPreview;health 按表收下",
		},
		{
			file: EXTENSION_SOURCE_TEST,
			title: "拓展拿到的 ctx 里没有核心独有的三个口:链接解析、AI 工具、直播互动(运行时也拿不到)",
		},
	),
	health: driven(TITLE.health),
	fetchPreview: closed(
		"这一版不对拓展开(4-14 主人定:没有真使用者,第一个要真实预览的拓展再开;契约「订阅源」表里 `fetchLiveStatus、fetchPreview、health、auth` 一行的 🔗):SourceDef 里没有这一格、运行时带了也不认,拓展订阅的卡片预览一律用示例。",
		{
			file: EXTENSION_SOURCE_TEST,
			title:
				"不开的成员带了也不认:auth、liveInteractions、descriptor、fetchPreview;health 按表收下",
		},
	),
	start: driven(TITLE.lifecycle),
	stop: driven(TITLE.lifecycle),
	auth: closed(
		"这一版不对拓展开(主人 10-24 定,契约「订阅源」表里 `fetchLiveStatus、fetchPreview、health、auth` 一行的 🔗):类型里排除、运行时带了也不认,等第一个要登录的拓展。",
		THIS(TITLE.closedPorts),
		{
			file: EXTENSION_SOURCE_TEST,
			title:
				"不开的成员带了也不认:auth、liveInteractions、descriptor、fetchPreview;health 按表收下",
		},
	),
} satisfies Record<keyof Source, Row>;

type SubscriptionCell = keyof NonNullable<ExtensionManifest["contributes"]["subscription"]>;

const SUBSCRIPTION_CELL_ROWS = {
	label: driven(TITLE.subscriptionCells),
	shortLabel: driven(TITLE.subscriptionCells),
	color: driven(TITLE.subscriptionCells),
	icon: driven(TITLE.subscriptionCells),
	postNoun: driven(TITLE.nouns),
	creatorNoun: { state: "elsewhere", file: ROAST_E2E, it: ROAST_TITLE },
	externalIdNoun: driven(TITLE.nouns),
	searchAccepts: driven(TITLE.subscriptionCells),
	externalIdRegex: driven(TITLE.externalIdRegex),
	supportedFeatures: driven(TITLE.subscriptionCells),
	featureHints: {
		state: "elsewhere",
		file: "apps/server/src/routes/__tests__/sources-list-route.test.ts",
		it: "拓展清单写了的格原样下发(图标、搜人收的输入都在),自带皮肤的包内路径不下发",
	},
	cardSkin: closed(
		"宿主今天不读这一格:它是装包那头的事(自带卡片皮肤,ADR-0019 决策 13),面板视图里剥掉、服务端没有读者,等「自带皮肤」那一步。假源的清单也没写它。证据只有清单收下它的单测,没有单测钉「宿主不读」。",
		{ file: MANIFEST_TEST, title: "cardSkin %s —— 收下" },
	),
} satisfies Record<SubscriptionCell, Row>;

/** 拓展来源上下文自己的成员(去掉集成上下文那一半),外加问题上报(集成上下文那一份,三层各报一遍)。 */
type SourceContextMember =
	| Exclude<keyof ExtensionSourceContext, keyof IntegrationContext>
	| "reportProblem"
	| "resolveProblem";

const SOURCE_CONTEXT_ROWS = {
	subscriptions: driven(TITLE.subscriptions),
	onSubscriptionsChanged: driven(TITLE.subscriptions),
	reportPost: driven(TITLE.reportPost),
	reportLive: driven(TITLE.reportLive),
	reportProfile: driven(TITLE.reportProfile),
	reportProblem: driven(TITLE.problems),
	resolveProblem: driven(TITLE.problems),
} satisfies Record<SourceContextMember, Row>;

const ADAPTER_ROWS = {
	adapterKey: {
		state: "hostFilled",
		reason:
			"适配器键由宿主按拓展 id 填,拓展自报的那份被覆盖(`PlatformAdapterDef` 把它摘掉,契约「推送」表)。假源在运行时故意自报 `onebot`,证明没有顶替内置。",
		evidence: [
			THIS(TITLE.adapterKey),
			{ file: CONTEXT_GRANTS_TEST, title: "分发键由宿主按 id 填 —— 拓展自报的那份被覆盖掉" },
		],
	},
	descriptor: closed(
		"外观以清单为准、由宿主填:描述取自 `contributes.push`、每次读按当前语言盖好译文,拓展自己交的不认(契约「推送」表里 `descriptor` 一行;ADR-0024 决策 3 下 10-14 的 🔗)。",
		THIS(TITLE.pushCells),
		{
			file: CONTEXT_GRANTS_TEST,
			title: "代码里还交外观 / 字段表(按第 1 版的写法)—— 抛:两份声明会打架,以清单为准",
		},
		{
			file: CONTEXT_I18N_TEST,
			title: "登记的平台适配器,描述由宿主照清单推送那一口填,每次读按当前语言盖好译文",
		},
	),
	probe: driven(TITLE.probe),
	start: driven(TITLE.lifecycle),
	stop: driven(TITLE.lifecycle),
	isAvailable: driven(TITLE.sendAndAvailable),
	send: driven(TITLE.sendAndAvailable),
	capabilities: driven(TITLE.capabilities),
	probeCapabilities: driven(TITLE.probe),
	settingsSchema: driven(TITLE.settingsAndCandidates),
	listConnectionCandidates: driven(TITLE.settingsAndCandidates),
	listAddressCandidates: closed(
		"这一版不对拓展开放(ADR-0024 决策 11:alpha 之后改桥协议时再考虑;契约「推送」表 `listAddressCandidates` 一行 10-11):类型里排除、宿主登记拓展适配器时摘掉,带了也不认。",
		THIS(TITLE.closedPorts),
		{
			file: CONTEXT_GRANTS_TEST,
			title: "这一版不对拓展开放的成员(列地址候选、连接认证)带了也不认,别的成员照收",
		},
	),
	connectionAuth: closed(
		"这一版不对拓展开放(ADR-0024 决策 11;契约「推送」表 `connectionAuth` 一行 10-11):类型里排除、宿主登记拓展适配器时摘掉,带了也不认。",
		THIS(TITLE.closedPorts),
		{
			file: CONTEXT_GRANTS_TEST,
			title: "这一版不对拓展开放的成员(列地址候选、连接认证)带了也不认,别的成员照收",
		},
	),
} satisfies Record<keyof PlatformAdapter, Row>;

/** `PlatformAdapterDef` 从 `PlatformAdapter` 上摘掉的四个成员(类型里排除)。 */
const ADAPTER_DEF_OMITTED = [
	"adapterKey",
	"descriptor",
	"listAddressCandidates",
	"connectionAuth",
] as const satisfies readonly Exclude<keyof PlatformAdapter, keyof PlatformAdapterDef>[];
/** 反过来也要全:`PlatformAdapterDef` 再多摘一个成员,这一行就类型检查不过。 */
const ADAPTER_DEF_OMITTED_IS_COMPLETE: Exclude<
	keyof PlatformAdapter,
	keyof PlatformAdapterDef
> extends (typeof ADAPTER_DEF_OMITTED)[number]
	? true
	: never = true;

type PushCell = keyof NonNullable<ExtensionManifest["contributes"]["push"]>;

const PUSH_CELL_ROWS = {
	label: driven(TITLE.pushCells),
	shortLabel: driven(TITLE.pushCells),
	color: driven(TITLE.pushCells),
	icon: driven(TITLE.pushCells),
	settingsFields: driven(TITLE.pushCells),
} satisfies Record<PushCell, Row>;

const ADAPTER_CONTEXT_ROWS = {
	connections: driven(TITLE.lifecycle),
	onConnectionsChanged: driven(TITLE.lifecycle),
	inbound: driven(TITLE.inbound),
} satisfies Record<Exclude<keyof PlatformAdapterContext, keyof IntegrationContext>, Row>;

const INTEGRATION_CONTEXT_ROWS = {
	timezone: {
		state: "elsewhere",
		file: "apps/server/src/__tests__/integration-stores-wiring.test.ts",
		it: "timezone parity: activate/source/adapter read, notify, stop and restart",
	},
	onTimezoneChanged: {
		state: "elsewhere",
		file: "apps/server/src/__tests__/integration-stores-wiring.test.ts",
		it: "timezone parity: activate/source/adapter read, notify, stop and restart",
	},
	logger: {
		state: "elsewhere",
		file: "apps/server/src/integrations/__tests__/context.test.ts",
		it: "被拒的记成什么等级跟选项走:拓展传 warn 就是 warn,不是 error",
	},
	signal: {
		state: "elsewhere",
		file: "apps/server/src/integrations/__tests__/context.test.ts",
		it: "钩子跑的时候 signal 已经中止,原因是给的那句",
	},
	onDispose: {
		state: "elsewhere",
		file: "apps/server/src/integrations/__tests__/context.test.ts",
		it: "收尾钩子后登记的先跑",
	},
	state: {
		state: "elsewhere",
		file: "apps/server/src/__tests__/integration-stores-wiring.test.ts",
		it: "activate(ctx) 与适配器 start(ctx) 里写的,盘上真有,而且两处是同一对对象",
	},
	secrets: {
		state: "elsewhere",
		file: "apps/server/src/__tests__/integration-stores-wiring.test.ts",
		it: "activate(ctx) 与适配器 start(ctx) 里写的,盘上真有,而且两处是同一对对象",
	},
	redact: {
		state: "elsewhere",
		file: "apps/server/src/integrations/__tests__/context.test.ts",
		it: "登记之后,值被遮;没登记的不遮",
	},
	settings: {
		state: "elsewhere",
		file: "apps/server/src/integrations/__tests__/context.test.ts",
		it: "ctx.settings(规则) 就是交进来的实现:读得到它的值,它说变了才叫",
	},
	http: {
		state: "elsewhere",
		file: "apps/server/src/subscriptions/__tests__/source-context.test.ts",
		it: "ctx.http / fetchImage / storeImage 就是集成上下文上的那三个:来源抓图、请求走集成自己的客户端",
	},
	fetchImage: {
		state: "elsewhere",
		file: "apps/server/src/subscriptions/__tests__/source-context.test.ts",
		it: "ctx.http / fetchImage / storeImage 就是集成上下文上的那三个:来源抓图、请求走集成自己的客户端",
	},
	storeImage: {
		state: "elsewhere",
		file: "apps/server/src/subscriptions/__tests__/source-context.test.ts",
		it: "ctx.http / fetchImage / storeImage 就是集成上下文上的那三个:来源抓图、请求走集成自己的客户端",
	},
	reportProblem: {
		state: "elsewhere",
		file: "apps/server/src/integrations/__tests__/context.test.ts",
		it: "报一条:问题表里报的人是集成键、不带 about,notify 不进表",
	},
	resolveProblem: {
		state: "elsewhere",
		file: "apps/server/src/integrations/__tests__/context.test.ts",
		it: "resolveProblem 带 notify: false:清掉但不补已恢复",
	},
} satisfies Record<keyof IntegrationContext, Row>;

const TABLES = {
	IntegrationContext: INTEGRATION_CONTEXT_ROWS,
	Source: SOURCE_ROWS,
	SubscriptionCell: SUBSCRIPTION_CELL_ROWS,
	SourceContext: SOURCE_CONTEXT_ROWS,
	PlatformAdapter: ADAPTER_ROWS,
	PushCell: PUSH_CELL_ROWS,
	AdapterContext: ADAPTER_CONTEXT_ROWS,
};
type Tables = typeof TABLES;

/** 这份文件实际驱动过的行(`table.member`),末尾的自检拿它对行表。 */
const drivenInThisRun = new Set<string>();
function drove<T extends keyof Tables>(table: T, ...members: (keyof Tables[T] & string)[]): void {
	for (const member of members) drivenInThisRun.add(`${table}.${member}`);
}

/** 本文件注册过的 `it` 标题(自检核「driven 的行指向的标题真在」)。 */
const registeredTitles = new Set<string>();
function step(title: string, run: () => Promise<void> | void, timeout = 30_000): void {
	registeredTitles.add(title);
	it(title, run, timeout);
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (!address || typeof address === "string") {
				probe.close(() => reject(new Error("failed to allocate test port")));
				return;
			}
			const { port } = address;
			probe.close(() => resolve(port));
		});
	});
}

/** 假适配器记在拓展页视图里的发送账:读口的一块块积木。 */
interface ViewBlock {
	type: string;
	text?: string;
	items?: { label: string; value: string }[];
	rows?: { text: string }[][];
}
interface AdapterView {
	/** 「假平台管着 N 条连接」里的 N。 */
	connections: number;
	/** 「假平台收到的发送」表,新的在前(最多 10 条),每行 `连接 id | 平台 | 去向 | 载荷`。 */
	rows: string[];
	/** 「最近一条文字」那句,去掉前缀。 */
	latest: string;
	/** 视图摘要(「N 条订阅」)与「开着订阅的人」那格。 */
	summary: string;
	people: string;
}

const sentRow = (connectionId: string, platform: string, destination: string, payload: string) =>
	[connectionId, platform, destination, payload].join(" | ");

/**
 * 发送账前面新来的行。账是新的在前、最多 10 条,所以新账 = 新来的几行 + 旧账(截去超出的尾巴):
 * 找最小的 k 使「新账去掉前 k 行」恰是「旧账的头」。
 */
function freshRows(before: readonly string[], after: readonly string[]): string[] {
	for (let k = 0; k <= after.length; k++) {
		const tail = after.slice(k);
		const head = before.slice(0, tail.length);
		if (tail.length === head.length && tail.every((row, i) => row === head[i])) {
			return after.slice(0, k);
		}
	}
	return [...after];
}

const count = (rows: readonly string[], wanted: string) => rows.filter((r) => r === wanted).length;

describe("拓展契约逐成员对拍 e2e:假源经订阅源与平台适配器两口,把契约的每个成员走一遍", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;
	let port: number;
	/** 解析门候选的外部 id(`-a` / `-b` / `-c`)与端点连接托管出来的目标 id。 */
	const world = {
		externalA: "",
		externalB: "",
		externalC: "",
		hookTarget: "",
		/** 乙的订阅 id(拉取式直播那一条会删了重建,换成新的)。 */
		subB: ID.subB as string,
		/** 第一次作品推送之后的发送账与历史(几条用例读同一份)。 */
		postRun: undefined as { rows: string[]; history: HistoryEntryView[] } | undefined,
		/** 入站 `/status` 的回复整段文字。 */
		statusReply: "",
	};

	const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
	const json = (body: unknown, method = "POST"): RequestInit => ({
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	async function okJson<T>(res: Response): Promise<T> {
		expect(res.status, await res.clone().text()).toBeLessThan(300);
		return (await res.json()) as T;
	}
	/** 失败回包:状态码与 `code`(必要时再看话)。 */
	async function failed(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	/** 面板按一下假源页上的动作钮。 */
	async function press(action: string): Promise<void> {
		const res = await api(`/api/ext/${FAKE}/actions/${action}`, { method: "POST" });
		expect(res.status, await res.clone().text()).toBe(200);
	}

	/** 拨开 / 拨关假源,再列一次拓展(那一口先把热装落实掉)。 */
	async function setEnabled(enabled: boolean) {
		await okJson(
			await api("/api/settings", json({ core: { extensions: { [FAKE]: { enabled } } } }, "PATCH")),
		);
		return fakeRow();
	}
	async function fakeRow() {
		const body = await okJson<ExtensionsResponse>(await api("/api/ext"));
		const row = body.extensions.find((e) => e.id === FAKE);
		if (!row) throw new Error("拓展列表里没有假源");
		return row;
	}

	/** 来源表(`/api/sources`)里假源那一条:面板画订阅源那一口的外观取它。 */
	async function fakeSourceEntry() {
		const body = await okJson<SourcesResponse>(await api("/api/sources"));
		return body.sources.find((one) => one.key === FAKE);
	}

	async function adapterView(): Promise<AdapterView> {
		const res = await api(`/api/ext/${FAKE}/status`);
		const body = await okJson<{ summary?: { text: string }; page: { block: ViewBlock }[] }>(res);
		const blocks = body.page.map((entry) => entry.block);
		const managed = blocks.find((b) => b.items?.[0]?.label === "假平台管着")?.items?.[0]?.value;
		const people = blocks.find((b) => b.items?.[0]?.label === "开着订阅的人")?.items?.[0]?.value;
		const table = blocks.find((b) => b.type === "table");
		const notice = blocks.filter((b) => b.type === "notice").at(-1)?.text ?? "";
		return {
			connections: Number.parseInt(managed ?? "", 10),
			rows: (table?.rows ?? []).map((row) => row.map((cell) => cell.text).join(" | ")),
			latest: notice.replace(/^最近一条文字:/, ""),
			summary: body.summary?.text ?? "",
			people: people ?? "",
		};
	}

	/** 等发送账里恰好多出 `n` 行(相对 `before`),回这几行(新的在前)。 */
	async function waitFresh(before: readonly string[], n: number): Promise<string[]> {
		return vi.waitFor(
			async () => {
				const fresh = freshRows(before, (await adapterView()).rows);
				expect(fresh).toHaveLength(n);
				return fresh;
			},
			{ timeout: 10_000 },
		);
	}

	async function history(): Promise<HistoryEntryView[]> {
		return (await okJson<HistoryResponse>(await api("/api/history?limit=200"))).entries;
	}
	const postRows = (entries: readonly HistoryEntryView[]) =>
		entries.filter((e) => e.feature === "post");

	async function problemsOfFake() {
		const body = await okJson<ProblemsResponse>(await api("/api/problems"));
		return body.problems.filter((p) => p.reporter === FAKE);
	}

	async function liveRows(): Promise<LiveListeningEntry[]> {
		const rows = await okJson<LiveListeningEntry[]>(await api("/api/live/listening"));
		return rows.sort((x, y) => x.subscriptionId.localeCompare(y.subscriptionId));
	}

	async function subscriptions(): Promise<SubscriptionDTO[]> {
		return okJson<SubscriptionDTO[]>(await api("/api/subscriptions"));
	}

	async function createConnection(id: string, name: string, platform: string, settings: object) {
		return api(
			"/api/connections",
			json({ id, name, enabled: true, adapterKey: FAKE, platform, settings }),
		);
	}

	/** 经解析门拿到的候选建一条订阅(作品路由到 `post` 里的目标,路由里的目标都开 @全体)。 */
	async function createSubscription(
		id: string,
		externalId: string,
		post: readonly string[],
		enabled = true,
	): Promise<Response> {
		const base = makeExtensionSubscription({ id, extensionId: FAKE, externalId, enabled });
		return api(
			"/api/subscriptions",
			json({
				...base,
				routing: { ...base.routing, post: [...post] },
				extraTargets: {
					...base.extraTargets,
					atAllPost: Object.fromEntries(post.map((target) => [target, true])),
				},
			}),
		);
	}

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-extension-contract-parity-e2e-"));
		await installRepoExtensionInto(dataDir, FAKE, "@bilibili-notify/extension-fake-source");
		port = await findFreePort();
		handle = await startServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			// 配了浏览器才有出卡的渲染器;真正起来的是上面那个替身。AI 不开。
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1", BN_CHROME_PATH: "/fake/chrome" },
		});
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	// ---------------------------------------------------------------------
	// 生命周期与托管
	// ---------------------------------------------------------------------

	// 验红:`extensions/context.ts` 登记适配器时把转给总线订阅的 `onConnectionsChanged` 换成空操作,
	// 建连接后「管着 N 条」不涨,第一段红。
	step(TITLE.lifecycle, async () => {
		// 开机时没拨开假源:适配器不在册,新建连接、问候选都说没在跑,解析门问不到它。
		const early = await failed(await api(`/api/adapters/${FAKE}/candidates`));
		expect(early).toMatchObject({ status: 503, body: { code: "unavailable" } });
		const earlyCreate = await failed(await createConnection(ID.chatA, "甲", "fake-chat", {}));
		expect(earlyCreate).toMatchObject({ status: 503, body: { code: "unavailable" } });

		// 晚登记:开机之后才拨开。
		expect((await setEnabled(true)).state).toBe("running");
		const candidates = await okJson<{ candidates: { platform: { platform: string } }[] }>(
			await api(`/api/adapters/${FAKE}/candidates`),
		);
		expect(candidates.candidates.map((c) => c.platform.platform)).toEqual([
			"fake-chat",
			"fake-hook",
		]);
		// 来源起来了:解析门回候选。
		const looked = await okJson<CreatorsResponse>(
			await api(`/api/sources/${FAKE}/creators?q=${encodeURIComponent(LOOKUP_QUERY)}`),
		);
		expect(looked.candidates).toHaveLength(3);
		expect((await adapterView()).connections).toBe(0);

		// 建连接 → 适配器订的连接变更回调当场对账,「管着 N 条」跟着涨。
		const settings = { atAll: true, inboundFrom: OWNER };
		await okJson(await createConnection(ID.chatA, "甲", "fake-chat", settings));
		await vi.waitFor(async () => expect((await adapterView()).connections).toBe(1));
		await okJson(await createConnection(ID.chatB, "乙", "fake-chat", { atAll: false }));
		await vi.waitFor(async () => expect((await adapterView()).connections).toBe(2));
		await okJson(await createConnection(ID.hook, "假钩子连接", "fake-hook", {}));
		await vi.waitFor(async () => expect((await adapterView()).connections).toBe(3));

		// 拨关:适配器与来源一起撤掉 —— 候选、新建连接、解析门都说没在跑,能力表里一条都没有。
		expect((await setEnabled(false)).state).toBe("disabled");
		expect(await failed(await api(`/api/adapters/${FAKE}/candidates`))).toMatchObject({
			status: 503,
			body: { code: "unavailable" },
		});
		expect(await failed(await createConnection(ID.chatA, "丙", "fake-chat", {}))).toMatchObject({
			status: 503,
			body: { code: "unavailable" },
		});
		expect(
			await failed(
				await api(`/api/sources/${FAKE}/creators?q=${encodeURIComponent(LOOKUP_QUERY)}`),
			),
		).toMatchObject({ status: 404, body: { code: "not_found" } });
		expect(
			await okJson<ConnectionCapabilitiesMap>(await api("/api/connections/capabilities")),
		).toEqual({});

		// 再拨开:`start` 里读到已有的三条连接,刚起来那一刻视图就已是 3 条;解析门又回候选。
		expect((await setEnabled(true)).state).toBe("running");
		expect((await adapterView()).connections).toBe(3);
		const again = await okJson<CreatorsResponse>(
			await api(`/api/sources/${FAKE}/creators?q=${encodeURIComponent(LOOKUP_QUERY)}`),
		);
		expect(again.candidates).toHaveLength(3);
		world.externalA = again.candidates[0]?.externalId ?? "";
		world.externalB = again.candidates[1]?.externalId ?? "";
		world.externalC = again.candidates[2]?.externalId ?? "";

		drove("Source", "start", "stop");
		drove("PlatformAdapter", "start", "stop");
		drove("AdapterContext", "connections", "onConnectionsChanged");
	});

	step(TITLE.fixture, async () => {
		// 端点连接托管出来的目标(下面的订阅路由要用它的 id)。
		const managed = await okJson<{ id: string; managedBy?: string }[]>(await api("/api/targets"));
		world.hookTarget = managed.find((t) => t.managedBy === "connection")?.id ?? "";
		expect(world.hookTarget).not.toBe("");
		const target = async (
			id: string,
			name: string,
			connectionId: string,
			scope: string,
			address: string,
			parentAddress?: string,
		) =>
			okJson(
				await api(
					"/api/targets",
					json({
						id,
						name,
						connectionId,
						kind: "session",
						scope,
						address,
						...(parentAddress === undefined ? {} : { parentAddress }),
						enabled: true,
					}),
				),
			);
		// 甲上:群、私聊(主人)、子频道(上级地址手填)、一个地址为空的群(isAvailable 那一行用);乙上一个群。
		await target(ID.groupA, "甲群", ID.chatA, "group", "g-a");
		await target(ID.privateOwner, "主人", ID.chatA, "private", OWNER);
		await target(ID.channelA, "甲频道", ID.chatA, "channel", "sub-1", "guild-1");
		await target(ID.emptyGroupA, "甲空群", ID.chatA, "group", "");
		await target(ID.groupB, "乙群", ID.chatB, "group", "g-b");
		await okJson(
			await api(
				"/api/settings",
				json({ core: { master: { targetId: ID.privateOwner } } }, "PATCH"),
			),
		);

		// 两条订阅(经解析门的候选;不带资料名,作者名落身份标签)。甲路由到甲群、乙群、端点托管目标、地址为空的群,
		// 乙路由到前三个;都开 @全体(能不能真 @ 由各连接的能力定)。
		const routeA = [ID.groupA, ID.groupB, world.hookTarget, ID.emptyGroupA];
		const routeB = [ID.groupA, ID.groupB, world.hookTarget];
		await okJson(await createSubscription(ID.subA, world.externalA, routeA));
		await okJson(await createSubscription(ID.subB, world.externalB, routeB));
		expect((await subscriptions()).map((s) => s.id)).toEqual([ID.subA, ID.subB]);
	});

	// ---------------------------------------------------------------------
	// 订阅源:解析门与清单订阅段
	// ---------------------------------------------------------------------

	step(TITLE.searchCreators, async () => {
		const got = await okJson<CreatorsResponse>(
			await api(`/api/sources/${FAKE}/creators?q=${encodeURIComponent(LOOKUP_QUERY)}`),
		);
		// 同一句字永远是同一组:id 是摘要的前 16 位加 a / b / c。
		expect(got.candidates.map((c) => c.externalId)).toEqual([
			world.externalA,
			world.externalB,
			world.externalC,
		]);
		for (const [i, tag] of ["a", "b", "c"].entries()) {
			expect(got.candidates[i]?.externalId).toMatch(new RegExp(`^fake-[0-9a-f]{16}-${tag}$`));
		}
		expect(got.candidates[0]?.name).toBe(LOOKUP_QUERY);
		// 空:成功的空表。
		expect(
			await okJson(await api(`/api/sources/${FAKE}/creators?q=${encodeURIComponent("空")}`)),
		).toEqual({
			candidates: [],
		});
		// 坏:来源回的失败,码与原话原样交回。
		const bad = await failed(
			await api(`/api/sources/${FAKE}/creators?q=${encodeURIComponent("坏")}`),
		);
		expect(bad.body).toMatchObject({ code: "unauthorized" });
		expect(String(bad.body.message)).toContain("cookie 已过期");
		// 乱:候选不合规矩,整次拒,话点名哪一格。
		const messy = await failed(
			await api(`/api/sources/${FAKE}/creators?q=${encodeURIComponent("乱")}`),
		);
		expect(messy.body).toMatchObject({ code: "invalid" });
		expect(String(messy.body.message)).toContain("0.avatar");
		expect(String(messy.body.message)).toContain("1.followers");
		drove("Source", "searchCreators");
	});

	step(TITLE.externalIdRegex, async () => {
		const res = await createSubscription(ID.subExtra, "not-a-fake-id", []);
		expect(await failed(res)).toMatchObject({
			status: 400,
			body: {
				code: "invalid",
				issues: [{ path: ["identity", "externalId"], message: expect.stringContaining("假源") }],
			},
		});
		expect((await subscriptions()).some((s) => s.id === ID.subExtra)).toBe(false);
		drove("SubscriptionCell", "externalIdRegex");
	});

	async function manifestOfFake(): Promise<{
		contributes: { subscription: Record<string, unknown>; push: Record<string, unknown> };
	}> {
		return JSON.parse(
			// 包里那份(构建从规则导出了连接配置项),不是源码根那份。
			await readFile(join(REPO_ROOT, "extensions", FAKE, "dist", "extension.json"), "utf8"),
		);
	}

	step(TITLE.subscriptionCells, async () => {
		const manifest = await manifestOfFake();
		const face = (await fakeSourceEntry())?.descriptor as Record<string, unknown> | undefined;
		expect(face).toBeDefined();
		const written = manifest.contributes.subscription;
		// 清单写了的格,面板读到的逐格相等(`cardSkin` 是装包那头的事,不下发,清单也没写)。
		for (const cell of [
			"label",
			"shortLabel",
			"color",
			"icon",
			"postNoun",
			"creatorNoun",
			"externalIdNoun",
			"searchAccepts",
			"externalIdRegex",
			"supportedFeatures",
		]) {
			expect(written[cell], `清单里应写了 ${cell}`).toBeDefined();
			expect(face?.[cell], cell).toEqual(written[cell]);
		}
		expect(face).not.toHaveProperty("cardSkin");
		// 这些格的真值(防止清单被改成空壳而两边一起空):平台名「假源」、图标是图片 data URL。
		expect(face?.label).toBe("假源");
		expect(String(face?.icon)).toMatch(/^data:image\//);
		drove(
			"SubscriptionCell",
			"label",
			"shortLabel",
			"color",
			"icon",
			"searchAccepts",
			"supportedFeatures",
		);
		drove("Source", "descriptor");
	});

	step(TITLE.pushCells, async () => {
		const manifest = await manifestOfFake();
		const { adapters } = await okJson<AdaptersResponse>(await api("/api/adapters"));
		const face = adapters.find((entry) => entry.key === FAKE)?.descriptor as unknown as
			| Record<string, unknown>
			| undefined;
		expect(face).toBeDefined();
		for (const cell of ["label", "shortLabel", "color", "icon", "settingsFields"]) {
			expect(manifest.contributes.push[cell], `清单里应写了 ${cell}`).toBeDefined();
			expect(face?.[cell], cell).toEqual(manifest.contributes.push[cell]);
		}
		expect(face?.label).toBe("假平台");
		drove("PushCell", "label", "shortLabel", "color", "icon", "settingsFields");
		// 适配器描述由宿主照清单填，不再经拓展生命周期 DTO 中转。
		drove("PlatformAdapter", "descriptor");
	});

	// ---------------------------------------------------------------------
	// 平台适配器:设置、候选、宿主填、不开的口、能力、探测
	// ---------------------------------------------------------------------

	step(TITLE.settingsAndCandidates, async () => {
		const before = await okJson<unknown[]>(await api("/api/connections"));
		// 设置过 zod:`atAll` 要布尔。
		const wrongType = await failed(
			await createConnection("f4600000-0000-4000-8000-000000000c0d", "丙", "fake-chat", {
				atAll: "yes",
			}),
		);
		expect(wrongType.status).toBe(400);
		// 候选只有 `fake-chat`、`fake-hook` 两个平台:一个实现对多个平台;第三个平台不认。
		const unknownPlatform = await failed(
			await createConnection("f4600000-0000-4000-8000-000000000c0d", "丙", "fake-other", {}),
		);
		expect(unknownPlatform).toMatchObject({ status: 400, body: { code: "invalid" } });
		expect(await okJson<unknown[]>(await api("/api/connections"))).toHaveLength(before.length);
		// 两个平台各自的快照来自各自的候选:会话型有群 / 私聊 / 频道三种范围,端点型只有 channel。
		const conns = await okJson<
			{ id: string; platform: string; platformSnapshot: { targetKind: string; scopes: string[] } }[]
		>(await api("/api/connections"));
		const snapshotOf = (id: string) => conns.find((c) => c.id === id)?.platformSnapshot;
		expect(snapshotOf(ID.chatA)).toMatchObject({
			targetKind: "session",
			scopes: ["group", "private", "channel"],
		});
		expect(snapshotOf(ID.hook)).toMatchObject({ targetKind: "endpoint", scopes: ["channel"] });
		drove("PlatformAdapter", "settingsSchema", "listConnectionCandidates");
	});

	step(TITLE.adapterKey, async () => {
		// 假源在运行时故意自报 `adapterKey: "onebot"`:三条假连接的适配器键仍是拓展 id,收发照常(下面各用例),
		const conns = await okJson<{ id: string; adapterKey: string }[]>(await api("/api/connections"));
		expect(conns.map((c) => [c.id, c.adapterKey])).toEqual([
			[ID.chatA, FAKE],
			[ID.chatB, FAKE],
			[ID.hook, FAKE],
		]);
		// 内置的 onebot 适配器没被顶替:候选仍是内置那一份。
		const builtin = await okJson<{
			candidates: { name: string; platform: { platform: string } }[];
		}>(await api("/api/adapters/onebot/candidates"));
		expect(builtin.candidates.map((c) => [c.name, c.platform.platform])).toEqual([
			["OneBot v11", "onebot"],
		]);
		drove("PlatformAdapter", "adapterKey");
	});

	// 验红:`extensions/context.ts` 登记适配器时不摘 `listAddressCandidates`,`addresses` 那一段红;
	// `extension-source.ts` 按展开取成员(不按成员表),`auth` 那一段红。
	step(TITLE.closedPorts, async () => {
		// 订阅源:假源在运行时塞了 `auth`,宿主没认,这个来源「不用登录」。
		expect(await failed(await api(`/api/sources/${FAKE}/auth`))).toMatchObject({
			status: 400,
			body: { code: "unsupported", message: "这个来源不用登录" },
		});
		// 适配器:塞了 `listAddressCandidates` 与 `connectionAuth`,宿主没认。
		expect(
			await failed(await api(`/api/connections/${ID.chatA}/addresses?scope=group`)),
		).toMatchObject({ status: 400, body: { code: "unsupported" } });
		expect(await failed(await api(`/api/adapters/${FAKE}/auth`, json({})))).toMatchObject({
			status: 400,
			body: { code: "unsupported" },
		});
		expect(await failed(await api(`/api/adapters/${FAKE}/auth/some-task`))).toMatchObject({
			status: 400,
			body: { code: "unsupported" },
		});
		drove("Source", "auth");
		drove("PlatformAdapter", "listAddressCandidates", "connectionAuth");
	});

	// 验红:`routes/connections.ts` 的能力快照对拓展连接不问适配器(跳过),这一条红。
	step(TITLE.capabilities, async () => {
		const caps = await okJson<ConnectionCapabilitiesMap>(
			await api("/api/connections/capabilities"),
		);
		expect(Object.keys(caps).sort()).toEqual([ID.chatA, ID.chatB, ID.hook].sort());
		// 甲打开了 @全体、填了入站发送者;乙与端点都没有。
		expect(caps[ID.chatA]).toMatchObject({
			atAll: { state: "supported" },
			inbound: { state: "supported" },
		});
		for (const id of [ID.chatB, ID.hook]) {
			expect(caps[id]).toMatchObject({
				atAll: { state: "unsupported", reason: "这条假连接没打开 @全体" },
				inbound: { state: "unsupported", reason: "这条假连接没填入站发送者" },
			});
		}
		// 原生分享恒答「还不知道」,逼宿主在手动测试时补探。
		for (const id of [ID.chatA, ID.chatB, ID.hook]) {
			expect(caps[id]?.nativeShare.state).toBe("unknown");
		}
		drove("PlatformAdapter", "capabilities");
	});

	step(TITLE.probe, async () => {
		const probed = await okJson<{ ok: boolean }>(
			await api(`/api/connections/${ID.chatA}/probe`, json({})),
		);
		expect(probed.ok).toBe(true);
		const conns = await okJson<{ id: string; probeState?: { status: string } }[]>(
			await api("/api/connections"),
		);
		expect(conns.find((c) => c.id === ID.chatA)?.probeState?.status).toBe("reachable");
		// 手动测试有「还不知道」的格就补探一次:甲的原生分享成了「不支持」,理由是 `probeCapabilities` 给的那句;
		// 没测过的乙仍是「还不知道」(补探只补这一条连接)。
		const caps = await okJson<ConnectionCapabilitiesMap>(
			await api("/api/connections/capabilities"),
		);
		expect(caps[ID.chatA]?.nativeShare).toMatchObject({
			state: "unsupported",
			reason: "假平台发不了原生分享",
		});
		expect(caps[ID.chatB]?.nativeShare.state).toBe("unknown");
		drove("PlatformAdapter", "probe", "probeCapabilities");
	});

	// ---------------------------------------------------------------------
	// 作品:推送、@全体、不可用的目标、叫法、富文本
	// ---------------------------------------------------------------------

	// 验红:假适配器的 `capabilities` 让乙也答 `atAll` 支持,乙群与端点多出 @全体,账里不是 8 行,这里红。
	step(TITLE.atAll, async () => {
		const before = (await adapterView()).rows;
		expect(before).toEqual([]);
		await press("report.post");
		// 两条订阅、各自的路由:甲群(@全体 + 卡)、乙群(卡)、端点(卡),甲订阅另有地址为空的群(下一条用例);
		// 账里就是 2 × (2 + 1 + 1) = 8 行,历史是 6 行(甲群那两行各带 @全体 那条附加消息)。
		const run = await vi.waitFor(
			async () => {
				const rows = (await adapterView()).rows;
				expect(rows).toHaveLength(8);
				const entries = postRows(await history());
				expect(entries).toHaveLength(6);
				for (const entry of entries) {
					expect(entry.status).toBe("delivered");
					expect(entry.messages.length, entry.targetId ?? "").toBe(
						entry.targetId === ID.groupA ? 2 : 1,
					);
				}
				return { rows, history: entries };
			},
			{ timeout: 10_000 },
		);
		world.postRun = run;
		const atAllRow = sentRow(ID.chatA, "fake-chat", "group g-a", "at-all");
		const cardA = sentRow(ID.chatA, "fake-chat", "group g-a", "image + text");
		const cardB = sentRow(ID.chatB, "fake-chat", "group g-b", "image + text");
		const cardHook = sentRow(ID.hook, "fake-hook", `端点 ${world.hookTarget}`, "image + text");
		// 甲(@全体 为真)是对照:证明 @全体 那条路确实被驱动 —— 一条订阅一条只含 at-all 段的消息;
		// 乙与端点的连接答「不支持」,不 @全体:它们的目标只收到卡。
		expect(count(run.rows, atAllRow)).toBe(2);
		expect(count(run.rows, cardA)).toBe(2);
		expect(count(run.rows, cardB)).toBe(2);
		expect(count(run.rows, cardHook)).toBe(2);
		expect(run.rows.filter((r) => r.endsWith("at-all"))).toHaveLength(2);
		// 先 @ 后卡:按到达先后(账是新的在前,倒过来走),任何时候已出现的 @全体 都不少于已出现的甲群卡。
		let seenAtAll = 0;
		let seenCards = 0;
		for (const row of [...run.rows].reverse()) {
			if (row === atAllRow) seenAtAll += 1;
			if (row === cardA) seenCards += 1;
			expect(seenAtAll, "甲群的 @全体 要排在它的卡之前").toBeGreaterThanOrEqual(seenCards);
		}
		// 历史里 @全体 是甲群那一行的附加消息,别的目标的行没有。
		for (const entry of run.history) {
			const extras = entry.messages.filter((m) => m.role === "extra");
			expect(
				extras.map((m) => m.text),
				entry.targetId ?? "",
			).toEqual(entry.targetId === ID.groupA ? ["@全体"] : []);
		}
	});

	step(TITLE.endpoint, async () => {
		const run = world.postRun;
		if (!run) throw new Error("上一条用例没留下发送账");
		const targets = await okJson<
			{ id: string; kind: string; managedBy?: string; connectionId: string; name: string }[]
		>(await api("/api/targets"));
		// 建了一条 `fake-hook` 连接(端点型),目标表里自动多了一条:端点、由连接托管,不用手建;别的连接没有。
		const endpoints = targets.filter((t) => t.kind === "endpoint");
		expect(endpoints).toHaveLength(1);
		expect(endpoints[0]).toMatchObject({
			id: world.hookTarget,
			managedBy: "connection",
			connectionId: ID.hook,
			name: "假钩子连接",
			enabled: true,
		});
		// 手建端点目标:拒,话是「由它的连接自动创建」(46-1 改过的那句,按目标形态说、不提 webhook)。
		const manual = await failed(
			await api(
				"/api/targets",
				json({
					id: "f4600000-0000-4000-8000-000000000e01",
					name: "手建",
					connectionId: ID.hook,
					kind: "endpoint",
					enabled: true,
				}),
			),
		);
		expect(manual).toMatchObject({
			status: 400,
			body: { code: "invalid", message: "主人，端点目标由它的连接自动创建，不能手动新建" },
		});
		// 作品路由到它(两条订阅各一条),适配器收到的去向是端点、带着端点 id,不是会话。
		expect(
			count(run.rows, sentRow(ID.hook, "fake-hook", `端点 ${world.hookTarget}`, "image + text")),
		).toBe(2);
		expect(run.history.filter((e) => e.targetId === world.hookTarget)).toHaveLength(2);
	});

	// 验红:假适配器的 `isAvailable` 恒回 true,没补地址前账里就多出地址为空的群那两行(先在上一条用例的 8 行上红)。
	step(
		TITLE.sendAndAvailable,
		async () => {
			const run = world.postRun;
			if (!run) throw new Error("上一条用例没留下发送账");
			// send:账里每个目标一条卡,去向与载荷种类对得上 —— 会话去向带范围与地址,端点去向带端点 id;
			// 递到适配器手上的连接就是目标所挂的那一条(平台串对得上)。
			expect(new Set(run.rows)).toEqual(
				new Set([
					sentRow(ID.chatA, "fake-chat", "group g-a", "at-all"),
					sentRow(ID.chatA, "fake-chat", "group g-a", "image + text"),
					sentRow(ID.chatB, "fake-chat", "group g-b", "image + text"),
					sentRow(ID.hook, "fake-hook", `端点 ${world.hookTarget}`, "image + text"),
				]),
			);
			// isAvailable:甲订阅也路由到地址为空的群,会话去向地址为空回 false —— 推送层当「暂不可达」按退避重试,
			// 不往里发:账里没有它(没有「group 」那一行),历史里也没有它的行。
			expect(run.rows.some((row) => row.includes("group |"))).toBe(false);
			expect(run.history.some((e) => e.targetId === ID.emptyGroupA)).toBe(false);
			// 补上地址:下一次重试(3 秒一轮,退避)`isAvailable` 回 true,@全体 与卡都发出去。
			await okJson(
				await api(`/api/targets/${ID.emptyGroupA}`, json({ address: "g-late" }, "PATCH")),
			);
			await vi.waitFor(
				async () => {
					const rows = (await adapterView()).rows;
					expect(count(rows, sentRow(ID.chatA, "fake-chat", "group g-late", "at-all"))).toBe(1);
					expect(count(rows, sentRow(ID.chatA, "fake-chat", "group g-late", "image + text"))).toBe(
						1,
					);
					const late = postRows(await history()).filter((e) => e.targetId === ID.emptyGroupA);
					expect(late).toHaveLength(1);
					expect(late[0]?.status).toBe("delivered");
				},
				{ timeout: 15_000 },
			);
			drove("PlatformAdapter", "send", "isAvailable");
		},
		40_000,
	);

	step(TITLE.nouns, async () => {
		const run = world.postRun;
		if (!run) throw new Error("上一条用例没留下历史");
		// 订阅没有资料名:作者名落身份标签「{externalIdNoun} {外部 id}」;作品文案里的叫法是清单的 `postNoun`
		// (第一条是图文,模板「发布了一条{postNoun}」)。
		for (const [subscriptionId, externalId] of [
			[ID.subA, world.externalA],
			[ID.subB, world.externalB],
		] as const) {
			const rows = run.history.filter((e) => e.subscriptionId === subscriptionId);
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) {
				expect(row.messages[0]?.text).toMatch(
					new RegExp(
						`^假号 ${externalId}发布了一条假帖\\nhttps://fake-source\\.invalid/[0-9a-f]{12}/post/1$`,
					),
				);
			}
		}
		drove("SubscriptionCell", "postNoun", "externalIdNoun");
	});

	// 验红:`extension-source.ts` 把转给拓展的 `onSubscriptionsChanged` 换成空操作,「面板被喊一声」那一段红。
	step(TITLE.subscriptions, async () => {
		expect((await adapterView()).people).toBe("2 个");
		statusChanged.length = 0;
		await okJson(await createSubscription(ID.subExtra, world.externalC, []));
		await vi.waitFor(async () => {
			expect((await adapterView()).people).toBe("3 个");
			expect((await adapterView()).summary).toBe("3 条订阅");
			expect(statusChanged).toContain(FAKE);
		});
		// 停用的不在名单里。
		statusChanged.length = 0;
		await okJson(await api(`/api/subscriptions/${ID.subExtra}`, json({ enabled: false }, "PATCH")));
		await vi.waitFor(async () => {
			expect((await adapterView()).people).toBe("2 个");
			expect(statusChanged).toContain(FAKE);
		});
		expect((await api(`/api/subscriptions/${ID.subExtra}`, { method: "DELETE" })).status).toBe(204);
		drove("SourceContext", "subscriptions", "onSubscriptionsChanged");
	});

	// 验红:`extension-source.ts` 翻作品时丢掉 `richText`,总线上的作品没有片段,这里红;出图器那一侧
	// (`packages/image/src/rich-text.tsx` 的链接图标)不画图标,HTML 里的 `<img … >网页` 找不到,最后一段红。
	step(
		TITLE.reportPost,
		async () => {
			heard.length = 0;
			renderedHtml.length = 0;
			const rowsBefore = postRows(await history()).length;
			await press("report.richPost");
			await vi.waitFor(() => expect(heard).toHaveLength(2));
			for (const event of heard) {
				const segments = event.post.richText ?? [];
				expect(segments.map((s) => s.kind)).toEqual([
					"text",
					"mention",
					"text",
					"topic",
					"text",
					"link",
					"text",
					"emoji",
					"text",
				]);
				expect(event.post.text).toBe(segments.map((s) => s.text).join(""));
			}
			const rich = heard[0]?.post.richText ?? [];
			const mention = rich.find((s) => s.kind === "mention");
			const topic = rich.find((s) => s.kind === "topic");
			const link = rich.find((s) => s.kind === "link");
			const emoji = rich.find((s) => s.kind === "emoji");
			expect(mention).toMatchObject({
				text: "@假朋友",
				externalId: expect.stringContaining("fake-user-"),
			});
			expect(topic).toMatchObject({ text: "#假话题", name: "假话题" });
			expect(link).toMatchObject({
				text: "网页",
				url: expect.stringContaining("fake-source.invalid"),
			});
			// 链接片段的图标与表情的图都是图库引用,取得回来。
			const iconRef = link?.kind === "link" ? link.icon : undefined;
			const emojiRef = emoji?.kind === "emoji" ? emoji.image : undefined;
			expect(iconRef && isValidImageRef(iconRef)).toBe(true);
			expect(emojiRef && isValidImageRef(emojiRef)).toBe(true);
			const iconRes = await api(`/api/images/${iconRef}`);
			expect(iconRes.status).toBe(200);
			const iconBytes = Buffer.from(await iconRes.arrayBuffer());
			expect((await api(`/api/images/${emojiRef}`)).status).toBe(200);
			// 出图器吃到的 HTML:图标画在链接字「网页」前面(同一个 span 里),字节就是图库里那张图。
			const card = await vi.waitFor(
				() => {
					const found = renderedHtml.find(
						(html) => html.includes("五种片段") && html.includes("网页"),
					);
					expect(found, "五种片段那张卡没画出来").toBeDefined();
					return found as string;
				},
				{ timeout: 10_000 },
			);
			const icon = card.match(/<img[^>]*src="(data:image\/png;base64,[A-Za-z0-9+/=]+)"[^>]*>网页/);
			expect(icon, "链接字前面应有图标 <img>").not.toBeNull();
			expect(Buffer.from((icon?.[1] ?? "").split(",")[1] ?? "", "base64").equals(iconBytes)).toBe(
				true,
			);
			expect(card).toContain('<span class="text-[#00AEEC]">@假朋友</span>');
			expect(card).toContain('<span class="text-[#FF6699]">#假话题</span>');
			// 一格没丢:上报出入里没有这一条。
			expect((await fakeRow()).reportDiscrepancies).toBeUndefined();
			// 推送收完(甲 4 个目标、乙 3 个),再把两条订阅的作品路由清空,后面的用例不再被作品推送搅乱发送账。
			await vi.waitFor(async () => expect(postRows(await history())).toHaveLength(rowsBefore + 7), {
				timeout: 15_000,
			});
			for (const sub of await subscriptions()) {
				// JSON Merge Patch:键缺席 = 不改,`null` 才删 —— 路由清空的同时,@全体 的逐目标表也要逐键删掉(它的键必须是路由的子集)。
				const atAllPost = Object.fromEntries(
					Object.keys(sub.extraTargets.atAllPost).map((target) => [target, null]),
				);
				await okJson(
					await api(
						`/api/subscriptions/${sub.id}`,
						json({ routing: { post: [] }, extraTargets: { atAllPost } }, "PATCH"),
					),
				);
			}
			drove("SourceContext", "reportPost");
		},
		40_000,
	);

	// 验红:`push/target-dispatcher.ts` 的 `destinationOf` 丢掉 `parentAddress`,账里去向没有「/ 上级」。
	step(TITLE.parentAddress, async () => {
		// 契约这一版没有「列上级地址」的口(`listAddressCandidates` 不开),子频道目标的 `parentAddress` 只能主人手填;
		// 填了什么,适配器收到的去向就带着什么。
		const targets = await okJson<{ id: string; parentAddress?: string }[]>(
			await api("/api/targets"),
		);
		expect(targets.find((t) => t.id === ID.channelA)?.parentAddress).toBe("guild-1");
		const before = (await adapterView()).rows;
		const sent = await okJson<{ ok: boolean }>(
			await api(`/api/targets/${ID.channelA}/test`, json({ kind: "text" })),
		);
		expect(sent.ok).toBe(true);
		const fresh = await waitFresh(before, 1);
		expect(fresh).toEqual([sentRow(ID.chatA, "fake-chat", "channel sub-1 / 上级 guild-1", "text")]);
	});

	// ---------------------------------------------------------------------
	// 入站:指令回复、健康、校验
	// ---------------------------------------------------------------------

	step(TITLE.inbound, async () => {
		const before = (await adapterView()).rows;
		await press("inbound.private");
		// 只有甲填了入站发送者,所以恰好一条私聊 `/status`;回复回到「私聊 + 主人地址 + 甲这条连接」,恰好一条。
		const fresh = await waitFresh(before, 1);
		expect(fresh).toEqual([sentRow(ID.chatA, "fake-chat", `private ${OWNER}`, "text")]);
		world.statusReply = (await adapterView()).latest;
		drove("AdapterContext", "inbound");
	});

	step(TITLE.health, async () => {
		const reply = world.statusReply;
		expect(reply, "上一条用例没留下 /status 的回复").not.toBe("");
		// 「平台名:来源自己说的那句」,平台名取清单订阅段的 `label`,那句是 `health()` 经 `ctx.i18n` 翻出来的,
		// 两个开着订阅的人。
		expect(reply.split("\n")).toContain("假源：在跑 · 管着 2 个人");
		drove("Source", "health");
	});

	// 验红:`push/adapter-context.ts` 的 `feed` 摘掉连接归属检查,冒名的入站也递下去,日志里没有「不是适配器 … 的」那一行。
	step(TITLE.forged, async () => {
		const before = (await adapterView()).rows;
		await press("inbound.forged");
		// 不存在的连接:宿主丢掉并记一行,不会有回复。
		const line = `丢掉一条私聊消息:连接 ${FORGED_CONNECTION_ID} 不是适配器 ${FAKE} 的`;
		await vi.waitFor(
			async () => {
				const logs = await okJson<{ entries: { level: string; msg: string }[] }>(
					await api("/api/system/logs?limit=500"),
				);
				expect(logs.entries.some((e) => e.level === "warn" && e.msg === line)).toBe(true);
			},
			{ timeout: 10_000 },
		);
		expect((await adapterView()).rows).toEqual(before);
		// 内置那一半:内置适配器与拓展适配器共用同一个 `createPlatformAdapterContext`,校验只有这一处(两处调用点);
		// 「别人的连接」那一支与停下之后的丢弃由 `push/__tests__/adapter-context.test.ts` 那组单测钉着。
		for (const caller of [
			"apps/server/src/push/builtin-adapters.ts",
			"apps/server/src/extensions/context.ts",
		]) {
			expect(await readFile(join(REPO_ROOT, caller), "utf8"), caller).toContain(
				"createPlatformAdapterContext(",
			);
		}
	});

	// ---------------------------------------------------------------------
	// 问题上报
	// ---------------------------------------------------------------------

	// 验红:`extension-source.ts` 把转给拓展的 `reportProblem` 换成空操作,来源级与订阅级的问题报不上去,问题表那一段红。
	step(TITLE.problems, async () => {
		const subIds = [ID.subA, ID.subB];
		const before = (await adapterView()).rows;
		await press("report.problem");
		// 问题表:拓展级、来源级各一条(没有 about),订阅级一人一条(about 是订阅 id),连接级一条一条(about 是连接 id)。
		const reported = await problemsOfFake();
		const byCode = (code: string) => reported.filter((p) => p.code === code);
		expect(byCode("fake_extension_problem").map((p) => p.about)).toEqual([undefined]);
		expect(byCode("fake_source_problem").map((p) => p.about)).toEqual([undefined]);
		expect(
			byCode("fake_creator_problem")
				.map((p) => (p.about as { subscriptionId?: string } | undefined)?.subscriptionId)
				.sort(),
		).toEqual([...subIds].sort());
		expect(
			byCode("fake_connection_problem")
				.map((p) => (p.about as { connectionId?: string } | undefined)?.connectionId)
				.sort(),
		).toEqual([ID.chatA, ID.chatB, ID.hook].sort());
		expect(reported).toHaveLength(7);
		// 订阅页上那两位的订阅带着自己的问题。
		const subs = await subscriptions();
		for (const id of subIds) {
			expect(subs.find((s) => s.id === id)?.problems.map((p) => p.code)).toEqual([
				"fake_creator_problem",
			]);
		}
		// 只有拓展级的带了 `notify`:主人收到恰好一条私聊,「<清单名> 报告:<原句>」。
		const dm = await waitFresh(before, 1);
		expect(dm).toEqual([sentRow(ID.chatA, "fake-chat", `private ${OWNER}`, "text")]);
		expect((await adapterView()).latest).toContain(
			"假源(开发用)报告：假源拓展暂时无法处理订阅更新，假源这一侧会继续尝试。",
		);

		// 清掉:四层都没了,当初私聊过的那一条补一句恢复句(带的是拓展自己写的那句)。
		const beforeResolve = (await adapterView()).rows;
		await press("resolve.problem");
		await vi.waitFor(async () => expect(await problemsOfFake()).toEqual([]));
		const recovery = await waitFresh(beforeResolve, 1);
		expect(recovery).toEqual([sentRow(ID.chatA, "fake-chat", `private ${OWNER}`, "text")]);
		expect((await adapterView()).latest).toContain("假源拓展已恢复，订阅数据可以继续更新。");
		for (const id of subIds) {
			expect((await subscriptions()).find((s) => s.id === id)?.problems).toEqual([]);
		}
		drove("SourceContext", "reportProblem", "resolveProblem");
	});

	// ---------------------------------------------------------------------
	// 直播与资料
	// ---------------------------------------------------------------------

	step(TITLE.reportLive, async () => {
		await press("report.liveStart");
		const started = await vi.waitFor(async () => {
			const rows = await liveRows();
			expect(rows.map((row) => row.subscriptionId)).toEqual([ID.subA, ID.subB]);
			return rows;
		});
		for (const row of started) {
			expect(row).toMatchObject({
				isLive: true,
				title: "假直播 · 第 1 场",
				totalViewers: 1000,
				startedAt: expect.any(String),
			});
		}
		await press("report.liveStatus");
		const later = await vi.waitFor(async () => {
			const rows = await liveRows();
			expect(rows[0]?.totalViewers).toBeGreaterThan(1000);
			return rows;
		});
		expect(later.map((row) => row.startedAt)).toEqual(started.map((row) => row.startedAt));
		await press("report.liveEnd");
		await vi.waitFor(async () => expect(await liveRows()).toEqual([]));
		drove("SourceContext", "reportLive");
	});

	// 验红:`extension-source.ts` 不把 `fetchLiveStatus` 放进核心的来源,订阅重建之后在播表里等不到这一场。
	step(
		TITLE.fetchLiveStatus,
		async () => {
			await press("report.liveStart");
			const first = await vi.waitFor(async () => {
				const rows = await liveRows();
				expect(rows).toHaveLength(2);
				return rows;
			});
			const startedAt = first[0]?.startedAt;
			expect(first[0]?.title).toBe("假直播 · 第 2 场");
			// 删了乙再用同一个人建一条新订阅:新订阅手里没有场次,核心就问来源「此刻在不在播」;
			// 假源按它记着的答:在播,开播时刻就是按钮那一下 —— 拓展没有再报一次。
			expect((await api(`/api/subscriptions/${ID.subB}`, { method: "DELETE" })).status).toBe(204);
			await vi.waitFor(async () =>
				expect((await liveRows()).map((r) => r.subscriptionId)).toEqual([ID.subA]),
			);
			await okJson(await createSubscription(ID.subB2, world.externalB, []));
			world.subB = ID.subB2;
			const pulled = await vi.waitFor(
				async () => {
					const row = (await liveRows()).find((r) => r.subscriptionId === ID.subB2);
					expect(row).toBeDefined();
					return row;
				},
				{ timeout: 15_000 },
			);
			expect(pulled).toMatchObject({
				isLive: true,
				title: "假直播 · 第 2 场",
				startedAt,
				identity: { sourceKey: FAKE, externalId: world.externalB },
			});
			await press("report.liveEnd");
			await vi.waitFor(async () => expect(await liveRows()).toEqual([]));
			drove("Source", "fetchLiveStatus");
		},
		40_000,
	);

	const nameOf = async (id: string) =>
		(await subscriptions()).find((s) => s.id === id)?.cachedProfile?.name;

	step(TITLE.fetchProfile, async () => {
		// 记号 id(合外部 id 格式、解析门永远现编不出的那个)建一条订阅,让来源对它回 `not_found`。
		await okJson(await createSubscription(ID.subMissing, MISSING_EXTERNAL_ID, []));
		await okJson(await api("/api/dev/run/core.profiles.refresh-now", json({ params: {} })));
		// 没被按钮报过资料的人,来源现编一份名字带「拉取版」的。
		await vi.waitFor(async () => {
			expect(await nameOf(ID.subA)).toContain("拉取版");
			expect(await nameOf(world.subB)).toContain("拉取版");
		});
		// 平台上没有的人:记成关于那条订阅的 `creator_not_found`。
		const missing = (await subscriptions()).find((s) => s.id === ID.subMissing);
		expect(missing?.problems).toMatchObject([
			{
				reporter: FAKE,
				code: "creator_not_found",
				about: { subscriptionId: ID.subMissing },
			},
		]);
		expect((await api(`/api/subscriptions/${ID.subMissing}`, { method: "DELETE" })).status).toBe(
			204,
		);
		drove("Source", "fetchProfile");
	});

	step(TITLE.reportProfile, async () => {
		await press("report.profile");
		await vi.waitFor(async () => {
			expect(await nameOf(ID.subA)).toContain("第 1 版");
			expect(await nameOf(world.subB)).toContain("第 1 版");
		});
		// 按钮报过的人,之后核心定时拉取,来源交回的就是宿主已经收下的同一版(不会被「拉取版」盖掉)。
		await okJson(await api("/api/dev/run/core.profiles.refresh-now", json({ params: {} })));
		expect(await nameOf(ID.subA)).toContain("第 1 版");
		expect(await nameOf(world.subB)).toContain("第 1 版");
		drove("SourceContext", "reportProfile");
	});

	// ---------------------------------------------------------------------
	// 清单自己:自检
	// ---------------------------------------------------------------------

	// 注意:这一组必须排在上面所有用例之后(靠文件内顺序),它拿「实际驱动过的行」对行表。
	describe("清单自己", () => {
		const entries = Object.entries(TABLES).flatMap(([table, rows]) =>
			Object.entries(rows as Record<string, Row>).map(([member, row]) => ({
				key: `${table}.${member}`,
				table,
				member,
				row,
			})),
		);

		it("七张行表的行数,与走通 / 不开 / 宿主填各有几行(提交 9 抄进 architecture)", () => {
			const size = (table: keyof Tables) => Object.keys(TABLES[table]).length;
			expect(size("Source")).toBe(10);
			expect(size("SubscriptionCell")).toBe(12);
			expect(size("SourceContext")).toBe(7);
			expect(size("PlatformAdapter")).toBe(13);
			expect(size("PushCell")).toBe(5);
			expect(size("AdapterContext")).toBe(3);
			expect(size("IntegrationContext")).toBe(14);
			expect(entries).toHaveLength(64);
			const of = (state: Row["state"]) => entries.filter((e) => e.row.state === state);
			// 本文件驱动 39 行，另有 16 行由所引用测试管着（含 featureHints 的公共来源路由）；不开 8 行，宿主填 1 行。
			expect(of("driven")).toHaveLength(39);
			expect(of("elsewhere")).toHaveLength(16);
			expect(of("closed")).toHaveLength(8);
			expect(of("hostFilled")).toHaveLength(1);
			expect(
				of("closed")
					.map((e) => e.key)
					.sort(),
			).toEqual(
				[
					"PlatformAdapter.connectionAuth",
					"PlatformAdapter.descriptor",
					"PlatformAdapter.listAddressCandidates",
					"Source.auth",
					"Source.descriptor",
					"Source.fetchPreview",
					"Source.liveInteractions",
					"SubscriptionCell.cardSkin",
				].sort(),
			);
		});

		it("开放的行与宿主那张成员表对得上:来源 = SOURCE_DEF_MEMBERS 里为 true 的,适配器的「不开 / 宿主填」= PlatformAdapterDef 摘掉的四个", () => {
			expect(ADAPTER_DEF_OMITTED_IS_COMPLETE).toBe(true);
			const opened = Object.entries(SOURCE_ROWS)
				.filter(([, row]) => (row as Row).state === "driven")
				.map(([member]) => member)
				.sort();
			const hostOpens = Object.entries(SOURCE_DEF_MEMBERS)
				.filter(([, open]) => open)
				.map(([member]) => member)
				.sort();
			expect(opened).toEqual(hostOpens);
			const notOpen = Object.entries(ADAPTER_ROWS)
				.filter(([, row]) => (row as Row).state === "closed" || (row as Row).state === "hostFilled")
				.map(([member]) => member)
				.sort();
			expect(notOpen).toEqual([...ADAPTER_DEF_OMITTED].sort());
			expect(ADAPTER_ROWS.adapterKey.state).toBe("hostFilled");
		});

		it("引用的东西真有:driven 指向本文件注册过的用例标题;elsewhere / closed / hostFilled 引的文件在、含那个 it 标题、理由非空", async () => {
			const texts = new Map<string, string>();
			const textOf = async (file: string) => {
				if (!texts.has(file)) texts.set(file, await readFile(join(REPO_ROOT, file), "utf8"));
				return texts.get(file) as string;
			};
			const hasTitle = async (file: string, title: string) =>
				file === THIS_FILE ? registeredTitles.has(title) : (await textOf(file)).includes(title);
			for (const { key, row } of entries) {
				if (row.state === "driven") {
					expect(registeredTitles.has(row.it), `${key} → ${row.it}`).toBe(true);
				} else if (row.state === "elsewhere") {
					expect(await hasTitle(row.file, row.it), `${key} → ${row.file}`).toBe(true);
				} else {
					expect(row.reason.trim().length, `${key} 要写理由`).toBeGreaterThan(0);
					expect(row.evidence.length, `${key} 要写证据`).toBeGreaterThan(0);
					for (const proof of row.evidence) {
						expect(await hasTitle(proof.file, proof.title), `${key} → ${proof.file}`).toBe(true);
					}
				}
			}
		});

		it("标「走通」的行恰好都被驱动到了(含「不开」行里指向本文件用例的证据),没有多驱动的", () => {
			const expected = new Set<string>();
			for (const { key, row } of entries) {
				if (row.state === "driven") expected.add(key);
				if (
					(row.state === "closed" || row.state === "hostFilled") &&
					row.evidence.some((proof) => proof.file === THIS_FILE)
				) {
					expected.add(key);
				}
			}
			expect(drivenInThisRun).toEqual(expected);
		});
	});
});
