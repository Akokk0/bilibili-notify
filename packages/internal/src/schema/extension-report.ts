import { z } from "zod";
import { FAILURE_CODES, type Failure, type FailureCode, fail, type Issue, ok } from "../result";
import { ImageRefSchema } from "./history";
import { EXTERNAL_ID_MAX } from "./subscriptions";

/**
 * 一条作品最多几张图。抖音图文一次最多 30 张(开放平台「创建图文」文档:「每次最多上传 30 张图片」;
 * App 里选图也是最多勾 30 张)。
 */
export const SUBSCRIPTION_POST_IMAGES_MAX = 30;

/** 正文、简介这类长文本的字数上限。 */
export const SUBSCRIPTION_REPORT_TEXT_MAX = 10_000;
/** 标题、分区的字数上限。 */
export const SUBSCRIPTION_REPORT_TITLE_MAX = 256;
/** 名字的字数上限。 */
export const SUBSCRIPTION_REPORT_NAME_MAX = 128;
/** 链接的字数上限。 */
export const SUBSCRIPTION_REPORT_URL_MAX = 2048;

const TIME_MIN = Date.UTC(2000, 0, 1);
const TIME_MAX = 8_640_000_000_000_000;
const CREATOR_CANDIDATES_MAX = 10;
const TOPIC_MAX = 64;
const BIO_MAX = SUBSCRIPTION_REPORT_TEXT_MAX;

const ExternalIdSchema = z.string().min(1).max(EXTERNAL_ID_MAX);
const NameSchema = z.string().min(1).max(SUBSCRIPTION_REPORT_NAME_MAX);
const UrlSchema = z
	.url({ protocol: /^https?$/, error: "invalid-url" })
	.max(SUBSCRIPTION_REPORT_URL_MAX);
const TimeSchema = z.number().int().min(TIME_MIN).max(TIME_MAX);
const CountSchema = z.number().int().nonnegative();

function stripTopic(value: string): string {
	const strippable = (char: string | undefined) =>
		char === "#" || (char !== undefined && /\s/.test(char));
	let start = 0;
	let end = value.length;
	while (start < end && strippable(value[start])) start++;
	while (end > start && strippable(value[end - 1])) end--;
	return value.slice(start, end);
}

const TopicSchema = z.preprocess(
	(value) => (typeof value === "string" ? stripTopic(value) : value),
	z.string().min(1).max(TOPIC_MAX),
);

const TRUNCATE_AT = new WeakMap<z.ZodType, number>();

function truncatingText(max: number) {
	const schema = z.string().max(max);
	TRUNCATE_AT.set(schema, max);
	return schema;
}

const PostTextSchema = truncatingText(SUBSCRIPTION_REPORT_TEXT_MAX);
const VideoTitleSchema = truncatingText(SUBSCRIPTION_REPORT_TITLE_MAX);
const LongTextSchema = z.string().max(SUBSCRIPTION_REPORT_TEXT_MAX);
const NarrativeTextSchema = z.string().max(SUBSCRIPTION_REPORT_TITLE_MAX);

/** 按 UTF-16 单元截、不劈开代理对。 */
export function truncateText(value: string, max: number): string {
	const last = value.charCodeAt(max - 1);
	return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

interface ArrayRule {
	max?: number;
}

const ARRAY_RULES = new WeakMap<z.ZodType, ArrayRule>();

function list<T extends z.ZodType>(item: T, rule: ArrayRule = {}) {
	const schema =
		rule.max === undefined ? z.array(item) : z.array(item).max(rule.max, `max:${rule.max}`);
	ARRAY_RULES.set(schema, rule);
	return schema;
}

const SubscriptionCreatorSchema = z.strictObject({
	name: NameSchema.optional(),
	avatar: ImageRefSchema.optional(),
});

const ExtensionRichTextSegmentSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("text"),
		text: LongTextSchema,
	}),
	z.strictObject({
		kind: z.literal("mention"),
		text: LongTextSchema,
		userId: ExternalIdSchema.optional(),
	}),
	z.strictObject({
		kind: z.literal("topic"),
		text: LongTextSchema,
		name: TopicSchema,
	}),
	z.strictObject({
		kind: z.literal("link"),
		text: LongTextSchema,
		url: UrlSchema,
		icon: ImageRefSchema.optional(),
	}),
	z.strictObject({
		kind: z.literal("emoji"),
		text: LongTextSchema,
		image: ImageRefSchema.optional(),
	}),
]);

const PostVideoSchema = z.strictObject({
	cover: ImageRefSchema.optional(),
	title: VideoTitleSchema.optional(),
	description: LongTextSchema.optional(),
	durationSec: z.number().nonnegative().optional(),
	views: CountSchema.optional(),
});

const PostStatsSchema = z.strictObject({
	likes: CountSchema.optional(),
	comments: CountSchema.optional(),
	shares: CountSchema.optional(),
});

const PostSchema = z.strictObject({
	creator: SubscriptionCreatorSchema.optional(),
	publishedAt: TimeSchema,
	text: PostTextSchema,
	richText: list(ExtensionRichTextSegmentSchema).optional(),
	images: list(ImageRefSchema, { max: SUBSCRIPTION_POST_IMAGES_MAX }).optional(),
	topic: TopicSchema.optional(),
	video: PostVideoSchema.optional(),
	stats: PostStatsSchema.optional(),
});

export const ExtensionPostReportSchema = z.strictObject({
	postId: ExternalIdSchema,
	url: UrlSchema,
	post: PostSchema,
});

const LiveDetailsSchema = z.strictObject({
	creator: SubscriptionCreatorSchema.optional(),
	title: NarrativeTextSchema.optional(),
	cover: ImageRefSchema.optional(),
	category: NarrativeTextSchema.optional(),
	url: UrlSchema.optional(),
	currentViewers: CountSchema.optional(),
	totalViewers: CountSchema.optional(),
	likes: CountSchema.optional(),
	description: LongTextSchema.optional(),
});

const ExtensionLiveStartSchema = z.strictObject({
	kind: z.literal("start"),
	startedAt: TimeSchema.optional(),
	details: LiveDetailsSchema,
});

const ExtensionLiveStatusSignalSchema = z.strictObject({
	kind: z.literal("status"),
	isLive: z.boolean(),
	startedAt: TimeSchema.optional(),
	details: LiveDetailsSchema,
});

const ExtensionLiveEndSchema = z.strictObject({
	kind: z.literal("end"),
	endedAt: TimeSchema.optional(),
	startedAt: TimeSchema.optional(),
	details: LiveDetailsSchema.optional(),
});

export const ExtensionLiveSignalReportSchema = z.discriminatedUnion("kind", [
	ExtensionLiveStartSchema,
	ExtensionLiveStatusSignalSchema,
	ExtensionLiveEndSchema,
]);

export const ExtensionCreatorProfileReportSchema = z.strictObject({
	name: NameSchema,
	avatar: ImageRefSchema.optional(),
	bio: z.string().max(BIO_MAX).optional(),
	followers: CountSchema.optional(),
	fanClubName: NameSchema.optional(),
});

const ExtensionCreatorCandidateSchema = z.strictObject({
	externalId: ExternalIdSchema,
	name: NameSchema,
	avatar: ImageRefSchema.optional(),
	bio: z.string().max(BIO_MAX).optional(),
	followers: CountSchema.optional(),
	fanClubName: NameSchema.optional(),
});

export const ExtensionCreatorCandidatesSchema = z
	.array(ExtensionCreatorCandidateSchema)
	.max(CREATOR_CANDIDATES_MAX)
	.superRefine((candidates, ctx) => {
		const seen = new Set<string>();
		candidates.forEach((candidate, index) => {
			if (seen.has(candidate.externalId)) {
				ctx.addIssue({
					code: "custom",
					path: [index, "externalId"],
					message: "duplicate",
				});
			}
			seen.add(candidate.externalId);
		});
	});

const LiveStatusLiveSchema = z.strictObject({
	ok: z.literal(true),
	kind: z.literal("live"),
	startedAt: TimeSchema.optional(),
	details: LiveDetailsSchema,
});

const LiveStatusOfflineSchema = z.strictObject({
	ok: z.literal(true),
	kind: z.literal("offline"),
});

const LiveStatusFailureSchema = z.strictObject({
	ok: z.literal(false),
	code: z.enum(Object.keys(FAILURE_CODES) as [FailureCode, ...FailureCode[]]),
	message: z.string().min(1),
});

export const ExtensionLiveStatusResultSchema = z.union([
	z.discriminatedUnion("kind", [LiveStatusLiveSchema, LiveStatusOfflineSchema]),
	LiveStatusFailureSchema,
]);

export const ExtensionSourceHealthSchema = z.strictObject({
	summary: z.string(),
});

const REPORT_SCHEMAS = {
	post: ExtensionPostReportSchema,
	live: ExtensionLiveSignalReportSchema,
	profile: ExtensionCreatorProfileReportSchema,
} as const;

export type ExtensionReportKind = keyof typeof REPORT_SCHEMAS;
export type ExtensionReportValue<K extends ExtensionReportKind> = z.infer<
	(typeof REPORT_SCHEMAS)[K]
>;

export type ExtensionReportIssueCode =
	| "unknown-field"
	| "required"
	| "type"
	| "invalid"
	| "too-short"
	| "too-long"
	| "below-min"
	| "above-max"
	| "not-integer"
	| "negative"
	| "too-many"
	| "duplicate";

export interface ExtensionReportIssue {
	path: (string | number)[];
	code: ExtensionReportIssueCode;
	limit?: number;
}

export type ExtensionReportFailureIssue = Issue & ExtensionReportIssue;

export type ExtensionReportFailure = Failure & {
	code: "invalid";
	issues: ExtensionReportFailureIssue[];
};

export type ExtensionReportCheck<K extends ExtensionReportKind> =
	| {
			ok: true;
			value: ExtensionReportValue<K>;
			dropped: ExtensionReportIssue[];
	  }
	| ExtensionReportFailure;

function reportIssue(
	path: (string | number)[],
	code: ExtensionReportIssueCode,
	limit?: number,
): ExtensionReportIssue {
	const issue: ExtensionReportIssue = { path: [...path], code };
	if (limit !== undefined) issue.limit = limit;
	return issue;
}

type CellOutcome =
	| { accepted: true; value: unknown }
	| { accepted: false; fatal: boolean; issue: ExtensionReportIssue };

interface WalkState {
	dropped: ExtensionReportIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(path: (string | number)[], key: string | number): (string | number)[] {
	return [...path, key];
}

function issueLimit(value: bigint | number | undefined): number | undefined {
	return typeof value === "bigint" ? Number(value) : value;
}

function parsedIssue(
	schema: z.ZodType,
	value: unknown,
	path: (string | number)[],
): ExtensionReportIssue {
	const parsed = schema.safeParse(value);
	if (parsed.success) return reportIssue(path, "invalid");
	const first = parsed.error.issues[0];
	if (first === undefined) return reportIssue(path, "invalid");
	if (first.code === "too_small") {
		const limit = issueLimit(first.minimum);
		if (first.origin === "string") return reportIssue(path, "too-short", limit);
		if (limit === 0) return reportIssue(path, "negative", limit);
		return reportIssue(path, "below-min", limit);
	}
	if (first.code === "too_big") {
		const limit = issueLimit(first.maximum);
		return reportIssue(path, first.origin === "string" ? "too-long" : "above-max", limit);
	}
	if (
		first.code === "invalid_type" &&
		typeof value === "number" &&
		Number.isFinite(value) &&
		!Number.isInteger(value)
	) {
		return reportIssue(path, "not-integer");
	}
	if (first.code === "invalid_type") return reportIssue(path, "type");
	return reportIssue(path, "invalid");
}

function walkObject(
	shape: Record<string, z.ZodType>,
	raw: Record<string, unknown>,
	path: (string | number)[],
	state: WalkState,
): CellOutcome {
	const unknown = Object.keys(raw).filter((key) => !Object.hasOwn(shape, key));
	if (unknown.length > 0) {
		return {
			accepted: false,
			fatal: true,
			issue: reportIssue(at(path, unknown[0]), "unknown-field"),
		};
	}
	const out: Record<string, unknown> = {};
	for (const [key, schema] of Object.entries(shape)) {
		const where = at(path, key);
		const optional = schema instanceof z.ZodOptional;
		const value = raw[key];
		if (value === undefined) {
			if (!optional) {
				return {
					accepted: false,
					fatal: false,
					issue: reportIssue(where, "required"),
				};
			}
			continue;
		}
		const cell = walkCell((optional ? schema.unwrap() : schema) as z.ZodType, value, where, state);
		if (cell.accepted) {
			out[key] = cell.value;
		} else if (cell.fatal || !optional) {
			return cell;
		} else {
			state.dropped.push(cell.issue);
		}
	}
	return { accepted: true, value: out };
}

function walkUnion(
	schema: { options: readonly z.ZodType[] },
	value: unknown,
	path: (string | number)[],
	state: WalkState,
) {
	if (!isRecord(value) || typeof value.kind !== "string") {
		return {
			accepted: false as const,
			fatal: false,
			issue: reportIssue(path, "invalid"),
		};
	}
	for (const option of schema.options) {
		if (!(option instanceof z.ZodObject)) continue;
		const kind = option.shape.kind;
		if (!(kind instanceof z.ZodLiteral) || kind.value !== value.kind) continue;
		return walkObject(option.shape as Record<string, z.ZodType>, value, path, state);
	}
	return {
		accepted: false as const,
		fatal: false,
		issue: reportIssue(path, "invalid"),
	};
}

function walkCell(
	schema: z.ZodType,
	value: unknown,
	path: (string | number)[],
	state: WalkState,
): CellOutcome {
	if (schema instanceof z.ZodObject) {
		if (!isRecord(value)) {
			return { accepted: false, fatal: false, issue: reportIssue(path, "type") };
		}
		return walkObject(schema.shape as Record<string, z.ZodType>, value, path, state);
	}
	if (schema instanceof z.ZodUnion) {
		return walkUnion(schema as unknown as { options: readonly z.ZodType[] }, value, path, state);
	}
	if (schema instanceof z.ZodArray) {
		if (!Array.isArray(value)) {
			return { accepted: false, fatal: false, issue: reportIssue(path, "type") };
		}
		const max = ARRAY_RULES.get(schema)?.max;
		const kept: unknown[] = [];
		const limit = max ?? value.length;
		for (let index = 0; index < Math.min(value.length, limit); index++) {
			const cell = walkCell(
				schema.element as unknown as z.ZodType,
				value[index],
				at(path, index),
				state,
			);
			if (cell.accepted) kept.push(cell.value);
			else if (cell.fatal) return cell;
			else state.dropped.push(cell.issue);
		}
		if (max !== undefined && value.length > max) {
			state.dropped.push(reportIssue(at(path, max), "too-many", max));
		}
		return { accepted: true, value: kept };
	}
	if (typeof value === "string") {
		const cut = TRUNCATE_AT.get(schema);
		if (cut !== undefined && value.length > cut) {
			state.dropped.push(reportIssue(path, "too-long", cut));
			value = truncateText(value, cut);
		}
	}
	const parsed = schema.safeParse(value);
	return parsed.success
		? { accepted: true, value: parsed.data }
		: { accepted: false, fatal: false, issue: parsedIssue(schema, value, path) };
}

function liveSchemaFor(raw: Record<string, unknown>): z.ZodType | undefined {
	switch (raw.kind) {
		case "start":
			return ExtensionLiveStartSchema;
		case "status":
			return ExtensionLiveStatusSignalSchema;
		case "end":
			return ExtensionLiveEndSchema;
		default:
			return undefined;
	}
}

function rejected(issues: ExtensionReportIssue[]): ExtensionReportFailure {
	return fail("invalid", "extension-report-invalid", {
		issues: issues.map((issue) => ({ ...issue, message: issue.code })),
	}) as ExtensionReportFailure;
}

export function checkExtensionReport<K extends ExtensionReportKind>(
	kind: K,
	raw: unknown,
): ExtensionReportCheck<K> {
	try {
		if (!isRecord(raw)) {
			return rejected([reportIssue([], "type")]);
		}
		const schema: z.ZodType | undefined =
			kind === "live" ? liveSchemaFor(raw) : (REPORT_SCHEMAS[kind] as z.ZodObject);
		if (schema === undefined) {
			return rejected([reportIssue(["kind"], "invalid")]);
		}
		const state: WalkState = { dropped: [] };
		const walked =
			schema instanceof z.ZodObject
				? walkObject(schema.shape as Record<string, z.ZodType>, raw, [], state)
				: undefined;
		if (walked === undefined || !walked.accepted) {
			return rejected([walked?.accepted === false ? walked.issue : reportIssue([], "invalid")]);
		}
		const whole = schema.safeParse(walked.value);
		if (!whole.success) {
			return rejected(
				whole.error.issues.map((issue) =>
					reportIssue(
						issue.path.map((part) => (typeof part === "symbol" ? String(part) : part)),
						"invalid",
					),
				),
			);
		}
		return ok({
			value: whole.data as ExtensionReportValue<K>,
			dropped: state.dropped,
		});
	} catch {
		return rejected([reportIssue([], "invalid")]);
	}
}
