/**
 * 🔴 **守卫 21b:进程内对拍 —— 一个不是 B 站的来源,照内置那条路登记之后,核心给它的待遇与给 B 站的一样。**
 *
 * 假来源(`support/in-process-source.ts`,键 `acme.inprocess`)只实现中立的 `Source`,经真入口、真 `compose.ts`
 * (`vi.mock` 包一层:真 B 站来源照常并排登记,之外对假来源调同一个 `pipeline.registerSource`)、真登记表、真来源上下文
 * 走完整条链:名单、作品、过滤、出卡、推送、历史、统计、问题、设置、健康、登录口、存储、关停。
 * 核心里每一处按 B 站键分岔的地方因此都走另一支 —— 对拍测的就是那一支。
 *
 * 推送内容从 devtools 的截流记录里读(不出网);出卡的浏览器是假的(灌进去的 HTML 留下来);AI 是回环上的假模型。
 * 联网守卫对每条用例自动查账,只许回环。
 *
 * **这份文件自己是清单**:`PARITY_ROWS` 列着对拍的每一行与「这版不开」的每一行(不开的必须写清等哪一期、为什么);
 * 成员棘轮(`satisfies Record<keyof …>`)让接口上多一个成员时这里类型检查就过不去 —— 必须来补一行。
 * 下面每条用例前的「验红」写的是施工时真改坏跑过的那一处。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CreatorsResponse,
	DevCapturedDelivery,
	HistoryEntryView,
	HistoryResponse,
	LiveListeningEntry,
	ProblemsResponse,
	SourceAuthResponse,
	SourcesResponse,
	StatsOverviewResponse,
	SubscriptionDTO,
} from "@bilibili-notify/contract";
import {
	fail,
	makeDefaultGlobalConfig,
	ok,
	type Post,
	type PostReport,
	type Source,
	type SourceAuth,
	type SourceContext,
	type SourceDescriptor,
} from "@bilibili-notify/internal";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { WebSocket } from "ws";
import {
	importsOf,
	isInside,
	parseSource,
	resolveSpecifier,
} from "../../../../scripts/source-scan.mjs";
import { integrationSettingsFile } from "../config/store.js";
import { type ServerHandle, startServer } from "../index.js";
import type { NodeServiceContext } from "../runtime/service-context.js";
import type { LogEntry } from "../ws/types.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { activeGeneration } from "./support/generation.js";
import {
	createInProcessAiToolProvider,
	currentProbe,
	IN_PROCESS_CUSTOM_PROGRAM_ID,
	IN_PROCESS_ECHO_TOOL_LABEL,
	IN_PROCESS_ECHO_TOOL_NAME,
	IN_PROCESS_KEY,
	IN_PROCESS_LABEL,
	IN_PROCESS_OTHER_PROGRAM_ID,
	IN_PROCESS_OTHER_TIER_KEY,
	IN_PROCESS_PROGRAM_ID,
	IN_PROCESS_SKILL_BODY,
	IN_PROCESS_SKILL_FULL_NAME,
	IN_PROCESS_TIER_ICON_BASE64,
	IN_PROCESS_TIER_KEY,
	inProcessWorld,
	LINK_NATIVE_PREFIX,
	LINK_TITLE_PREFIX,
	LIVE_STATUS_PROBLEM_CODE,
	resetInProcessWorld,
	SETTINGS_PROBLEM_CODE,
} from "./support/in-process-source.js";
import { png } from "./support/report-images.js";
import { subscriptionsFileText } from "./support/subscriptions-file.js";

/** 总线上看到的直播事件(P36):`live-session-changed` 与 `live-viewers-changed`,按到达先后。 */
const liveBusEvents = vi.hoisted(
	() => [] as Array<{ event: "live-session-changed" | "live-viewers-changed"; data: unknown }>,
);

/** 值里(深搜)有没有叫这些名字的键。 */
function hasKey(value: unknown, keys: readonly string[]): boolean {
	if (Array.isArray(value)) return value.some((item) => hasKey(item, keys));
	if (typeof value !== "object" || value === null) return false;
	return Object.entries(value).some(([key, inner]) => keys.includes(key) || hasKey(inner, keys));
}

/** 假浏览器:截图恒交这串字节,灌进去的每一份 HTML 留下来。 */
const renderedHtml = vi.hoisted(() => [] as string[]);

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

// 照内置那条路登记:真 compose 照跑(真 B 站来源并排在册),包装层再对假来源调同一个 `pipeline.registerSource`。
vi.mock("../compose.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../compose.js")>();
	const support = await import("./support/in-process-source.js");
	return support.wrapCompose(real);
});

// 总线是运行时的:真运行时照建,在它的总线上挂耳朵(假来源世界那几只由支架挂,直播的两只在这里)。
vi.mock("../runtime/bootstrap.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../runtime/bootstrap.js")>();
	const support = await import("./support/in-process-source.js");
	const wrapped = support.wrapBootstrap(real);
	return {
		...wrapped,
		createAppRuntime(...args: Parameters<typeof wrapped.createAppRuntime>) {
			const runtime = wrapped.createAppRuntime(...args);
			runtime.bus.on("live-session-changed", (data) => {
				liveBusEvents.push({ event: "live-session-changed", data });
			});
			runtime.bus.on("live-viewers-changed", (data) => {
				liveBusEvents.push({ event: "live-viewers-changed", data });
			});
			return runtime;
		},
	};
});

// ---------------------------------------------------------------------------
// 清单自己
// ---------------------------------------------------------------------------

type ParityRow =
	| { id: string; title: string; checked: true }
	| { id: string; title: string; checked: false; waitsFor: string; reason: string };

/**
 * 对拍的行(`checked: true`,P01–P52)与「这版不开」的行(`checked: false`,N01–N16 去掉
 * N02、N03、N04、N05、N06、N07、N08、N10、N11、N12、N13、N16,必须写清等哪一期、为什么)。
 * 末尾的用例核:条数、id 不重、不开的两格都非空、`checked` 的 id 与这份文件实际驱动过的一致。
 */
const PARITY_ROWS: readonly ParityRow[] = [
	{ id: "P01", title: "登记即启动", checked: true },
	{ id: "P02", title: "名单", checked: true },
	{ id: "P03", title: "名单变了的两路", checked: true },
	{ id: "P04", title: "作品到推送", checked: true },
	{ id: "P05", title: "按身份展开", checked: true },
	{ id: "P06", title: "作品到卡片", checked: true },
	{ id: "P07", title: "过滤与留痕", checked: true },
	{ id: "P08", title: "历史行", checked: true },
	{ id: "P09", title: "统计作品行", checked: true },
	{ id: "P10", title: "作品叫法进 AI", checked: true },
	{ id: "P11", title: "问题上报与清除", checked: true },
	{ id: "P12", title: "问题的私聊与恢复句", checked: true },
	{ id: "P13", title: "读设置", checked: true },
	{ id: "P14", title: "设置坏着开机", checked: true },
	{ id: "P15", title: "健康与 status", checked: true },
	{ id: "P16", title: "登录口", checked: true },
	{ id: "P17", title: "state / secrets", checked: true },
	// 停后 `reportPost` 不入队这一半 e2e 里看不到(作品入口先于集成上下文收尾就已关掉,摘掉守卫也观察不到差别),
	// 由单测钉着:`subscriptions/__tests__/source-context.test.ts` 的「dispose 之后:回调不再叫、监听摘掉、reportPost 不入队并记 error、再登记回调也不会被叫」
	// 与 `subscriptions/__tests__/builtin-sources.test.ts` 的「撤销把手:先 stop 来源,再收上下文(收上下文之后再上报会被丢)」。
	{ id: "P18", title: "关停次序", checked: true },
	{ id: "P19", title: "会员体系读口", checked: true },
	{ id: "P20", title: "日志等级与没碰 B 站", checked: true },
	{ id: "P21", title: "status 的「登录」行、login [来源]", checked: true },
	{ id: "P22", title: "链接解析器的登记、认领与来源停下时自动撤", checked: true },
	{ id: "P23", title: "外部 id 的格式", checked: true },
	{ id: "P24", title: "日志按值打码:ctx.redact 与 secrets 里的值", checked: true },
	{ id: "P25", title: "女仆订阅视图里的平台名与 creator", checked: true },
	{ id: "P26", title: "searchCreators 经女仆的搜人工具", checked: true },
	{
		id: "P27",
		title:
			"ctx.http / fetchImage / storeImage:作品带图(存的配图与头像进卡片)、抓图拦内网、请求不拦内网",
		checked: true,
	},
	{
		id: "P28",
		title: "看图从图库引用:只有图库引用、没有地址的配图,喂给 AI 的是这张图的 data URL",
		checked: true,
	},
	{
		id: "P29",
		title:
			"reportLive:开播、状态、下播进场次,推开播与下播卡,断流接续同一场,在播列表里恰好一行(按订阅 id 认)",
		checked: true,
	},
	{
		id: "P30",
		title:
			"fetchLiveStatus:按开播时刻起算的周期卡、周期关着只核不推、发现已下播走下播且时长算到发现那刻、取不到跳过不停(问题由来源自己报)、订阅开始监听时认出已在播的一场并补报",
		checked: true,
	},
	{
		id: "P31",
		title: "特别弹幕与特别进场:名单按 viewer.id、开关与名单都要",
		checked: true,
	},
	{
		id: "P32",
		title: "醒目留言:非人民币过门槛、卡按档取色、头像懒取一次、出不了卡退成一句",
		checked: true,
	},
	{
		id: "P33",
		title: "会员:custom 体系、按体系的 minRank、声明档带徽章与按档换色、自定义文案的 {tier}",
		checked: true,
	},
	{
		id: "P34",
		title: "下播回顾:词云卡、模板总结(够人数才有)、AI 版按目标挑",
		checked: true,
	},
	{
		id: "P35",
		title:
			"模板变量 {tier}、{fanclub}、{time}、{follower}、{follower_change}、{watched} 由假来源交得出",
		checked: true,
	},
	{
		id: "P36",
		title:
			"live-session-changed、live-viewers-changed 按订阅 id、WS 帧与在播列表里没有 uid / roomId",
		checked: true,
	},
	{
		id: "P37",
		title:
			"get_creator_profile 对没订阅的人回落调 fetchProfile:identity 原样递给来源、名字粉丝简介喂回模型;订阅着且有缓存的不问来源;来源回失败,话原样喂回",
		checked: true,
	},
	{
		id: "P38",
		title:
			"身份标签:没资料名的订阅,女仆订阅视图里的名字是「平台名 · 外部 id」;描述符声明了 externalIdNoun 就是「叫法 外部 id」",
		checked: true,
	},
	{
		id: "P39",
		title:
			"资料刷新:核心按 cron 调 fetchProfile,名字、头像(图库引用)、简介、粉丝数、粉丝团名进资料缓存;not_found 记成关于那条订阅的 creator_not_found、下一次成功清;开播卡上的名字跟着新资料",
		checked: true,
	},
	{
		id: "P40",
		title:
			"followers-refreshed:WS 帧与 GET /api/stats/followers 的条目带 identity,整个帧与整个回应里没有 uid / extensionId",
		checked: true,
	},
	{
		id: "P41",
		title:
			"get_creator_posts、get_creator_stats、get_live_status 对假来源的订阅按 creator 答得出:作品、统计、在播都读自核心手里按订阅 id 记的东西,话里是夹具里写死的内容",
		checked: true,
	},
	{
		id: "P42",
		title:
			"来源登记的只读 AI 工具以命名空间加全名挂给模型,执行结果喂回且带标签;撤销后请求里没有、调用记未知工具",
		checked: true,
	},
	{
		id: "P43",
		title: "提供方技能经列表、聊天目录与斜杠点名可见，撤销登记后三处都拿不到",
		checked: true,
	},
	{ id: "P44", title: "提示词里的叫法", checked: true },
	{
		id: "P45",
		title:
			"统计「在记」由核心算：在册来源登录着，这个小时按每条订阅的开关记作品 / 直播；没登录、停用、作品开关关着、没人认领的键不记",
		checked: true,
	},
	{
		id: "P46",
		title: "文字模板跟随默认：没改过的不落盘、读时取出厂；改过的照存；删键回到默认；换语言不写盘",
		checked: true,
	},
	{
		id: "P47",
		title:
			"reportProfile：名字、头像（图库引用）、简介、粉丝数、粉丝团名进资料缓存；停用的不收；粉丝样本按刷新间隔稀释；面板那一行当场跟着变",
		checked: true,
	},
	{
		id: "P48",
		title: "按订阅的皮肤：假来源作品出图用这条订阅指的皮肤与旋钮，不是全局当前那套",
		checked: true,
	},
	{
		id: "P49",
		title:
			"过滤与点评共用 postText：假来源作品的正文 / 标题 / 视频标题 / 转发原文，过滤吃得到非正文段，AI 输入带齐同一组字段",
		checked: true,
	},
	{
		id: "P50",
		title:
			"来源表：假来源的描述符经 /api/sources 原样下发（会员体系除外），has 按它实现的可选成员推；B 站并排在表里",
		checked: true,
	},
	{
		id: "P51",
		title:
			"卡片预览走来源：挑一条假来源订阅预览作品与直播，假来源交的作品与详情经出卡器画成卡；它回失败时出示例卡、原话进 sampleReason",
		checked: true,
	},
	{
		id: "P52",
		title:
			"经接口搜人与新建订阅：搜人口把 q 原样交给假来源、候选照回、失败码原样；挑中的候选经接口建成订阅（门问登记表），资料由候选种",
		checked: true,
	},
	{
		id: "N09",
		title: "规则节按描述符露出(featureHints、supportedExtras)",
		checked: false,
		waitsFor: "第 4 期",
		reason:
			"服务端描述符与提示经 P50 下发；面板能力由 Rules.extension-subs / section-scope、提示覆盖由 UpDialog.extension 组件测试管着（4-26/27），不记为进程内渲染对拍；4-27 统筹真页11组通过，含提示与能力的详情操作，规则页仅全局冒烟，按来源节显隐仍由上述组件测试负责",
	},
	{
		id: "N14",
		title: "订阅、历史、统计、概览四个页面的清单",
		checked: false,
		waitsFor: "第 4 期",
		reason: "面板不在进程内对拍的范围,页面按描述画是第 4 期",
	},
	{
		id: "P53",
		title:
			"宿主运行态与健康详情:假来源运行中,问题叠橙灯,摘要读取失败不改启动结论;失败与拓展八档另由登记表和路由测试钉住",
		checked: true,
	},
	{ id: "P54", title: "共同timezone现读、独立去重与撤订", checked: true },
	// N08(默认文案)在 3b-12 落成了,转进对拍的 P46(「默认文案有更新」是面板算的、与来源无关,由面板测试钉,不在对拍里);
	// N16(统计「在记」)在 3b-26 落成了,转进对拍的 P45;
	// N12(作品带图)在 3b-39 落成了,转进对拍的 P27;
	// N02(fetchProfile)与 N13(followers-refreshed)在 3b-24 落成了,转进对拍的 P39、P40;
	// N17(status 的「登录」行、login [来源])在 3b-06 落成了,转进对拍的 P21;N07(LinkResolver)在 3b-28 落成了,转进 P22;
	// 编号不回填;N18(女仆订阅视图里的平台名)在 3b-33 落成了,转进对拍的 P25(P24 留给 3b-38)。
];

/**
 * 成员棘轮(类型层):接口上每个成员都要在这里说「哪几行对拍管着它」。
 * 给 `Source` / `SourceContext` / `SourceDescriptor` / `SourceAuth` 加一个成员,下面四张表的 `satisfies Record<keyof …>`
 * 就类型检查过不去 —— 必须来补一行,而且只能指向对拍(`checked: true`)的行:指向「不开」的行,
 * 末尾「成员棘轮」那条用例会红。新成员没有对拍管着,就先补对拍的行再加成员。
 */
type RowId = `P${number}` | `N${number}`;
const SOURCE_MEMBERS = {
	descriptor: ["P10", "P15", "P19", "P50"],
	health: ["P15"],
	start: ["P01"],
	stop: ["P18"],
	auth: ["P16"],
	searchCreators: ["P26", "P52"],
	fetchProfile: ["P37", "P39"],
	fetchLiveStatus: ["P30", "P36"],
	liveInteractions: ["P32", "P33"],
	fetchPreview: ["P51"],
} as const satisfies Record<keyof Source, readonly RowId[]>;
const SOURCE_CONTEXT_MEMBERS = {
	timezone: ["P54"],
	onTimezoneChanged: ["P54"],
	logger: ["P20"],
	signal: ["P18"],
	onDispose: ["P18"],
	state: ["P17"],
	secrets: ["P17"],
	redact: ["P24"],
	settings: ["P13", "P14"],
	http: ["P27"],
	fetchImage: ["P27"],
	storeImage: ["P27"],
	subscriptions: ["P02"],
	onSubscriptionsChanged: ["P03"],
	reportPost: ["P04"],
	reportLive: ["P29", "P36"],
	reportLiveInteraction: ["P31", "P32", "P33"],
	reportProblem: ["P11"],
	resolveProblem: ["P11"],
	registerLinkResolver: ["P22"],
	registerAiToolProvider: ["P42"],
	reportProfile: ["P47"],
} as const satisfies Record<keyof SourceContext, readonly RowId[]>;
const SOURCE_DESCRIPTOR_MEMBERS = {
	label: ["P15"],
	postNoun: ["P10"],
	creatorNoun: ["P44"],
	externalIdRegex: ["P23"],
	membershipPrograms: ["P19"],
	externalIdNoun: ["P38"],
	shortLabel: ["P50"],
	color: ["P50"],
	colorByExternalId: ["P50"],
	icon: ["P50"],
	searchAccepts: ["P50"],
	supportedFeatures: ["P50"],
	supportedExtras: ["P50"],
	featureHints: ["P50"],
} as const satisfies Record<keyof SourceDescriptor, readonly RowId[]>;
const SOURCE_AUTH_MEMBERS = {
	beginLogin: ["P16"],
	logout: ["P16"],
	state: ["P16"],
	account: ["P16"],
	onChange: ["P16"],
} as const satisfies Record<keyof SourceAuth, readonly RowId[]>;

/** 这份文件实际驱动过的行(每条对拍用例结束时登记),末尾的用例拿它对 `PARITY_ROWS`。 */
const drivenInThisRun = new Set<string>();
const drove = (id: string): void => {
	drivenInThisRun.add(id);
};

// ---------------------------------------------------------------------------
// 共用的小件
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

/** 一条订阅的 id(`a1…-NN`)。 */
const subId = (n: number): string =>
	`a1000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const SUB = {
	alice: subId(1),
	bob: subId(2),
	carol: subId(3),
	dave: subId(4),
	erin1: subId(5),
	erin2: subId(6),
	frank: subId(7),
} as const;
/** 外部 id。 */
const EXT = {
	alice: "alice-ext",
	bob: "bob-ext",
	carol: "carol-ext",
	dave: "dave-ext",
	erin: "erin-ext",
	frank: "frank-ext",
} as const;
/** alice 特别关注名单上的那位观众的 id(P31)。 */
const SPECIAL_VIEWER = "7001";
/** 没人认领的另一个键(名单里不该出现它名下的人)。 */
const OTHER_KEY = "other.nobody";

const ID = {
	connection: "a1000000-0000-4000-8000-00000000c001",
	master: "a1000000-0000-4000-8000-0000000000a1",
	group: "a1000000-0000-4000-8000-0000000000a2",
} as const;
const MASTER_USER = "10001";
const GROUP_ADDRESS = "88888";
const AI_REPLY = "测试女仆的点评一句话";
const ALICE_PROFILE_NAME = "爱丽丝资料名";
const ALICE_FAN_CLUB_NAME = "爱丽丝资料粉丝团";
/** alice 的那份资料:既写进存好的缓存,也是假来源被问到她时回的那一份(同一份出处)。 */
const ALICE_PROFILE = {
	name: ALICE_PROFILE_NAME,
	followers: 12_345,
	fanClubName: ALICE_FAN_CLUB_NAME,
};
const HOUR_MS = 3_600_000;

/** 一条纯文字作品。 */
function textReport(
	postId: string,
	creator: string,
	text: string,
	extra: Partial<Post> = {},
): PostReport {
	return {
		postId,
		url: `https://acme.invalid/post/${postId}`,
		post: { creator: { name: creator }, publishedAt: "2026-10-01T08:00:00.000Z", text, ...extra },
	};
}

describe("进程内对拍:假来源与 B 站并排在册,走同一条登记路", () => {
	let dataDir: string;
	/** 开机之后在用的那一代的目录。 */
	let generation: string;
	let handle: ServerHandle | undefined;
	let port: number;
	let aiServer: Server;
	let aiBaseUrl: string;
	/** 假模型服务收到的每一问(用户那句)。 */
	const aiAsked: string[] = [];
	/** 每一条假模型请求里收到的工具名,按请求先后。 */
	const aiRequestedToolNames: string[][] = [];
	/** 最近一问里 `load_skill` 的目录;P43 用它证明提供方技能进了模型自选清单。 */
	let aiLoadSkillCatalog: { description: string; names: string[] } | undefined;
	/** 最近一问里的 system 正文;P43 用它证明斜杠点名把技能正文交给了模型。 */
	let aiLastSystem = "";
	/**
	 * 要假模型先调一把工具(只在带着工具表、末条是用户话的那一问上调,调一次就清);
	 * 调完工具之后喂回来的 `tool` 消息正文记进 {@link aiToolSeen}。
	 */
	let aiToolScript: { name: string; args: object } | null = null;
	const aiToolSeen: string[] = [];
	/** 每一条假模型请求里收到的系统提示词,按请求先后。 */
	const aiSystems: string[] = [];

	const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
	const json = (body: unknown, method = "POST"): RequestInit => ({
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	async function okRes(res: Response): Promise<Response> {
		expect(res.status, await res.clone().text()).toBeLessThan(300);
		return res;
	}
	const patchSettings = async (body: unknown) =>
		okRes(await api("/api/settings", json(body, "PATCH")));
	/** 改核心设置(挂在 `core` 下);集成的设置挂在各自的键下,走上面那个。 */
	const patchCore = (core: unknown) => patchSettings({ core });

	async function captures(): Promise<DevCapturedDelivery[]> {
		const res = await okRes(await api("/api/dev/captures"));
		return ((await res.json()) as { entries: DevCapturedDelivery[] }).entries;
	}
	async function clearCaptures(): Promise<void> {
		await okRes(await api("/api/dev/captures/clear", { method: "POST" }));
	}
	/** 等截流记录到至少 `n` 条,再多等一会儿(要是重复发了,多出来的会在这段时间里到),最后回全部。 */
	async function settledCaptures(n: number): Promise<DevCapturedDelivery[]> {
		await vi.waitFor(async () => expect((await captures()).length).toBeGreaterThanOrEqual(n), {
			timeout: 10_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		return captures();
	}
	async function history(): Promise<HistoryEntryView[]> {
		const res = await okRes(await api("/api/history?limit=500"));
		return ((await res.json()) as HistoryResponse).entries;
	}
	/** 一条订阅某一类直播推送推了几次(同一次推送落几行都算一次,按 pushId 数)。 */
	async function livePushCount(
		subscriptionId: string,
		feature: HistoryEntryView["feature"],
	): Promise<number> {
		return new Set(
			(await history())
				.filter((row) => row.subscriptionId === subscriptionId && row.feature === feature)
				.map((row) => row.pushId),
		).size;
	}
	async function problems() {
		const res = await okRes(await api("/api/problems"));
		return ((await res.json()) as ProblemsResponse).problems;
	}
	async function overview() {
		const res = await okRes(await api("/api/stats/overview?days=7&tz=0"));
		return ((await res.json()) as StatsOverviewResponse).rows;
	}

	const aiSettings = (base: ReturnType<typeof makeDefaultGlobalConfig>["ai"]) => ({
		...base,
		activeProfile: "fake",
		providers: {
			fake: {
				provider: "deepseek" as const,
				apiFlavor: "chat",
				label: "",
				apiKey: "sk-fake",
				baseUrl: aiBaseUrl,
				model: "fake-model",
				enableThinking: false,
				thinkingLevel: "medium" as const,
				extraParams: "",
				enableVision: false,
				vision: { baseUrl: "", apiKey: "", model: "" },
			},
		},
	});

	/**
	 * 开一场新对话,让假模型先调一把工具再说话,回喂给模型的 `tool` 消息正文(`seen`)与痕迹里的工具行(`tools`)。
	 * 回的是 SSE,读到底就是整轮(调工具 → 喂回 → 正文)走完了。AI 开关只在这一问里开着。
	 */
	async function askMaid(script: { name: string; args: object }): Promise<{
		seen: string;
		tools: Array<{ name: string; ok: boolean; label?: string; message?: string }>;
		requestedTools: string[][];
	}> {
		await patchCore({ ai: { enabled: true } });
		try {
			const created = await okRes(await api("/api/ai/conversations", json({})));
			const { conversation } = (await created.json()) as { conversation: { id: string } };
			aiToolSeen.length = 0;
			aiRequestedToolNames.length = 0;
			aiLoadSkillCatalog = undefined;
			aiLastSystem = "";
			aiToolScript = script;
			const sse = await (
				await okRes(
					await api(`/api/ai/conversations/${conversation.id}/chat`, json({ message: "问一句" })),
				)
			).text();
			const done = /event: done\ndata: (.*)\n/.exec(sse)?.[1];
			const reply = done
				? (
						JSON.parse(done) as {
							reply?: {
								tools?: Array<{
									name: string;
									ok: boolean;
									label?: string;
									message?: string;
								}>;
							};
						}
					).reply
				: undefined;
			return {
				seen: aiToolSeen.join("\n"),
				tools: reply?.tools ?? [],
				requestedTools: aiRequestedToolNames.map((names) => [...names]),
			};
		} finally {
			aiToolScript = null;
			await patchCore({ ai: { enabled: false } });
		}
	}

	const boot = (listenPort: number, env: Record<string, string> = {}) =>
		startServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(listenPort),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1", ...env },
		});

	beforeAll(async () => {
		resetInProcessWorld();
		// —— 假模型服务:OpenAI 兼容的最小回应,只听回环地址。
		aiServer = createHttpServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				const parsed = JSON.parse(body || "{}") as {
					messages?: { role?: string; content?: unknown }[];
					tools?: Array<{
						function?: {
							name?: string;
							description?: string;
							parameters?: { properties?: { name?: { enum?: string[] } } };
						};
					}>;
					stream?: boolean;
				};
				const messages = parsed.messages;
				aiAsked.push(JSON.stringify(messages?.at(-1)?.content ?? ""));
				aiLastSystem = (messages ?? [])
					.filter((message) => message.role === "system")
					.map((message) => JSON.stringify(message.content))
					.join("\n");
				aiSystems.push(
					JSON.stringify(messages?.find((message) => message.role === "system")?.content ?? ""),
				);
				aiRequestedToolNames.push(
					(parsed.tools ?? []).flatMap((tool) =>
						typeof tool.function?.name === "string" ? [tool.function.name] : [],
					),
				);
				const loadSkill = parsed.tools?.find(
					(tool) => tool.function?.name === "load_skill",
				)?.function;
				aiLoadSkillCatalog =
					loadSkill === undefined
						? undefined
						: {
								description: loadSkill.description ?? "",
								names: loadSkill.parameters?.properties?.name?.enum ?? [],
							};
				const last = messages?.at(-1);
				const callsTool = aiToolScript !== null && last?.role === "user" && !!parsed.tools?.length;
				if (last?.role === "tool") aiToolSeen.push(String(last.content));
				// 聊天口先发流式一问:流式要回 SSE,不然 SDK 读不出东西。
				if (parsed.stream) {
					const chunk = (delta: object, finish: string | null) =>
						`data: ${JSON.stringify({
							id: "chatcmpl-fake",
							object: "chat.completion.chunk",
							created: 0,
							model: "fake-model",
							choices: [{ index: 0, delta, finish_reason: finish }],
						})}\n\n`;
					const script = callsTool ? aiToolScript : null;
					if (script) aiToolScript = null;
					const frames = script
						? [
								chunk(
									{
										role: "assistant",
										tool_calls: [
											{
												index: 0,
												id: "call_1",
												type: "function",
												function: { name: script.name, arguments: JSON.stringify(script.args) },
											},
										],
									},
									null,
								),
								chunk({}, "tool_calls"),
							]
						: [chunk({ role: "assistant", content: AI_REPLY }, null), chunk({}, "stop")];
					res
						.writeHead(200, { "content-type": "text/event-stream" })
						.end(`${frames.join("")}data: [DONE]\n\n`);
					return;
				}
				res.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify({
						id: "chatcmpl-fake",
						object: "chat.completion",
						created: 0,
						model: "fake-model",
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: AI_REPLY },
								finish_reason: "stop",
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}),
				);
			});
		});
		await new Promise<void>((resolve) => aiServer.listen(0, "127.0.0.1", resolve));
		const aiAddress = aiServer.address();
		if (!aiAddress || typeof aiAddress === "string") throw new Error("假模型服务没起来");
		aiBaseUrl = `http://127.0.0.1:${aiAddress.port}/v1`;

		dataDir = await mkdtemp(join(tmpdir(), "bn-in-process-parity-e2e-"));

		// —— 先空启动一趟:建连接、目标、主人、AI 的服务商(关着);订阅要开机就在(场景从开机那一刻算),
		// 所以关掉之后往在用的那一代里直接摆订阅文件,再起第二趟。经接口搜人与新建订阅另在 P52 验。
		const seedPort = await findFreePort();
		const seed = await boot(seedPort);
		const seedApi = (path: string, init?: RequestInit) =>
			fetch(`http://127.0.0.1:${seedPort}${path}`, init);
		await okRes(
			await seedApi(
				"/api/connections",
				json({
					id: ID.connection,
					name: "本机回环 bot",
					enabled: true,
					adapterKey: "onebot",
					platform: "onebot",
					settings: {
						transport: "http",
						baseUrl: `http://127.0.0.1:${await findFreePort()}`,
						maxRetries: 0,
						retryIntervalMs: 0,
					},
				}),
			),
		);
		for (const [id, name, scope, address] of [
			[ID.master, "主人", "private", MASTER_USER],
			[ID.group, "测试群", "group", GROUP_ADDRESS],
		] as const) {
			await okRes(
				await seedApi(
					"/api/targets",
					json({
						id,
						name,
						connectionId: ID.connection,
						kind: "session",
						scope,
						address,
						enabled: true,
					}),
				),
			);
		}
		await okRes(
			await seedApi(
				"/api/settings",
				json(
					{
						core: {
							master: { targetId: ID.master },
							ai: { ...aiSettings(makeDefaultGlobalConfig().ai), enabled: false },
						},
					},
					"PATCH",
				),
			),
		);
		await seed.close("seed");

		const sub = (
			id: string,
			externalId: string,
			opts: Partial<Parameters<typeof makeExtensionSubscription>[0]> = {},
		) => {
			const base = makeExtensionSubscription({
				id,
				extensionId: IN_PROCESS_KEY,
				externalId,
				enabled: true,
				...opts,
			});
			return { ...base, routing: { ...base.routing, post: [ID.group] } };
		};
		generation = await activeGeneration(dataDir);
		await writeFile(
			join(generation, "config", "subscriptions.json"),
			subscriptionsFileText([
				// alice 还路由了开播与下播(P29)、特别弹幕与特别进场(P31)、醒目留言(P32)、会员(P33),别人只路由作品。
				// 特别关注名单上有一位 7001,两样都带;特性开关出厂是关的,P31 自己开关。
				{
					...sub(SUB.alice, EXT.alice),
					routing: {
						...sub(SUB.alice, EXT.alice).routing,
						liveStart: [ID.group],
						liveStreaming: [ID.group],
						liveEnd: [ID.group, ID.master],
						membership: [ID.group],
						superchat: [ID.group],
						viewerChat: [ID.group],
						viewerEnter: [ID.group],
					},
					specialViewers: [{ id: SPECIAL_VIEWER, features: ["viewerChat", "viewerEnter"] }],
				},
				// 作品开关关着:在名单里,但 features 里没有 post。
				{ ...sub(SUB.bob, EXT.bob), overrides: { features: { post: false } } },
				// 停用的、另一个没人认领的键名下的:都不在名单里。
				// carol 路由了开播(P30 里启用它,补报的「正在直播」卡走开播的目标)。
				{
					...sub(SUB.carol, EXT.carol, { enabled: false }),
					routing: { ...sub(SUB.carol, EXT.carol).routing, liveStart: [ID.group] },
				},
				sub(SUB.dave, EXT.dave, { extensionId: OTHER_KEY }),
				// 同一个人遗留的两条重复订阅。
				sub(SUB.erin1, EXT.erin),
				sub(SUB.erin2, EXT.erin),
				// frank 路由了开播、正在直播与下播(P30 的周期卡与下播卡)。
				{
					...sub(SUB.frank, EXT.frank),
					routing: {
						...sub(SUB.frank, EXT.frank).routing,
						liveStart: [ID.group],
						liveStreaming: [ID.group],
						liveEnd: [ID.group],
					},
				},
			]),
		);

		// alice 有存好的资料名(历史行的名字快照取它);别人没有。
		await mkdir(join(generation, "runtime"), { recursive: true });
		await writeFile(
			join(generation, "runtime", "subscription-state.json"),
			JSON.stringify({
				[SUB.alice]: {
					cachedProfile: {
						name: ALICE_PROFILE.name,
						followers: ALICE_PROFILE.followers,
						refreshedAt: new Date().toISOString(),
						fanClubName: ALICE_PROFILE.fanClubName,
					},
				},
			}),
		);

		resetInProcessWorld({
			creatorNoun: "博主",
			knownProfiles: { [EXT.alice]: ALICE_PROFILE },
		});
		port = await findFreePort();
		// 配了浏览器才有出卡的渲染器;真正起来的是上面那个假浏览器。
		handle = await boot(port, { BN_CHROME_PATH: "/fake/chrome" });
		// 开截流:此后所有往外发的都被拦在派发器调适配器 `send` 的那一处,不出网。
		await okRes(await api("/api/dev/run/core.push.capture", json({ params: {} })));
	}, 60_000);

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await new Promise<void>((resolve) => aiServer.close(() => resolve()));
		await rm(dataDir, { recursive: true, force: true });
	});

	it("P01 登记即启动:start 恰好一次;假来源的登录口在册;B 站并排在册", async () => {
		const probe = currentProbe();
		expect(probe.starts).toBe(1);
		expect(probe.ctx).toBeDefined();
		const own = await api(`/api/sources/${IN_PROCESS_KEY}/auth`);
		expect(own.status).toBe(200);
		expect(await own.json()).toEqual({ state: { status: "logged-out" } });
		// 并排在册的 B 站:它的登录口同样问得到(不回 unavailable),而且登记即 start 落定时登录已经恢复完
		// (测试数据目录里没有 cookie:是「未登录」,不是还在「确认中」)。
		const bili = await api("/api/sources/bilibili/auth");
		expect(bili.status).toBe(200);
		expect(await bili.json()).toEqual({ state: { status: "logged-out" } });
		// Accounts must aggregate both registered sources through the same neutral read port.
		const accounts = await api("/api/accounts");
		expect(accounts.status).toBe(200);
		expect(await accounts.json()).toEqual({
			accounts: [
				{ sourceKey: "bilibili", state: { status: "logged-out" } },
				{ sourceKey: IN_PROCESS_KEY, state: { status: "logged-out" } },
			],
		});
		drove("P01");
	});

	// 验红:`routes/sources.ts` 的 `hasOf` 把 `liveStatus` 写死成 false,这条红;列登记表那一段整个跳过,这条也红。
	it("P50 来源表:假来源的完整描述符经 /api/sources 下发,has 按它实现的可选成员推;B 站并排在表里", async () => {
		const res = await api("/api/sources");
		expect(res.status).toBe(200);
		const { sources } = (await res.json()) as SourcesResponse;
		const declared = currentProbe().descriptor;
		expect(sources.find((one) => one.key === IN_PROCESS_KEY)?.descriptor.featureHints).toEqual({
			post: "Probe post hint",
			liveEnd: "Probe end hint",
		});
		expect(sources.find((one) => one.key === IN_PROCESS_KEY)).toEqual({
			key: IN_PROCESS_KEY,
			status: "running",
			descriptor: declared,
			// 假来源实现了登录口、查直播状态与卡片页的真实预览。
			has: { auth: true, liveStatus: true, preview: true },
		});
		expect(sources.find((one) => one.key === "bilibili")?.descriptor.label).toBe("B 站");
		expect(sources.find((one) => one.key === "bilibili")?.descriptor.colorByExternalId).toBe(true);
		drove("P50");
	});

	it("P53 宿主运行态与健康详情:来源运行中,问题叠橙灯,摘要读取失败不改启动结论", async () => {
		const probe = currentProbe();
		const read = async () => {
			const body = (await (await api("/api/health/details")).json()) as {
				integrations: Array<{
					key: string;
					status: string;
					light: string;
					health?: unknown;
					problemCount: number;
				}>;
			};
			return body.integrations.find((entry) => entry.key === IN_PROCESS_KEY);
		};
		const sources = (await (await api("/api/sources")).json()) as SourcesResponse;
		expect(sources.sources.find((entry) => entry.key === IN_PROCESS_KEY)?.status).toBe("running");
		const before = (await read())?.problemCount ?? 0;
		probe.ctx?.reportProblem({ code: "health_parity", message: "health parity issue" });
		try {
			expect(await read()).toMatchObject({
				status: "running",
				light: "orange",
				problemCount: before + 1,
			});
			probe.healthThrows = true;
			expect(await read()).toMatchObject({
				status: "running",
				light: "orange",
				health: { ok: false, code: "unavailable" },
			});
		} finally {
			probe.healthThrows = false;
			probe.ctx?.resolveProblem({ code: "health_parity", notify: false });
		}
		expect((await read())?.problemCount).toBe(before);
		drove("P53");
	});

	it("P54 共同timezone现读、独立去重与撤订", async () => {
		const ctx = currentProbe().ctx;
		expect(ctx).toBeDefined();
		if (!ctx) throw new Error("source context missing");
		const before = ctx.timezone();
		await patchCore({ timezone: "Asia/Shanghai" });
		const seen: string[] = [];
		const claim = ctx.onTimezoneChanged(() => seen.push(ctx.timezone()));
		try {
			expect(seen).toEqual([]);
			await patchCore({ timezone: "UTC" });
			expect(ctx.timezone()).toBe("UTC");
			await patchCore({ timezone: "UTC" });
			await patchCore({ timezone: "Asia/Kathmandu" });
			expect(seen).toEqual(["UTC", "Asia/Kathmandu"]);
			claim.dispose();
			claim.dispose();
			await patchCore({ timezone: "Asia/Shanghai" });
			expect(seen).toEqual(["UTC", "Asia/Kathmandu"]);
		} finally {
			claim.dispose();
			await patchCore({ timezone: before });
		}
		drove("P54");
	});

	// 验红:`routes/cards.ts` 不问来源(或不把 nth 交过去),第一段红;来源回失败时不记原因,第三段红。
	it("P51 卡片预览走来源:挑一条假来源订阅,作品按 nth 问它、直播问它,交的数据经出卡器画成卡;它回失败时出示例卡、原话进 sampleReason", async () => {
		const probe = currentProbe();
		const preview = async (body: unknown) => {
			const res = await api("/api/cards/preview", json(body));
			expect(res.status).toBe(200);
			return (await res.json()) as { ok: boolean; dataUrl?: string; sampleReason?: string };
		};
		probe.previewOutcome = undefined;
		probe.previewAsked.length = 0;

		let before = renderedHtml.length;
		const post = await preview({
			kind: "post",
			style: {},
			content: { subscriptionId: SUB.alice, nth: 2 },
		});
		expect(post).toMatchObject({ ok: true });
		expect(post).not.toHaveProperty("sampleReason");
		expect(probe.previewAsked.at(-1)).toEqual({
			externalId: EXT.alice,
			options: { kind: "post", nth: 2 },
		});
		expect(renderedHtml.slice(before).some((page) => page.includes("对拍预览正文P51 第2条"))).toBe(
			true,
		);

		before = renderedHtml.length;
		await preview({ kind: "live", style: {}, content: { subscriptionId: SUB.alice } });
		expect(probe.previewAsked.at(-1)).toEqual({ externalId: EXT.alice, options: { kind: "live" } });
		expect(renderedHtml.slice(before).some((page) => page.includes("对拍预览直播P51"))).toBe(true);

		probe.previewOutcome = fail("unavailable", "对拍源这一次预览取不到");
		try {
			const sample = await preview({
				kind: "post",
				style: {},
				content: { subscriptionId: SUB.alice },
			});
			expect(sample).toMatchObject({ ok: true, sampleReason: "对拍源这一次预览取不到" });
		} finally {
			probe.previewOutcome = undefined;
		}
		drove("P51");
	});

	/** 名单(现读的)折成「外部 id → 作品开关开没开」,按外部 id 排。 */
	const rosterPostFlags = (roster: ReturnType<SourceContext["subscriptions"]> | undefined) =>
		(roster ?? [])
			.map((view) => [view.externalId, view.features.has("post")] as const)
			.sort(([a], [b]) => a.localeCompare(b));

	// 验红:`source-subscriptions.ts` 里把 `sourceKey` 那一道筛去掉(别人的、没人认领的键名下的也混进来),这条红。
	it("P02 名单:恰好是假键名下启用着的人,features 是折好的;停用的、别的键名下的不在;重复订阅合成一条", async () => {
		const probe = currentProbe();
		// 名单是 start 的那一刻现读的:alice、erin(两条重复合成一条)、frank 开着作品,bob 的作品开关关着;
		// carol(停用)与 dave(别的键)不在。
		expect(rosterPostFlags(probe.rosterAtStart)).toEqual([
			[EXT.alice, true],
			[EXT.bob, false],
			[EXT.erin, true],
			[EXT.frank, true],
		]);
		// 此刻现读与 start 时一致(不缓存、不串键)。
		expect(rosterPostFlags(probe.ctx?.subscriptions())).toEqual(
			rosterPostFlags(probe.rosterAtStart),
		);
		drove("P02");
	});

	// 验红:`source-context.ts` 里摘掉 `config-changed` 那一路,第二段红;摘掉 `subscription-changed` 那一路,第一段红。
	it("P03 名单变了的两路:停用一条订阅、翻全局作品开关,回调各被叫一次、回调里现读的名单各自对", async () => {
		const probe = currentProbe();
		probe.rosterChanges.length = 0;

		// 一路:经真路由停用 frank。
		try {
			await okRes(await api(`/api/subscriptions/${SUB.frank}`, json({ enabled: false }, "PATCH")));
			await vi.waitFor(() => expect(probe.rosterChanges.length).toBeGreaterThanOrEqual(1));
			expect(rosterPostFlags(probe.rosterChanges.at(-1))).toEqual([
				[EXT.alice, true],
				[EXT.bob, false],
				[EXT.erin, true],
			]);
		} finally {
			await okRes(await api(`/api/subscriptions/${SUB.frank}`, json({ enabled: true }, "PATCH")));
		}

		// 另一路:翻全局默认的作品开关(各人的 features 跟着折)。
		probe.rosterChanges.length = 0;
		try {
			await patchCore({ defaults: { features: { post: false } } });
			await vi.waitFor(() => expect(probe.rosterChanges.length).toBeGreaterThanOrEqual(1));
			expect(rosterPostFlags(probe.rosterChanges.at(-1))).toEqual([
				[EXT.alice, false],
				[EXT.bob, false],
				[EXT.erin, false],
				[EXT.frank, false],
			]);
		} finally {
			await patchCore({ defaults: { features: { post: true } } });
		}
		await vi.waitFor(() =>
			expect(rosterPostFlags(probe.rosterChanges.at(-1))).toEqual([
				[EXT.alice, true],
				[EXT.bob, false],
				[EXT.erin, true],
				[EXT.frank, true],
			]),
		);
		drove("P03");
	});

	// 验红:`pipeline.ts` 的 `registerSource` 里不递 `enqueue`,这条红(没有任何作品到得了推送)。
	it("P04 作品到推送:报一条纯文字作品 → 截流记录恰好一条,目标是这条订阅路由的目标,正文是模板插值后的字、带链接", async () => {
		await clearCaptures();
		currentProbe().ctx?.reportPost(EXT.alice, textReport("p04", "小爱", "今天天气不错"));
		const entries = await settledCaptures(1);
		expect(entries).toHaveLength(1);
		const [hit] = entries;
		expect(hit).toMatchObject({
			targetId: ID.group,
			connectionId: ID.connection,
			private: false,
			kind: "composite",
		});
		// `{name}` 取 `post.creator.name`,`{postNoun}` 取来源声明的叫法(假来源不声明 → 缺省「作品」);
		// 链接是作品的 url,作为独立部件跟在后面。
		expect(hit?.text).toContain("小爱发布了一条作品");
		expect(hit?.text).toContain("https://acme.invalid/post/p04");
		drove("P04");
	});

	/** 盘上的核心设置(`core.json`,写盘是后台的,调用方自己 `waitFor`)。 */
	async function storedCore(): Promise<{
		locale?: unknown;
		defaults?: { templates?: Record<string, unknown> };
	}> {
		return JSON.parse(await readFile(join(generation, "config", "settings", "core.json"), "utf8"));
	}

	/** 盘上核心设置里 `defaults.templates` 的文字格。 */
	async function storedTemplates(): Promise<Record<string, unknown>> {
		return (await storedCore()).defaults?.templates ?? {};
	}

	// 验红:`resolveTemplates`(packages/internal)里不回落出厂,①③④ 三段红(推出去的不是出厂那句);
	// 设置写入那条路上换语言时把出厂文字写回盘,④ 的「盘上没有 post」红。
	it("P46 文字模板跟随默认:没改过的不落盘、读时取出厂;改过的照存;删键回到默认;换语言不写盘", async () => {
		const pushedText = async (tag: string) => {
			await clearCaptures();
			currentProbe().ctx?.reportPost(EXT.alice, textReport(tag, "小爱", "今天天气不错"));
			const [hit] = await settledCaptures(1);
			return hit?.text ?? "";
		};
		const factoryText = "小爱发布了一条作品"; // P04 钉过的出厂那句
		try {
			// ① 新装的盘上没有 post,推出去是出厂那句。
			expect(await storedTemplates()).not.toHaveProperty("post");
			expect(await pushedText("p46a")).toContain(factoryText);

			// ② 改过的照存,假来源没声明叫法 → `{postNoun}` 填「作品」。
			await patchCore({ defaults: { templates: { post: "自定义 {name} 的{postNoun}" } } });
			await vi.waitFor(async () =>
				expect(await storedTemplates()).toHaveProperty("post", "自定义 {name} 的{postNoun}"),
			);
			const custom = await pushedText("p46b");
			expect(custom).toContain("自定义 小爱 的作品");
			expect(custom).not.toContain(factoryText);

			// ③ 发 null 删键:盘上没了,回到出厂那句。
			await patchCore({ defaults: { templates: { post: null } } });
			await vi.waitFor(async () => expect(await storedTemplates()).not.toHaveProperty("post"));
			expect(await pushedText("p46c")).toContain(factoryText);

			// ④ 换语言不写盘:英文今天没有出厂文字、拿简体打底,盘上仍没有 post,推出去仍是出厂那句。
			await patchCore({ locale: "en" });
			// 等语言落了盘再看:语言与模板在同一份文件里一次写完,换语言时若顺手写了 post,此刻它也在。
			await vi.waitFor(async () => expect((await storedCore()).locale).toBe("en"));
			expect(await storedTemplates()).not.toHaveProperty("post");
			expect(await pushedText("p46d")).toContain(factoryText);
		} finally {
			await patchCore({ locale: null, defaults: { templates: { post: null } } });
		}
		drove("P46");
	});

	/** 某条订阅的统计作品行(`stats/posts/<订阅 id>.jsonl`,落盘是后台写的,调用方自己 `waitFor`)。 */
	async function statsPostRows(subscriptionId: string): Promise<Array<Record<string, unknown>>> {
		try {
			const text = await readFile(
				join(generation, "stats", "posts", `${subscriptionId}.jsonl`),
				"utf8",
			);
			return text
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
	}

	// 验红:`source-context.ts` 的 `reportPost` 改回只取 `subs[0]`,这条红(只推一份、历史一行)。
	it("P05 按身份展开:同一个人遗留的两条重复订阅,报一条 → 两条订阅各推一份、历史两行、统计各记一行", async () => {
		await clearCaptures();
		currentProbe().ctx?.reportPost(EXT.erin, textReport("p05", "艾琳", "重复订阅也各收一份"));
		const entries = await settledCaptures(2);
		expect(entries).toHaveLength(2);
		for (const hit of entries) expect(hit).toMatchObject({ targetId: ID.group, kind: "composite" });
		await vi.waitFor(async () => {
			const rows = (await history()).filter((row) => row.identity.externalId === EXT.erin);
			expect(rows.map((row) => row.subscriptionId).sort()).toEqual([SUB.erin1, SUB.erin2].sort());
			for (const row of rows) expect(row.status).toBe("delivered");
			for (const id of [SUB.erin1, SUB.erin2]) {
				expect((await statsPostRows(id)).map((row) => row.id)).toEqual(["p05"]);
			}
		});
		drove("P05");
	});

	// 验红:`image()` 接成恒 `undefined`(出图器没接上),卡片 HTML 一份都没有,这条红。
	it("P06 作品到卡片:五种片段、附加块、转发嵌套、只给两项的互动数 —— 都画进了送去出图的 HTML,缺的那项不出现", async () => {
		await clearCaptures();
		const before = renderedHtml.length;
		const richText = [
			{ kind: "text", text: "旅行第一天 " },
			{ kind: "mention", text: "@阿宇" },
			{ kind: "text", text: " 去了 " },
			{ kind: "topic", text: "#海边风景", name: "海边风景" },
			{ kind: "text", text: " 看 " },
			{ kind: "link", text: "网页链接", url: "https://acme.invalid/link" },
			{ kind: "text", text: " " },
			{ kind: "emoji", text: "[doge]" },
		] as const;
		currentProbe().ctx?.reportPost(
			EXT.alice,
			textReport("p06", "小爱", richText.map((s) => s.text).join(""), {
				richText: [...richText],
				attachment: { kind: "card", title: "附加块标题XYZ", lines: [{ text: "附加行一" }] },
				repost: {
					creator: { name: "原作者甲" },
					publishedAt: "2026-09-30T08:00:00.000Z",
					text: "被转发的原文内容",
				},
				// 互动数只给两项:转发数没给。
				stats: { likes: 7, comments: 3 },
			}),
		);
		const [hit] = await settledCaptures(1);
		// 推出去的是「卡 + 文案 + 链接」:截流记录里带一张图。
		expect(hit).toMatchObject({ kind: "composite", images: 1 });
		const html = renderedHtml.slice(before).find((page) => page.includes("旅行第一天"));
		expect(html, "这条作品没画成卡").toBeDefined();
		for (const word of [
			"旅行第一天",
			"@阿宇",
			"海边风景",
			"网页链接",
			"[doge]",
			"附加块标题XYZ",
			"附加行一",
			"原作者甲",
			"被转发的原文内容",
		]) {
			expect(html, word).toContain(word);
		}
		expect(html).toMatch(/aria-label="点赞"[\s\S]*?<span>7<\/span>/);
		expect(html).toMatch(/aria-label="评论"[\s\S]*?<span>3<\/span>/);
		// 没给的那项不画,也不会画成 undefined / 0。
		expect(html).not.toContain('aria-label="转发"');
		expect(html).not.toContain("undefined");
		drove("P06");
	});

	const NO_FILTERS = {
		blockReposts: false,
		blockArticles: false,
		blockImages: false,
		blockVideos: false,
		blockKeywords: [] as string[],
		blockRegex: [] as string[],
		allowKeywords: [] as string[],
		allowRegex: [] as string[],
	};
	const PLAIN_TEXT = "一句平常的话";
	const hiddenVideo = (title: string): Post["video"] => ({ cover: {}, title, description: "" });
	/** [用例名, 订阅上的过滤规则, 作品的补充格, 作品正文, 期望的原因, 期望的 postText(plain)] */
	const FILTER_CASES: ReadonlyArray<
		readonly [string, Partial<typeof NO_FILTERS>, Partial<Post>, string, string, string]
	> = [
		[
			"屏蔽词 × 正文",
			{ blockKeywords: ["红线甲"] },
			{},
			"正文里有红线甲",
			"blocked-keyword",
			"正文里有红线甲",
		],
		[
			"屏蔽词 × 视频标题",
			{ blockKeywords: ["红线乙"] },
			{ video: hiddenVideo("视频标题含红线乙") },
			PLAIN_TEXT,
			"blocked-keyword",
			`${PLAIN_TEXT}\n视频标题含红线乙`,
		],
		[
			"屏蔽词 × 文章标题",
			{ blockKeywords: ["红线丙"] },
			{ article: { title: "文章标题含红线丙" } },
			PLAIN_TEXT,
			"blocked-keyword",
			`${PLAIN_TEXT}\n文章标题含红线丙`,
		],
		[
			"屏蔽词 × 被转发的原作品",
			{ blockKeywords: ["红线丁"] },
			{
				repost: {
					creator: { name: "原作者" },
					publishedAt: "2026-09-30T08:00:00.000Z",
					text: "转发的原文含红线丁",
				},
			},
			PLAIN_TEXT,
			"blocked-keyword",
			`${PLAIN_TEXT}\n转发的原文含红线丁`,
		],
		[
			"屏蔽正则 × 正文",
			{ blockRegex: ["红线\\d+"] },
			{},
			"正文含红线42",
			"blocked-keyword",
			"正文含红线42",
		],
		[
			"白名单没命中",
			{ allowKeywords: ["通行证"] },
			{},
			PLAIN_TEXT,
			"allowlist-unmatched",
			PLAIN_TEXT,
		],
		[
			"屏蔽转发",
			{ blockReposts: true },
			{
				repost: {
					creator: { name: "原作者" },
					publishedAt: "2026-09-30T08:00:00.000Z",
					text: "被转发的字",
				},
			},
			PLAIN_TEXT,
			"blocked-reposts",
			`${PLAIN_TEXT}\n被转发的字`,
		],
		[
			"屏蔽专栏",
			{ blockArticles: true },
			{ article: { title: "一篇专栏" } },
			PLAIN_TEXT,
			"blocked-articles",
			`${PLAIN_TEXT}\n一篇专栏`,
		],
		["屏蔽图集", { blockImages: true }, { images: [{}] }, PLAIN_TEXT, "blocked-images", PLAIN_TEXT],
		[
			"屏蔽视频",
			{ blockVideos: true },
			{ video: hiddenVideo("一条视频") },
			PLAIN_TEXT,
			"blocked-videos",
			`${PLAIN_TEXT}\n一条视频`,
		],
	];

	// 验红:`deliver-post.ts` 里不调 `recordFiltered`,历史里等不到「已过滤」那一行,这组全红;
	// 把 `filterPost` 的调用整个摘掉,截流记录里多出推送,这组也红。
	it.each(FILTER_CASES)(
		"P07 过滤与留痕 · %s:不推、历史留一行已过滤(身份、原因、文字都对)",
		async (name, rules, extra, text, reason, plainText) => {
			await okRes(
				await api(
					`/api/subscriptions/${SUB.frank}`,
					json({ overrides: { filters: { ...NO_FILTERS, ...rules } } }, "PATCH"),
				),
			);
			await clearCaptures();
			const postId = `p07-${FILTER_CASES.findIndex(([n]) => n === name)}`;
			const report = textReport(postId, "弗兰克", text, extra);
			currentProbe().ctx?.reportPost(EXT.frank, report);
			await vi.waitFor(async () => {
				const row = (await history()).find((entry) =>
					entry.messages[0]?.text?.endsWith(report.url),
				);
				expect(row, name).toBeDefined();
				expect(row).toMatchObject({
					feature: "post",
					status: "filtered",
					filteredBy: reason,
					subscriptionId: SUB.frank,
					targetId: null,
					identity: { sourceKey: IN_PROCESS_KEY, externalId: EXT.frank },
				});
				expect(row?.messages[0]?.text).toBe(`${plainText}\n${report.url}`);
			});
			// 一条都没推出去。
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(await captures()).toEqual([]);
			drove("P07");
		},
	);

	it("(P07 收尾)清掉过滤规则", async () => {
		await okRes(
			await api(
				`/api/subscriptions/${SUB.frank}`,
				json({ overrides: { filters: NO_FILTERS } }, "PATCH"),
			),
		);
	});

	// 验红:`push-history.ts` 里把 `identity` 写死成别的来源键,这条红;名字快照取资料名,把 `nameSnapshot` 那一行摘掉也红。
	it("P08 历史行:身份是假来源的键、特性是作品、订阅 id 与目标对、名字快照取资料名", async () => {
		const row = (await history()).find((entry) =>
			entry.messages[0]?.text?.endsWith("https://acme.invalid/post/p04"),
		);
		expect(row).toMatchObject({
			feature: "post",
			status: "delivered",
			subscriptionId: SUB.alice,
			targetId: ID.group,
			identity: { sourceKey: IN_PROCESS_KEY, externalId: EXT.alice },
			nameSnapshot: ALICE_PROFILE_NAME,
		});
		expect(row?.messages[0]).toMatchObject({ kind: "composite", ok: true });
		drove("P08");
	});

	// 验红:`stats/recorder.ts` 里摘掉 `post-detected` 的监听,作品行落不了盘,这条红。
	// 「在记」那一格见 P45;这里读的是落盘的作品行。
	it("P09 统计作品行:每条作品(含被过滤的)在这条订阅名下落一行,带不带视频与报的一致", async () => {
		await vi.waitFor(async () => {
			const aliceRows = await statsPostRows(SUB.alice);
			expect(aliceRows.find((row) => row.id === "p04")).toMatchObject({
				id: "p04",
				hasVideo: false,
				url: "https://acme.invalid/post/p04",
			});
			// 被过滤的视频作品也算这位的产出,且标着带视频。
			const frankRows = await statsPostRows(SUB.frank);
			const videoIds = frankRows.filter((row) => row.hasVideo === true).map((row) => row.id);
			expect(videoIds.sort()).toEqual(["p07-1", "p07-9"]);
			expect(frankRows.filter((row) => row.hasVideo === false)).toHaveLength(
				FILTER_CASES.length - 2,
			);
		});
		// 别的来源名下的人(没有订阅的 dave)没有行。
		expect(await statsPostRows(SUB.dave)).toEqual([]);
		drove("P09");
	});

	// 验红:`source-context.ts` 里不抄 `postNoun`,AI 请求里没有「帖子」,第一段红;`deliver-post.ts` 的缺省改回「动态」,第二段红。
	it("P10 作品叫法进 AI:描述符声明的叫法进提示词;没声明的缺省叫「作品」", async () => {
		await patchCore({ ai: { enabled: true } });
		try {
			const probe = currentProbe();
			probe.descriptor.postNoun = "帖子";
			aiAsked.length = 0;
			await clearCaptures();
			probe.ctx?.reportPost(EXT.alice, textReport("p10a", "小爱", "声明了叫法"));
			const [hit] = await settledCaptures(1);
			// AI 点评替掉了模板文案。
			expect(hit?.text).toContain(AI_REPLY);
			expect(aiAsked.some((asked) => asked.includes("小爱发布了一条帖子"))).toBe(true);
			expect(aiAsked.some((asked) => asked.includes("发布了一条动态"))).toBe(false);

			// 不声明:缺省的叫法是「作品」(不是 B 站的「动态」)。
			probe.descriptor.postNoun = undefined;
			aiAsked.length = 0;
			await clearCaptures();
			probe.ctx?.reportPost(EXT.alice, textReport("p10b", "小爱", "没声明叫法"));
			await settledCaptures(1);
			expect(aiAsked.some((asked) => asked.includes("小爱发布了一条作品"))).toBe(true);
			expect(aiAsked.some((asked) => asked.includes("发布了一条动态"))).toBe(false);
		} finally {
			await patchCore({ ai: { enabled: false } });
		}
		drove("P10");
	});

	// 验红:`runtime/pipeline.ts` 不给生成器接叫法,或 `deliver-post.ts` 不递这条订阅,这句系统提示词里没有「博主」。
	it("P44 提示词里的叫法:推送点评按这条订阅取创作者叫法,不混平台词", async () => {
		await patchCore({ ai: { enabled: true } });
		try {
			aiSystems.length = 0;
			await clearCaptures();
			currentProbe().ctx?.reportPost(EXT.alice, textReport("p44", "小爱", "看叫法"));
			await settledCaptures(1);
			await vi.waitFor(() => expect(aiSystems.length).toBeGreaterThan(0));
			const system = aiSystems.at(-1) ?? "";
			expect(system).toContain(IN_PROCESS_LABEL);
			expect(system).toContain("博主");
			expect(system).not.toContain("UP主");
			expect(system).not.toContain("UP 主");
			expect(system).not.toContain("B 站");
		} finally {
			await patchCore({ ai: { enabled: false } });
		}
		drove("P44");
	});

	// 验红:`source-context.ts` 里 `reporter` 写成别的键,第一段红;带人的那条不按身份展开(只写一条),第二段红。
	it("P11 问题上报与清除:来源级一条、带人的按订阅展开;同 code 再报只换文案;清掉没了", async () => {
		const probe = currentProbe();
		const mine = async () => (await problems()).filter((p) => p.reporter === IN_PROCESS_KEY);

		probe.ctx?.reportProblem({ code: "source_trouble", message: "来源出了点状况" });
		probe.ctx?.reportProblem({
			externalId: EXT.erin,
			code: "person_trouble",
			message: "这个人有点状况",
		});
		const opened = (await mine()).filter((p) => p.code !== SETTINGS_PROBLEM_CODE);
		const own = opened.find((p) => p.code === "source_trouble");
		expect(own).toMatchObject({ reporter: IN_PROCESS_KEY, message: "来源出了点状况" });
		expect(own?.about).toBeUndefined();
		// 同一个人遗留的两条订阅,各一条。
		const perSub = opened.filter((p) => p.code === "person_trouble");
		expect(
			perSub
				.map((p) => (p.about && "subscriptionId" in p.about ? p.about.subscriptionId : undefined))
				.sort(),
		).toEqual([SUB.erin1, SUB.erin2].sort());
		for (const p of perSub) expect(p.message).toBe("这个人有点状况");

		// 订阅列表也带:那个人名下的两条订阅各带这条问题,别的订阅是空数组(对任何来源都成立)。
		const problemsBySub = async () => {
			const res = await okRes(await api("/api/subscriptions"));
			const rows = (await res.json()) as Array<{
				id: string;
				problems: ProblemsResponse["problems"];
			}>;
			return new Map(rows.map((row) => [row.id, row.problems]));
		};
		const bySub = await problemsBySub();
		for (const id of [SUB.erin1, SUB.erin2]) {
			expect(bySub.get(id)?.map((p) => p.code)).toEqual(["person_trouble"]);
		}
		for (const [id, list] of bySub) {
			if (id !== SUB.erin1 && id !== SUB.erin2) expect(list).toEqual([]);
		}

		// 再报同一个 code:只换文案,开始时刻不动。
		const since = own?.since;
		await new Promise((resolve) => setTimeout(resolve, 20));
		probe.ctx?.reportProblem({ code: "source_trouble", message: "文案换了" });
		const again = (await mine()).find((p) => p.code === "source_trouble");
		expect(again).toMatchObject({ message: "文案换了", since });
		expect((await mine()).filter((p) => p.code === "source_trouble")).toHaveLength(1);

		// 清掉:没了(带人的清掉一个人,两条订阅名下的都没)。
		probe.ctx?.resolveProblem({ code: "source_trouble", notify: false });
		probe.ctx?.resolveProblem({ externalId: EXT.erin, code: "person_trouble", notify: false });
		const left = await mine();
		expect(left.filter((p) => p.code === "source_trouble" || p.code === "person_trouble")).toEqual(
			[],
		);
		for (const list of (await problemsBySub()).values()) expect(list).toEqual([]);
		drove("P11");
	});

	// 验红:`pipeline.ts` 里不把问题表递给通知器(`table:` 换成一张永远空的),第一段红。
	it("P12 问题的私聊与恢复句:notify 的问题私聊主人一条(报的那句由宿主加上来源名的引子);清掉时发它自带的恢复句(同样加引子)", async () => {
		const probe = currentProbe();
		await clearCaptures();
		probe.ctx?.reportProblem({
			code: "needs_attention",
			message: "有一处要看一眼",
			notify: true,
			recoveryMessage: "已经好了",
		});
		const [asked] = await settledCaptures(1);
		expect(await captures()).toHaveLength(1);
		expect(asked).toMatchObject({
			targetId: ID.master,
			private: true,
			kind: "text",
			text: "主人，刚刚对拍源报告：有一处要看一眼",
		});

		await clearCaptures();
		probe.ctx?.resolveProblem({ code: "needs_attention" });
		const [recovered] = await settledCaptures(1);
		expect(await captures()).toHaveLength(1);
		expect(recovered).toMatchObject({
			targetId: ID.master,
			private: true,
			text: "主人，好消息，对拍源报告：已经好了",
		});
		drove("P12");
	});

	// 验红:`integrations/settings-reader.ts` 的 `settingsReaderOptionsOf` 里 `read` 的键写死成别的集成:第一段不红
	// (两边读出来都是默认值 `{ mode: "normal", threshold: 10 }`),红在第二段(存对之后 `onChange` 没被叫)与 P14;
	// 同一处的 `onChanged` 接成空操作,存对之后 `onChange` 不叫,第二段红。
	it("P13 读设置:get() 是盘上的值;经 PATCH /api/settings 改一格 onChange 被叫、新值对;别的集成动了不叫", async () => {
		const probe = currentProbe();
		expect(probe.settings?.get()).toEqual({
			ok: true,
			settings: { mode: "normal", threshold: 10 },
		});
		probe.settingsChanges.length = 0;

		await patchSettings({ [IN_PROCESS_KEY]: { threshold: 33 } });
		await vi.waitFor(() => expect(probe.settingsChanges).toHaveLength(1));
		expect(probe.settingsChanges[0]).toEqual({
			ok: true,
			settings: { mode: "normal", threshold: 33 },
		});
		expect(probe.settings?.get()).toEqual({
			ok: true,
			settings: { mode: "normal", threshold: 33 },
		});
		const onDisk = JSON.parse(
			await readFile(join(generation, "config", "settings", `${IN_PROCESS_KEY}.json`), "utf8"),
		) as Record<string, unknown>;
		expect(onDisk).toMatchObject({ threshold: 33 });

		// 别的集成(B 站)的设置动了,假来源的 onChange 不叫。
		await patchSettings({ bilibili: { healthCheckMinutes: 45 } });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(probe.settingsChanges).toHaveLength(1);
		drove("P13");
	});

	/** 把状态行读成 `label：summary` 的数组。 */
	async function statusLines(): Promise<string[]> {
		await clearCaptures();
		await okRes(
			await api("/api/dev/run/core.inbound.command", json({ params: { text: "/status" } })),
		);
		const [reply] = await settledCaptures(1);
		expect(reply).toMatchObject({ private: true, kind: "text", targetName: `私聊 ${MASTER_USER}` });
		return (reply?.text ?? "").split("\n");
	}

	// 验红:`index.ts` 里 `status` 的 `sources:` 接成空数组,这条红(假来源的那一行没了)。
	it("P15 健康与 status:回复里有一行「<label>：<那句话>」;health() 抛了那一行是「状态读不到」,别的行照出", async () => {
		const probe = currentProbe();
		probe.healthSummary = "上次抓取 2 分钟前";
		const normal = await statusLines();
		expect(normal).toContain(`${IN_PROCESS_LABEL}：上次抓取 2 分钟前`);
		// 并排在册的 B 站、推送通道、渲染排队那几行也在。
		expect(normal.some((line) => line.startsWith("推送通道："))).toBe(true);
		expect(normal.some((line) => line.startsWith("渲染排队："))).toBe(true);

		probe.healthThrows = true;
		try {
			const broken = await statusLines();
			expect(broken).toContain(`${IN_PROCESS_LABEL}：状态读不到`);
			expect(broken.some((line) => line.startsWith("推送通道："))).toBe(true);
		} finally {
			probe.healthThrows = false;
		}
		drove("P15");
	});

	// 验红:`stats/registry-source.ts` 里去掉 `auth` 判断,「登录前全假」红;不看 `recordsPosts`,bob 红;
	// 登记表里没有的键也记,dave 红;`bootstrap.ts` 递一张空登记表,登录后的那段红。
	it("P45 统计「在记」由核心算:在册来源登录着,这个小时按每条订阅的开关记作品 / 直播;没登录、停用、作品开关关着、没人认领的键不记", async () => {
		const probe = currentProbe();
		/**
		 * 窗口里有没有哪一天「在记」,按订阅 id 取;`days` 不同缓存键就不同(总览缓存 30 秒、键不含账)。
		 * 不只看最后一天:账记下与查询之间跨了 UTC 午夜,最后一格就成了新的一天。P45 之前没有哪一行让假来源登录过,
		 * 所以登录前窗口里一天都不该在记。
		 */
		const recordedInWindow = async (days: number) => {
			const res = await okRes(await api(`/api/stats/overview?days=${days}&tz=0`));
			const rows = ((await res.json()) as StatsOverviewResponse).rows;
			const anyDayOf = (id: string) => {
				const recording = rows.find((row) => row.subscriptionId === id)?.recording;
				return {
					posts: recording?.posts.some((day) => day === true) ?? false,
					live: recording?.live.some((day) => day === true) ?? false,
				};
			};
			return {
				alice: anyDayOf(SUB.alice),
				bob: anyDayOf(SUB.bob),
				carol: anyDayOf(SUB.carol),
				dave: anyDayOf(SUB.dave),
			};
		};
		const none = { posts: false, live: false };
		try {
			// 登录前:假来源起始 logged-out,谁也不记。
			probe.auth.set({ status: "logged-out" });
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(await recordedInWindow(5)).toEqual({
				alice: none,
				bob: none,
				carol: none,
				dave: none,
			});

			// 登上:登录口一发事件,核心现读到已登录就立刻记(不等定时)。
			probe.auth.set({ status: "logged-in", loggedInAt: "2026-10-01T00:00:00.000Z" });
			// 每轮换一个 `days`:同一个 `days` 的头一次查要是赶在账落盘之前,那份结果会缓存 30 秒,之后每轮都读到旧的。
			let days = 6;
			await vi.waitFor(
				async () => {
					const got = await recordedInWindow(days++);
					expect(got.alice).toEqual({ posts: true, live: true });
				},
				{ timeout: 10_000, interval: 200 },
			);
			// 作品开关关着的 bob 不记作品;停用的 carol、没人认领的键 dave 全不记(alice 记上之后再换一个 `days` 查)。
			const after = await recordedInWindow(days);
			expect(after.bob.posts).toBe(false);
			expect(after.carol).toEqual(none);
			expect(after.dave).toEqual(none);
		} finally {
			probe.auth.set({ status: "logged-out" });
		}
		drove("P45");
	}, 30_000);

	/** 订阅 WS 的一个频道,攒下收到的帧。 */
	async function watchFrames(channel: string) {
		const frames: Array<{ type?: string; event?: string; data?: unknown }> = [];
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		ws.on("message", (raw) => {
			frames.push(JSON.parse(String(raw)) as (typeof frames)[number]);
		});
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});
		ws.send(JSON.stringify({ type: "subscribe", channels: [channel] }));
		await vi.waitFor(() => expect(frames.some((f) => f.type === "subscribed")).toBe(true));
		return {
			frames,
			close: () => ws.close(),
		};
	}

	// 验红:`pipeline.ts` 里不递 `onAuthChanged`,WS 上收不到帧,第三段红;路由换成只回 `state` 不回 `account`,第一段红。
	it("P16 登录口:GET 逐格挑、POST 进 awaiting-scan 再 POST 回 conflict、DELETE 回 logged-out;状态一变 WS 的 auth 频道收到帧", async () => {
		const probe = currentProbe();
		const watch = await watchFrames("auth");
		try {
			const authUrl = `/api/sources/${IN_PROCESS_KEY}/auth`;

			// 登着一个账号:回包只有 state 与 account 的名字 —— 来源多带的格不外泄。
			probe.auth.set(
				{ status: "logged-in", loggedInAt: "2026-10-01T00:00:00.000Z" },
				{ name: "账号甲" },
			);
			const got = (await (await okRes(await api(authUrl))).json()) as SourceAuthResponse;
			expect(got).toEqual({
				state: { status: "logged-in", loggedInAt: "2026-10-01T00:00:00.000Z" },
				account: { name: "账号甲" },
			});

			// 发起扫码:进 awaiting-scan;已在等扫码时再发起,回 conflict。
			const begun = await okRes(await api(authUrl, { method: "POST" }));
			expect(((await begun.json()) as SourceAuthResponse).state.status).toBe("awaiting-scan");
			const second = await api(authUrl, { method: "POST" });
			expect(second.status).toBe(409);
			expect(await second.json()).toMatchObject({ code: "conflict" });

			// 退出登录。
			const out = await okRes(await api(authUrl, { method: "DELETE" }));
			expect(await out.json()).toEqual({ state: { status: "logged-out" } });

			// WS:状态每变一次一帧,来源键是假来源的键。
			await vi.waitFor(() => {
				const seen = watch.frames
					.filter((f) => f.type === "auth" && f.event === "subscription-auth-changed")
					.map((f) => f.data as { sourceKey: string; state: { status: string } });
				expect(seen.map((d) => [d.sourceKey, d.state.status])).toEqual([
					[IN_PROCESS_KEY, "logged-in"],
					[IN_PROCESS_KEY, "awaiting-scan"],
					[IN_PROCESS_KEY, "logged-out"],
				]);
			});
		} finally {
			watch.close();
		}
		drove("P16");
	});

	/** 经真的入站口敲一条私聊指令,等回话到齐(至少 `n` 条),回会话里收到的全部。 */
	async function sendCommand(text: string, n: number): Promise<DevCapturedDelivery[]> {
		await clearCaptures();
		await okRes(await api("/api/dev/run/core.inbound.command", json({ params: { text } })));
		return settledCaptures(n);
	}

	// 验红:`index.ts` 里 `login` / `status` 递的名单换成只有 B 站(或改回直读 `authSystem`),这条红
	// (假来源没有自己的「登录」行,敲它的键扫的是 B 站、假来源的 `beginLogin` 没被叫);
	// 把 `login` 里「多个不带参数 → 列出来」改成直接扫第一个,第二段红。
	it("P21 login 与 status 的登录行:假来源与 B 站并排在册,status 里各有一行「<名字>登录：…」;login 不带词列出两个,带假来源的键扫的是它", async () => {
		const probe = currentProbe();
		probe.auth.set({ status: "logged-in", loggedInAt: "2026-10-01T00:00:00.000Z" });
		const lines = await statusLines();
		expect(lines).toContain(`${IN_PROCESS_LABEL}登录：已登录`);
		expect(lines.some((line) => line.startsWith("B 站登录："))).toBe(true);
		// 登录行排在来源自己的行之前。
		expect(lines.indexOf(`${IN_PROCESS_LABEL}登录：已登录`)).toBeLessThan(
			lines.findIndex((line) => line.startsWith("推送通道：")),
		);

		// 两个带登录的来源、不带词:回清单,谁也不扫(真 B 站的 beginLogin 会出网,联网守卫会拦)。
		probe.auth.set({ status: "logged-out" });
		const [list, ...rest] = await sendCommand("/login", 1);
		expect(rest).toEqual([]);
		expect(list).toMatchObject({ private: true, kind: "text" });
		expect(list?.text).toBe(
			`有好几个来源可以登录：\n- B 站（bilibili）\n- ${IN_PROCESS_LABEL}（${IN_PROCESS_KEY}）\n想扫哪一个，就在 login 后面跟上它的名字或键，比如「login bilibili」～`,
		);
		expect(probe.auth.state()).toEqual({ status: "logged-out" });

		// 带假来源的键:发回来一张图(假来源的二维码)加一句点它名字的话;它的登录口进了 awaiting-scan。
		const scanned = await sendCommand(`/login ${IN_PROCESS_KEY}`, 2);
		expect(scanned.map((d) => [d.private, d.kind, d.images])).toEqual([
			[true, "image", 1],
			[true, "text", 0],
		]);
		expect(scanned[1]?.text).toBe(
			`扫这张码登录「${IN_PROCESS_LABEL}」就行，180 秒内有效，过期了再敲一次～`,
		);
		expect(probe.auth.state()).toMatchObject({
			status: "awaiting-scan",
			qr: { dataUrl: "data:image/png;base64,AAAA" },
		});
		// B 站那一边没被动。
		const bili = (await (await okRes(await api("/api/sources/bilibili/auth"))).json()) as {
			state: { status: string };
		};
		expect(bili.state.status).not.toBe("awaiting-scan");

		// 名字也认,大小写不论;对不上的词是失败话,带分发器的前缀。
		const byName = await sendCommand(`/login ${IN_PROCESS_LABEL}`, 2);
		expect(byName[1]?.text).toContain(`登录「${IN_PROCESS_LABEL}」`);
		const unknown = await sendCommand("/login douyin", 1);
		expect(unknown[0]?.text).toBe(
			`『login』没办成：没有叫「douyin」的来源～能登录的有：B 站（bilibili）、${IN_PROCESS_LABEL}（${IN_PROCESS_KEY}）`,
		);
		probe.auth.set({ status: "logged-out" });
		drove("P21");
	});

	// 验红:`membership-tiers.ts` 不按体系找档(或只读第一个在册来源),假来源的（体系, 档）就认不出、或跨体系串档。
	it("P19 会员体系读口:按（体系 id, 档 key）认档;乱写的 key、别的体系的 key 回 400;老请求不带体系照旧认", async () => {
		/** 预览请求故意带一个无关的错(nth 是 0):校验一定会跑,不碰渲染(也就不碰任何网)。 */
		const preview = async (program: string | undefined, tierKey: string) => {
			const res = await api(
				"/api/cards/preview",
				json({
					kind: "membership",
					style: {},
					content: { ...(program === undefined ? {} : { program }), tierKey, nth: 0 },
				}),
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as {
				issues?: Array<{ path: string | Array<string | number> }>;
			};
			return (body.issues ?? []).map((issue) =>
				Array.isArray(issue.path) ? issue.path.join(".") : String(issue.path),
			);
		};
		const known = await preview(IN_PROCESS_PROGRAM_ID, IN_PROCESS_TIER_KEY);
		expect(known).toContain("content.nth");
		expect(known).not.toContain("content.tierKey");

		const unknown = await preview(IN_PROCESS_PROGRAM_ID, "acme-不存在的档");
		expect(unknown).toContain("content.nth");
		expect(unknown).toContain("content.tierKey");

		// 同一个档 key 在别的体系里不算数:档 key 只在体系内唯一。
		const otherProgram = await preview(IN_PROCESS_OTHER_PROGRAM_ID, IN_PROCESS_TIER_KEY);
		expect(otherProgram).toContain("content.tierKey");
		expect(await preview(IN_PROCESS_OTHER_PROGRAM_ID, IN_PROCESS_OTHER_TIER_KEY)).not.toContain(
			"content.tierKey",
		);

		// 老请求不带体系:照旧按登记先后找,不因此拒收。
		const noProgram = await preview(undefined, IN_PROCESS_TIER_KEY);
		expect(noProgram).not.toContain("content.tierKey");
		drove("P19");
	});

	// 验红:包装层取日志器时把键写成别的集成(比如 B 站那一格),调 `logging.levels["acme.inprocess"]` 压不住假来源的 warn,第二段红。
	it("P20 日志等级与没碰 B 站:调低假来源那一格只压它自己;整轮下来问题、历史、统计里没有任何 B 站名下的条目是假来源弄出来的", async () => {
		const probe = currentProbe();
		const ctx = inProcessWorld.serviceCtx as unknown as NodeServiceContext;
		const seen: LogEntry[] = [];
		const previous = ctx.setLogHook((entry) => seen.push(entry));
		const mine = probe.ctx?.logger;
		const core = ctx.logger;
		const bili = ctx.forSubsystem("dynamic", "bilibili").logger;
		const emit = () => {
			seen.length = 0;
			mine?.warn("mine-warn");
			mine?.error("mine-error");
			core.warn("core-warn");
			bili.warn("bili-warn");
			return seen.map((entry) => entry.msg);
		};
		try {
			expect(emit()).toEqual(["mine-warn", "mine-error", "core-warn", "bili-warn"]);

			await patchCore({ logging: { levels: { [IN_PROCESS_KEY]: "error" } } });
			expect(emit()).toEqual(["mine-error", "core-warn", "bili-warn"]);

			await patchCore({ logging: { levels: { [IN_PROCESS_KEY]: null } } });
			expect(emit()).toEqual(["mine-warn", "mine-error", "core-warn", "bili-warn"]);
		} finally {
			ctx.setLogHook(previous);
		}

		// 没碰 B 站:假来源报过的问题 code 没有一条记在 B 站名下;历史与统计里没有 B 站身份的行。
		const mineCodes = new Set([
			"source_trouble",
			"person_trouble",
			"needs_attention",
			SETTINGS_PROBLEM_CODE,
		]);
		expect(
			(await problems()).filter((p) => p.reporter === "bilibili" && mineCodes.has(p.code)),
		).toEqual([]);
		expect((await history()).filter((row) => row.identity.sourceKey === "bilibili")).toEqual([]);
		expect((await overview()).filter((row) => row.identity.sourceKey === "bilibili")).toEqual([]);
		for (const event of inProcessWorld.postDetected) {
			expect(event.identity.sourceKey).toBe(IN_PROCESS_KEY);
		}
		drove("P20");
	});

	// 验红:`pipeline.ts` 里 attachReadOnlyTools 的 `platformLabel` 改回只问拓展装载器(假源不是拓展,装载器回 undefined),
	// 视图里的平台名退成键名 `acme.inprocess`,这条红。
	it("P25 女仆订阅视图:订阅带着 creator(来源键:外部 id),平台名取登记表里描述符的叫法", async () => {
		const { seen } = await askMaid({ name: "list_subscriptions", args: {} });
		expect(seen).toContain(IN_PROCESS_LABEL);
		expect(seen).toContain(`${IN_PROCESS_KEY}:${EXT.alice}`);
		// 没有按 B 站分叉的写法:不再有「UID:」。
		expect(seen).not.toContain("UID:");
		drove("P25");
	});

	// 验红:`search_creators` 不把 query 递下去(或外壳吞掉来源的失败),这条红。
	it("P26 searchCreators 经女仆的搜人工具:query 原样递给来源,候选带 creator 喂回;来源回失败时痕迹是失败、话原样喂回;键不在册时话里列出在册来源", async () => {
		const probe = currentProbe();
		probe.searches.length = 0;
		try {
			const found = await askMaid({
				name: "search_creators",
				args: { source: IN_PROCESS_KEY, query: "x" },
			});
			expect(probe.searches).toEqual(["x"]);
			expect(found.seen).toContain(`${IN_PROCESS_KEY}:cand-1`);
			expect(found.seen).toContain("候选甲");
			expect(found.seen).toContain(`${IN_PROCESS_KEY}:cand-2`);
			expect(found.tools).toEqual([expect.objectContaining({ name: "search_creators", ok: true })]);

			probe.searchOutcome = fail("rate_limited", "对拍源被风控了");
			const limited = await askMaid({
				name: "search_creators",
				args: { source: IN_PROCESS_KEY, query: "y" },
			});
			expect(limited.seen).toContain("对拍源被风控了");
			expect(limited.tools).toEqual([
				expect.objectContaining({ name: "search_creators", ok: false }),
			]);

			const missing = await askMaid({
				name: "search_creators",
				args: { source: "nope.nobody", query: "z" },
			});
			expect(missing.seen).toContain(`${IN_PROCESS_KEY}（${IN_PROCESS_LABEL}）`);
			expect(probe.searches).toEqual(["x", "y"]);
		} finally {
			probe.searchOutcome = undefined;
		}
		drove("P26");
	});

	// 验红:`createIntegrationContext` 里把 `storeImage` 绑成永远失败的写口,这条红(卡片里没有那张图);
	// 把 `fetchImage` 的客户端换成不挂 `addressCheck` 的,抓回环那一问不再被拒,这条红。
	it("P27 ctx.http / fetchImage / storeImage:storeImage 存的配图与头像画进卡片;fetchImage 抓回环被拒;ctx.http 打回环照通", async () => {
		await clearCaptures();
		const probe = currentProbe();
		const ctx = probe.ctx;
		if (!ctx) throw new Error("假来源还没 start");
		const before = renderedHtml.length;
		// 宽高写在文件头里的两张 png,字节各不相同(图库里就是引用各不相同)。
		const picture = Buffer.from(png(16, 9, 1));
		const avatar = Buffer.from(png(8, 8, 3));

		const storedPicture = await ctx.storeImage(picture);
		const storedAvatar = await ctx.storeImage(avatar);
		if (!storedPicture.ok || !storedAvatar.ok) throw new Error("storeImage 存图失败");
		// 不是图的字节被拒:
		const notImage = await ctx.storeImage(new Uint8Array([1, 2, 3]));
		expect(notImage.ok).toBe(false);
		if (!notImage.ok) expect(notImage.code).toBe("invalid");

		// 抓图拦内网(回环算内网),请求本身不拦(局域网里的 RSSHub 要连得上)。
		const loopback = new URL(aiBaseUrl).origin;
		const fetched = await ctx.fetchImage(`${loopback}/pic.png`);
		expect(fetched.ok).toBe(false);
		if (!fetched.ok) expect(fetched.code).toBe("invalid");
		const plain = await ctx.http.fetch(`${loopback}/anything`);
		expect(plain.ok).toBe(true);

		ctx.reportPost(
			EXT.alice,
			textReport("p27", "带图的人", "带图的作品正文P27", {
				creator: { name: "带图的人", avatar: storedAvatar.ref },
				images: [{ ref: storedPicture.ref }],
			}),
		);
		const [hit] = await settledCaptures(1);
		expect(hit).toMatchObject({ kind: "composite", images: 1 });
		const html = renderedHtml.slice(before).find((page) => page.includes("带图的作品正文P27"));
		expect(html, "这条作品没画成卡").toBeDefined();
		// 出图器按引用读图库、把字节换成 data URL 画进卡片:配图和头像的字节都在页面里。
		expect(html).toContain(picture.toString("base64"));
		expect(html).toContain(avatar.toString("base64"));
		drove("P27");
	});

	// 验红:`deliver-post.ts` 的 `commentImagesOf` 跳过只有引用的图,AI 那一问里没有 data URL,这条红;
	// 把断言里的 data URL 换成另一张图的,这条也红(比的是这张图的字节,不只是有没有图)。
	it("P28 看图从图库引用:只有图库引用、没有地址的配图,喂给 AI 的是这张图的 data URL", async () => {
		const probe = currentProbe();
		const ctx = probe.ctx;
		if (!ctx) throw new Error("假来源还没 start");
		const picture = Buffer.from(png(12, 7, 5));
		const stored = await ctx.storeImage(picture);
		if (!stored.ok) throw new Error("storeImage 存图失败");
		// 主模型能看图:服务商要支持看图(deepseek 官方接口不支持,换成自定义档)且开着 enableVision。
		await patchCore({
			ai: { enabled: true, providers: { fake: { provider: "custom", enableVision: true } } },
		});
		try {
			aiAsked.length = 0;
			await clearCaptures();
			ctx.reportPost(
				EXT.alice,
				textReport("p28", "小爱", "只有图库引用的配图P28", { images: [{ ref: stored.ref }] }),
			);
			await settledCaptures(1);
			const asked = aiAsked.join("\n");
			expect(asked).toContain(`data:image/png;base64,${picture.toString("base64")}`);
		} finally {
			await patchCore({
				ai: { enabled: false, providers: { fake: { provider: "deepseek", enableVision: false } } },
			});
		}
		drove("P28");
	});

	// 验红:`post-settings.ts` 的 `cardSkin` 忽略订阅覆盖(取全局),出图的 HTML 里是全局皮肤的旋钮色,这条红;
	// `cardSkinKnobs` 不递给出图器,订阅的旋钮色画不进去,这条也红。
	it("P48 按订阅的皮肤:假来源作品出图用这条订阅指的皮肤与旋钮,不是全局当前那套", async () => {
		const duplicate = async (name: string): Promise<string> => {
			const res = await okRes(await api("/api/cards/skins/default/duplicate", json({ name })));
			return ((await res.json()) as { id: string }).id;
		};
		const subSkin = await duplicate("订阅用皮肤P48");
		const globalSkin = await duplicate("全局皮肤P48");
		const SUB_COLOR = "#1a2b3c";
		const GLOBAL_COLOR = "#c0ffee";
		try {
			await okRes(await api("/api/cards/skins/active", json({ id: globalSkin }, "PUT")));
			await patchCore({
				defaults: { cardSkinKnobs: { [globalSkin]: { "gradient-start": GLOBAL_COLOR } } },
			});
			await okRes(
				await api(
					`/api/subscriptions/${SUB.alice}`,
					json(
						{
							overrides: {
								cardSkin: subSkin,
								cardSkinKnobs: { [subSkin]: { "gradient-start": SUB_COLOR } },
							},
						},
						"PATCH",
					),
				),
			);
			await clearCaptures();
			const before = renderedHtml.length;
			currentProbe().ctx?.reportPost(EXT.alice, textReport("p48", "小爱", "按订阅的皮肤P48"));
			await settledCaptures(1);
			const html = renderedHtml.slice(before).find((page) => page.includes("按订阅的皮肤P48"));
			expect(html, "这条作品没画成卡").toBeDefined();
			expect(html).toContain(SUB_COLOR);
			expect(html).not.toContain(GLOBAL_COLOR);
		} finally {
			await okRes(
				await api(
					`/api/subscriptions/${SUB.alice}`,
					json({ overrides: { cardSkin: null, cardSkinKnobs: null } }, "PATCH"),
				),
			);
			await okRes(await api("/api/cards/skins/active", json({ id: "default" }, "PUT")));
			await patchCore({ defaults: { cardSkinKnobs: { [globalSkin]: null } } });
			for (const id of [subSkin, globalSkin]) {
				await api(`/api/cards/skins/${id}`, { method: "DELETE" });
			}
		}
		drove("P48");
	});

	// 验红:`post-filter.ts` 只拿正文过滤(不调 `postText`),标题 / 视频标题 / 转发原文命中的屏蔽词放行,第一段红;
	// `deliver-post.ts` 的 AI 输入换成只给正文,第二段红。
	it("P49 过滤与点评共用 postText:假来源作品的正文 / 标题 / 视频标题 / 转发原文,过滤吃得到非正文段,AI 输入带齐同一组字段", async () => {
		const BODY = "正文标记P49";
		const TITLE = "标题标记P49";
		const VIDEO = "视频标记P49";
		const REPOST = "转发标记P49";
		const fields = (): Partial<Post> => ({
			title: TITLE,
			video: hiddenVideo(VIDEO),
			repost: {
				creator: { name: "原作者P49" },
				publishedAt: "2026-09-30T08:00:00.000Z",
				text: REPOST,
			},
		});
		const setFilters = async (rules: Partial<typeof NO_FILTERS>) =>
			okRes(
				await api(
					`/api/subscriptions/${SUB.alice}`,
					json({ overrides: { filters: { ...NO_FILTERS, ...rules } } }, "PATCH"),
				),
			);
		try {
			// 一拍:屏蔽词各只命中一个非正文段,都被过滤并在历史留痕。
			for (const [mark, key] of [
				[TITLE, "title"],
				[VIDEO, "video"],
				[REPOST, "repost"],
			] as const) {
				await setFilters({ blockKeywords: [mark] });
				await clearCaptures();
				const report = textReport(`p49-${key}`, "小爱", BODY, fields());
				currentProbe().ctx?.reportPost(EXT.alice, report);
				await vi.waitFor(async () => {
					const row = (await history()).find((entry) =>
						entry.messages[0]?.text?.endsWith(report.url),
					);
					expect(row, key).toMatchObject({
						status: "filtered",
						filteredBy: "blocked-keyword",
						subscriptionId: SUB.alice,
					});
				});
				await new Promise((resolve) => setTimeout(resolve, 200));
				expect(await captures(), key).toEqual([]);
			}
			// 二拍:不过滤,开 AI,同一组字段在送给模型的那一问里带着各自的标签。
			await setFilters({});
			await patchCore({ ai: { enabled: true } });
			try {
				aiAsked.length = 0;
				await clearCaptures();
				currentProbe().ctx?.reportPost(EXT.alice, textReport("p49-ai", "小爱", BODY, fields()));
				await settledCaptures(1);
				const asked = aiAsked.join("\n");
				for (const part of [
					BODY,
					`标题：${TITLE}`,
					`视频标题：${VIDEO}`,
					"转发自 原作者P49",
					REPOST,
				]) {
					expect(asked, part).toContain(part);
				}
			} finally {
				await patchCore({ ai: { enabled: false } });
			}
		} finally {
			await setFilters({});
		}
		drove("P49");
	});

	// 验红:`routes/live.ts` 不按订阅仓补身份,或在播表里把同一订阅列两次,「恰好一行」那段红;
	// `source-context.ts` 里 `reportLive` 的展开只取第一条订阅、或 `pipeline.ts` 不递 `liveSignals`,开播卡那段红。
	it("P29 reportLive:开播、状态、下播进场次,推开播与下播卡,断流接续同一场,在播列表里恰好一行(按订阅 id 认)", async () => {
		const probe = currentProbe();
		const TITLE = "开播标题P29";
		const aliceRows = async (): Promise<LiveListeningEntry[]> => {
			const res = await okRes(await api("/api/live/listening"));
			return ((await res.json()) as LiveListeningEntry[]).filter(
				(row) => row.subscriptionId === SUB.alice,
			);
		};
		const livePushes = (feature: HistoryEntryView["feature"]) => livePushCount(SUB.alice, feature);
		const waitPushes = (feature: HistoryEntryView["feature"], n: number) =>
			vi.waitFor(async () => expect(await livePushes(feature)).toBe(n), { timeout: 10_000 });
		const htmlBefore = renderedHtml.length;
		// 开播时刻取此刻:来源没实现拉取式的话无所谓,实现了(假来源实现了)的话第一次周期核对在一个小时之后,
		// 不会在这条用例中途打进来。
		const startedAt = () => new Date().toISOString();

		// 开播:推一次开播卡;在播列表里 alice 恰好一行(在册来源走 B 站形状的快照,不再列拓展形状那一行)。
		probe.reportLive(EXT.alice, {
			kind: "start",
			startedAt: startedAt(),
			details: { title: TITLE, category: "聊天", totalViewers: 7 },
		});
		await waitPushes("liveStart", 1);
		expect(renderedHtml.slice(htmlBefore).some((html) => html.includes(TITLE))).toBe(true);
		expect(await aliceRows()).toEqual([
			expect.objectContaining({
				subscriptionId: SUB.alice,
				identity: { sourceKey: IN_PROCESS_KEY, externalId: EXT.alice },
				isLive: true,
				title: TITLE,
				category: "聊天",
				totalViewers: 7,
			}),
		]);

		// 状态:人数换新,仍是这一行;下播:推下播卡(标题从在播表里补),列表里没有了。
		probe.reportLive(EXT.alice, { kind: "status", isLive: true, details: { totalViewers: 20 } });
		expect(await aliceRows()).toEqual([
			expect.objectContaining({ totalViewers: 20, title: TITLE }),
		]);
		probe.reportLive(EXT.alice, { kind: "end", endedAt: "2026-10-20T09:00:00.000Z" });
		await waitPushes("liveEnd", 1);
		expect(await aliceRows()).toEqual([]);

		// 断流接续:开着时下播先等,等待里又开播就是同一场 —— 不再推开播卡,列表里仍是一行。
		await patchCore({ defaults: { schedule: { liveEndGrace: true, liveEndGraceMinutes: 1 } } });
		try {
			const second = startedAt();
			probe.reportLive(EXT.alice, { kind: "start", startedAt: second, details: { title: TITLE } });
			await waitPushes("liveStart", 2);
			probe.reportLive(EXT.alice, { kind: "end", endedAt: new Date().toISOString() });
			probe.reportLive(EXT.alice, { kind: "start", startedAt: second, details: { title: TITLE } });
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(await livePushes("liveStart")).toBe(2);
			expect(await livePushes("liveEnd")).toBe(1);
			expect(await aliceRows()).toHaveLength(1);
		} finally {
			await patchCore({ defaults: { schedule: { liveEndGrace: false } } });
		}
		// 收尾:关着断流接续时下播当场结束,不留一场在表里。
		probe.reportLive(EXT.alice, { kind: "end", endedAt: new Date().toISOString() });
		await waitPushes("liveEnd", 2);
		expect(await aliceRows()).toEqual([]);
		drove("P29");
	});

	// 验红:`live-sessions.ts` 的计时起点改回「挂上那一刻」,第一段红(开播时刻往前挪了的场次两秒后没被问);
	// `ok:false` 分支加回停计时/结束场次,「取不到」那段红;去掉断流到期的核对,不在本文件钉(单测 `live-poll.test.ts`)。
	it("P30 fetchLiveStatus:按开播时刻起算的周期卡、周期关着只核不推、发现已下播走下播且时长算到发现那刻、取不到跳过不停(问题由来源自己报)、订阅开始监听时认出已在播的一场并补报", async () => {
		const probe = currentProbe();
		const who = SUB.frank;
		const ext = EXT.frank;
		const pushes = (feature: HistoryEntryView["feature"]) => livePushCount(who, feature);
		const waitPushes = (feature: HistoryEntryView["feature"], n: number) =>
			vi.waitFor(async () => expect(await pushes(feature)).toBe(n), { timeout: 15_000 });
		const rowsOf = async (id: string): Promise<LiveListeningEntry[]> =>
			(
				(await (await okRes(await api("/api/live/listening"))).json()) as LiveListeningEntry[]
			).filter((row) => row.subscriptionId === id);
		const asked = () => probe.liveStatusAsked.filter((id) => id === ext).length;
		const HOUR_MS = 3_600_000;
		const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const startedAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

		// ⓪ 开机重建:来源登记完,它名下启用着、要监听的订阅各被问过一次(重启之后靠这一问认出已在播的场次)。
		expect(probe.liveStatusAsked).toContain(EXT.alice);

		// ① 周期「正在直播」开着、间隔 2 小时:开播时刻是 2 小时少 2 秒前 → 两秒后问一次(不是从挂上那一刻起算,
		// 否则要等 2 小时),在播 → 推一张「正在直播」卡,卡上是这一次问到的标题。
		await patchCore({
			defaults: { features: { liveStreaming: true }, liveStreaming: { streamingIntervalHours: 2 } },
		});
		const htmlBefore = renderedHtml.length;
		try {
			probe.liveStatusOutcome = {
				ok: true,
				kind: "live",
				details: { title: "轮询到的标题P30", totalViewers: 99 },
			};
			const askedBefore = asked();
			probe.reportLive(ext, {
				kind: "start",
				startedAt: startedAgo(2 * HOUR_MS - 2000),
				details: { title: "开播标题P30" },
			});
			await waitPushes("liveStart", 1);
			await waitPushes("liveStreaming", 1);
			expect(asked()).toBe(askedBefore + 1);
			expect(renderedHtml.slice(htmlBefore).some((html) => html.includes("轮询到的标题P30"))).toBe(
				true,
			);
			probe.reportLive(ext, { kind: "end", endedAt: new Date().toISOString() });
			await waitPushes("liveEnd", 1);
		} finally {
			await patchCore({
				defaults: {
					features: { liveStreaming: false },
					liveStreaming: { streamingIntervalHours: 1 },
				},
			});
		}

		// ② 周期关着:间隔用默认 1 小时,开播时刻是 1 小时少 2 秒前 → 照样核一次,但不推「正在直播」。
		const askedBeforeOff = asked();
		probe.reportLive(ext, {
			kind: "start",
			startedAt: startedAgo(HOUR_MS - 2000),
			details: { title: "开播标题P30" },
		});
		await waitPushes("liveStart", 2);
		await vi.waitFor(() => expect(asked()).toBe(askedBeforeOff + 1), { timeout: 15_000 });
		await wait(500);
		expect(await pushes("liveStreaming")).toBe(1);
		probe.reportLive(ext, { kind: "end", endedAt: new Date().toISOString() });
		await waitPushes("liveEnd", 2);

		// ③ 取不到:跳过这一轮,场次还在(在播列表还有这一行)、没有下播卡;问题是来源自己报的。
		probe.liveStatusOutcome = { ok: false, code: "rate_limited", message: "被风控了" };
		const askedBeforeFail = asked();
		probe.reportLive(ext, {
			kind: "start",
			startedAt: startedAgo(HOUR_MS - 2000),
			details: { title: "开播标题P30" },
		});
		await waitPushes("liveStart", 3);
		await vi.waitFor(() => expect(asked()).toBe(askedBeforeFail + 1), { timeout: 15_000 });
		await vi.waitFor(async () =>
			expect(
				(await problems()).some(
					(problem) =>
						problem.reporter === IN_PROCESS_KEY && problem.code === LIVE_STATUS_PROBLEM_CODE,
				),
			).toBe(true),
		);
		await wait(500);
		expect(await rowsOf(who)).toHaveLength(1);
		expect(await pushes("liveEnd")).toBe(2);
		probe.reportLive(ext, { kind: "end", endedAt: new Date().toISOString() });
		await waitPushes("liveEnd", 3);

		// ④ 发现已下播:来源没报下播,核到「没在播」→ 走下播同一条路,推下播卡,时长算到发现的那一刻
		// (开播时刻是 3 小时少 2 秒前,间隔 1 小时,第三个整点就是两秒后 → 时长正好 3 小时)。
		probe.liveStatusOutcome = { ok: true, kind: "offline" };
		await clearCaptures();
		probe.reportLive(ext, {
			kind: "start",
			startedAt: startedAgo(3 * HOUR_MS - 2000),
			details: { title: "开播标题P30" },
		});
		await waitPushes("liveStart", 4);
		await waitPushes("liveEnd", 4);
		const endCard = (await captures()).find((entry) => entry.text?.includes("下播啦"));
		expect(endCard?.text).toContain("3小时");
		expect(await rowsOf(who)).toEqual([]);

		// ⑤ 订阅开始监听时认出已经在播的一场并补报:carol 停用着,启用的那一刻问一次,在播 → 认出一场(在播列表有
		// 一行),补报开着就补一张「正在直播」卡(推送类型 CatchUp,历史记成开播)。
		await patchCore({ defaults: { liveStart: { catchUpOnBoot: true } } });
		try {
			probe.liveStatusOutcome = {
				ok: true,
				kind: "live",
				details: { title: "补报标题P30" },
			};
			await okRes(await api(`/api/subscriptions/${SUB.carol}`, json({ enabled: true }, "PATCH")));
			await vi.waitFor(async () => expect(await rowsOf(SUB.carol)).toHaveLength(1), {
				timeout: 15_000,
			});
			await vi.waitFor(async () => expect(await livePushCount(SUB.carol, "liveStart")).toBe(1), {
				timeout: 15_000,
			});
		} finally {
			await okRes(await api(`/api/subscriptions/${SUB.carol}`, json({ enabled: false }, "PATCH")));
			await patchCore({ defaults: { liveStart: { catchUpOnBoot: false } } });
			probe.liveStatusOutcome = { ok: true, kind: "offline" };
		}
		drove("P30");
	}, 90_000);

	// 验红:`live-interactions.ts` 里名单改成按名字认,「名单按 viewer.id」那段红(同名不同 id 的推了);
	// 去掉对特性开关的核,不在本文件钉(开关关着时推送层也会丢,见 `live/__tests__/live-interactions.test.ts`)。
	it("P31 特别弹幕与特别进场:名单按 viewer.id、开关与名单都要", async () => {
		const probe = currentProbe();
		const who = SUB.alice;
		const ext = EXT.alice;
		const pushes = (feature: HistoryEntryView["feature"]) => livePushCount(who, feature);
		const waitPushes = (feature: HistoryEntryView["feature"], n: number) =>
			vi.waitFor(async () => expect(await pushes(feature)).toBe(n), { timeout: 10_000 });
		// 「没推」要等一会儿才算数:要是推了,它会在这段时间里到。
		const settle = () => new Promise((resolve) => setTimeout(resolve, 500));
		const viewer = { id: SPECIAL_VIEWER, name: "路人甲" };
		const sameNameOtherId = { id: "7002", name: "路人甲" };
		const sameIdOtherName = { id: SPECIAL_VIEWER, name: "路人乙" };

		await patchCore({ defaults: { features: { viewerChat: true, viewerEnter: true } } });
		try {
			// 特别弹幕:名单上的 7001 推;同名不同 id 的不推,同 id 换了名字的照推(认的是 id)。
			probe.reportLiveInteraction(ext, { kind: "viewerChat", viewer, text: "你好呀" });
			await waitPushes("viewerChat", 1);
			probe.reportLiveInteraction(ext, {
				kind: "viewerChat",
				viewer: sameNameOtherId,
				text: "你好呀",
			});
			await settle();
			expect(await pushes("viewerChat")).toBe(1);
			probe.reportLiveInteraction(ext, {
				kind: "viewerChat",
				viewer: sameIdOtherName,
				text: "改名了",
			});
			await waitPushes("viewerChat", 2);

			// 特别进场同理。
			probe.reportLiveInteraction(ext, { kind: "viewerEnter", viewer });
			await waitPushes("viewerEnter", 1);
			probe.reportLiveInteraction(ext, { kind: "viewerEnter", viewer: sameNameOtherId });
			await settle();
			expect(await pushes("viewerEnter")).toBe(1);

			// 开关与名单都要:名单上有人、这一把开关关着 → 不推;另一把照推。
			await patchCore({ defaults: { features: { viewerChat: false } } });
			probe.reportLiveInteraction(ext, { kind: "viewerChat", viewer, text: "关着开关" });
			probe.reportLiveInteraction(ext, { kind: "viewerEnter", viewer });
			await waitPushes("viewerEnter", 2);
			expect(await pushes("viewerChat")).toBe(2);

			// 开关开着、名单没有这个人(换成别人的订阅 id 也一样:认的是这条订阅现折的名单)→ 不推。
			probe.reportLiveInteraction(EXT.bob, { kind: "viewerEnter", viewer });
			await settle();
			expect(await livePushCount(SUB.bob, "viewerEnter")).toBe(0);
		} finally {
			await patchCore({ defaults: { features: { viewerChat: false, viewerEnter: false } } });
		}
		drove("P31");
	}, 60_000);

	// 验红:`live-interactions.ts` 不接 `superchat`(什么都不发),整条红;门槛挪到头像之前取、或忘了传 `tier`,
	// 「不取头像」「按档取色」那两段红;不看来源给的 `fallbackText`,兜底那段红。
	it("P32 醒目留言:非人民币过门槛、卡按档取色、头像懒取一次、出不了卡退成一句", async () => {
		await clearCaptures();
		const probe = currentProbe();
		const ctx = probe.ctx;
		if (!ctx) throw new Error("假来源还没 start");
		const avatar = Buffer.from(png(8, 8, 21));
		const stored = await ctx.storeImage(avatar);
		if (!stored.ok) throw new Error("storeImage 存头像失败");
		probe.viewerAvatarRef = stored.ref;
		const who = SUB.alice;
		const ext = EXT.alice;
		const superchat = (over: Record<string, unknown> = {}) =>
			probe.reportLiveInteraction(ext, {
				kind: "superchat",
				viewer: { id: "42", name: "观众小明P32" },
				text: "加油P32",
				amount: 100,
				currency: "CNY",
				tier: { rank: 3, durationSec: 300 },
				...over,
			} as Parameters<typeof probe.reportLiveInteraction>[1]);
		const htmlOf = (text: string) => renderedHtml.find((page) => page.includes(text));

		await patchCore({
			defaults: { features: { superchat: true }, superchat: { minAmount: 30 } },
		});
		try {
			// 人民币低于门槛:不推,也不取头像(懒取口只在确定要出卡时问)。
			superchat({ amount: 10 });
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(await captures()).toEqual([]);
			expect(probe.viewerAvatarAsked).toEqual([]);

			// 人民币过门槛:出卡,档 3 取默认配色表第 3 色;观众头像经来源的懒取口取一次并画进卡。
			superchat();
			await settledCaptures(1);
			const first = await captures();
			expect(first[0]).toMatchObject({ kind: "image", images: 1 });
			const firstHtml = htmlOf("加油P32");
			expect(firstHtml, "醒目留言没画成卡").toBeDefined();
			expect(firstHtml).toContain("#a29bfe");
			expect(firstHtml).toContain(avatar.toString("base64"));
			expect(probe.viewerAvatarAsked).toEqual([`${ext}:42`]);

			// 非人民币:拿美元的 5 去比人民币的 30 没有意义,放行;换一档(1)就换一套配色。
			superchat({ amount: 5, currency: "USD", tier: { rank: 1 }, text: "美元P32" });
			await settledCaptures(2);
			const secondHtml = htmlOf("美元P32");
			expect(secondHtml, "非人民币的醒目留言没出卡").toBeDefined();
			expect(secondHtml).toContain("#a8e6cf");
			expect(probe.viewerAvatarAsked).toEqual([`${ext}:42`, `${ext}:42`]);

			// 出不了卡(出图关着):退成一句。来源给了就用来源那句;没给就用核心字典里那句中性的。
			await patchCore({ defaults: { cards: { enabled: false } } });
			superchat({ text: "来源兜底P32", fallbackText: "来源给的兜底P32" });
			await settledCaptures(3);
			expect((await captures())[2]).toMatchObject({ kind: "text", text: "来源给的兜底P32" });
			superchat({ text: "默认兜底P32" });
			await settledCaptures(4);
			const fallback = (await captures())[3];
			expect(fallback?.text).toContain("观众小明P32");
			expect(fallback?.text).toContain("默认兜底P32");
			expect(fallback?.text).toContain("醒目留言");
			// 没有卡可取,懒取口一次都没被多问。
			expect(probe.viewerAvatarAsked).toHaveLength(2);
			expect(await livePushCount(who, "superchat")).toBe(4);
		} finally {
			probe.viewerAvatarRef = undefined;
			await patchCore({
				defaults: {
					features: { superchat: false },
					superchat: { minAmount: 0 },
					cards: { enabled: true },
				},
			});
		}
		drove("P32");
	}, 60_000);

	// 验红:会员分支不按 `program` 认体系 / 不读按体系存的 minRank / 声明档不取档色与徽章 / custom 不用事件的档名,各段红。
	it("P33 会员:custom 体系、按体系的 minRank、声明档带徽章与按档换色、自定义文案的 {tier}", async () => {
		await clearCaptures();
		const probe = currentProbe();
		const who = SUB.alice;
		const ext = EXT.alice;
		expect(probe.tierIconRef, "假来源 start 里没把徽章存进图库").toBeDefined();
		const htmlBefore = renderedHtml.length;
		const membership = (over: Record<string, unknown> = {}) =>
			probe.reportLiveInteraction(ext, {
				kind: "membership",
				viewer: { id: "42", name: "观众P33" },
				program: IN_PROCESS_PROGRAM_ID,
				tier: { key: IN_PROCESS_TIER_KEY, name: "事件里的名字", rank: 2 },
				...over,
			} as Parameters<typeof probe.reportLiveInteraction>[1]);
		const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

		await patchCore({
			defaults: {
				features: { membership: true },
				membership: { minRank: { [IN_PROCESS_PROGRAM_ID]: 2 } },
			},
		});
		try {
			// 按体系的门槛:rank 1 低于 2,不推、不出卡。
			membership({ tier: { key: IN_PROCESS_TIER_KEY, name: "事件里的名字", rank: 1 } });
			await settle();
			expect(await captures()).toEqual([]);

			// 过门槛:出卡,档名 / 档色 / 徽章都取声明的那一档;徽章在描述符里,不问懒取口。
			membership();
			await settledCaptures(1);
			expect((await captures())[0]).toMatchObject({ kind: "image", images: 1 });
			const cardHtml = renderedHtml
				.slice(htmlBefore)
				.find((html) => html.includes(IN_PROCESS_TIER_ICON_BASE64));
			expect(cardHtml, "会员卡没画上描述符里的徽章").toBeDefined();
			expect(cardHtml).toContain("#112233");
			expect(cardHtml).toContain("#445566");
			// 默认会员卡不画 tierName;假来源的档像 B 站大航海一样声明了带 `{tier}` 的宣告语,档名经它上卡。
			expect(cardHtml).toContain("金牌");
			expect(cardHtml).not.toContain("事件里的名字");
			expect(probe.tierIconAsked).toEqual([]);

			// 自定义文案 + custom 体系:按体系的门槛、事件带来的档名;没有徽章、不出卡。
			await patchCore({
				defaults: {
					membership: {
						minRank: {
							[IN_PROCESS_PROGRAM_ID]: 2,
							[IN_PROCESS_CUSTOM_PROGRAM_ID]: 3,
						},
					},
					templates: {
						membership: {
							[IN_PROCESS_CUSTOM_PROGRAM_ID]: {
								enabled: true,
								default: { template: "{viewer} 成为了 {tier}", imageUrl: "" },
								tiers: {},
							},
						},
					},
				},
			});
			const custom = (rank: number) =>
				membership({
					program: IN_PROCESS_CUSTOM_PROGRAM_ID,
					tier: { key: "vip", name: "自定义贵族", rank },
				});
			custom(2);
			await settle();
			expect(await captures()).toHaveLength(1);
			custom(3);
			await settledCaptures(2);
			expect((await captures())[1]).toMatchObject({
				kind: "text",
				text: "观众P33 成为了 自定义贵族",
			});
			expect(renderedHtml.slice(htmlBefore)).toHaveLength(1);
			expect(probe.tierIconAsked).toEqual([]);
			expect(await livePushCount(who, "membership")).toBe(2);
		} finally {
			await patchCore({
				defaults: {
					features: { membership: false },
					membership: { minRank: {} },
				},
			});
		}
		drove("P33");
	}, 60_000);

	// 验红:核心下播卡不带 `recapAnchors` → 没有词云 / 总结;总结锚点不带 `aiMessages` → 两个目标都收模板。
	it("P34 下播回顾:词云卡、模板总结(够人数才有)、AI 版按目标挑", async () => {
		await clearCaptures();
		const probe = currentProbe();
		const who = SUB.alice;
		const ext = EXT.alice;
		aiAsked.length = 0;
		const htmlBefore = renderedHtml.length;
		const names = ["回顾甲", "回顾乙", "回顾丙", "回顾丁", "回顾戊"];

		await patchCore({
			ai: {
				enabled: true,
				writing: {
					liveSummary: {
						isOnByDefault: false,
						byTarget: { [ID.group]: true, [ID.master]: false },
					},
				},
			},
			defaults: {
				features: {
					extras: { wordcloud: true, liveSummary: true },
				},
				templates: {
					liveSummary: "P34总结 {fanclub}|{dmc}|{dca}|{un1}|{dc1}",
				},
			},
		});
		try {
			probe.reportLive(ext, {
				kind: "start",
				startedAt: new Date(Date.now() - HOUR_MS).toISOString(),
				details: { title: "回顾场次P34" },
			});
			// 50 个不同热词够词云门槛;5 个不同观众够总结门槛。
			for (let i = 0; i < 50; i += 1) {
				probe.reportLiveInteraction(ext, {
					kind: "viewerChat",
					viewer: { id: `8${i % names.length}`, name: names[i % names.length] ?? "" },
					text: `P34word${String(i).padStart(2, "0")}`,
				});
			}
			probe.reportLive(ext, { kind: "end", endedAt: new Date().toISOString() });

			await vi.waitFor(
				async () => {
					const entries = await captures();
					expect(
						entries.some((entry) => entry.targetId === ID.group && entry.text === AI_REPLY),
					).toBe(true);
					expect(
						entries.some(
							(entry) =>
								entry.targetId === ID.master &&
								entry.text?.startsWith("P34总结") &&
								entry.text.includes(ALICE_FAN_CLUB_NAME),
						),
					).toBe(true);
					expect(
						renderedHtml
							.slice(htmlBefore)
							.some((html) => html.includes("P34word00") && html.includes("P34word49")),
					).toBe(true);
				},
				{ timeout: 20_000 },
			);
			expect(aiAsked.join("\n")).toContain(`粉丝牌名：${ALICE_FAN_CLUB_NAME}`);
			expect(await livePushCount(who, "liveEnd")).toBeGreaterThanOrEqual(1);
		} finally {
			await patchCore({
				ai: {
					enabled: false,
					writing: {
						liveSummary: { isOnByDefault: true, byTarget: {} },
					},
				},
				defaults: {
					features: {
						extras: { wordcloud: false, liveSummary: false },
					},
					templates: {
						// 恢复默认 = 删键(文字模板只存改过的,发 null 回到跟随默认)
						liveSummary: null,
					},
				},
			});
		}
		drove("P34");
	}, 60_000);

	// 验红:下播卡不接核心收集器 / 总结不带资料的 `fanClubName` / 直播设置不折 `aiOverride`,对应段红。
	it("P35 模板变量 {tier}、{fanclub}、{time}、{follower}、{follower_change}、{watched} 由假来源交得出", async () => {
		await clearCaptures();
		const probe = currentProbe();
		const who = SUB.alice;
		const ext = EXT.alice;
		const names = ["变量甲", "变量乙", "变量丙", "变量丁", "变量戊"];

		await patchCore({
			defaults: {
				features: {
					membership: true,
					liveStreaming: true,
					extras: { wordcloud: false, liveSummary: true },
				},
				liveStreaming: { streamingIntervalHours: 2 },
				templates: {
					liveStart: "P35START {time}|{follower}",
					liveStreaming: "P35LIVE {time}|{watched}",
					liveEnd: "P35END {time}|{follower_change}",
					liveSummary: "P35SUMMARY {fanclub}|{dmc}|{dca}|{un1}|{dc1}",
					membership: {
						[IN_PROCESS_CUSTOM_PROGRAM_ID]: {
							enabled: true,
							default: { template: "P35TIER {tier}", imageUrl: "" },
							tiers: {},
						},
					},
				},
			},
		});
		try {
			probe.liveStatusOutcome = {
				ok: true,
				kind: "live",
				details: { title: "变量场次P35", totalViewers: 314 },
			};
			probe.reportLive(ext, {
				kind: "start",
				startedAt: new Date(Date.now() - 2 * HOUR_MS + 2_000).toISOString(),
				details: { title: "变量场次P35", totalViewers: 314 },
			});
			await vi.waitFor(
				async () => expect(await livePushCount(who, "liveStreaming")).toBeGreaterThanOrEqual(1),
				{ timeout: 15_000 },
			);
			for (let i = 0; i < 5; i += 1) {
				probe.reportLiveInteraction(ext, {
					kind: "viewerChat",
					viewer: { id: `9${i}`, name: names[i] ?? "" },
					text: `变量弹幕${i}`,
				});
			}
			probe.reportLiveInteraction(ext, {
				kind: "membership",
				viewer: { id: "95", name: "变量观众" },
				program: IN_PROCESS_CUSTOM_PROGRAM_ID,
				tier: { key: "vip", name: "变量贵族", rank: 3 },
			});
			probe.reportLive(ext, { kind: "end", endedAt: new Date().toISOString() });

			await vi.waitFor(
				async () => {
					const texts = (await captures()).flatMap((entry) =>
						entry.text === undefined ? [] : [entry.text],
					);
					expect(texts).toContain("P35TIER 变量贵族");
					expect(texts.some((text) => text.startsWith("P35START "))).toBe(true);
					expect(texts.some((text) => text.startsWith("P35LIVE "))).toBe(true);
					expect(texts.some((text) => text.startsWith("P35END "))).toBe(true);
					expect(texts.some((text) => text.startsWith("P35SUMMARY "))).toBe(true);
				},
				{ timeout: 20_000 },
			);

			const texts = (await captures()).flatMap((entry) =>
				entry.text === undefined ? [] : [entry.text],
			);
			const start = texts.find((text) => text.startsWith("P35START "));
			const streaming = texts.find((text) => text.startsWith("P35LIVE "));
			const end = texts.find((text) => text.startsWith("P35END "));
			const summary = texts.find((text) => text.startsWith("P35SUMMARY "));
			// 开播时刻特意摆在两小时间隔前 2 秒，让周期核对马上触发；开播卡此刻只播了约 1:59:58。
			// 秒数随认出场次的快慢浮动，只钉到分钟。
			expect(start).toMatch(/^P35START 1小时59分\d+秒\|1\.2万$/);
			expect(streaming).toMatch(/^P35LIVE [^|]+\|314$/);
			expect(end).toMatch(/^P35END [^|]+\|0$/);
			expect(summary).toContain(`P35SUMMARY ${ALICE_FAN_CLUB_NAME}|5|5|`);
			expect(streaming).toContain("2小时");
			expect(end).toContain("2小时");
		} finally {
			probe.liveStatusOutcome = { ok: true, kind: "offline" };
			await patchCore({
				defaults: {
					features: {
						membership: false,
						liveStreaming: false,
						extras: { wordcloud: false, liveSummary: false },
					},
					liveStreaming: { streamingIntervalHours: 1 },
					// 恢复默认 = 删键(文字模板只存改过的,发 null 回到跟随默认)
					templates: {
						liveStart: null,
						liveStreaming: null,
						liveEnd: null,
						liveSummary: null,
						membership: { [IN_PROCESS_CUSTOM_PROGRAM_ID]: null },
					},
				},
			});
		}
		drove("P35");
	}, 60_000);

	// 验红:`ws/channels.ts` 转 `live-session-changed` 时给帧多带一格 `uid`,WS 那段红;`routes/live.ts` 的行漏掉 `identity`
	// (或带回 `uid`),在播列表那段红;`live-sessions.ts` 不发 `live-viewers-changed`,人数那段红。
	it("P36 直播事件按订阅 id:总线与 WS 的 live-session-changed / live-viewers-changed、在播列表里都没有 uid / roomId", async () => {
		const probe = currentProbe();
		const who = SUB.alice;
		const ext = EXT.alice;
		const BANNED = ["uid", "roomId"] as const;
		const isIso = (value: unknown): boolean =>
			typeof value === "string" && new Date(value).toISOString() === value;
		const busFrom = liveBusEvents.length;
		const mine = () =>
			liveBusEvents
				.slice(busFrom)
				.filter((item) => (item.data as { subscriptionId?: string }).subscriptionId === who);
		const sessionKinds = () =>
			mine()
				.filter((item) => item.event === "live-session-changed")
				.map((item) => (item.data as { kind: string }).kind);
		const startedAt = new Date(Date.now() - 60_000).toISOString();
		const endedAt = new Date().toISOString();
		const watch = await watchFrames("push-events");
		try {
			probe.reportLive(ext, {
				kind: "start",
				startedAt,
				details: { title: "开播标题P36", totalViewers: 11 },
			});
			probe.reportLive(ext, { kind: "status", isLive: true, details: { totalViewers: 33 } });

			// 在播期间的列表:带 identity,深搜没有 uid / roomId。
			const rows = await vi.waitFor(async () => {
				const res = await okRes(await api("/api/live/listening"));
				const body = (await res.json()) as LiveListeningEntry[];
				expect(body.some((row) => row.subscriptionId === who)).toBe(true);
				return body;
			});
			const row = rows.find((entry) => entry.subscriptionId === who);
			expect(row).toMatchObject({
				subscriptionId: who,
				identity: { sourceKey: IN_PROCESS_KEY, externalId: ext },
				isLive: true,
			});
			expect(hasKey(rows, BANNED)).toBe(false);

			probe.reportLive(ext, { kind: "end", endedAt });
			await vi.waitFor(() => expect(sessionKinds()).toContain("end"));

			// 总线:start / status / end 都按订阅 id,时刻是 ISO。
			const kinds = sessionKinds();
			expect(kinds).toContain("start");
			expect(kinds).toContain("status");
			const sessionOf = (kind: string) =>
				mine()
					.filter((item) => item.event === "live-session-changed")
					.map(
						(item) =>
							item.data as { kind: string; session?: { startedAt?: string }; endedAt?: string },
					)
					.find((change) => change.kind === kind);
			expect(isIso(sessionOf("start")?.session?.startedAt)).toBe(true);
			expect(sessionOf("start")?.session?.startedAt).toBe(startedAt);
			expect(sessionOf("end")?.endedAt).toBe(endedAt);
			expect(isIso(sessionOf("end")?.endedAt)).toBe(true);
			expect(isIso(sessionOf("end")?.session?.startedAt)).toBe(true);
			const viewers = mine()
				.filter((item) => item.event === "live-viewers-changed")
				.map((item) => item.data);
			expect(viewers).toContainEqual({ subscriptionId: who, totalViewers: 33 });
			expect(hasKey(mine(), BANNED)).toBe(false);

			// WS push-events:同样两种帧出现,整帧深搜没有 uid / roomId。
			await vi.waitFor(() => {
				const events = watch.frames.map((frame) => frame.event);
				expect(events).toContain("live-session-changed");
				expect(events).toContain("live-viewers-changed");
			});
			const liveFrames = watch.frames.filter(
				(frame) => frame.event === "live-session-changed" || frame.event === "live-viewers-changed",
			);
			for (const frame of liveFrames) {
				expect(frame.type).toBe("push-events");
				expect((frame.data as { subscriptionId?: string }).subscriptionId).toBe(who);
				expect(hasKey(frame, ["uid"]), JSON.stringify(frame)).toBe(false);
				expect(hasKey(frame, BANNED), JSON.stringify(frame)).toBe(false);
			}
		} finally {
			watch.close();
		}
		drove("P36");
	});

	// 验红:`read-only-tools.ts` 的 profile 回落不调来源,第一段红;订阅着且有缓存的也调来源,第二段红。
	it("P37 fetchProfile 经女仆的资料工具:没订阅的人 identity 原样递给来源、资料喂回;订阅着有缓存的不问来源;来源回失败时话原样喂回", async () => {
		const probe = currentProbe();
		probe.profileAsked.length = 0;
		try {
			const ghost = "ghost-ext";
			const found = await askMaid({
				name: "get_creator_profile",
				args: { creator: `${IN_PROCESS_KEY}:${ghost}` },
			});
			expect(probe.profileAsked).toEqual([{ sourceKey: IN_PROCESS_KEY, externalId: ghost }]);
			expect(found.seen).toContain(`资料-${ghost}`);
			expect(found.seen).toContain("314");
			expect(found.seen).toContain("现查的来源资料");
			expect(found.tools).toEqual([
				expect.objectContaining({ name: "get_creator_profile", ok: true }),
			]);

			probe.profileAsked.length = 0;
			const cached = await askMaid({
				name: "get_creator_profile",
				args: { creator: `${IN_PROCESS_KEY}:${EXT.alice}` },
			});
			expect(probe.profileAsked).toEqual([]);
			expect(cached.seen).toContain(ALICE_PROFILE_NAME);
			expect(cached.tools).toEqual([
				expect.objectContaining({ name: "get_creator_profile", ok: true }),
			]);

			probe.profileOutcome = fail("rate_limited", "对拍源查资料被风控了");
			const limited = await askMaid({
				name: "get_creator_profile",
				args: { creator: `${IN_PROCESS_KEY}:${ghost}` },
			});
			expect(limited.seen).toContain("对拍源查资料被风控了");
			expect(limited.tools).toEqual([
				expect.objectContaining({ name: "get_creator_profile", ok: false }),
			]);
		} finally {
			probe.profileOutcome = undefined;
		}
		drove("P37");
	});

	// 验红:`pipeline.ts` 递给女仆的取标签口改成只回外部 id,女仆那一段第一处红(没有「对拍源 · …」);
	// contract 的 `subscriptionIdentityLabel` 不看 noun,第二处红(没有「号 …」);
	// `pipeline.ts` 给 `bindLivePush` 的 `identityLabel` 换成只回外部 id,直播那一段红。
	// 没资料名的订阅:开机首轮资料刷新把启用着的都拉出了名字,所以先让来源查不到资料,再启用停着的 carol;
	// 收尾复原(P30 之后 carol 是停用的,别的行不依赖她此刻的状态)。
	it("P38 身份标签:没资料名的订阅,女仆订阅视图与开播卡文字里的名字是「平台名 · 外部 id」;描述符声明了 externalIdNoun 就是「叫法 外部 id」", async () => {
		const probe = currentProbe();
		const patchCarol = async (enabled: boolean) =>
			okRes(await api(`/api/subscriptions/${SUB.carol}`, json({ enabled }, "PATCH")));
		const liveStartText = async (round: number): Promise<string> => {
			await clearCaptures();
			probe.reportLive(EXT.carol, {
				kind: "start",
				startedAt: new Date().toISOString(),
				details: { title: "开播标题P38" },
			});
			const sent = await settledCaptures(1);
			probe.reportLive(EXT.carol, { kind: "end", endedAt: new Date().toISOString() });
			await vi.waitFor(async () => expect(await livePushCount(SUB.carol, "liveEnd")).toBe(round), {
				timeout: 15_000,
			});
			return sent.map((entry) => entry.text ?? "").join("\n");
		};
		// carol 出厂就路由了开播(见 SUB 的出厂数据),直播这一段直接用。
		const carolListening = async () =>
			(
				(await (await okRes(await api("/api/live/listening"))).json()) as LiveListeningEntry[]
			).filter((row) => row.subscriptionId === SUB.carol);
		try {
			probe.profileOutcome = fail("unavailable", "对拍源暂时查不到资料");
			await patchCarol(true);
			expect(await carolListening()).toEqual([]);

			const plain = await askMaid({ name: "list_subscriptions", args: {} });
			expect(plain.seen).toContain(`${IN_PROCESS_LABEL} · ${EXT.carol}`);
			expect(await liveStartText(1)).toMatch(
				new RegExp(`(^|\\n)${IN_PROCESS_LABEL} · ${EXT.carol} 开播啦`),
			);

			probe.descriptor.externalIdNoun = "号";
			const named = await askMaid({ name: "list_subscriptions", args: {} });
			expect(named.seen).toContain(`号 ${EXT.carol}`);
			expect(named.seen).not.toContain(`${IN_PROCESS_LABEL} · ${EXT.carol}`);
			expect(await liveStartText(2)).toMatch(new RegExp(`(^|\\n)号 ${EXT.carol} 开播啦`));
		} finally {
			probe.descriptor.externalIdNoun = undefined;
			probe.profileOutcome = undefined;
			await patchCarol(false);
		}
		drove("P38");
	}, 30_000);

	/** 经 devtools 立刻跑一轮资料刷新(不等 cron),跑完才回。 */
	const refreshProfilesNow = async (): Promise<void> => {
		await okRes(await api("/api/dev/run/core.profiles.refresh-now", json({ params: {} })));
	};

	// 验红:`runtime/profile-refresh.ts` 的一轮跳过在册的非 B 站来源,不调来源,问题那一段第一处红;
	// `not_found` 不记 creator_not_found,问题那一段红;成功不清,清除那一段红;资料缓存不写头像(或粉丝团名),缓存那一段红。
	// 没资料名的订阅用出厂停用的 carol:先让来源查不到(not_found),再启用她;收尾停回去(停用时问题自己清)。
	it("P39 资料刷新:按来源拉资料写进缓存(名字、头像引用、简介、粉丝数、粉丝团名);not_found 记成关于这条订阅的 creator_not_found、成功后清;开播卡上的名字是新资料名", async () => {
		const probe = currentProbe();
		const patchCarol = async (enabled: boolean) =>
			okRes(await api(`/api/subscriptions/${SUB.carol}`, json({ enabled }, "PATCH")));
		const carolProblems = async () =>
			(await problems()).filter(
				(row) =>
					row.reporter === IN_PROCESS_KEY &&
					row.code === "creator_not_found" &&
					row.about !== undefined &&
					"subscriptionId" in row.about &&
					row.about.subscriptionId === SUB.carol,
			);
		const carolProfile = async () => {
			const res = await okRes(await api("/api/subscriptions"));
			const rows = (await res.json()) as Array<{
				id: string;
				cachedProfile?: {
					name?: string;
					avatar?: string;
					sign?: string;
					fans?: number;
					fanClubName?: string;
				};
			}>;
			return rows.find((row) => row.id === SUB.carol)?.cachedProfile;
		};
		const stored = await probe.ctx?.storeImage(Buffer.from(png(8, 8, 39)));
		if (!stored?.ok) throw new Error("storeImage 存图失败");
		try {
			// 查不到:来源回 not_found,核心记一条关于 carol 的问题,不写资料。
			probe.profileOutcome = fail("not_found", "对拍源没有这个人");
			probe.profileAsked.length = 0;
			await patchCarol(true);
			await refreshProfilesNow();
			expect(probe.profileAsked).toContainEqual({
				sourceKey: IN_PROCESS_KEY,
				externalId: EXT.carol,
			});
			await vi.waitFor(async () => expect(await carolProblems()).toHaveLength(1));
			expect((await carolProblems())[0]?.message).toContain("对拍源没有这个人");
			expect((await carolProfile())?.name).toBeUndefined();

			// 查得到:资料各格进缓存(头像是图库引用,读得出来),问题清掉。
			probe.profileOutcome = ok({
				name: "卡罗资料名P39",
				avatar: stored.ref,
				bio: "卡罗的简介P39",
				followers: 4242,
				fanClubName: "卡罗团P39",
			});
			await refreshProfilesNow();
			await vi.waitFor(async () =>
				expect(await carolProfile()).toMatchObject({
					name: "卡罗资料名P39",
					avatar: stored.ref,
					bio: "卡罗的简介P39",
					followers: 4242,
					fanClubName: "卡罗团P39",
				}),
			);
			expect(await carolProblems()).toEqual([]);
			const image = await api(`/api/images/${stored.ref}`);
			expect(image.status).toBe(200);

			// 资料名换了,开播卡上的名字跟着换。
			await clearCaptures();
			probe.reportLive(EXT.carol, {
				kind: "start",
				startedAt: new Date().toISOString(),
				details: { title: "开播标题P39" },
			});
			const sent = await settledCaptures(1);
			expect(sent.map((entry) => entry.text ?? "").join("\n")).toMatch(
				/(^|\n)卡罗资料名P39 开播啦/,
			);
			probe.reportLive(EXT.carol, { kind: "end", endedAt: new Date().toISOString() });
			await vi.waitFor(async () => expect(await livePushCount(SUB.carol, "liveEnd")).toBe(3), {
				timeout: 15_000,
			});
		} finally {
			probe.profileOutcome = undefined;
			await patchCarol(false);
		}
		drove("P39");
	}, 30_000);

	// 验红:`ws/channels.ts` 转 `followers-refreshed` 时给每个条目多带一格 `uid`,WS 那段红;
	// 资料刷新给条目少了 `identity`,两段都红。
	it("P40 followers-refreshed:WS 帧与 GET /api/stats/followers 的条目带 identity(假来源的键、外部 id),整个帧与整个回应里没有 uid / extensionId", async () => {
		const BANNED = ["uid", "extensionId"] as const;
		const watch = await watchFrames("push-events");
		try {
			await refreshProfilesNow();
			await vi.waitFor(() => {
				const frame = watch.frames.find((one) => one.event === "followers-refreshed");
				expect(frame).toBeDefined();
				const data = frame?.data as { entries: Array<{ subscriptionId: string }> } | undefined;
				expect(data?.entries.some((entry) => entry.subscriptionId === SUB.alice)).toBe(true);
			});
			const frames = watch.frames.filter((one) => one.event === "followers-refreshed");
			for (const frame of frames) {
				expect(frame.type).toBe("push-events");
				expect(hasKey(frame, BANNED), JSON.stringify(frame)).toBe(false);
			}
			const last = frames.at(-1)?.data as {
				entries: Array<{ subscriptionId: string; identity?: unknown; current?: number }>;
			};
			expect(last.entries.find((entry) => entry.subscriptionId === SUB.alice)).toMatchObject({
				identity: { sourceKey: IN_PROCESS_KEY, externalId: EXT.alice },
				current: ALICE_PROFILE.followers,
			});
			for (const entry of last.entries) expect(entry.identity, entry.subscriptionId).toBeDefined();

			const res = await okRes(await api("/api/stats/followers"));
			const body = (await res.json()) as { entries: Array<{ subscriptionId: string }> };
			expect(hasKey(body, BANNED), JSON.stringify(body)).toBe(false);
			expect(body.entries.find((entry) => entry.subscriptionId === SUB.alice)).toMatchObject({
				identity: { sourceKey: IN_PROCESS_KEY, externalId: EXT.alice },
				current: ALICE_PROFILE.followers,
			});
		} finally {
			watch.close();
		}
		drove("P40");
	});

	// 验红:`source-context.ts` 的 `reportProfile` 去掉「只取启用中的」,停用的 carol 那一格红;
	// 收口(`reported-profiles.ts`)写完不叫 `refreshReportedEntries`,面板那一行不当场变,最后一段红;
	// 收口不记「在记」(`recordActive`),`recording.followers` 那一段红。
	// 用 erin(同一个人遗留的两条启用订阅)当收的一方、停用的 carol 当不收的一方。
	it("P47 reportProfile:名字、头像(图库引用)、简介、粉丝数、粉丝团名进启用中订阅的资料缓存;停用的不收;面板那一行当场跟着变", async () => {
		const probe = currentProbe();
		const profiles = async () => {
			const res = await okRes(await api("/api/subscriptions"));
			const rows = (await res.json()) as Array<{
				id: string;
				cachedProfile?: Record<string, unknown>;
			}>;
			return new Map(rows.map((row) => [row.id, row.cachedProfile]));
		};
		const stored = await probe.ctx?.storeImage(Buffer.from(png(8, 8, 46)));
		if (!stored?.ok) throw new Error("storeImage 存图失败");
		const carolBefore = (await profiles()).get(SUB.carol);

		probe.reportProfile(EXT.erin, {
			name: "艾琳资料名P47",
			avatar: stored.ref,
			bio: "艾琳的简介P47",
			followers: 4646,
			fanClubName: "艾琳团P47",
		});
		probe.reportProfile(EXT.carol, { name: "卡罗不该收P47", followers: 1 });

		// 资料缓存是排队写的:等到名字出现。
		const expected = {
			name: "艾琳资料名P47",
			avatar: stored.ref,
			bio: "艾琳的简介P47",
			followers: 4646,
			fanClubName: "艾琳团P47",
		};
		await vi.waitFor(async () => {
			const got = await profiles();
			expect(got.get(SUB.erin1)).toMatchObject(expected);
			expect(got.get(SUB.erin2)).toMatchObject(expected);
		});
		// 停用的 carol:不收(上面两份是同一个队列里的,erin 落了 carol 若收早已落)。
		expect((await profiles()).get(SUB.carol)).toEqual(carolBefore);

		// 没给的格沿用原来的:这次只改名字与粉丝数。
		probe.reportProfile(EXT.erin, { name: "艾琳新名P47", followers: 4700 });
		await vi.waitFor(async () =>
			expect((await profiles()).get(SUB.erin1)).toMatchObject({
				name: "艾琳新名P47",
				avatar: stored.ref,
				bio: "艾琳的简介P47",
				followers: 4700,
				fanClubName: "艾琳团P47",
			}),
		);

		// 面板那一行当场跟着变:不等下一轮资料刷新,GET /api/stats/followers 里 erin 的当前数就是 4700。
		await vi.waitFor(async () => {
			const res = await okRes(await api("/api/stats/followers"));
			const body = (await res.json()) as {
				entries: Array<{ subscriptionId: string; current?: number }>;
			};
			expect(body.entries.find((entry) => entry.subscriptionId === SUB.erin1)?.current).toBe(4700);
			expect(body.entries.find((entry) => entry.subscriptionId === SUB.carol)).toBeUndefined();
		});

		// 带粉丝数的上报让统计记「这个小时拉过资料」(followers 那一格;carol 在 P39 里记过,不能拿来比)。每轮换一个 `days` 绕开总览缓存。
		let days = 20;
		await vi.waitFor(
			async () => {
				const res = await okRes(await api(`/api/stats/overview?days=${days++}&tz=0`));
				const rows = ((await res.json()) as StatsOverviewResponse).rows;
				const followersRecorded = (id: string) =>
					rows
						.find((row) => row.subscriptionId === id)
						?.recording.followers.some((d) => d === true);
				expect(followersRecorded(SUB.erin1)).toBe(true);
				expect(followersRecorded(SUB.erin2)).toBe(true);
			},
			{ timeout: 10_000, interval: 200 },
		);
		drove("P47");
	}, 30_000);

	// 验红:`read-only-tools.ts` 里 `recentPosts` 一支不按订阅 id 读统计仓(回空数组),作品那段红;
	// `stats` 一支回 `not_found`,统计那段红;`liveNowFromTable` 恒回 `idle`,在播那段红。
	it("P41 get_creator_posts / get_creator_stats / get_live_status 对假来源的订阅按 creator 答得出:作品、统计、在播都是夹具里写死的内容", async () => {
		const probe = currentProbe();
		const creator = `${IN_PROCESS_KEY}:${EXT.alice}`;
		try {
			// 作品:报一条带标题与摘要、发布得最晚的作品,统计仓落一行之后女仆读得到,话里带发布时间、标题、摘要。
			await clearCaptures();
			probe.ctx?.reportPost(
				EXT.alice,
				textReport("p41", "小爱", "对拍P41的作品摘要", {
					title: "对拍P41的作品标题",
					// 比前面各行都晚:女仆只读最近 5 条、新的在前。
					publishedAt: "2026-10-22T08:00:00.000Z",
				}),
			);
			await settledCaptures(1);
			await vi.waitFor(async () =>
				expect((await statsPostRows(SUB.alice)).some((row) => row.id === "p41")).toBe(true),
			);
			const posts = await askMaid({ name: "get_creator_posts", args: { creator } });
			expect(posts.seen).toContain("对拍P41的作品标题");
			expect(posts.seen).toContain("对拍P41的作品摘要");
			expect(posts.tools).toEqual([
				expect.objectContaining({ name: "get_creator_posts", ok: true }),
			]);

			// 统计:总览里 alice 那一行,当前粉丝取资料刷新写下的粉丝数。
			const stats = await askMaid({ name: "get_creator_stats", args: { creator, days: "7" } });
			expect(stats.seen).toContain("近 7 天");
			expect(stats.seen).toContain(`当前粉丝: ${ALICE_PROFILE.followers}`);
			expect(stats.tools).toEqual([
				expect.objectContaining({ name: "get_creator_stats", ok: true }),
			]);

			// 在播:没开播答「未开播」,开播后话里有标题,下播后回到「未开播」。
			const idle = await askMaid({ name: "get_live_status", args: {} });
			expect(idle.seen).toContain(`${ALICE_PROFILE_NAME}：未开播`);
			probe.reportLive(EXT.alice, {
				kind: "start",
				startedAt: new Date().toISOString(),
				details: { title: "开播标题P41", totalViewers: 5 },
			});
			const live = await askMaid({ name: "get_live_status", args: {} });
			expect(live.seen).toContain(`${ALICE_PROFILE_NAME}：直播中「开播标题P41」`);
			expect(live.tools).toEqual([expect.objectContaining({ name: "get_live_status", ok: true })]);
		} finally {
			probe.reportLive(EXT.alice, { kind: "end", endedAt: new Date().toISOString() });
			await clearCaptures();
		}
		drove("P41");
	});

	// 验红:读口不合并提供方技能、聊天目录不读读口、斜杠不读读口,三个阶段分别红。
	it("P43 提供方技能:列表里只读可见、聊天目录可自选、斜杠正文进 system;撤登记后三处消失且点名 not_found", async () => {
		const probe = currentProbe();
		const claim = probe.aiToolProviderClaim;
		if (!claim) throw new Error("假来源没有登记 AI 工具提供方");
		const askWithSkill = async (skill: string) => {
			await patchCore({ ai: { enabled: true } });
			try {
				const created = await okRes(await api("/api/ai/conversations", json({})));
				const { conversation } = (await created.json()) as { conversation: { id: string } };
				aiLastSystem = "";
				const res = await api(
					`/api/ai/conversations/${conversation.id}/chat`,
					json({ message: "按技能做", skill }),
				);
				const text = await res.text();
				return { res, text, system: aiLastSystem };
			} finally {
				await patchCore({ ai: { enabled: false } });
			}
		};

		const listed = (await (await okRes(await api("/api/ai/skills"))).json()) as {
			list: Array<{ name: string; builtin: boolean }>;
		};
		expect(listed.list).toContainEqual(
			expect.objectContaining({ name: IN_PROCESS_SKILL_FULL_NAME, builtin: true }),
		);
		for (const name of [
			"weekly-report",
			"unsub-cleanup",
			"live-copy",
			"today-digest",
			"find-creator",
			"creator-pk",
		]) {
			expect(
				listed.list.some((skill) => skill.name === name),
				name,
			).toBe(true);
		}

		const loaded = await askMaid({
			name: "load_skill",
			args: { name: IN_PROCESS_SKILL_FULL_NAME },
		});
		expect(aiLoadSkillCatalog?.names).toContain(IN_PROCESS_SKILL_FULL_NAME);
		expect(aiLoadSkillCatalog?.description).toContain(IN_PROCESS_SKILL_FULL_NAME);
		expect(loaded.seen).toContain(IN_PROCESS_SKILL_BODY);

		const slash = await askWithSkill(IN_PROCESS_SKILL_FULL_NAME);
		expect(slash.res.status).toBeLessThan(300);
		expect(slash.system).toContain(IN_PROCESS_SKILL_BODY);

		claim.dispose();
		const after = (await (await okRes(await api("/api/ai/skills"))).json()) as {
			list: Array<{ name: string }>;
		};
		expect(after.list.some((skill) => skill.name === IN_PROCESS_SKILL_FULL_NAME)).toBe(false);

		await askMaid({ name: "load_skill", args: { name: IN_PROCESS_SKILL_FULL_NAME } });
		expect(aiLoadSkillCatalog?.names).not.toContain(IN_PROCESS_SKILL_FULL_NAME);

		const missing = await askWithSkill(IN_PROCESS_SKILL_FULL_NAME);
		expect(missing.res.status).toBe(404);
		expect(JSON.parse(missing.text)).toMatchObject({ code: "not_found" });

		if (probe.ctx) {
			probe.aiToolProviderClaim = probe.ctx.registerAiToolProvider(createInProcessAiToolProvider());
		}
		drove("P43");
	});

	// 验红:`read-only-tools.ts` 不把登记表交给常驻生成器,或登记表包工具时忘了命名空间,
	// 这条在请求工具表里找不到全名;`source-context.ts` 不接撤销把手,第二段还会挂着它。
	it("P42 来源登记的只读工具:请求里是命名空间全名,执行结果喂回且痕迹带标签;撤销后请求里没有、调用记未知工具", async () => {
		const probe = currentProbe();
		const claim = probe.aiToolProviderClaim;
		if (!claim) throw new Error("假来源没有登记 AI 工具提供方");
		const found = await askMaid({
			name: IN_PROCESS_ECHO_TOOL_NAME,
			args: { creator: EXT.alice },
		});
		expect(found.requestedTools[0]).toContain(IN_PROCESS_ECHO_TOOL_NAME);
		expect(found.seen).toContain(`回声: ${EXT.alice}`);
		expect(found.tools).toEqual([
			expect.objectContaining({
				name: IN_PROCESS_ECHO_TOOL_NAME,
				ok: true,
				label: IN_PROCESS_ECHO_TOOL_LABEL,
			}),
		]);

		claim.dispose();
		const missing = await askMaid({
			name: IN_PROCESS_ECHO_TOOL_NAME,
			args: { creator: EXT.alice },
		});
		expect(
			missing.requestedTools.every((names) => !names.includes(IN_PROCESS_ECHO_TOOL_NAME)),
		).toBe(true);
		expect(missing.tools).toEqual([
			expect.objectContaining({
				name: IN_PROCESS_ECHO_TOOL_NAME,
				ok: false,
				message: expect.stringContaining("未知工具"),
			}),
		]);
		drove("P42");
	});

	// 验红:`external-id.ts` 的核法改成永远放行,第一段红(不合格式的被收进了下一道闸,回的不是 invalid)。
	// 放在 P22 之前:P22 末尾把服务端关了。
	it("P23 外部 id 的格式:来源在描述符里声明,经接口新建订阅时不合格式的被拒(invalid、issues 点名 identity.externalId);合格式的过了这一道;没声明的不替它做主", async () => {
		const probe = currentProbe();
		const P23_SUBSCRIPTION_ID = "e2300000-0000-4000-8000-000000000023";
		const create = async (externalId: string) =>
			api(
				"/api/subscriptions",
				json(
					makeExtensionSubscription({
						id: P23_SUBSCRIPTION_ID,
						extensionId: IN_PROCESS_KEY,
						externalId,
					}),
				),
			);
		const failureOf = async (res: Response) =>
			(await res.json()) as {
				code: string;
				message: string;
				issues?: Array<{ path: string[] }>;
			};
		try {
			probe.descriptor.externalIdRegex = "[a-z]+[0-9]";
			const bad = await create("abc");
			expect(bad.status).toBe(400);
			const refusal = await failureOf(bad);
			expect(refusal.code).toBe("invalid");
			expect(refusal.message).toContain(IN_PROCESS_LABEL);
			expect(refusal.issues).toEqual([
				{ path: ["identity", "externalId"], message: expect.any(String) },
			]);
			// 整串匹配:前缀合格式、后面多一截也拒。
			expect((await create("abc1x")).status).toBe(400);

			// 合格式的过了这一道,建成(新建的门问登记表,在册的进程内来源认得;经接口新建另见 P52)。建完删掉,
			// 不留给后面的用例。
			const remove = async () =>
				expect(
					(await api(`/api/subscriptions/${P23_SUBSCRIPTION_ID}`, { method: "DELETE" })).status,
				).toBe(204);
			expect((await create("abc1")).status).toBe(200);
			await remove();

			// 没声明:核心不替来源做主,同一个 "abc" 不再被格式拦。
			probe.descriptor.externalIdRegex = undefined;
			expect((await create("abc")).status).toBe(200);
			await remove();
		} finally {
			probe.descriptor.externalIdRegex = undefined;
		}
		drove("P23");
	});

	// 验红:`createIntegrationContext` 的 `redact` 改成空函数,`ctx.redact` 登记的那个值在归档里原样出现,红;
	// `bootstrap.ts` 不把登记册交给日志出口,两个值都原样出现,红。
	// 放在 P22 之前:P22 末尾把服务端关了。
	it("P24 日志按值打码:来源 ctx.redact 登记的临时值与 ctx.secrets 存下的值,打进日志之后,归档(GET /api/system/logs)里都是 ***", async () => {
		const ctx = currentProbe().ctx;
		if (!ctx) throw new Error("假来源还没拿到 ctx");
		ctx.redact("FAKE-PARITY-TEMP-0001");
		const stored = await ctx.secrets.set("p24", "FAKE-PARITY-STORED-0002");
		expect(stored.ok).toBe(true);

		ctx.logger.warn("p24-log FAKE-PARITY-TEMP-0001 FAKE-PARITY-STORED-0002", {
			nested: "FAKE-PARITY-TEMP-0001",
		});

		const res = await okRes(await api("/api/system/logs?limit=500"));
		const text = await res.text();
		expect(text).not.toContain("FAKE-PARITY-TEMP-0001");
		expect(text).not.toContain("FAKE-PARITY-STORED-0002");
		const entries = (JSON.parse(text) as { entries: Array<{ msg: string; args?: unknown[] }> })
			.entries;
		const mine = entries.filter((entry) => entry.msg.startsWith("p24-log"));
		expect(mine.map((entry) => entry.msg)).toEqual(["p24-log *** ***"]);
		expect(mine[0]?.args).toEqual([{ nested: "***" }]);
		drove("P24");
	});

	// 验红:`link-previewer.ts` 退回直接用 B 站正则认链接(不问登记表),这条整条红(假解析器从没被问过)。
	// 验红:`/api/sources/:sourceKey/creators` 把来源的失败一律折成 not_found(旧 `/lookup` 的做法),风控那段红;
	// 新建订阅的门改回「键不是 bilibili 就只认装着的拓展」,建订阅那段红(404,没有这个来源)。
	// 放在 P22 之前:P22 末尾把服务端关了。
	it("P52 经接口搜人与新建订阅:搜人口把 q 原样交给假来源、候选照回、失败码原样;挑中的候选经接口建成订阅、资料由候选种", async () => {
		const probe = currentProbe();
		const asked = probe.searches.length;
		const found = (await (
			await okRes(
				await api(`/api/sources/${IN_PROCESS_KEY}/creators?q=${encodeURIComponent("对拍搜人P52")}`),
			)
		).json()) as CreatorsResponse;
		expect(probe.searches.slice(asked)).toEqual(["对拍搜人P52"]);
		expect(found.candidates).toEqual([
			{ externalId: "cand-1", name: "候选甲", followers: 11, bio: "候选甲的简介" },
			{ externalId: "cand-2", name: "候选乙" },
		]);

		probe.searchOutcome = fail("rate_limited", "对拍风控P52");
		try {
			const limited = await api(`/api/sources/${IN_PROCESS_KEY}/creators?q=x`);
			expect(limited.status).toBe(429);
			expect(await limited.json()).toEqual({ code: "rate_limited", message: "对拍风控P52" });
		} finally {
			probe.searchOutcome = undefined;
		}

		const [picked] = found.candidates;
		if (!picked) throw new Error("没有候选");
		const id = "e5200000-0000-4000-8000-000000000052";
		const created = await okRes(
			await api(
				"/api/subscriptions",
				json({
					...makeExtensionSubscription({
						id,
						extensionId: IN_PROCESS_KEY,
						externalId: picked.externalId,
					}),
					cachedProfile: { name: picked.name, followers: picked.followers },
				}),
			),
		);
		const row = ((await created.json()) as SubscriptionDTO[]).find((one) => one.id === id);
		expect(row?.identity).toEqual({ sourceKey: IN_PROCESS_KEY, externalId: "cand-1" });
		expect(row?.cachedProfile).toMatchObject({ name: "候选甲", followers: 11 });
		expect((await api(`/api/subscriptions/${id}`, { method: "DELETE" })).status).toBe(204);
		drove("P52");
	});

	it("P22 链接解析器:来源在 start 里登的解析器认领自己的链接 —— 关着不回、开了回一张图、冷却里不回第二张、逐目标关掉不回、能力支持时回原生分享;来源停下后没人再认", async () => {
		const probe = currentProbe();
		/** 往测试群贴一句话(必须传 `text`:缺省正文是 B 站链接,会去打真接口)。 */
		const say = async (text: string) =>
			okRes(await api("/api/dev/run/core.inbound.link", json({ params: { text } })));
		const quiet = () => new Promise((resolve) => setTimeout(resolve, 400));
		const htmlWith = (needle: string) => renderedHtml.filter((html) => html.includes(needle));
		await clearCaptures();

		// 总开关关着(默认):不问解析器、不回。
		await say("看 https://acme.invalid/link/a1");
		await quiet();
		expect(probe.linkResolves).toEqual([]);
		expect(await captures()).toEqual([]);

		// 开了:回一张图,送去出图的 HTML 里是假解析器交的正文。
		await patchCore({
			linkPreview: { enabled: true, cooldownSec: 60, isOnByDefault: true, replyForm: "image" },
		});
		await say("看 https://acme.invalid/link/a1");
		const first = await settledCaptures(1);
		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({ kind: "image", images: 1, targetName: expect.any(String) });
		expect(htmlWith(`${LINK_TITLE_PREFIX}a1`)).toHaveLength(1);
		expect(probe.linkResolves).toEqual(["https://acme.invalid/link/a1"]);

		// 同群同一条在冷却里:不再问、不再回。
		await say("又看 https://acme.invalid/link/a1");
		await quiet();
		expect(probe.linkResolves).toHaveLength(1);
		expect(await captures()).toHaveLength(1);

		// 同一个东西换了写法重贴:问一次(链接原文不同),但认出是同一个,不回第二张。
		await say("换个写法 https://acme.invalid/link/a1?from=share");
		await quiet();
		expect(probe.linkResolves).toHaveLength(2);
		expect(await captures()).toHaveLength(1);

		// 逐目标关掉:不问、不回;随后放开,冷却没被吃掉,新链接照回。
		await patchCore({ linkPreview: { byTarget: { [ID.group]: { isOn: false } } } });
		await say("https://acme.invalid/link/a2");
		await quiet();
		expect(probe.linkResolves).toHaveLength(2);
		expect(await captures()).toHaveLength(1);
		await patchCore({ linkPreview: { byTarget: { [ID.group]: null } } });

		// 形式选原生分享、连接能力注成支持:回原生分享,截流里是标题,不出图。
		await okRes(
			await api(
				"/api/dev/run/core.connection.capability",
				json({ params: { connection: ID.connection, state: "supported" } }),
			),
		);
		await patchCore({ linkPreview: { isOnByDefault: true, replyForm: "nativeShare" } });
		const htmlBefore = renderedHtml.length;
		await clearCaptures();
		await say("https://acme.invalid/link/a3");
		const native = await settledCaptures(1);
		expect(native).toHaveLength(1);
		expect(native[0]).toMatchObject({
			kind: "native-share",
			text: `${LINK_NATIVE_PREFIX}a3`,
			images: 0,
		});
		expect(renderedHtml.length).toBe(htmlBefore);

		// 形式改成文字后贴新链接:只回作者名 + 作品文字,截流里是 text,不出图。
		await patchCore({ linkPreview: { isOnByDefault: true, replyForm: "text" } });
		await clearCaptures();
		await say("https://acme.invalid/link/a4");
		const texted = await settledCaptures(1);
		expect(texted).toHaveLength(1);
		expect(texted[0]).toMatchObject({
			kind: "text",
			text: expect.stringMatching(/^链接作者/),
			images: 0,
		});
		expect(renderedHtml.length).toBe(htmlBefore);

		// 来源停下(引擎先停来源、进程还活着的那一刻)后同一类链接再贴:没有人再认。
		// 关停途中适配器已停、开发场景用不了,所以这一段直接往门的入站出口喂(控制组走同一条路,证明这条路是通的)。
		const inbound = inProcessWorld.inboundGroup;
		if (!inbound) throw new Error("入站出口没取到");
		const feedDirect = async (text: string) => {
			inbound(
				{ address: GROUP_ADDRESS, senderId: "20002", text, sharedLinks: [] },
				{ connectionId: ID.connection, platform: "onebot" },
			);
			await quiet();
		};
		await patchCore({ linkPreview: { isOnByDefault: true, replyForm: "image" } });
		await feedDirect("控制组 https://acme.invalid/link/a4");
		const resolvedBeforeStop = probe.linkResolves.length;
		expect(probe.linkResolves.at(-1)).toBe("https://acme.invalid/link/a4");
		let fedAfterStop = false;
		inProcessWorld.afterSourceStopped = async () => {
			await feedDirect("停后 https://acme.invalid/link/a5");
			fedAfterStop = true;
		};
		await handle?.close("test");
		handle = undefined;
		expect(fedAfterStop).toBe(true);
		expect(probe.linkResolves).toHaveLength(resolvedBeforeStop);
		drove("P22");
	}, 60_000);
});

// ---------------------------------------------------------------------------
// 需要两趟开机的几行:各自一台服务端、一个数据目录,不与上面共用的那一台混
// ---------------------------------------------------------------------------

describe("进程内对拍:两趟开机", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-in-process-parity-boots-e2e-"));
		resetInProcessWorld();
	});

	afterEach(async () => {
		await handle?.close("test cleanup").catch(() => {});
		handle = undefined;
		await rm(dataDir, { recursive: true, force: true });
	});

	const boot = async (listenPort: number) =>
		startServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(listenPort),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
		});

	/** 先空启动一趟让数据代就位、关掉,回在用的那一代的目录。 */
	async function seedGeneration(): Promise<string> {
		const seed = await boot(await findFreePort());
		await seed.close("seed");
		resetInProcessWorld();
		return activeGeneration(dataDir);
	}

	// 验红:`store.ts` 的 `readIntegrationSettings` 在坏格时回默认值(不把坏格的原文放回去),`get()` 读到好值,
	// 来源不报问题,第一段红;`settingsReaderOptionsOf` 里 `onChanged` 接成空操作,存对之后问题清不掉,第三段红。
	it("P14 设置坏着开机:起得来、来源在册;get() 回 invalid 点名那一格;来源自己报的问题在表里;经真路由存对之后没了", async () => {
		const generation = await seedGeneration();
		const file = join(generation, ...integrationSettingsFile(IN_PROCESS_KEY));
		await mkdir(join(file, ".."), { recursive: true });
		await writeFile(file, JSON.stringify({ mode: "fancy", threshold: 0 }));

		const port = await findFreePort();
		handle = await boot(port);
		const api = (path: string, init?: RequestInit) =>
			fetch(`http://127.0.0.1:${port}${path}`, init);
		const probe = currentProbe();
		expect(probe.starts).toBe(1);
		expect((await api(`/api/sources/${IN_PROCESS_KEY}/auth`)).status).toBe(200);

		// 坏的是 threshold 这一格:get() 回 invalid,issues 点名它。
		expect(probe.settingsAtStart).toMatchObject({ ok: false, code: "invalid" });
		const issues =
			probe.settingsAtStart && !probe.settingsAtStart.ok ? probe.settingsAtStart.issues : [];
		expect(issues?.map((issue) => issue.path)).toEqual([["threshold"]]);
		const mine = async () =>
			(
				(await (await api("/api/problems")).json()) as {
					problems: Array<{ reporter: string; code: string; about?: unknown }>;
				}
			).problems
				// 假来源开机是未登录:宿主会在它名下报一条 auth_lost,这一条测的是设置,不数它
				.filter((p) => p.reporter === IN_PROCESS_KEY && p.code !== "auth_lost");
		expect((await mine()).map((p) => p.code)).toEqual([SETTINGS_PROBLEM_CODE]);

		// 经真路由把坏的那格存对:来源收到变化、问题没了、文件是新值(好的那格原样留着)。
		const saved = await api("/api/settings", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ [IN_PROCESS_KEY]: { threshold: 20 } }),
		});
		expect(saved.status).toBe(200);
		await vi.waitFor(async () => expect(await mine()).toEqual([]));
		expect(probe.settings?.get()).toEqual({ ok: true, settings: { mode: "fancy", threshold: 20 } });
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ mode: "fancy", threshold: 20 });
		drove("P14");
	});

	// 验红:包装层里把 `state` / `secrets` 换成内存存储,第二趟读不回上一趟写的,这条红。
	it("P17 state / secrets:上一趟写的第二趟读得回;state 是数据代里假键那一格的明文,secrets 是加密文件", async () => {
		// 假来源由装配登记为内置集成，按注入的键落根目录；第一趟开机前什么都还没写过。
		handle = await boot(await findFreePort());
		const generation = await activeGeneration(dataDir);
		const stateFile = join(generation, "runtime", IN_PROCESS_KEY, "state.json");
		const secretsFile = join(generation, "secrets", IN_PROCESS_KEY, "secrets.enc");
		const first = currentProbe();
		expect(first.stateAtStart).toBeUndefined();
		expect(first.secretAtStart).toBeUndefined();
		await handle.close("first");
		handle = undefined;
		expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({ entries: { boots: 1 } });

		handle = await boot(await findFreePort());
		const second = currentProbe();
		expect(second).not.toBe(first);
		expect(second.stateAtStart).toBe(1);
		expect(second.secretAtStart).toBe("token-1");
		await handle.close("second");
		handle = undefined;
		expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({ entries: { boots: 2 } });
		// 密钥落的是加密文件:盘上找不到明文。
		expect((await readFile(secretsFile)).includes("token-2")).toBe(false);
		drove("P17");
	});

	// 验红:包装层里把上下文的收尾钩子挪到 `registerSources` 里登记(晚于引擎的关停钩子),`stop()` 看到 signal 已中止,这条红;
	// `registry.ts` 的把手不等 `stop()` 落定、或 `pipeline.ts` 的 `dispose` 不等在途收尾,`stop()` 途中那一报被丢,这条红;
	// 摘掉 `subscriptions/source-context.ts` 里问题上报停后的守卫(`forEachProblemObject` 的 `if (disposed)`),停后那一报进了问题表,这条红。
	it("P18 关停次序:stop 恰好一次、被叫的那一刻 signal 还没中止;stop 途中(异步)报的问题照收;关完之后 signal 才中止;来源停下之后再上报的问题不进问题表", async () => {
		const generation = await seedGeneration();
		const base = makeExtensionSubscription({
			id: SUB.alice,
			extensionId: IN_PROCESS_KEY,
			externalId: EXT.alice,
		});
		await writeFile(
			join(generation, "config", "subscriptions.json"),
			subscriptionsFileText([{ ...base, routing: { ...base.routing, post: [] } }]),
		);

		handle = await boot(await findFreePort());
		const probe = currentProbe();
		expect(probe.stops).toBe(0);
		expect(probe.ctx?.signal.aborted).toBe(false);
		// 问题表收到一条上报,核心的日志里会有「[problems] 开 … code」:拿它看「收没收」。
		const serviceCtx = inProcessWorld.serviceCtx as unknown as NodeServiceContext;
		const seen: string[] = [];
		const previous = serviceCtx.setLogHook((entry) => seen.push(entry.msg));
		const tableOpened = (code: string) =>
			seen.filter((msg) => msg.startsWith("[problems] 开") && msg.includes(code));
		// 开着的时候报一条,问题表收得到(证明下面「停后不收」不是因为这条路本来就不通)。
		probe.ctx?.reportProblem({
			externalId: EXT.alice,
			code: "open_problem",
			message: "开着的时候",
		});
		expect(tableOpened("open_problem")).toHaveLength(1);

		// `stop()` 是异步的:引擎已撤了登记、来源还在停的路上(上下文要等 stop 落定才收),这时再报要照收。
		let midStopReported = false;
		probe.duringStop = async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			probe.ctx?.reportProblem({
				externalId: EXT.alice,
				code: "mid_stop_problem",
				message: "停途中",
			});
			midStopReported = true;
		};

		// 来源已被引擎停下、上下文已收掉而进程还活着的那一刻(引擎之后、集成上下文收尾之前)再报:
		// 关完整个服务再报什么都看不到,断言会恒成立。
		let lateReported = false;
		inProcessWorld.afterSourceStopped = () => {
			probe.ctx?.reportProblem({ externalId: EXT.alice, code: "late_problem", message: "停后" });
			lateReported = true;
		};

		try {
			await handle.close("test");
			handle = undefined;
		} finally {
			serviceCtx.setLogHook(previous);
		}
		expect(probe.stops).toBe(1);
		expect(probe.stopSawAborted).toBe(false);
		expect(probe.ctx?.signal.aborted).toBe(true);

		expect(midStopReported).toBe(true);
		expect(tableOpened("mid_stop_problem")).toHaveLength(1);
		expect(lateReported).toBe(true);
		expect(tableOpened("late_problem")).toEqual([]);
		// 作品那一半(停后 `reportPost` 不入队)在这里看不到:作品入口先于集成上下文收尾就已关掉,
		// 守卫摘掉也观察不到差别,所以由 `source-context.test.ts` 与 `builtin-sources.test.ts` 的单测钉(见 PARITY_ROWS 的 P18)。
		drove("P18");
	});
});

describe("进程内对拍:清单自己", () => {
	// 注意:这一组必须排在上面两组之后(靠文件内顺序),它拿「实际驱动过的行」对清单。
	it("PARITY_ROWS:对拍 54 行、不开 2 行,id 不重;不开的每行都写了等哪一期与理由", () => {
		expect(PARITY_ROWS).toHaveLength(56);
		expect(new Set(PARITY_ROWS.map((row) => row.id)).size).toBe(PARITY_ROWS.length);
		const checked = PARITY_ROWS.filter((row) => row.checked);
		const closed = PARITY_ROWS.filter((row) => !row.checked);
		expect(checked.map((row) => row.id)).toEqual(
			Array.from({ length: 54 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`),
		);
		// N02→P39、N13→P40(N13 的直播一半先在 3b-23 转了 P36)、N17→P21、N07→P22、N18→P25、N12→P27、N10→P33、N04 / N11→P34 / P35、N03→P36;
		// N08→P46(「默认文案有更新」归面板测试);N06 的「六把中立工具」那一半→P41,
		// N06 的登记与撤销→P42、技能可见性→P43、提示词叫法→P44,N06 整行转完;N16→P45;编号不回填(P47 是 3b-42 新加的 reportProfile,没有 N 行转来);P48、P49 是 3b-50 补的「另补项」(按订阅的皮肤、过滤与点评共用取段),同样没有 N 来源;
		// N09 的服务端一半(描述符经来源表下发)在 4-12 转了 P50,面板一半(规则节按描述符露出)仍是 N09;N05→P51(4-14);
		// N01→P52(4-15)。
		expect(closed.map((row) => row.id)).toEqual(
			Array.from({ length: 16 }, (_, i) => i + 1)
				.filter((n) => ![1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 15, 16].includes(n))
				.map((n) => `N${String(n).padStart(2, "0")}`),
		);
		for (const row of closed) {
			if (row.checked) continue;
			expect(row.waitsFor.trim().length, `${row.id} 要写等哪一期`).toBeGreaterThan(0);
			expect(row.reason.trim().length, `${row.id} 要写理由`).toBeGreaterThan(0);
		}
		for (const row of PARITY_ROWS) expect(row.title.trim().length, row.id).toBeGreaterThan(0);
	});

	it("成员棘轮:四张表里指向的行都是清单里「对拍」的行(类型层另有 satisfies Record<keyof …> 守着不漏成员)", () => {
		const checkedIds = new Set(PARITY_ROWS.filter((row) => row.checked).map((row) => row.id));
		const tables = {
			Source: SOURCE_MEMBERS,
			SourceContext: SOURCE_CONTEXT_MEMBERS,
			SourceDescriptor: SOURCE_DESCRIPTOR_MEMBERS,
			SourceAuth: SOURCE_AUTH_MEMBERS,
		};
		for (const [name, table] of Object.entries(tables)) {
			for (const [member, rows] of Object.entries(table as Record<string, readonly string[]>)) {
				expect(rows.length, `${name}.${member} 没有行管着`).toBeGreaterThan(0);
				for (const id of rows) expect(checkedIds.has(id), `${name}.${member} → ${id}`).toBe(true);
			}
		}
	});

	it("标「对拍」的行恰好都被驱动到了,标「不开」的一行也没碰", () => {
		const declared = new Set(PARITY_ROWS.filter((row) => row.checked).map((row) => row.id));
		expect(drivenInThisRun).toEqual(declared);
	});

	it("假来源与它的夹具不碰 B 站:import 只有中立的几样,源码里没有 B 站的键常量与字面量", async () => {
		const FIXTURE = "apps/server/src/__tests__/support/in-process-source.ts";
		const THIS_FILE = "apps/server/src/__tests__/in-process-source-parity-e2e.test.ts";
		const fixture = parseSource(FIXTURE);
		const parity = parseSource(THIS_FILE);

		// 夹具的 import 只有这几样:中立的内部包、zod、集成上下文及其读手(造假来源的集成上下文要一份),外加三个只取类型的
		// (组装根、配置仓、运行时 —— 总线是运行时的,组装根不拿它,夹具包 `createAppRuntime` 在总线上挂耳朵)。
		const specifiers = importsOf(fixture).map((ref) => ref.specifier);
		expect(specifiers.sort()).toEqual(
			[
				"@bilibili-notify/internal",
				"zod",
				"../../compose.js",
				"../../config/store.js",
				"../../integrations/open.js",
				"../../integrations/settings-reader.js",
				"../../runtime/bootstrap.js",
			].sort(),
		);
		// 夹具与这份对拍文件的任何一个 import 都不解析到 bilibili/ 下。
		for (const [file, source] of [
			[FIXTURE, fixture],
			[THIS_FILE, parity],
		] as const) {
			for (const ref of importsOf(source)) {
				const resolved = resolveSpecifier(file, ref.specifier);
				if (resolved === undefined) continue;
				expect(isInside(resolved, "apps/server/src/bilibili"), `${file} → ${ref.specifier}`).toBe(
					false,
				);
			}
		}
		// 夹具源码里没有 B 站的键常量(注释之外)与那个字面量。
		const code = fixture.text
			.split("\n")
			.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
			.join("\n");
		expect(code).not.toContain("BILIBILI_SOURCE_KEY");
		expect(code).not.toMatch(/["'`]bilibili["'`]/);
	});
});
