import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { z } from "zod";

/**
 * 升级清单的**唯一**信任入口。
 *
 * 解析与验签在这里合成一扇门:调用方要么拿到一个已验签的 {@link Manifest},
 * 要么什么都拿不到。故意不提供「先解析、后验签」的两段式 API —— 那会让
 * 「已解析但未验证」的中间态出现在调用方手里,而那正是「忘了验签」这类 bug
 * 的温床;签名机制一旦被绕过一次,整套自主升级就等于没有。
 *
 * 签名覆盖的是**清单文件的原始字节**,不是重新序列化的 JSON —— 键序、空白、
 * 换行的任何差异都会让验签失败,这是故意的。
 */
/**
 * 未知字段会被**丢弃而不是拒绝** —— 老客户端拿到带新字段的清单必须照样能读,
 * 否则我们一加字段,存量安装就集体失去升级能力。
 */
const ManifestSchema = z.object({
	version: z.string(),
	/**
	 * 这一版的载荷:去哪下、多大、校验和是多少。**必填** —— 一份不说载荷在哪的
	 * 清单对客户端毫无用处。
	 *
	 * 下面几条约束挡的全是**我们自己发版侧写错**,不是攻击(整份清单是签过的,
	 * 外人改不动)。写错的代价是:签得过、下得动,最后死在 `installPayload` 的
	 * sha256 比对上 —— 用户看到「下载完了升级失败」,一条完全指错方向的信息。
	 * 在这里当场拒绝,错误至少指向清单本身。
	 */
	payload: z.object({
		/**
		 * https 强制。真正拦住改包的是下面那个 sha256,但没有理由把 https 这道
		 * 免费的门让出去。**不影响用户用 http 自建镜像** —— 镜像前缀是客户端本地
		 * 配置,拼在这条地址**前面**,不受这里约束。
		 */
		url: z.string().url().startsWith("https://"),
		/** 小写 hex,64 位。比对是字符串相等,大写或长度不对就永远匹配不上算出来的摘要。 */
		sha256: z.string().regex(/^[0-9a-f]{64}$/),
		/** 流式熔断的上限来源。0 / 负数会让每次下载一开始就当场超限。 */
		size: z.number().int().positive(),
	}),
	/**
	 * 这一版的发布页。下不动时「通知 + 给个链接让用户自己去下」是设计里的兜底
	 * 出口,那条链接得在清单里 —— 客户端不许自己拼 GitHub 地址(拼错了就是把用户
	 * 送去一个不存在的页面,而且我们永远不会知道)。
	 */
	releaseUrl: z.string().url().startsWith("https://"),
	/**
	 * 签发时间(epoch 秒)。**必填** —— 这是清单的新鲜度:签名只证明「这串字节我们签过」,
	 * 不证明它是**当前**那一份。加速站是设计上的中间人,它拿不出未签名的代码,但拿得出
	 * 我们签过的**旧**清单 —— 一直回放那份被撤回版本的清单,就能把用户钉在坏版本上,
	 * 面板全程绿。客户端记住见过的最大值,比它旧的一律不收。
	 */
	issuedAt: z.number().int().positive(),
	/** 给用户看的一句话说明,可选。 */
	notes: z.string().optional(),
	/**
	 * 事后撤回的版本号。发出去的版本收不回来,这是唯一能拦住**还没升的人**的手段
	 * —— 已经中招的那批靠客户端启动失败自愈,不靠这里。
	 *
	 * 可选:老清单没有这个字段,照样要读得出来。
	 */
	revoked: z.array(z.string()).optional(),
	/**
	 * 这一版**对镜像/安装包的最低要求**。载荷可以比镜像新,但 Node、chromium、
	 * 字体、tini 全都来自镜像 —— 要求不满足时只能让用户去重拉镜像,在线升不动。
	 *
	 * 可选:绝大多数版本不抬门槛,不写就是「谁都能装」。
	 */
	requires: z
		.object({
			nodeMajor: z.number().int().optional(),
		})
		.optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;

export type LoadManifestResult =
	| { ok: true; manifest: Manifest }
	/** 信任列表里没有一把公钥能验过这串字节 —— 被改过,或不是我们签的。 */
	| { ok: false; reason: "bad-signature" }
	/** 签名验过了,但内容读不出一个合法清单 —— 通常意味着我们自己签错了东西。 */
	| { ok: false; reason: "malformed" };

/**
 * @param bytes 清单文件的原始字节。
 * @param signatureBase64 Ed25519 签名(base64)。
 * @param trustedKeysBase64 内置信任列表:Ed25519 公钥的 SPKI DER(base64)。
 *   **多于一把**是设计使然 —— 主用私钥泄露时,备用私钥是唯一的退路。
 */
export function loadSignedManifest(
	bytes: Uint8Array,
	signatureBase64: string,
	trustedKeysBase64: readonly string[],
): LoadManifestResult {
	const signature = Buffer.from(signatureBase64, "base64");

	const verified = trustedKeysBase64.some((keyBase64) =>
		cryptoVerify(
			null,
			bytes,
			createPublicKey({
				key: Buffer.from(keyBase64, "base64"),
				format: "der",
				type: "spki",
			}),
			signature,
		),
	);
	if (!verified) return { ok: false, reason: "bad-signature" };

	// 清单是从网上下来的,而分发链上站着我们不控制的代理站。任何让它把进程带走
	// 的路径,都等于白送对方一个拒绝服务的开关。
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		return { ok: false, reason: "malformed" };
	}

	// 验签只证明「这是我们签的、没被改过」,不证明内容是对的。我们自己签错一次
	// 东西,下游就会拿着一份 version 缺失的清单去比版本 —— NapCat 更新完显示
	// 0.0.0 就是这一类。
	const shaped = ManifestSchema.safeParse(parsed);
	if (!shaped.success) return { ok: false, reason: "malformed" };

	return { ok: true, manifest: shaped.data };
}
