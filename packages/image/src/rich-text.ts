import type { RichTextNode } from "./types";

/**
 * 将富文本节点数组渲染为 HTML 片段
 * @param rt 富文本节点数组
 * @param title 可选标题（专栏标题等）
 * @param isArticle 是否为专栏（专栏使用双换行）
 */
export function parseRichText(rt: RichTextNode, title?: string, isArticle = false): string {
	// 将节点合并为 HTML 字符串（emoji 转换为 img 标签）
	const richText = rt.reduce((acc, node) => {
		if (node.emoji) {
			return `${acc}<img style="width:17px; height:17px;" src="${node.emoji.icon_url}"/>`;
		}
		return acc + node.text;
	}, "");

	// 按换行分割，限制最大显示行数
	const lines = richText.split("\n");
	// 专栏每行后有空白行，实际显示行数为 2n-1，故 n ≤ 5
	const maxOriginalLines = isArticle ? 5 : 9;
	let displayText: string;
	let isTruncated = false;

	if (lines.length > maxOriginalLines) {
		displayText = lines.slice(0, maxOriginalLines).join("\n");
		isTruncated = true;
	} else {
		displayText = richText;
	}

	const text = displayText.replace(/\n/g, isArticle ? "<br><br>" : "<br>");

	return `
            <div class="card-details">
                ${title ? `<h1 class="dyn-title">${title}</h1>` : ""}
                ${text}
                ${isTruncated ? '<span style="color: #999;">...（全文过长，已省略）</span>' : ""}
            </div>
        `;
}
