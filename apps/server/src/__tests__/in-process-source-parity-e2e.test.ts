/**
 * 🔴 **守卫 21b:进程内对拍 —— 一个不是 B 站的来源,照内置那条路登记之后,核心给它的待遇与给 B 站的一样。**
 *
 * 假来源(`support/in-process-source.ts`,键 `acme.inprocess`)只实现中立的 `Source`,经真入口、真 `compose.ts`
 * (`vi.mock` 包一层:真 B 站来源照常并排登记,之外对假来源调同一个 `engines.registerSource`)、真登记表、真来源上下文
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
	DevCapturedDelivery,
	HistoryEntryView,
	HistoryResponse,
	ProblemsResponse,
	SourceAuthResponse,
	StatsOverviewResponse,
} from "@bilibili-notify/contract";
import {
	fail,
	makeDefaultGlobalConfig,
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
	currentProbe,
	IN_PROCESS_KEY,
	IN_PROCESS_LABEL,
	IN_PROCESS_TIER_KEY,
	inProcessWorld,
	LINK_NATIVE_PREFIX,
	LINK_TITLE_PREFIX,
	resetInProcessWorld,
	SETTINGS_PROBLEM_CODE,
} from "./support/in-process-source.js";
import { png } from "./support/report-images.js";
import { subscriptionsFileText } from "./support/subscriptions-file.js";

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

// 照内置那条路登记:真 compose 照跑(真 B 站来源并排在册),包装层再对假来源调同一个 `engines.registerSource`。
vi.mock("../compose.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../compose.js")>();
	const support = await import("./support/in-process-source.js");
	return support.wrapCompose(real);
});

// ---------------------------------------------------------------------------
// 清单自己
// ---------------------------------------------------------------------------

type ParityRow =
	| { id: string; title: string; checked: true }
	| { id: string; title: string; checked: false; waitsFor: string; reason: string };

/**
 * 对拍的行(`checked: true`,P01–P28)与「这版不开」的行(`checked: false`,N01–N16 去掉 N07、N12,必须写清等哪一期、为什么)。
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
		id: "N01",
		title: "经接口(路由与面板)搜人、经接口新建订阅",
		checked: false,
		waitsFor: "第 4 期",
		reason:
			"searchCreators 这一期只有女仆的搜人工具读它(P26),GET /api/sources/:sourceKey/creators 与面板第 4 期;新建订阅的门只认装着的 v2 订阅源、不问登记表",
	},
	{
		id: "N02",
		title: "fetchProfile:资料、头像、粉丝、显示名链",
		checked: false,
		waitsFor: "3b 资料刷新中立化",
		reason: "接口上没有 fetchProfile;资料仍由粉丝轮询那条 B 站专有的路做",
	},
	{
		id: "N03",
		title: "fetchLiveStatus、场次、live-session-changed、live-viewers-changed",
		checked: false,
		waitsFor: "3b 合场次引擎",
		reason: "直播在 3a 只是外壳(出期条件),接口上没有 fetchLiveStatus",
	},
	{
		id: "N04",
		title: "liveInteractions:醒目留言、会员、特别弹幕、特别进场、词云、总结",
		checked: false,
		waitsFor: "3b",
		reason: "直播在 3a 只是外壳,接口上没有 liveInteractions",
	},
	{
		id: "N05",
		title: "fetchPreview、预览走它",
		checked: false,
		waitsFor: "第 4 期",
		reason: "接口上没有 fetchPreview;卡片真实预览仍读 B 站接口",
	},
	{
		id: "N06",
		title: "AiToolProvider 登记与撤销、六把中立工具、技能可见性、提示词里的叫法",
		checked: false,
		waitsFor: "3b(守卫「AI 工具与技能约束」同期)",
		reason: "AiToolProvider 的登记表没有造",
	},
	{
		id: "N08",
		title: "模板变量 {postNoun}、{tier}、{fanclub}、时长与粉丝变量;默认文案有更新",
		checked: false,
		waitsFor: "3b-22",
		reason:
			"{postNoun} 已在 P04 拍;{tier}、{fanclub}、时长与粉丝变量要假来源交得出会员与一场直播,接口上 3b-22 才有",
	},
	{
		id: "N09",
		title: "描述符其余格、规则节按描述符露出",
		checked: false,
		waitsFor: "第 4 期",
		reason: "描述符只造了有读者的三格,其余随面板改造",
	},
	{
		id: "N10",
		title: "规则里的直播项:非人民币醒目留言门槛、custom 会员体系、minRank、特别关注按 viewer.id",
		checked: false,
		waitsFor: "3b",
		reason: "全是直播",
	},
	{
		id: "N11",
		title: "会员卡 custom 加 tier.icon 加按档换色、词云与总结卡",
		checked: false,
		waitsFor: "3b",
		reason: "全是直播;档的图标仍取 B 站徽章图",
	},
	{
		id: "N13",
		title: "followers-refreshed;WS 帧快照里没有 uid",
		checked: false,
		waitsFor: "3b",
		reason: "粉丝走 B 站轮询;事件载荷棘轮 3b 末清零",
	},
	{
		id: "N14",
		title: "订阅、历史、统计、概览四个页面的清单",
		checked: false,
		waitsFor: "第 4 期",
		reason: "面板不在进程内对拍的范围,页面按描述画是第 4 期",
	},
	{
		id: "N15",
		title: "运行状态读口(running / failed / settings-invalid)",
		checked: false,
		waitsFor: "第 4 期健康卡(等第一个读者)",
		reason: "没造,「在册就算在跑」",
	},
	{
		id: "N16",
		title: "统计「在记」",
		checked: false,
		waitsFor: "3b",
		reason:
			"「这个小时在记」只有 B 站登录着的每小时一跳与拓展的上报事件两个来路,内置的非 B 站来源没人替它记",
	},
	// N12(作品带图)在 3b-39 落成了,转进对拍的 P27;
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
	descriptor: ["P10", "P15", "P19"],
	health: ["P15"],
	start: ["P01"],
	stop: ["P18"],
	auth: ["P16"],
	searchCreators: ["P26"],
} as const satisfies Record<keyof Source, readonly RowId[]>;
const SOURCE_CONTEXT_MEMBERS = {
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
	reportProblem: ["P11"],
	resolveProblem: ["P11"],
	registerLinkResolver: ["P22"],
} as const satisfies Record<keyof SourceContext, readonly RowId[]>;
const SOURCE_DESCRIPTOR_MEMBERS = {
	label: ["P15"],
	postNoun: ["P10"],
	externalIdRegex: ["P23"],
	membershipPrograms: ["P19"],
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
	/**
	 * 要假模型先调一把工具(只在带着工具表、末条是用户话的那一问上调,调一次就清);
	 * 调完工具之后喂回来的 `tool` 消息正文记进 {@link aiToolSeen}。
	 */
	let aiToolScript: { name: string; args: object } | null = null;
	const aiToolSeen: string[] = [];

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
	async function askMaid(script: {
		name: string;
		args: object;
	}): Promise<{ seen: string; tools: Array<{ name: string; ok: boolean }> }> {
		await patchSettings({ ai: { enabled: true } });
		try {
			const created = await okRes(await api("/api/ai/conversations", json({})));
			const { conversation } = (await created.json()) as { conversation: { id: string } };
			aiToolSeen.length = 0;
			aiToolScript = script;
			const sse = await (
				await okRes(
					await api(`/api/ai/conversations/${conversation.id}/chat`, json({ message: "问一句" })),
				)
			).text();
			const done = /event: done\ndata: (.*)\n/.exec(sse)?.[1];
			const reply = done
				? (JSON.parse(done) as { reply?: { tools?: Array<{ name: string; ok: boolean }> } }).reply
				: undefined;
			return { seen: aiToolSeen.join("\n"), tools: reply?.tools ?? [] };
		} finally {
			aiToolScript = null;
			await patchSettings({ ai: { enabled: false } });
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
					tools?: unknown[];
					stream?: boolean;
				};
				const messages = parsed.messages;
				aiAsked.push(JSON.stringify(messages?.at(-1)?.content ?? ""));
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

		// —— 先空启动一趟:建连接、目标、主人、AI 的服务商(关着);订阅不能经接口建(新建订阅的门只认装着的订阅源,N01),
		// 所以关掉之后往在用的那一代里直接摆订阅文件,再起第二趟。
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
						master: { targetId: ID.master },
						ai: { ...aiSettings(makeDefaultGlobalConfig().ai), enabled: false },
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
				sub(SUB.alice, EXT.alice),
				// 作品开关关着:在名单里,但 features 里没有 post。
				{ ...sub(SUB.bob, EXT.bob), overrides: { features: { post: false } } },
				// 停用的、另一个没人认领的键名下的:都不在名单里。
				sub(SUB.carol, EXT.carol, { enabled: false }),
				sub(SUB.dave, EXT.dave, { extensionId: OTHER_KEY }),
				// 同一个人遗留的两条重复订阅。
				sub(SUB.erin1, EXT.erin),
				sub(SUB.erin2, EXT.erin),
				sub(SUB.frank, EXT.frank),
			]),
		);

		// alice 有存好的资料名(历史行的名字快照取它);别人没有。
		await mkdir(join(generation, "runtime"), { recursive: true });
		await writeFile(
			join(generation, "runtime", "sub-runtime.json"),
			JSON.stringify({ [SUB.alice]: { cachedProfile: { name: ALICE_PROFILE_NAME } } }),
		);

		resetInProcessWorld();
		port = await findFreePort();
		// 配了浏览器才有出卡的渲染器;真正起来的是上面那个假浏览器。
		handle = await boot(port, { BN_CHROME_PATH: "/fake/chrome" });
		// 开截流:此后所有往外发的都被拦在派发器调适配器 `send` 的那一处,不出网。
		await okRes(await api("/api/dev/run/push.capture", json({ params: {} })));
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
		// 并排在册的 B 站:它的登录口同样问得到(不回 unavailable)。
		const bili = await api("/api/sources/bilibili/auth");
		expect(bili.status).toBe(200);
		drove("P01");
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
			await patchSettings({ defaults: { features: { post: false } } });
			await vi.waitFor(() => expect(probe.rosterChanges.length).toBeGreaterThanOrEqual(1));
			expect(rosterPostFlags(probe.rosterChanges.at(-1))).toEqual([
				[EXT.alice, false],
				[EXT.bob, false],
				[EXT.erin, false],
				[EXT.frank, false],
			]);
		} finally {
			await patchSettings({ defaults: { features: { post: true } } });
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

	// 验红:`engines.ts` 的 `registerSource` 里不递 `enqueue`,这条红(没有任何作品到得了推送)。
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
	// 「在记」那一格(统计总览里 posts 为数)对内置的非 B 站来源今天不成立,见「这版不开」N16;所以这里读的是落盘的作品行。
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
		await patchSettings({ ai: { enabled: true } });
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
			await patchSettings({ ai: { enabled: false } });
		}
		drove("P10");
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
		drove("P11");
	});

	// 验红:`engines.ts` 里不把问题表递给通知器(`table:` 换成一张永远空的),第一段红。
	it("P12 问题的私聊与恢复句:notify 的问题私聊主人一条(正文是报的那句);清掉时发它自带的恢复句", async () => {
		const probe = currentProbe();
		await clearCaptures();
		probe.ctx?.reportProblem({
			code: "needs_attention",
			message: "主人，对拍源需要您看一眼",
			notify: true,
			recoveryMessage: "主人，对拍源已经好啦",
		});
		const [asked] = await settledCaptures(1);
		expect(await captures()).toHaveLength(1);
		expect(asked).toMatchObject({
			targetId: ID.master,
			private: true,
			kind: "text",
			text: "主人，对拍源需要您看一眼",
		});

		await clearCaptures();
		probe.ctx?.resolveProblem({ code: "needs_attention" });
		const [recovered] = await settledCaptures(1);
		expect(await captures()).toHaveLength(1);
		expect(recovered).toMatchObject({
			targetId: ID.master,
			private: true,
			text: "主人，对拍源已经好啦",
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
		await okRes(await api("/api/dev/run/inbound.command", json({ params: { text: "/status" } })));
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

	/** 订阅 WS 的 `auth` 频道,攒下收到的帧。 */
	async function watchAuthFrames() {
		const frames: Array<{ type?: string; event?: string; data?: unknown }> = [];
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		ws.on("message", (raw) => {
			frames.push(JSON.parse(String(raw)) as (typeof frames)[number]);
		});
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});
		ws.send(JSON.stringify({ type: "subscribe", channels: ["auth"] }));
		await vi.waitFor(() => expect(frames.some((f) => f.type === "subscribed")).toBe(true));
		return {
			frames,
			close: () => ws.close(),
		};
	}

	// 验红:`engines.ts` 里不递 `onAuthChanged`,WS 上收不到帧,第三段红;路由换成只回 `state` 不回 `account`,第一段红。
	it("P16 登录口:GET 逐格挑、POST 进 awaiting-scan 再 POST 回 conflict、DELETE 回 logged-out;状态一变 WS 的 auth 频道收到帧", async () => {
		const probe = currentProbe();
		const watch = await watchAuthFrames();
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
		await okRes(await api("/api/dev/run/inbound.command", json({ params: { text } })));
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

	// 验红:`membership-tiers.ts` 只读第一个在册来源(B 站),假来源的档 key 就认不出,第一段红。
	it("P19 会员体系读口:假来源声明的档 key 过得了请求校验;乱写的 key 回 400、issues 点名 content.tierKey", async () => {
		/** 预览请求故意带一个无关的错(fallback 不是布尔):校验一定会跑,不碰渲染(也就不碰任何网)。 */
		const preview = async (tierKey: string) => {
			const res = await api(
				"/api/cards/preview",
				json({
					kind: "membership",
					style: {},
					content: { tierKey },
					fallback: "不是布尔",
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
		const known = await preview(IN_PROCESS_TIER_KEY);
		expect(known).toContain("fallback");
		expect(known).not.toContain("content.tierKey");

		const unknown = await preview("acme-不存在的档");
		expect(unknown).toContain("fallback");
		expect(unknown).toContain("content.tierKey");
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

			await patchSettings({ logging: { levels: { [IN_PROCESS_KEY]: "error" } } });
			expect(emit()).toEqual(["mine-error", "core-warn", "bili-warn"]);

			await patchSettings({ logging: { levels: { [IN_PROCESS_KEY]: null } } });
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

	// 验红:`engines.ts` 里 attachReadOnlyTools 的 `platformLabel` 改回只问拓展装载器(假源不是拓展,装载器回 undefined),
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
		await patchSettings({
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
			await patchSettings({
				ai: { enabled: false, providers: { fake: { provider: "deepseek", enableVision: false } } },
			});
		}
		drove("P28");
	});

	// 验红:`external-id.ts` 的核法改成永远放行,第一段红(不合格式的被收进了下一道闸,回的不是 invalid)。
	// 放在 P22 之前:P22 末尾把服务端关了。
	it("P23 外部 id 的格式:来源在描述符里声明,经接口新建订阅时不合格式的被拒(invalid、issues 点名 identity.externalId);合格式的过了这一道;没声明的不替它做主", async () => {
		const probe = currentProbe();
		const create = async (externalId: string) =>
			api(
				"/api/subscriptions",
				json(
					makeExtensionSubscription({
						id: "e2300000-0000-4000-8000-000000000023",
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

			// 合格式的过了这一道。建成由 subscriptions-extension-create.test.ts 用真的拓展清单钉着;进程内来源
			// 过不了「装着的拓展」那道闸(新建订阅的下一道),回的是「没装」而不是格式不对,那是 N01 的事。
			const passed = await failureOf(await create("abc1"));
			expect(passed.code).toBe("not_found");

			// 没声明:核心不替来源做主,同一个 "abc" 不再被格式拦(停在同一道下一闸)。
			probe.descriptor.externalIdRegex = undefined;
			expect((await failureOf(await create("abc"))).code).toBe("not_found");
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
	it("P22 链接解析器:来源在 start 里登的解析器认领自己的链接 —— 关着不回、开了回一张图、冷却里不回第二张、逐目标关掉不回、能力支持时回原生分享;来源停下后没人再认", async () => {
		const probe = currentProbe();
		/** 往测试群贴一句话(必须传 `text`:缺省正文是 B 站链接,会去打真接口)。 */
		const say = async (text: string) =>
			okRes(await api("/api/dev/run/inbound.link", json({ params: { text } })));
		const quiet = () => new Promise((resolve) => setTimeout(resolve, 400));
		const htmlWith = (needle: string) => renderedHtml.filter((html) => html.includes(needle));
		await clearCaptures();

		// 总开关关着(默认):不问解析器、不回。
		await say("看 https://acme.invalid/link/a1");
		await quiet();
		expect(probe.linkResolves).toEqual([]);
		expect(await captures()).toEqual([]);

		// 开了:回一张图,送去出图的 HTML 里是假解析器交的正文。
		await patchSettings({
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
		await patchSettings({ linkPreview: { byTarget: { [ID.group]: { isOn: false } } } });
		await say("https://acme.invalid/link/a2");
		await quiet();
		expect(probe.linkResolves).toHaveLength(2);
		expect(await captures()).toHaveLength(1);
		await patchSettings({ linkPreview: { byTarget: { [ID.group]: null } } });

		// 形式选原生分享、连接能力注成支持:回原生分享,截流里是标题,不出图。
		await okRes(
			await api(
				"/api/dev/run/connection.capability",
				json({ params: { connection: ID.connection, state: "supported" } }),
			),
		);
		await patchSettings({ linkPreview: { isOnByDefault: true, replyForm: "nativeShare" } });
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
		await patchSettings({ linkPreview: { isOnByDefault: true, replyForm: "text" } });
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
		await patchSettings({ linkPreview: { isOnByDefault: true, replyForm: "image" } });
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
			).problems.filter((p) => p.reporter === IN_PROCESS_KEY);
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
		// 第一趟开机就是这台数据目录的头一趟(不先空启动):什么都还没写过。
		handle = await boot(await findFreePort());
		const generation = await activeGeneration(dataDir);
		const stateFile = join(generation, "runtime", "extensions", IN_PROCESS_KEY, "state.json");
		const secretsFile = join(generation, "secrets", "extensions", IN_PROCESS_KEY, "secrets.enc");
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
	// 摘掉 `subscriptions/source-context.ts` 里问题上报停后的守卫(`forEachProblemObject` 的 `if (disposed)`),停后那一报进了问题表,这条红。
	it("P18 关停次序:stop 恰好一次、被叫的那一刻 signal 还没中止;关完之后 signal 才中止;来源停下之后再上报的问题不进问题表", async () => {
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

		expect(lateReported).toBe(true);
		expect(tableOpened("late_problem")).toEqual([]);
		// 作品那一半(停后 `reportPost` 不入队)在这里看不到:作品入口先于集成上下文收尾就已关掉,
		// 守卫摘掉也观察不到差别,所以由 `source-context.test.ts` 与 `builtin-sources.test.ts` 的单测钉(见 PARITY_ROWS 的 P18)。
		drove("P18");
	});
});

describe("进程内对拍:清单自己", () => {
	// 注意:这一组必须排在上面两组之后(靠文件内顺序),它拿「实际驱动过的行」对清单。
	it("PARITY_ROWS:对拍 28 行、不开 14 行,id 不重;不开的每行都写了等哪一期与理由", () => {
		expect(PARITY_ROWS).toHaveLength(42);
		expect(new Set(PARITY_ROWS.map((row) => row.id)).size).toBe(PARITY_ROWS.length);
		const checked = PARITY_ROWS.filter((row) => row.checked);
		const closed = PARITY_ROWS.filter((row) => !row.checked);
		expect(checked.map((row) => row.id)).toEqual(
			Array.from({ length: 28 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`),
		);
		// N17 转进了对拍(P21)、N07 转进了对拍(P22)、N18 转进了对拍(P25)、N12 转进了对拍(P27),编号不回填。
		expect(closed.map((row) => row.id)).toEqual(
			Array.from({ length: 16 }, (_, i) => i + 1)
				.filter((n) => n !== 7 && n !== 12)
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

		// 夹具的 import 只有这几样:中立的内部包、zod、集成上下文及其读手(造假来源的集成上下文要一份),外加两个只取类型的(组装根、配置仓)。
		const specifiers = importsOf(fixture).map((ref) => ref.specifier);
		expect(specifiers.sort()).toEqual(
			[
				"@bilibili-notify/internal",
				"zod",
				"../../compose.js",
				"../../config/store.js",
				"../../integrations/open.js",
				"../../integrations/settings-reader.js",
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
