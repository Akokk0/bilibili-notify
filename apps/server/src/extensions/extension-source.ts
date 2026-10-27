import { displayNameOf } from "@bilibili-notify/contract";
import {
	type Creator,
	type CreatorCandidate,
	type CreatorProfileReport,
	checkExtensionLiveStatus,
	checkExtensionReport,
	createSerialQueue,
	EXTERNAL_ID_MAX,
	ExtensionCreatorCandidatesSchema,
	type ExtensionManifest,
	type ExtensionReportIssue,
	type ExtensionReportKind,
	type ExtensionReportValue,
	FAILURE_CODES,
	type Failure,
	type FailureCode,
	fail,
	formatZodIssues,
	type Identity,
	type LiveDetails,
	type LiveSignalReport,
	type LiveStatusResult,
	type Logger,
	normalizePost,
	ok,
	type Post,
	type PostImage,
	type PostReport,
	type RichText,
	readImageSize,
	type Source,
	type SourceContext,
	type SourceDescriptor,
	sniffImageFormat,
	truncateText,
} from "@bilibili-notify/internal";
import type {
	ExtensionLiveDetails,
	ExtensionSourceContext,
	SourceDef,
} from "@bilibili-notify/internal/extension";
import { t } from "../i18n/index.js";
import type { ImageStore } from "../images/image-store.js";
import { pickBoundMembers } from "../util/bound-members.js";
import { errorMessageOf } from "../util/error-message.js";
import { catchThenableRejection } from "../util/is-thenable.js";
import { textPreview } from "../util/text-preview.js";

/**
 * **拓展的订阅源 → 核心的 `Source`**(3b-42):把清单里订阅源那一口的外观(平台名、作品叫法、外部 id 格式)与
 * 拓展交上来的 {@link SourceDef} 拼成一份核心来源,登记进来源登记表,和 B 站走同一个 `SourceContext`、
 * 同一条作品入口、同一个场次引擎、同一个资料写口。
 *
 * 🔴 **拓展交回的一切都当外来数据,只在这一处收**(三种上报、搜人候选、取资料、拉取式直播状态):
 * 核心的 `createSourceContext` 不为拓展加分支。收的规矩在 `@bilibili-notify/internal` 的
 * `schema/extension-report.ts`(多一格整条拒、认识的选填格坏了只丢那一格、时刻是带时区的 ISO……),这里管:
 *
 * - **上报**:先核外部 id → 再核清单声明的种类 → 再核形状;被拒、丢格都记进拓展的「上报出入」(再由宿主打 warn),
 *   拓展自己不知道(上报没有返回值);然后把 ISO 统一成 UTC Z、图库引用 → `PostImage`、作者名缺了按「资料名 → 身份标签」
 *   补、下播没交 `endedAt` 取到达那一刻,再交核心那一份 ctx;
 * - **读口**(搜人、取资料、拉取式直播状态):抛了回失败(原话进 `message`),形状按上报同一套规矩核 ——
 *   多一格 / 必填坏了回 `invalid`、点名哪一格,选填坏了丢那一格,拒与丢格都记进出入表,不抛。
 *
 * 开放给拓展的成员由 {@link SOURCE_DEF_MEMBERS} 这张表定:表外的(`auth`、`liveInteractions`、`descriptor`)
 * 带了也不认 —— 契约的宽度是不可逆的,没开放的口子先被人用上就改不动了。
 */

/** `status` 里来源健康那一行的上限;超出截断,不拒整行。 */
export const SOURCE_HEALTH_SUMMARY_MAX_CHARS = 120;

/** 一条该记进「上报出入」的事(宿主再补时刻与「哪条订阅」)。 */
export interface ExtensionSourceDiscrepancy {
	kind: ExtensionReportKind;
	/** 拓展报的外部 id(不是字符串 / 太长的已截成一段能看的)。 */
	externalId: string;
	/** `rejected`:整条拒了(一句);`dropped`:收下了,动了这几格(每格一句)。 */
	outcome: "rejected" | "dropped";
	reasons: readonly string[];
}

/** 图库的读口(`ImageStore.read`):补作品图的宽高与动图标记。 */
type ImageReader = Pick<ImageStore, "read">;

/** 串行队的键:一个来源就这一条。 */
const REPORT_QUEUE_KEY = "reports";

export interface CreateExtensionSourceOptions {
	/** 拓展的 id,也是它的来源键。 */
	id: string;
	/** 清单(给人看的字已按当前语言盖好):描述符取自 `contributes.subscription`。 */
	manifest: ExtensionManifest;
	/** 拓展交上来的那份(第三方 JS,不受类型约束,所以逐个成员按表取)。 */
	def: SourceDef;
	logger: Logger;
	/** 图库读口:作品图与视频封面按引用读回字节,补宽高与动图标记。 */
	images: ImageReader;
	/** 「上报出入」的出口。 */
	recordDiscrepancy(discrepancy: ExtensionSourceDiscrepancy): void;
	/** 事件里没带作者名时补的名字:资料名,再没有就是身份标签(`displayNameOf` 那条链的后两段)。 */
	fallbackCreatorName(externalId: string): string;
	/** 只有测试会换:「下播没交 `endedAt`」取的到达时刻。 */
	now?: () => number;
}

/**
 * 开放给拓展的 `SourceDef` 成员。`satisfies Record<keyof SourceDef, boolean>` 把「接口多一个成员,这里要记得
 * 表态」变成编译错。
 */
export const SOURCE_DEF_MEMBERS = {
	start: true,
	stop: true,
	searchCreators: true,
	fetchProfile: true,
	fetchLiveStatus: true,
	health: true,
} satisfies Record<keyof SourceDef, boolean>;

const OPEN_MEMBER_NAMES = (Object.keys(SOURCE_DEF_MEMBERS) as (keyof SourceDef)[]).filter(
	(name) => SOURCE_DEF_MEMBERS[name],
);

type OpenMembers = Pick<SourceDef, "start" | "stop" | "searchCreators"> &
	Partial<Pick<SourceDef, "fetchProfile" | "fetchLiveStatus" | "health">>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 统一成以 `Z` 结尾的 UTC ISO。拓展可以用任意合法偏移交时刻,但核心按字符串排序 / 比较时,
 * 不同的 `+08:00` 之类偏移会让同一时刻看起来不同;到达时钟仍走这里换成同样的出口。
 */
function utcIsoOf(timestamp: string | number): string {
	return new Date(timestamp).toISOString();
}

/** 路径 → 给人看的格名:`post.stats.likes`、`images[3]`;落在根上的叫「整条上报」。 */
function cellOf(path: readonly (string | number)[]): string {
	if (path.length === 0) return t("extension.report.whole");
	let cell = "";
	for (const part of path) {
		if (typeof part === "number") cell += `[${part}]`;
		else cell += cell === "" ? part : `.${part}`;
	}
	return cell;
}

/** 一条结构化的毛病 → 一句话(句子进字典,包里只给「哪一格、哪种毛病、上限多少」)。 */
function describeIssue(issue: ExtensionReportIssue): string {
	const cell = cellOf(issue.path);
	const limit = issue.limit ?? 0;
	switch (issue.code) {
		case "unknown-field":
			return t("extension.report.issue.unknownField", { cell });
		case "required":
			return t("extension.report.issue.required", { cell });
		case "type":
			return t("extension.report.issue.type", { cell });
		case "invalid":
			return t("extension.report.issue.invalid", { cell });
		case "too-short":
			return t("extension.report.issue.tooShort", { cell, limit });
		case "too-long":
			return t("extension.report.issue.tooLong", { cell, limit });
		case "below-min":
			return t("extension.report.issue.belowMin", { cell, limit });
		case "above-max":
			return t("extension.report.issue.aboveMax", { cell, limit });
		case "not-integer":
			return t("extension.report.issue.notInteger", { cell });
		case "negative":
			return t("extension.report.issue.negative", { cell });
		case "too-many":
			return t("extension.report.issue.tooMany", { cell, limit });
		case "duplicate":
			return t("extension.report.issue.duplicate", { cell });
	}
}

/** 外部 id 的毛病:要是 1–{@link EXTERNAL_ID_MAX} 字的字符串(与订阅里存的那一格同一把尺子)。 */
function externalIdIssue(raw: unknown): ExtensionReportIssue | undefined {
	const path = ["externalId"];
	if (typeof raw !== "string") return { path, code: "type" };
	if (raw.length < 1) return { path, code: "too-short", limit: 1 };
	if (raw.length > EXTERNAL_ID_MAX) return { path, code: "too-long", limit: EXTERNAL_ID_MAX };
	return undefined;
}

/** 失败的码要是标准码,查表(名字是拓展给的,不能顺着原型链查)。 */
function isFailureCode(code: unknown): code is FailureCode {
	return typeof code === "string" && Object.hasOwn(FAILURE_CODES, code);
}

/**
 * 拓展抛出来的错 → 给人看的一句失败话(原话进 `message`);没留原话的说没说原因。
 * (核心不许 import `platforms/`,所以不用那边的 `upstreamMessage`。)
 */
function reasonOf(err: unknown): string {
	const message = errorMessageOf(err).trim();
	return message === "" ? t("extension.source.noReason") : message;
}

/**
 * 读口交回的结果先拆壳:`{ ok: false, code, message }` 按标准失败原样交回(码是标准码、话非空才算数),
 * `{ ok: true, … }` 拆出铺平的内容去过各自的 schema;别的形状都是 `invalid`。
 */
function readResult(
	raw: unknown,
): { kind: "body"; body: Record<string, unknown> } | { kind: "failure"; failure: Failure } {
	const bad = (path: string[]) => ({
		kind: "failure" as const,
		failure: fail(
			"invalid",
			t("extension.source.invalidResult", { detail: describeIssue({ path, code: "invalid" }) }),
		),
	});
	if (!isRecord(raw)) return bad([]);
	if (raw.ok === true) {
		const { ok: _ok, ...body } = raw;
		return { kind: "body", body };
	}
	if (raw.ok !== false) return bad(["ok"]);
	if (!isFailureCode(raw.code)) return bad(["code"]);
	if (typeof raw.message !== "string" || raw.message === "") return bad(["message"]);
	return { kind: "failure", failure: fail(raw.code, raw.message) };
}

/**
 * 换行统一成 `\n`,正文与每个片段的 `text` 用同一套。契约允许作者按自己平台的单位随意切段,
 * `\r` 落在一段末尾、`\n` 落在下一段开头时,逐段各自换会换出两个换行 —— 先去掉本段开头那个
 * 与上一段结尾 `\r` 配对的 `\n`,各段换完再拼就恒等于拼完再换。
 */
function normalizeNewlines(texts: readonly string[]): string[] {
	let previousEndedWithCr = false;
	return texts.map((text) => {
		const segment = previousEndedWithCr && text.startsWith("\n") ? text.slice(1) : text;
		previousEndedWithCr = text.endsWith("\r");
		return segment.replace(/\r\n?/g, "\n");
	});
}

export function createExtensionSource(opts: CreateExtensionSourceOptions): Source {
	const { id, manifest, logger } = opts;
	const now = opts.now ?? Date.now;
	const subscription = manifest.contributes.subscription;
	if (!subscription) {
		throw new Error(`extension ${id}: manifest has no contributes.subscription`);
	}
	const declared: ReadonlySet<string> = new Set(subscription.supportedFeatures);
	const { label, postNoun, creatorNoun, externalIdNoun, externalIdRegex } = subscription;
	const descriptor: SourceDescriptor = {
		label,
		...(postNoun === undefined ? {} : { postNoun }),
		...(creatorNoun === undefined ? {} : { creatorNoun }),
		...(externalIdNoun === undefined ? {} : { externalIdNoun }),
		...(externalIdRegex === undefined ? {} : { externalIdRegex }),
	};
	// 成员按表取、方法 bind 回拓展交上来的那个实例(class 写的方法在原型上、吃 `this`)。
	const def = pickBoundMembers(opts.def, OPEN_MEMBER_NAMES) as unknown as OpenMembers;

	/** 拓展的 `stop` 叫过了:之后的上报一概丢(契约:`stop()` 之后不许再上报)。 */
	let stopped = false;
	/** 这个来源自己的一条串行队:三种上报按到达顺序一条条处理。 */
	const queue = createSerialQueue();
	/** 上一次 `health()` 的毛病;同一句连读只记一遍,好了再坏会重新记。 */
	let lastHealthProblem: string | undefined;

	function refuseHealth(problem: string): never {
		if (lastHealthProblem !== problem) {
			logger.warn(`拓展来源 ${id} 的 health(): ${problem}`);
			lastHealthProblem = problem;
		}
		throw new Error(`extension ${id}: health() ${problem}`);
	}

	function readHealth(): { summary: string } {
		let raw: unknown;
		try {
			raw = def.health?.();
		} catch (err) {
			return refuseHealth(`threw: ${errorMessageOf(err)}`);
		}
		if (catchThenableRejection(raw)) {
			// 同步读口不等人;是 thenable 就接住它日后的拒绝,再拒收。
			return refuseHealth("must return synchronously, not a Promise or thenable");
		}
		if (!isRecord(raw)) return refuseHealth("must return an object");
		if (typeof raw.summary !== "string") return refuseHealth("summary must be a string");
		const summary = raw.summary.replace(/\s+/g, " ").trim();
		if (summary === "") return refuseHealth("summary must not be blank");
		lastHealthProblem = undefined;
		return { summary: truncateText(summary, SOURCE_HEALTH_SUMMARY_MAX_CHARS) };
	}

	function reject(
		kind: ExtensionReportKind,
		externalId: string,
		reasons: readonly string[],
	): undefined {
		opts.recordDiscrepancy({ kind, externalId, outcome: "rejected", reasons });
		return undefined;
	}

	/** 收下了、但动了几格:记进出入表。与 `reject` 对称,空的什么都不记。 */
	function recordDropped(
		kind: ExtensionReportKind,
		externalId: string,
		issues: readonly ExtensionReportIssue[],
	): void {
		if (issues.length === 0) return;
		opts.recordDiscrepancy({
			kind,
			externalId,
			outcome: "dropped",
			reasons: issues.map(describeIssue),
		});
	}

	/** 清单没声明的种类整条拒:`post` 要 `post`;直播的 `start` 要 `liveStart`、`end` 要 `liveEnd`、`status` 要其一;资料总收。 */
	function undeclaredReason(kind: ExtensionReportKind, raw: unknown): string | undefined {
		if (kind === "profile") return undefined;
		if (kind === "post") {
			return declared.has("post")
				? undefined
				: t("extension.report.undeclared", { feature: "post" });
		}
		const signal = isRecord(raw) ? raw.kind : undefined;
		if (signal === "start") {
			return declared.has("liveStart")
				? undefined
				: t("extension.report.undeclared", { feature: "liveStart" });
		}
		if (signal === "end") {
			return declared.has("liveEnd")
				? undefined
				: t("extension.report.undeclared", { feature: "liveEnd" });
		}
		if (signal === "status") {
			return declared.has("liveStart") || declared.has("liveEnd")
				? undefined
				: t("extension.report.undeclaredLiveStatus");
		}
		// 种类认不出的交给形状那一道拒。
		return undefined;
	}

	/**
	 * 收一条上报:核外部 id → 核清单声明的种类 → 核形状。拒了记进出入表并回 `undefined`;丢格照收、也记一条。
	 * 回的 `externalId` 是核过的那个。
	 */
	function admit<K extends ExtensionReportKind>(
		kind: K,
		rawExternalId: unknown,
		raw: unknown,
	): { externalId: string; value: ExtensionReportValue<K> } | undefined {
		const idIssue = externalIdIssue(rawExternalId);
		const shown = idIssue === undefined ? (rawExternalId as string) : textPreview(rawExternalId);
		if (idIssue) return reject(kind, shown, [describeIssue(idIssue)]);
		const undeclared = undeclaredReason(kind, raw);
		if (undeclared !== undefined) return reject(kind, shown, [undeclared]);
		const checked = checkExtensionReport(kind, raw);
		if (!checked.ok) return reject(kind, shown, [checked.issues.map(describeIssue).join(";")]);
		recordDropped(kind, shown, checked.dropped);
		return { externalId: shown, value: checked.value };
	}

	/** 作者:事件里的名字优先,没有按「资料名 → 身份标签」补;头像是事件带的图库引用。 */
	function creatorFromExtension(
		externalId: string,
		creator: { name?: string; avatar?: string } | undefined,
	): Creator {
		return {
			name: displayNameOf({ eventName: creator?.name }, opts.fallbackCreatorName(externalId)),
			...(creator?.avatar === undefined ? {} : { avatar: creator.avatar }),
		};
	}

	/**
	 * 图库引用 → `PostImage`(作品图、视频封面)。宽高与动图标记由 BN 读图库里的文件头补(拓展只交引用,
	 * 出图器判「长图」要宽高、认动图要标记,与第 2 版宿主读字节补的一样);读不到(图已被清扫、读盘出错)
	 * 就只放 `ref` 并记 debug,不拒整条 —— 出图器对没有宽高的图照样画。
	 */
	async function postImageFromRef(ref: string): Promise<PostImage> {
		let stored: Awaited<ReturnType<ImageReader["read"]>>;
		try {
			stored = await opts.images.read(ref);
		} catch (err) {
			logger.debug(`图库读 ${ref} 出错,这张图只放引用: ${errorMessageOf(err)}`);
			return { ref };
		}
		if (stored === undefined) {
			logger.debug(`图库里读不到 ${ref},这张图只放引用`);
			return { ref };
		}
		return {
			ref,
			...readImageSize(stored.bytes),
			isAnimated: sniffImageFormat(stored.bytes) === "gif",
		};
	}

	/** 直播封面:第 2 版就只放引用(在播表与直播卡不要宽高),照旧。 */
	function coverOf(ref: string): PostImage {
		return { ref };
	}

	async function postReportFromExtension(
		externalId: string,
		value: ExtensionReportValue<"post">,
	): Promise<PostReport> {
		const reported = value.post;
		// 换行统一成 `\n`,正文与片段的 `text` 一起做;只有空白的正文是空串,卡上正文块收起。
		const [text = reported.text] = normalizeNewlines([reported.text]);
		const post: Post = {
			creator: creatorFromExtension(externalId, reported.creator),
			publishedAt: utcIsoOf(reported.publishedAt),
			text: text.trim() === "" ? "" : text,
		};
		if (reported.topic !== undefined) post.topic = reported.topic;
		if (post.text !== "" && reported.richText !== undefined) {
			const segmentTexts = normalizeNewlines(reported.richText.map((segment) => segment.text));
			post.richText = reported.richText.map((segment, index) => ({
				...segment,
				text: segmentTexts[index] ?? segment.text,
			})) as RichText;
		}
		if (reported.images !== undefined) {
			post.images = await Promise.all(reported.images.map(postImageFromRef));
		}
		// 视频作品的 `label`(「投稿了视频」)不要了:主人 2026-10-24 定,契约不开 `label`,宿主也不替平台写这句。
		if (reported.video !== undefined) {
			const video = reported.video;
			post.video = {
				cover: video.cover === undefined ? {} : await postImageFromRef(video.cover),
				title: video.title ?? "",
				description: video.description ?? "",
				...(video.durationSec === undefined ? {} : { durationSec: video.durationSec }),
				...(video.views === undefined ? {} : { views: video.views }),
			};
		}
		if (reported.stats !== undefined && Object.keys(reported.stats).length > 0) {
			post.stats = reported.stats;
		}
		// 片段的字拼起来不等于正文就丢掉富文本(所有来源同一套整理)。
		return { postId: value.postId, url: value.url, post: normalizePost(post) };
	}

	function liveDetailsFromExtension(
		externalId: string,
		details: ExtensionLiveDetails,
	): LiveDetails {
		return {
			...(details.title === undefined ? {} : { title: details.title }),
			...(details.cover === undefined ? {} : { cover: coverOf(details.cover) }),
			...(details.category === undefined ? {} : { category: details.category }),
			...(details.url === undefined ? {} : { url: details.url }),
			...(details.currentViewers === undefined ? {} : { currentViewers: details.currentViewers }),
			...(details.totalViewers === undefined ? {} : { totalViewers: details.totalViewers }),
			...(details.likes === undefined ? {} : { likes: details.likes }),
			...(details.description === undefined ? {} : { description: details.description }),
			...(details.creator === undefined
				? {}
				: { creator: creatorFromExtension(externalId, details.creator) }),
		};
	}

	function liveSignalFromExtension(
		externalId: string,
		value: ExtensionReportValue<"live">,
		arrivedAt: number,
	): LiveSignalReport {
		const startedAt = value.startedAt === undefined ? {} : { startedAt: utcIsoOf(value.startedAt) };
		switch (value.kind) {
			case "start":
				return {
					kind: "start",
					...startedAt,
					details: liveDetailsFromExtension(externalId, value.details),
				};
			case "status":
				return {
					kind: "status",
					isLive: value.isLive,
					...startedAt,
					details: liveDetailsFromExtension(externalId, value.details),
				};
			case "end":
				return {
					kind: "end",
					// 下播的时刻是上报到达的那一刻(拓展没交时);断流接续的等待与时长都从它算。
					endedAt: utcIsoOf(value.endedAt ?? arrivedAt),
					...startedAt,
					...(value.details === undefined
						? {}
						: { details: liveDetailsFromExtension(externalId, value.details) }),
				};
		}
	}

	/**
	 * 拓展那一面的三种上报:都排进这个来源自己的一条串行队(翻作品要读图库、是异步的,不排队的话同一拓展先后两条
	 * 上报交给核心的次序会乱)。到这里一律不抛(抛了会砸在拓展自己的调用栈上);`stop()` 之后的不收。
	 */
	/**
	 * 交给核心之前再看一眼置停标记:队里排着(或正在读图)时来源停了,核心那一份 ctx 在登记表撤登记后紧接着就收,
	 * 交过去只会冒一条 error,所以丢、记 debug。
	 */
	function stillOpen(kind: ExtensionReportKind): boolean {
		if (!stopped) return true;
		logger.debug(`来源已停下,队里还没交出去的 ${kind} 上报丢弃`);
		return false;
	}

	function enqueue(kind: ExtensionReportKind, job: () => void | Promise<void>): void {
		if (stopped) {
			logger.warn(`来源已停下,还在上报 ${kind}(丢弃;拓展的 stop() 之后不许再上报)`);
			return;
		}
		queue.run(REPORT_QUEUE_KEY, job).catch((err: unknown) => {
			logger.error(`处理拓展的 ${kind} 上报时出错(丢弃): ${errorMessageOf(err)}`);
		});
	}

	return {
		descriptor,
		...(def.health ? { health: readHealth } : {}),
		async start(ctx: SourceContext) {
			// 🔴 逐格列出开放的成员,不展开核心那一份:`registerLinkResolver` / `registerAiToolProvider` /
			// `reportLiveInteraction` 运行时也拿不到(类型上排除不够,第三方 JS 不受类型约束)。
			const extensionCtx: ExtensionSourceContext = {
				logger: ctx.logger,
				signal: ctx.signal,
				onDispose: ctx.onDispose,
				state: ctx.state,
				secrets: ctx.secrets,
				redact: ctx.redact,
				reportProblem: ctx.reportProblem,
				resolveProblem: ctx.resolveProblem,
				settings: ctx.settings,
				http: ctx.http,
				fetchImage: ctx.fetchImage,
				storeImage: ctx.storeImage,
				subscriptions: ctx.subscriptions,
				onSubscriptionsChanged: ctx.onSubscriptionsChanged,
				reportPost(externalId, report) {
					enqueue("post", async () => {
						const admitted = admit("post", externalId, report);
						if (admitted) {
							const translated = await postReportFromExtension(admitted.externalId, admitted.value);
							if (stillOpen("post")) ctx.reportPost(admitted.externalId, translated);
						}
					});
				},
				reportLive(externalId, report) {
					// 下播的时刻取上报到达的那一刻,在核对之前就定下。
					const arrivedAt = now();
					enqueue("live", () => {
						const admitted = admit("live", externalId, report);
						if (admitted && stillOpen("live")) {
							ctx.reportLive(
								admitted.externalId,
								liveSignalFromExtension(admitted.externalId, admitted.value, arrivedAt),
							);
						}
					});
				},
				reportProfile(externalId, report) {
					enqueue("profile", () => {
						const admitted = admit("profile", externalId, report);
						if (admitted && stillOpen("profile"))
							ctx.reportProfile(admitted.externalId, admitted.value);
					});
				},
			};
			await def.start(extensionCtx);
		},
		async stop() {
			// 先置停(拒新的上报,队里还没交出去的也不再交),再叫拓展的 `stop`;登记表不等 `stop()` 返回。
			stopped = true;
			await def.stop();
		},
		async searchCreators(query, signal) {
			let raw: unknown;
			try {
				raw = await def.searchCreators(query, signal);
			} catch (err) {
				logger.warn(`搜人抛了: ${errorMessageOf(err)}`);
				return fail("unavailable", reasonOf(err));
			}
			const read = readResult(raw);
			if (read.kind === "failure") return read.failure;
			const parsed = ExtensionCreatorCandidatesSchema.safeParse(read.body.candidates);
			if (!parsed.success) {
				// 🔴 点名哪儿不对:吞成一句「出错了」的话,拓展作者只能对着黑盒猜。
				const detail = formatZodIssues(parsed.error).join(";");
				logger.warn(`搜人交回的候选形状不对: ${detail}`);
				return fail("invalid", t("extension.source.invalidCandidates", { detail }));
			}
			return ok({ candidates: parsed.data as CreatorCandidate[] });
		},
		async fetchProfile(identity: Identity, signal) {
			const fetchProfile = def.fetchProfile;
			if (!fetchProfile) return fail("unsupported", t("extension.source.noFetchProfile"));
			let raw: unknown;
			try {
				raw = await fetchProfile(identity, signal);
			} catch (err) {
				logger.warn(`取资料抛了: ${errorMessageOf(err)}`);
				return fail("unavailable", reasonOf(err));
			}
			const read = readResult(raw);
			if (read.kind === "failure") return read.failure;
			const checked = checkExtensionReport("profile", read.body);
			if (!checked.ok) {
				const reasons = checked.issues.map(describeIssue);
				const detail = reasons.join(";");
				logger.warn(`取资料交回的形状不对: ${detail}`);
				reject("profile", identity.externalId, reasons);
				return fail("invalid", t("extension.source.invalidResult", { detail }));
			}
			recordDropped("profile", identity.externalId, checked.dropped);
			return ok(checked.value satisfies CreatorProfileReport);
		},
		// 拓展实现了才放这一格(核心据此知道它有拉取式,按每一场自己的时钟问)。
		...(def.fetchLiveStatus
			? {
					async fetchLiveStatus(
						identity: Identity,
						signal: AbortSignal,
					): Promise<LiveStatusResult> {
						let raw: unknown;
						try {
							raw = await (def.fetchLiveStatus as NonNullable<OpenMembers["fetchLiveStatus"]>)(
								identity,
								signal,
							);
						} catch (err) {
							logger.warn(`拉取直播状态抛了: ${errorMessageOf(err)}`);
							return fail("unavailable", reasonOf(err));
						}
						const checked = checkExtensionLiveStatus(raw);
						if (!checked.ok) {
							const reasons = checked.issues.map(describeIssue);
							const detail = reasons.join(";");
							logger.warn(`拉取直播状态交回的形状不对: ${detail}`);
							reject("live", identity.externalId, reasons);
							return fail("invalid", t("extension.source.invalidResult", { detail }));
						}
						recordDropped("live", identity.externalId, checked.dropped);
						const result = checked.value;
						if (!result.ok) return fail(result.code, result.message);
						if (result.kind === "offline") return ok({ kind: "offline" as const });
						return ok({
							kind: "live" as const,
							...(result.startedAt === undefined ? {} : { startedAt: utcIsoOf(result.startedAt) }),
							// 作者名缺了同样按「资料名 → 身份标签」补(外部 id 取自被问的身份)。
							details: liveDetailsFromExtension(identity.externalId, result.details),
						});
					},
				}
			: {}),
	};
}
