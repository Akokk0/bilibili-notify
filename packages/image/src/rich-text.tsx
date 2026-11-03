import { packageText } from "@bilibili-notify/internal/texts";
/** @jsxImportSource vue */

/**
 * 动态正文的富文本渲染。
 *
 * 这两个根 div 是卡片皮肤 `dynamic.content` 的 `body` 挂点(ADR-0014 决策 9)所在:
 * content 块里的 `{node.body}` 是 VNode 插槽,**不给它包一层壳**(包了就往输出里塞一个
 * 今天没有的元素),挂点因此下沉到正文自己的根元素上。普通正文与专栏各有一个根,两个都挂。
 *
 * **小图标与表情图只认图库引用**(ADR-0021 决策 22 的 2026-10-05 🔗):`RichText` 的 `link.icon` /
 * `emoji.image` 是图库引用,由调用方给的 {@link ImageUrlOf} 解析成可画的地址。解析得到就画 —— 链接前的小图标、
 * 表情图;没有引用或解析不到(图已被清扫)就退成文字:链接只画文字(颜色照旧),表情画它的 `text`(「[doge]」)。
 * B 站这边只给表情图(出卡前由服务端抓进图库);链接前的小图标 B 站不给。
 */

import type { ImageRef, RichText } from "@bilibili-notify/internal";
import { escapeHtml } from "./html-escape";

/** 图库引用 → 可画的地址;解析不到回 `undefined`(调用方预先解析好的表,同步查)。 */
export type ImageUrlOf = (ref: ImageRef) => string | undefined;

/**
 * 正文片段 → 富文本 VNode(`Post.richText` 就是它的输入)。普通正文九行截断、专栏五行截断;片段只认
 * 五种:`mention` 与 `link` 画成 B 站蓝的字,`topic` 画成粉色的字,`emoji` 与 `text` 画成普通文字。
 * `link.icon` 与 `emoji.image` 经 `imageUrl` 解析,解析得到才画图(见文件头)。
 */
export function renderRichText(
	rt: RichText,
	title?: string,
	isArticle = false,
	imageUrl?: ImageUrlOf,
) {
	if (isArticle) {
		return parseRichTextArticle(rt, title, imageUrl);
	}

	const MAX_LINES = 9;

	type Seg =
		| { kind: "text"; text: string }
		| { kind: "break" }
		| { kind: "emojiImage"; src: string }
		| { kind: "at"; text: string }
		| { kind: "topic"; text: string }
		| { kind: "link"; text: string; icon?: string };

	const segs: Seg[] = [];
	let lineCount = 0;
	let truncated = false;

	outer: for (const node of rt) {
		// 表情有图(引用解析得到)就画图,否则当文字画它的 `text`(「[doge]」)。
		if (node.kind === "emoji" && node.image !== undefined) {
			const src = imageUrl?.(node.image);
			if (src !== undefined) {
				segs.push({ kind: "emojiImage", src });
				continue;
			}
		}
		const icon =
			node.kind === "link" && node.icon !== undefined ? imageUrl?.(node.icon) : undefined;
		let iconPending = icon !== undefined;
		const kind: Seg["kind"] =
			node.kind === "mention"
				? "at"
				: node.kind === "topic"
					? "topic"
					: node.kind === "link"
						? "link"
						: "text";

		const parts = node.text.split("\n");
		for (let i = 0; i < parts.length; i++) {
			if (i > 0) {
				lineCount++;
				if (lineCount >= MAX_LINES) {
					truncated = true;
					if (parts[i]) segs.push({ kind, text: parts[i] } as Seg);
					break outer;
				}
				segs.push({ kind: "break" });
			}
			if (parts[i]) {
				// 链接前的小图标跟在第一段字前面(整个链接节点只一个)。
				segs.push({ kind, text: parts[i], ...(iconPending ? { icon } : {}) } as Seg);
				iconPending = false;
			}
		}
	}

	return (
		<div data-bn="body" class="text-[16px] text-[#18191C] leading-[1.6] break-words">
			{title && <h1 class="text-[18px] font-bold mb-2">{title}</h1>}
			{segs.map((seg, i) => {
				if (seg.kind === "break") return <br key={i} />;
				if (seg.kind === "emojiImage")
					return <img key={i} class="inline w-[17px] h-[17px] align-middle" src={seg.src} alt="" />;
				if (seg.kind === "at")
					return (
						<span key={i} class="text-[#00AEEC]">
							{seg.text}
						</span>
					);
				if (seg.kind === "topic")
					return (
						<span key={i} class="text-[#FF6699]">
							{seg.text}
						</span>
					);
				if (seg.kind === "link")
					return (
						<span key={i} class="text-[#00AEEC]">
							{seg.icon === undefined ? (
								seg.text
							) : (
								<>
									<img
										style="width:1em;height:1em;display:inline;vertical-align:-0.15em;margin-right:2px;flex-shrink:0"
										src={seg.icon}
										alt=""
									/>
									{seg.text}
								</>
							)}
						</span>
					);
				return seg.text;
			})}
			{truncated && <span class="text-[#999]">{packageText("image.rich-text.1")}</span>}
		</div>
	);
}

/**
 * 专栏类型。node.text 来自 B 站 API,可含任意 HTML(攻击者可控)。**全部文本转义**
 * 后再喂 innerHTML —— innerHTML 仅渲染本函数自己拼的受控骨架(<h1>/<br>/<img>/<span>),
 * 任何注入的 <script>/<iframe>/onerror/@import 均被转义为纯文本。代价:专栏内的
 * HTML 排版退化为纯文本(安全优先;对齐 SCCard 转义策略)。
 */
function parseRichTextArticle(rt: RichText, title?: string, imageUrl?: ImageUrlOf) {
	const MAX_LINES = 5;

	const rawHtml = rt.reduce((acc, node) => {
		// 表情有图(引用解析得到)就拼一个受控的 <img>,地址转义;否则同样当文字:`node.text` 转义后拼进去。
		if (node.kind === "emoji" && node.image !== undefined) {
			const src = imageUrl?.(node.image);
			if (src !== undefined) {
				return `${acc}<img style="width:17px;height:17px;display:inline;vertical-align:middle" src="${escapeHtml(src)}"/>`;
			}
		}
		return acc + escapeHtml(node.text);
	}, "");

	const lines = rawHtml.split("\n");
	let displayHtml: string;
	let truncated = false;
	if (lines.length > MAX_LINES) {
		displayHtml = lines.slice(0, MAX_LINES).join("<br><br>");
		truncated = true;
	} else {
		displayHtml = rawHtml.replace(/\n/g, "<br><br>");
	}

	// 标题与「已省略」那行走 **class 不走 inline**:这段是拼进 `innerHTML` 的,而 inline
	// 皮肤永远压不过(清洗器一律摘 `!important`)。同一句灰字在上面非专栏那条路本来就是
	// `text-[#999]`,两条路的可染性不该差一截。
	const fullHtml = `${title ? `<h1 class="text-[18px] font-bold mb-[8px]">${escapeHtml(title)}</h1>` : ""}${displayHtml}${truncated ? `<span class="text-[#999]">${escapeHtml(packageText("image.rich-text.2"))}</span>` : ""}`;

	return (
		<div
			data-bn="body"
			class="text-[15px] text-[#18191C] leading-[1.6] break-words"
			innerHTML={fullHtml}
		/>
	);
}
