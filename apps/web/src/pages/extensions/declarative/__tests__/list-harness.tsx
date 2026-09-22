/**
 * 声明式列表(ADR-0019 决策 21 / 26 / 29)那一摞测试共用的摆台。
 *
 * 夹具照**桥迁过去之后**的样子写:一格 `links` 列表,项里是「哪一种桥」(带图标的枚举)/
 * 名字(必填,当标题)/ token(密钥 + 生成 + 等宽)/ 启用(布尔,画成停用 / 启用)。手写的桥页
 * 那一摞测试钉过的每一条行为,在这里对着**照声明画**的那一页再钉一遍 —— 迁移的承诺是「长相
 * 与行为照今天」(决策 24),这些测试就是那句承诺的形状。
 *
 * ⚠️ `vi.mock(".../services/api", …)` **留在各文件里** —— 它要被提升到 import 之前,搬进这里
 * 就不生效了。这里只是**用**那份 mock。
 */

import type {
	ExtensionDTO,
	ExtensionListField,
	ExtensionsResponse,
	ExtensionView,
} from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vite-plus/test";
import { api } from "../../../../services/api";
import ExtensionDetail from "../../../ExtensionDetail";
import { DeclarativeConfig } from "../extension-page";

/** 两种桥各一枚图 —— 清单里的枚举选项图标只收图片 data URL(决策 31)。 */
export const KOISHI_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
export const ASTRBOT_SVG = `data:image/svg+xml;base64,${btoa("<svg xmlns='http://www.w3.org/2000/svg'/>")}`;

/** 桥那一格列表 —— 照清单 v2 的写法。 */
export const LINKS_FIELD: ExtensionListField = {
	key: "links",
	type: "list",
	label: "桥接入",
	itemLabel: "接入",
	description:
		"在这里建一条,把生成的 token 和 BN 地址填进 koishi / AstrBot 的插件设置里,它就会自己连过来。",
	title: "name",
	mark: "bridgeKind",
	toggle: "enabled",
	newItemCopy: [{ host: "extensionUrl", label: "BN 地址" }, { field: "token" }],
	removeWarning: "那一头的插件会连不上,从它借来的 bot 建的那些连接也会发不出去。",
	fields: [
		{
			key: "bridgeKind",
			type: "enum",
			label: "哪一种桥",
			description: "只影响面板怎么称呼它。两种桥说的是同一套协议,BN 这边的处理完全相同。",
			options: [
				{ value: "koishi", label: "koishi", icon: KOISHI_PNG },
				{ value: "astrbot", label: "AstrBot", icon: ASTRBOT_SVG },
			],
			default: "koishi",
		},
		{
			key: "name",
			type: "string",
			label: "名字",
			required: true,
			placeholder: "比如「家里那台 koishi」",
		},
		{
			key: "token",
			type: "string",
			label: "token",
			secret: true,
			generate: true,
			monospace: true,
			description: "只在这一刻看得到全文。存下之后面板只显示头尾 —— 忘了就重新生成一个。",
		},
		{ key: "enabled", type: "boolean", label: "启用", default: true },
	],
};

/** 迁到 v2 的桥:设置里只有那一格列表。 */
export const BRIDGE: ExtensionDTO = {
	id: "bridge",
	name: "机器人框架桥接",
	description: "把 koishi / AstrBot 里已经配好的机器人借给 BN 用。",
	version: "1.0.0",
	apiVersion: 2,
	provides: ["push"],
	settings: { fields: [LINKS_FIELD] },
	enabled: true,
	state: "running",
	dir: "/data/extensions/bridge",
};

/** 这一摞测试共用的那把钥匙:32 位十六进制,与面板自己生成的同形。 */
export const TOKEN = "0123456789abcdef0123456789abcdef";

/** 一条接入的常态样子;要变哪一格就 `{ ...HOME, … }`。 */
export const HOME = {
	id: "c1",
	name: "家里那台",
	bridgeKind: "koishi",
	token: TOKEN,
	enabled: true,
};

/** 并排的第二条 —— 另一种桥、另一把钥匙,一屏两条时要分得出谁是谁。 */
export const OFFICE = {
	id: "c2",
	name: "机房那台",
	bridgeKind: "astrbot",
	token: "ffffffffffffffffffffffffffffffff",
	enabled: true,
};

/** 状态那一口的 404:拓展跑着、但还没交过视图。 */
export class NotFound extends Error {
	readonly status = 404;
}

export interface ListSetup {
	/** 拓展本身 —— 开关、状态、清单里的设置项。 */
	ext?: ExtensionDTO;
	/**
	 * 那份列表;`null` = 设置那一口读不到(401 / 服务端炸了 / 断网),`"pending"` = 那一口
	 * 一直没回来。
	 */
	items?: unknown[] | null | "pending";
	/** 设置里别的格(列表之外)。 */
	extraSettings?: Record<string, unknown>;
	/** 状态那一口:一份视图,或一个错。不给 = 404(跑着但没交过视图)。 */
	view?: ExtensionView | Error;
}

function mockApi({ ext = BRIDGE, items = [], extraSettings = {}, view }: ListSetup) {
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/ext") {
			return {
				extensions: [ext],
				restart: { can: true, how: "container" },
			} satisfies ExtensionsResponse;
		}
		if (url === "/api/globals") {
			if (items === "pending") return new Promise(() => {});
			if (items === null) throw new Error("配置读不出来:500");
			return {
				extensions: {
					[ext.id]: { enabled: ext.enabled, settings: { ...extraSettings, links: items } },
				},
			};
		}
		if (url === `/api/ext/${ext.id}/status`) {
			if (view === undefined) throw new NotFound("not found");
			if (view instanceof Error) throw view;
			return view;
		}
		if (url === `/api/ext/${ext.id}/docs`) return {};
		throw new Error(`没有这个口:${url}`);
	});
}

/** 「配置」页签的正文 —— 页面上 `tab === "config"` 时挂的就是它。 */
export function renderList(setup: ListSetup = {}) {
	mockApi(setup);
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<DeclarativeConfig ext={setup.ext ?? BRIDGE} />
		</QueryClientProvider>,
	);
}

/** 整页 —— 只有「配置」页签在不在、挂没挂上这件事要它。 */
export function renderDetailPage(setup: ListSetup = {}) {
	mockApi(setup);
	const id = (setup.ext ?? BRIDGE).id;
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[`/extensions/${id}`]}>
				<Routes>
					<Route path="/extensions/:id" element={<ExtensionDetail />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

/** 名单里的一条 —— 写回的是整份,每条原样带着它所有的键。 */
export type SavedItem = Record<string, unknown> & { id: string };

/**
 * 第 `call` 发写回里的那份列表。
 *
 * 🔴 补丁**只带这一格列表**:别的设置、别的拓展、开关都不碰 —— 设置是 JSON Merge Patch,
 * 多带一格就是把别处刚改的按回旧值。数组是整个换掉的,所以列表本身整份发。
 */
export function savedItems(call = 0): SavedItem[] {
	const args = vi.mocked(api.patch).mock.calls[call];
	if (!args) throw new Error(`没有第 ${call + 1} 发写回`);
	const [url, body] = args as [string, { extensions: Record<string, { settings: unknown }> }];
	if (url !== "/api/globals") throw new Error(`写去了别处:${url}`);
	const extensions = body.extensions ?? {};
	if (JSON.stringify(Object.keys(body)) !== '["extensions"]') {
		throw new Error(`补丁带了别的东西:${JSON.stringify(body)}`);
	}
	if (JSON.stringify(Object.keys(extensions)) !== '["bridge"]') {
		throw new Error(`补丁碰了别的拓展:${JSON.stringify(body)}`);
	}
	const slot = extensions.bridge as { settings?: Record<string, unknown> };
	if (JSON.stringify(Object.keys(slot)) !== '["settings"]') {
		throw new Error(`补丁碰了设置之外的东西:${JSON.stringify(body)}`);
	}
	if (JSON.stringify(Object.keys(slot.settings ?? {})) !== '["links"]') {
		throw new Error(`补丁带了列表之外的设置:${JSON.stringify(body)}`);
	}
	const links = slot.settings?.links;
	if (!Array.isArray(links)) throw new Error(`写回里没有列表:${JSON.stringify(body)}`);
	return links as SavedItem[];
}

/** 一条接入的那张卡。 */
export function cardOf(id: string): HTMLElement {
	const card = document.querySelector(`[data-list-card="${id}"]`);
	if (!card) throw new Error(`没有 ${id} 那张卡`);
	return card as HTMLElement;
}

/** 等那张卡画出来(设置那一口是异步的)。 */
export async function findCard(id: string): Promise<HTMLElement> {
	return waitFor(() => cardOf(id));
}
