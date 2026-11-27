import { ok } from "@bilibili-notify/extension";
import { type DefaultTreeAdapterTypes, parse } from "parse5";
import type { HuyaClient } from "./client";

const roomPath = /^\/([A-Za-z0-9_-]{1,80})\/?$/;
export const web = "https://www.huya.com";
export function publicRoom(url: URL | null) {
	return url &&
		url.protocol === "https:" &&
		!url.port &&
		!url.username &&
		!url.password &&
		["huya.com", "www.huya.com", "m.huya.com"].includes(url.hostname)
		? roomPath.exec(url.pathname)?.[1]
		: undefined;
}

/** 只取页面对本房间的明确标识，跳过推荐房间和脚本内的链接。 */
export async function pageRoom(client: HuyaClient, url: URL, signal: AbortSignal, profile = false) {
	const initialPath = url.pathname;
	for (let hop = 0; hop < 3; hop++) {
		const response = await client.read(url, signal);
		if (!response.ok) return response;
		if (response.location) {
			const next = URL.parse(response.location, url);
			if (
				!next ||
				!(profile
					? next.origin === web && !next.username && !next.password && next.pathname === initialPath
					: publicRoom(next))
			)
				return client.unavailable();
			url = next;
			continue;
		}
		const nodes: DefaultTreeAdapterTypes.Node[] = [parse(response.body)];
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			if ("childNodes" in node) nodes.push(...node.childNodes);
			if (!("tagName" in node)) continue;
			const tag = profile ? "a" : "link";
			if (node.tagName !== tag) continue;
			const attr = (name: string) => node.attrs.find((a) => a.name === name)?.value;
			const matches = profile
				? attr("class")?.split(/\s+/).includes("J_userLinkLive")
				: attr("rel")?.toLowerCase().split(/\s+/).includes("canonical");
			const href = attr("href");
			if (!matches || !href) continue;
			const number = publicRoom(URL.parse(href, url));
			if (number && /^[1-9]\d*$/.test(number)) return ok({ number });
		}
		break;
	}
	return client.unavailable();
}

/** 桌面房间的 image 可能是主播海报，也可能只是低清直播截图。 */
export function posterUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return;
	const url = URL.parse(value, web);
	if (
		!url ||
		!["https:", "http:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.port ||
		url.hostname !== "anchorpost.msstatic.com" ||
		!url.pathname.startsWith("/cdnimage/anchorpost/")
	)
		return;
	url.protocol = "https:";
	// image 元数据附带列表缩略图的裁切和模糊参数，静态海报的路径本身指向原图。
	url.search = "";
	return url.href;
}
export async function roomPoster(client: HuyaClient, number: string, signal: AbortSignal) {
	const result = await client.read(new URL(`/${number}`, web), signal);
	if (!result.ok || result.location) return;
	const head = parse(result.body.slice(0, 65536)).childNodes.find((n) => n.nodeName === "html");
	if (!head || !("childNodes" in head)) return;
	const metadata = head.childNodes.find((n) => n.nodeName === "head");
	if (!metadata || !("childNodes" in metadata)) return;
	let canonical: string | undefined, image: string | undefined;
	for (const el of metadata.childNodes) {
		if (!("tagName" in el)) continue;
		const attr = (name: string) => el.attrs.find((a) => a.name === name)?.value;
		if (el.tagName === "link" && attr("rel") === "canonical")
			canonical = publicRoom(URL.parse(attr("href") ?? "", web));
		if (el.tagName === "meta" && attr("name") === "image") image = posterUrl(attr("content"));
	}
	return canonical === number ? image : undefined;
}
