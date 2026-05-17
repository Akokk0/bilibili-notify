/** @jsxImportSource vue */
import { SVG_LOTTERY_INLINE, SVG_VIDEO_INLINE } from "./icons";
import type { RichTextNode } from "./types";

const TYPE_AT = "RICH_TEXT_NODE_TYPE_AT";
const TYPE_TOPIC = "RICH_TEXT_NODE_TYPE_TOPIC";
const TYPE_BV = "RICH_TEXT_NODE_TYPE_BV";
const TYPE_AV = "RICH_TEXT_NODE_TYPE_AV";
const TYPE_CV = "RICH_TEXT_NODE_TYPE_CV";
const TYPE_WEB = "RICH_TEXT_NODE_TYPE_WEB";
const TYPE_TAOBAO = "RICH_TEXT_NODE_TYPE_TAOBAO";
const TYPE_GOODS = "RICH_TEXT_NODE_TYPE_GOODS";
const TYPE_LOTTERY = "RICH_TEXT_NODE_TYPE_LOTTERY";
const TYPE_VOTE = "RICH_TEXT_NODE_TYPE_VOTE";
const TYPE_OGV_SEASON = "RICH_TEXT_NODE_TYPE_OGV_SEASON";
const TYPE_OGV_EP = "RICH_TEXT_NODE_TYPE_OGV_EP";

/**
 * HTML 转义 —— 同时安全用于文本内容与双引号属性值上下文。
 * 对齐 SCCard 的转义策略;`"` 一并转义以覆盖 `src="…"` 属性场景。
 */
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function parseRichText(rt: RichTextNode, title?: string, isArticle = false) {
	if (isArticle) {
		return parseRichTextArticle(rt, title);
	}

	const MAX_LINES = 9;

	type Seg =
		| { kind: "text"; text: string }
		| { kind: "break" }
		| { kind: "emoji"; src: string }
		| { kind: "at"; text: string }
		| { kind: "topic"; text: string }
		| { kind: "video"; text: string }
		| { kind: "lottery"; text: string }
		| { kind: "link"; text: string };

	const segs: Seg[] = [];
	let lineCount = 0;
	let truncated = false;

	outer: for (const node of rt) {
		if (node.emoji) {
			segs.push({ kind: "emoji", src: node.emoji.icon_url });
			continue;
		}

		const kind: Seg["kind"] =
			node.type === TYPE_AT
				? "at"
				: node.type === TYPE_TOPIC
					? "topic"
					: node.type === TYPE_BV || node.type === TYPE_AV
						? "video"
						: node.type === TYPE_LOTTERY
							? "lottery"
							: node.type === TYPE_WEB ||
									node.type === TYPE_CV ||
									node.type === TYPE_TAOBAO ||
									node.type === TYPE_GOODS ||
									node.type === TYPE_VOTE ||
									node.type === TYPE_OGV_SEASON ||
									node.type === TYPE_OGV_EP
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
			if (parts[i]) segs.push({ kind, text: parts[i] } as Seg);
		}
	}

	return (
		<div class="text-[16px] text-[#18191C] leading-[1.6] break-words">
			{title && <h1 class="text-[18px] font-bold mb-2">{title}</h1>}
			{segs.map((seg, i) => {
				if (seg.kind === "emoji")
					return <img key={i} class="inline w-[17px] h-[17px] align-middle" src={seg.src} alt="" />;
				if (seg.kind === "break") return <br key={i} />;
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
				if (seg.kind === "video")
					return (
						<span key={i} class="text-[#00AEEC]">
							{SVG_VIDEO_INLINE}
							{seg.text}
						</span>
					);
				if (seg.kind === "lottery")
					return (
						<span key={i} class="text-[#00AEEC]">
							{SVG_LOTTERY_INLINE}
							{seg.text}
						</span>
					);
				if (seg.kind === "link")
					return (
						<span key={i} class="text-[#00AEEC]">
							{seg.text}
						</span>
					);
				return seg.text;
			})}
			{truncated && <span class="text-[#999]">...（全文过长，已省略）</span>}
		</div>
	);
}

/**
 * 专栏类型。node.text 来自 B 站 API,可含任意 HTML(攻击者可控)。**全部文本转义**
 * 后再喂 innerHTML —— innerHTML 仅渲染本函数自己拼的受控骨架(<h1>/<br>/<img>/<span>),
 * 任何注入的 <script>/<iframe>/onerror/@import 均被转义为纯文本。代价:专栏内的
 * HTML 排版退化为纯文本(安全优先;对齐 SCCard 转义策略)。
 */
function parseRichTextArticle(rt: RichTextNode, title?: string) {
	const MAX_LINES = 5;

	const rawHtml = rt.reduce((acc, node) => {
		if (node.emoji) {
			return `${acc}<img style="width:17px;height:17px;display:inline;vertical-align:middle" src="${escapeHtml(node.emoji.icon_url)}"/>`;
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

	const fullHtml = `${title ? `<h1 style="font-size:18px;font-weight:bold;margin-bottom:8px">${escapeHtml(title)}</h1>` : ""}${displayHtml}${truncated ? '<span style="color:#999">...（全文过长，已省略）</span>' : ""}`;

	return <div class="text-[15px] text-[#18191C] leading-[1.6] break-words" innerHTML={fullHtml} />;
}
