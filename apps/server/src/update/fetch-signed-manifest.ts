import { type Failure, fail, ok, type Result } from "@bilibili-notify/internal";
import { type ZodType, z } from "zod";
import { t } from "../i18n/index.js";
import { fetchThroughMirrors, type MirrorAcceptanceResult } from "./fetch-through-mirrors.js";
import { loadSignedJson, type Manifest, ManifestSchema } from "./signed-manifest.js";

/**
 * 运输信封。**外层从不被签** —— 被签的是 `manifest` 那串字符,它是文件的真子集
 * 且不含签名,所以不存在「文件包含自己的签名」那种循环。
 *
 * 清单内容原样当**字符串**放进来,不展开成对象:展开的话验签就得把它重新序列化,
 * 而 JSON 的重新序列化不唯一(键序/空白/数字写法/unicode 转义),发版侧和客户端
 * 差一点就会验不过,且完全查不出原因。
 */
const EnvelopeSchema = z.object({
	manifest: z.string(),
	signature: z.string(),
});

export interface FetchSignedManifestOptions {
	url: string;
	mirrors: readonly string[];
	/** 内置信任列表:Ed25519 公钥的 SPKI DER(base64),主用 + 备用。 */
	trustedKeys: readonly string[];
	timeoutMs: number;
	maxBytes: number;
	/**
	 * 之前见过的最大 `issuedAt`。比它旧的清单不收 —— 签名有效不等于是当前那份,
	 * 加速站可以回放一份旧的。不传就不查(第一次、或者调用方不关心)。
	 */
	minIssuedAt?: number;
}

export type SignedDocumentFailureKind = "unreachable" | "malformed" | "untrusted" | "stale";

export type FetchSignedManifestResult = Result<{ manifest: Manifest }>;

export interface FetchSignedJsonOptions<T> extends FetchSignedManifestOptions {
	/** 信封里那份 JSON 的形状。 */
	schema: ZodType<T>;
	/** 新鲜度从哪一格读;回 `undefined` 就不查。 */
	issuedAtOf: (value: T) => number | undefined;
}

export type FetchSignedJsonResult<T> = Result<{ value: T }>;

/** 展示层的诊断分类，依据标准码，不按错误文字猜。 */
export function signedFailureKind(failure: Failure): SignedDocumentFailureKind {
	if (failure.code === "unauthorized") return "untrusted";
	if (failure.code === "invalid") return "malformed";
	if (failure.code === "conflict") return "stale";
	return "unreachable";
}

/**
 * 一份字节是不是我们签过的清单。**在候选循环里跑**:代理站回 200 + 垃圾页时,这里
 * 不过就换下一个候选,而不是让整条更新死在这一个站上。
 */
function acceptEnvelope<T>(
	bytes: Uint8Array,
	trustedKeys: readonly string[],
	minIssuedAt: number | undefined,
	schema: ZodType<T>,
	issuedAtOf: (value: T) => number | undefined,
): MirrorAcceptanceResult<T> {
	let envelope: unknown;
	try {
		envelope = JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		return fail("invalid", t("update.validation.document"));
	}

	const shaped = EnvelopeSchema.safeParse(envelope);
	if (!shaped.success) return fail("invalid", t("update.validation.document"));

	// 待验的字节 = 解析出来那串字符的 UTF-8,**不是文件字节**。所以信封本身怎么
	// 重排、换缩进、换转义写法都无所谓,签名照样成立。
	const signedBytes = Buffer.from(shaped.data.manifest, "utf8");
	const loaded = loadSignedJson(signedBytes, shaped.data.signature, trustedKeys, schema);
	if (!loaded.ok) {
		// 「签名验不过」和「签名没问题但内容不是一份清单」是两件事:前者可能有人在
		// 中间做手脚(该弹红字),后者是我们自己发错了东西(该指向发版侧)。混成一个
		// 的话,代理站抽风会被报成安全事件,而真篡改会被当成小毛病。
		return loaded;
	}
	// 新鲜度也在候选循环里判:代理站缓存了旧清单是常态,换下一个候选就好;直连给的
	// 都比见过的旧,那才是要报出去的事。
	const issuedAt = issuedAtOf(loaded.value);
	if (minIssuedAt !== undefined && issuedAt !== undefined && issuedAt < minIssuedAt) {
		return fail("conflict", t("update.validation.stale"));
	}
	return ok({ value: loaded.value });
}

export async function fetchSignedManifest(
	input: FetchSignedManifestOptions,
): Promise<FetchSignedManifestResult> {
	const fetched = await fetchSignedJson({
		...input,
		schema: ManifestSchema,
		issuedAtOf: (manifest) => manifest.issuedAt,
	});
	return fetched.ok ? ok({ manifest: fetched.value }) : fetched;
}

/** 同一条链的通用形态 —— 拓展市场的官方索引也是我们签的一份 JSON,走的就是它。 */
export async function fetchSignedJson<T>({
	url,
	mirrors,
	trustedKeys,
	timeoutMs,
	maxBytes,
	minIssuedAt,
	schema,
	issuedAtOf,
}: FetchSignedJsonOptions<T>): Promise<FetchSignedJsonResult<T>> {
	const fetched = await fetchThroughMirrors({
		url,
		mirrors,
		timeoutMs,
		maxBytes,
		accept: (bytes) => acceptEnvelope(bytes, trustedKeys, minIssuedAt, schema, issuedAtOf),
	});
	return fetched;
}
