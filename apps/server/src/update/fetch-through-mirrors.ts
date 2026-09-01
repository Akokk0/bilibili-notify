export interface FetchThroughMirrorsInput {
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
}

export type FetchThroughMirrorsResult =
	| { ok: true; bytes: Uint8Array }
	/** 每个候选都试过了,没有一个拿得到。 */
	| { ok: false; reason: "all-mirrors-failed" };

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
 * 按给定顺序逐个候选试,第一个成功就返回。
 *
 * **非 2xx 与抛错同等对待** —— 代理站挂掉时多半是回一张 502/404 页面而不是抛错,
 * 只 catch 异常的实现会把那张错误页当内容收下,然后在验签那里报「签名不对」,
 * 给用户一条完全指错方向的错误信息。
 */
export async function fetchThroughMirrors({
	url,
	mirrors,
	maxBytes,
	timeoutMs,
}: FetchThroughMirrorsInput): Promise<FetchThroughMirrorsResult> {
	for (const mirror of mirrors) {
		try {
			// signal 同时管住建连和读 body —— 慢慢滴水的站也一样被这一条掐断。
			const response = await fetch(candidateUrl(mirror, url), {
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!response.ok) continue;
			const bytes = await readCapped(response, maxBytes);
			if (bytes === null) continue; // 这个候选灌太多,换下一个
			return { ok: true, bytes };
		} catch {
			// 这个候选不通,换下一个。全都不通时由下面统一报。
		}
	}
	return { ok: false, reason: "all-mirrors-failed" };
}
