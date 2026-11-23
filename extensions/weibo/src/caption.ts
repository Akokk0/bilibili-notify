import type { ExtensionContext, ExtensionRichText, ImageRef } from "@bilibili-notify/extension";
import { type DefaultTreeAdapterTypes, parseFragment } from "parse5";
import { HOME, record, trustedHttps } from "./client";
import { image, imageUrl } from "./media";

type Element = DefaultTreeAdapterTypes.Element;
interface CommunityLink {
	title: string;
	url: string;
	icon?: URL;
}

function attribute(element: Element, name: string) {
	return element.attrs.find((attr) => attr.name === name)?.value;
}

function communityId(value: unknown) {
	return typeof value === "string" && /^100808[\da-f]{32}$/i.test(value) ? value : undefined;
}

function communityPage(value: string | undefined) {
	if (!value) return;
	const url = URL.parse(value, HOME);
	if (
		url &&
		trustedHttps(url) &&
		["weibo.com", "www.weibo.com"].includes(url.hostname) &&
		communityId(/^\/p\/([^/]+)\/?$/.exec(url.pathname)?.[1])
	)
		return url.origin + url.pathname;
}

export function plainText(html: unknown, communities?: Map<string, CommunityLink>): string {
	if (typeof html !== "string") return "";
	function read(node: DefaultTreeAdapterTypes.ChildNode): string {
		if ("value" in node) return node.value;
		if (!("tagName" in node) || ["script", "style", "template"].includes(node.tagName)) return "";
		if (node.tagName === "br") return "\n";
		if (node.tagName === "img") return attribute(node, "alt") ?? "";
		const contents = node.childNodes.map(read).join("");
		if (communities && node.tagName === "a") {
			const badge = node.childNodes.find(
				(child): child is Element => "tagName" in child && child.tagName === "img",
			);
			const marker = badge && attribute(badge, "title");
			const url = communityPage(attribute(node, "href"));
			if (badge && marker && /^#[^#\n]+\[超话\]#$/.test(marker) && url && contents.trim()) {
				communities.set(marker, {
					title: contents.trim(),
					url,
					icon: imageUrl(attribute(badge, "src")),
				});
				return marker;
			}
		}
		return ["p", "div"].includes(node.tagName) ? `${contents}\n` : contents;
	}
	return parseFragment(html).childNodes.map(read).join("").trim();
}

export async function caption(
	ctx: ExtensionContext,
	row: Record<string, unknown>,
	signal: AbortSignal,
): Promise<ExtensionRichText> {
	const communities = new Map<string, CommunityLink>();
	if (Array.isArray(row.url_struct)) {
		for (const entry of row.url_struct) {
			const item = record(entry);
			if (
				typeof item.short_url !== "string" ||
				typeof item.url_title !== "string" ||
				typeof item.page_id !== "string"
			)
				continue;
			const url = communityPage(`${HOME}p/${item.page_id}`);
			if (url && item.url_title.trim())
				communities.set(item.short_url, {
					title: item.url_title,
					url,
					icon: imageUrl(item.url_type_pic),
				});
		}
	}
	const html = plainText(row.text, communities);
	const text = (typeof row.text_raw === "string" ? row.text_raw : html)
		.trimEnd()
		.replace(/\u200b+$/u, "")
		.trimEnd();
	const segments: ExtensionRichText = [];
	const icons = new Map<string, ImageRef | undefined>();
	let offset = 0;
	for (const match of text.matchAll(/#([^\s#](?:[^#\r\n]*[^\s#])?)#/gu)) {
		if (match.index > offset)
			segments.push({ kind: "text", text: text.slice(offset, match.index) });
		const name = match[1];
		const community = communities.get(match[0]);
		if (community) {
			const badge = community.icon;
			if (badge && !icons.has(badge.href)) icons.set(badge.href, await image(ctx, badge, signal));
			const icon = badge && icons.get(badge.href);
			segments.push({
				kind: "link",
				text: community.title,
				url: community.url,
				...(icon && { icon }),
			});
		} else if (name.endsWith("[超话]") && name.length > 4) {
			const base = name.slice(0, -4);
			segments.push({ kind: "topic", name: base, text: `${base}超话` });
		} else {
			segments.push({ kind: "topic", name, text: match[0] });
		}
		offset = match.index + match[0].length;
	}
	if (offset < text.length) segments.push({ kind: "text", text: text.slice(offset) });
	return segments;
}
