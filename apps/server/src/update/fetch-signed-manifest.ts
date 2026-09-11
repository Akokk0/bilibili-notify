import { type ZodType, z } from "zod";
import { type Acceptance, fetchThroughMirrors } from "./fetch-through-mirrors.js";
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

export interface FetchSignedManifestInput {
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

export type FetchSignedFailure = "unreachable" | "malformed" | "untrusted" | "stale";

export type FetchSignedManifestResult =
	| { ok: true; manifest: Manifest }
	/** `stale`:签名没问题,但比之前见过的旧 —— 多半是代理站缓存,也可能是回放。 */
	| { ok: false; reason: FetchSignedFailure };

export interface FetchSignedJsonInput<T> extends FetchSignedManifestInput {
	/** 信封里那份 JSON 的形状。 */
	schema: ZodType<T>;
	/** 新鲜度从哪一格读;回 `undefined` 就不查。 */
	issuedAtOf: (value: T) => number | undefined;
}

export type FetchSignedJsonResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: FetchSignedFailure };

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
): Acceptance<T, "malformed" | "untrusted" | "stale"> {
	let envelope: unknown;
	try {
		envelope = JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		return { ok: false, reason: "malformed" };
	}

	const shaped = EnvelopeSchema.safeParse(envelope);
	if (!shaped.success) return { ok: false, reason: "malformed" };

	// 待验的字节 = 解析出来那串字符的 UTF-8,**不是文件字节**。所以信封本身怎么
	// 重排、换缩进、换转义写法都无所谓,签名照样成立。
	const signedBytes = Buffer.from(shaped.data.manifest, "utf8");
	const loaded = loadSignedJson(signedBytes, shaped.data.signature, trustedKeys, schema);
	if (!loaded.ok) {
		// 「签名验不过」和「签名没问题但内容不是一份清单」是两件事:前者可能有人在
		// 中间做手脚(该弹红字),后者是我们自己发错了东西(该指向发版侧)。混成一个
		// 的话,代理站抽风会被报成安全事件,而真篡改会被当成小毛病。
		return { ok: false, reason: loaded.reason === "malformed" ? "malformed" : "untrusted" };
	}
	// 新鲜度也在候选循环里判:代理站缓存了旧清单是常态,换下一个候选就好;直连给的
	// 都比见过的旧,那才是要报出去的事。
	const issuedAt = issuedAtOf(loaded.value);
	if (minIssuedAt !== undefined && issuedAt !== undefined && issuedAt < minIssuedAt) {
		return { ok: false, reason: "stale" };
	}
	return { ok: true, value: loaded.value };
}

export async function fetchSignedManifest(
	input: FetchSignedManifestInput,
): Promise<FetchSignedManifestResult> {
	const fetched = await fetchSignedJson({
		...input,
		schema: ManifestSchema,
		issuedAtOf: (manifest) => manifest.issuedAt,
	});
	return fetched.ok ? { ok: true, manifest: fetched.value } : fetched;
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
}: FetchSignedJsonInput<T>): Promise<FetchSignedJsonResult<T>> {
	const fetched = await fetchThroughMirrors({
		url,
		mirrors,
		timeoutMs,
		maxBytes,
		accept: (bytes) => acceptEnvelope(bytes, trustedKeys, minIssuedAt, schema, issuedAtOf),
	});
	if (fetched.ok) return { ok: true, value: fetched.value };
	// 归因来自最后一个候选(直连):它连字节都没拿到 → unreachable;它拿到了但验不过
	// → 那才是真的 malformed / untrusted。前面代理站说了什么胡话都不会漏到这儿。
	return {
		ok: false,
		reason: fetched.reason === "all-mirrors-failed" ? "unreachable" : fetched.reason,
	};
}
