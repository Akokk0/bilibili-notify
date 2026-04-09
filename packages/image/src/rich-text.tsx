/** @jsxImportSource vue */
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

const SVG_VIDEO = (
	<svg
		style="width:14px;height:14px;display:inline;vertical-align:middle;margin-right:2px;flex-shrink:0"
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 16 16"
		aria-label="视频"
	>
		<path
			d="M5.1911266666666664 0.9880383333333334C4.908345 1.1859883333333332 4.839576666666666 1.5756933333333332 5.0375266666666665 1.8584683333333332L6.109626666666665 3.3900216666666663C6.307576666666667 3.6728033333333334 6.697288333333333 3.7415716666666663 6.980041666666667 3.5436216666666667C7.26285 3.345673333333333 7.3316 2.955966666666666 7.133666666666667 2.6731916666666664L6.061558333333332 1.1416383333333333C5.863613333333333 0.8588566666666666 5.473901666666667 0.7900883333333333 5.1911266666666664 0.9880383333333334z"
			fill="currentColor"
		/>
		<path
			d="M10.808908333333331 0.9880316666666666C10.52615 0.7900883333333333 10.136408333333332 0.8588566666666666 9.938466666666667 1.1416383333333333L8.866399999999999 2.6731916666666664C8.668458333333334 2.9559716666666667 8.737216666666665 3.345678333333333 9.020024999999999 3.543628333333333C9.302775 3.7415716666666663 9.692466666666666 3.6728033333333334 9.890458333333333 3.3900216666666663L10.962533333333333 1.8584683333333332C11.160466666666665 1.5756883333333334 11.091716666666665 1.1859816666666667 10.808908333333331 0.9880316666666666z"
			fill="currentColor"
		/>
		<path
			d="M8.388033333333333 8.2152L8.548749999999998 7.036716666666667L7.611974999999999 7.036716666666667L7.45125 8.2152L8.388033333333333 8.2152z"
			fill="currentColor"
		/>
		<path
			d="M8 2.559733333333333C6.498214999999999 2.559733333333333 5.16768 2.6184066666666665 4.195425 2.678813333333333C2.923148333333333 2.75786 1.9012316666666664 3.7431133333333335 1.8069283333333335 5.026566666666666C1.7538833333333335 5.748475 1.7082533333333334 6.652113333333333 1.7082533333333334 7.626266666666666C1.7082533333333334 8.604275 1.75425 9.504349999999999 1.8075966666666665 10.219908333333333C1.9018333333333333 11.483925 2.899678333333333 12.460316666666666 4.154273333333333 12.551708333333332C5.104525 12.620916666666668 6.4048050000000005 12.688916666666666 7.876416666666666 12.692558333333332C8.379624999999999 13.169883333333333 9.433408333333333 14.084808333333331 10.662975 14.643741666666665C11.005616666666665 14.799541666666666 11.427091666666666 14.859316666666667 11.735999999999999 14.576575C12.039016666666665 14.299274999999998 12.024899999999999 13.881124999999999 11.919241666666666 13.523958333333333C11.811016666666664 13.158316666666666 11.757858333333333 12.821666666666667 11.73155 12.559758333333335C13.013916666666667 12.468349999999997 14.093808333333332 11.543458333333334 14.192449999999997 10.220175C14.245791666666666 9.504874999999998 14.291733333333333 8.604875 14.291733333333333 7.626266666666666C14.291733333333333 6.6514999999999995 14.246125 5.74798 14.193108333333331 5.026299999999999C14.098808333333332 3.7429283333333334 13.076958333333332 2.757873333333333 11.804816666666664 2.6788266666666662C10.832533333333332 2.6184133333333333 9.501883333333334 2.559733333333333 8 2.559733333333333z"
			fill="currentColor"
		/>
	</svg>
);

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
						: node.type === TYPE_WEB ||
								node.type === TYPE_CV ||
								node.type === TYPE_TAOBAO ||
								node.type === TYPE_GOODS ||
								node.type === TYPE_LOTTERY ||
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
						<span key={i} class="text-[#00AEEC] inline-flex items-center">
							{SVG_VIDEO}
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

/** 专栏类型：node.text 本身包含 HTML 标签，需用 innerHTML 渲染 */
function parseRichTextArticle(rt: RichTextNode, title?: string) {
	const MAX_LINES = 5;

	const rawHtml = rt.reduce((acc, node) => {
		if (node.emoji) {
			return `${acc}<img style="width:17px;height:17px;display:inline;vertical-align:middle" src="${node.emoji.icon_url}"/>`;
		}
		return acc + node.text;
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

	const fullHtml = `${title ? `<h1 style="font-size:18px;font-weight:bold;margin-bottom:8px">${title}</h1>` : ""}${displayHtml}${truncated ? '<span style="color:#999">...（全文过长，已省略）</span>' : ""}`;

	return <div class="text-[15px] text-[#18191C] leading-[1.6] break-words" innerHTML={fullHtml} />;
}
