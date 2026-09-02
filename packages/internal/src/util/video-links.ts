/**
 * 从聊天文本里挑出 B 站视频引用 —— 链接解析的入口判定,纯函数、零依赖。
 *
 * 只认三种形态,且域名必须是 bilibili.com(含任意子域)或 b23.tv:
 * - `…bilibili.com/video/BV<10 位>`
 * - `…bilibili.com/video/av<数字>`
 * - `https://b23.tv/<token>`(原样交出,由调用方跟一跳重定向再解)
 *
 * 别的域名一律不认。解析结果会驱动服务端去发请求,认错域名等于让任意站点指挥
 * 我们去连它。域名前用负向后顾钉住边界,`notbilibili.com` 这种长得像的不算。
 */

export type VideoLinkRef =
	| { kind: "bvid"; bvid: string }
	| { kind: "aid"; aid: string }
	| { kind: "short"; url: string };

const VIDEO_PATH_RE =
	/(?<![A-Za-z0-9.-])(?:https?:\/\/)?(?:[a-z0-9-]+\.)*bilibili\.com\/video\/(?:(BV[0-9A-Za-z]{10})|av(\d+))(?![0-9A-Za-z])/gi;
const SHORT_LINK_RE = /(?<![A-Za-z0-9.-])https?:\/\/b23\.tv\/([A-Za-z0-9]+)/gi;

export function extractVideoLinks(text: string): VideoLinkRef[] {
	if (!text) return [];
	const found: { at: number; ref: VideoLinkRef }[] = [];
	for (const m of text.matchAll(VIDEO_PATH_RE)) {
		const [, bv, av] = m;
		if (bv) found.push({ at: m.index, ref: { kind: "bvid", bvid: `BV${bv.slice(2)}` } });
		else if (av) found.push({ at: m.index, ref: { kind: "aid", aid: av } });
	}
	for (const m of text.matchAll(SHORT_LINK_RE)) {
		found.push({ at: m.index, ref: { kind: "short", url: `https://b23.tv/${m[1]}` } });
	}
	found.sort((a, b) => a.at - b.at);
	const seen = new Set<string>();
	const refs: VideoLinkRef[] = [];
	for (const { ref } of found) {
		const key = ref.kind === "bvid" ? ref.bvid : ref.kind === "aid" ? `av${ref.aid}` : ref.url;
		if (seen.has(key)) continue;
		seen.add(key);
		refs.push(ref);
	}
	return refs;
}
