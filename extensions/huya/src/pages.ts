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
