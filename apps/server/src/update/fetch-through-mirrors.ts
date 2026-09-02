/** 拿到字节之后的验收:成就带着解出来的值走,不成就带着理由换下一个候选。 */
export type Acceptance<T, R extends string> = { ok: true; value: T } | { ok: false; reason: R };

export interface FetchThroughMirrorsInput<T, R extends string> {
	/** 真实地址(GitHub Release 资产)。候选站以**前缀**形式拼在它前面。 */
	url: string;
	/**
	 * 按**试的顺序**给的候选站列表。空串表示直连(不加前缀)。
	 *
	 * 顺序即策略,这个函数不掺和 —— 直连排第几是上层的事:海外用户直连最快,
	 * 国内用户直连最慢。
	 */
	mirrors: readonly string[];
	/** 收下的字节上限。 */
	maxBytes: number;
	/**
	 * 单个候选的超时。**卡住的站比失败的站更糟** —— 失败会立刻换下一个,卡住会把
	 * 整次检查更新挂在那儿,而代理站最常见的死法恰恰是卡住而不是干脆拒绝。
	 */
	timeoutMs: number;
	/**
	 * 拿到字节之后的验收(验签 / sha256),**在候选循环里面**跑。
	 *
	 * 国内代理站最常见的死法不是 502,而是 **200 + 一张限流 / 门户 HTML** —— 只按状态码
	 * 换站的实现会把那张页当内容收下,然后整条更新死在验签上,而直连(永远排在末尾)
	 * 从没被试过。验收不过就和网络失败一样换下一个。
	 */
	accept: (bytes: Uint8Array) => Acceptance<T, R>;
}

export type FetchThroughMirrorsResult<T, R extends string> =
	| { ok: true; value: T }
	/**
	 * 没有一个候选交出验收得过的字节。理由取**最后一个候选**的:它拿到了字节但验收
	 * 不过 → 它的验收理由;它连字节都没拿到 → `all-mirrors-failed`。直连永远是最后
	 * 一个,所以「签名不对」这种要弹红字的归因只会来自直连,前面代理站的垃圾页
	 * 不会被报成安全事件。
	 */
	| { ok: false; reason: "all-mirrors-failed" | R };

/**
 * 边读边数,超过上限**当场 cancel**。不能「先 arrayBuffer() 收完再看大小」——
 * 那等于把内存用量交给对方决定,一个不肯停的流就能把容器撑爆。
 *
 * 返回 null 表示这个候选超限,按失败处理。
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
	const reader = response.body?.getReader();
	if (!reader) {
		// 极少数没有 body stream 的实现:退化成缓冲后即时校验。
		const buffered = await response.arrayBuffer();
		return buffered.byteLength > maxBytes ? null : new Uint8Array(buffered);
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function candidateUrl(mirror: string, url: string): string {
	return mirror ? `${mirror.replace(/\/+$/, "")}/${url}` : url;
}

/**
 * 按给定顺序逐个候选试,第一个**验收得过**的就返回。
 *
 * 三种失败同等对待、都换下一个:抛错、非 2xx、以及 **2xx 但验收不过**。前两种是
 * 代理站挂了,第三种是代理站活着但在说胡话(限流页、门户页、缓存了半截的文件)——
 * 后者更常见,也更阴险:只按状态码换站的实现会把它当内容收下,整条更新死在验签上。
 */
export async function fetchThroughMirrors<T, R extends string>({
	url,
	mirrors,
	maxBytes,
	timeoutMs,
	accept,
}: FetchThroughMirrorsInput<T, R>): Promise<FetchThroughMirrorsResult<T, R>> {
	let last: "all-mirrors-failed" | R = "all-mirrors-failed";
	for (const mirror of mirrors) {
		last = "all-mirrors-failed";
		try {
			// signal 同时管住建连和读 body —— 慢慢滴水的站也一样被这一条掐断。
			const response = await fetch(candidateUrl(mirror, url), {
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!response.ok) continue;
			const bytes = await readCapped(response, maxBytes);
			if (bytes === null) continue; // 这个候选灌太多,换下一个
			const accepted = accept(bytes);
			if (accepted.ok) return { ok: true, value: accepted.value };
			last = accepted.reason; // 拿到了字节但不是我们要的,换下一个
		} catch {
			// 这个候选不通,换下一个。全都不通时由下面统一报。
		}
	}
	return { ok: false, reason: last };
}
