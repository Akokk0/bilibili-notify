/**
 * 声明式列表(ADR-0019 决策 21 / 26 / 29)那一摞测试共用的摆台。
 *
 * 夹具照**桥迁过去之后**的样子写:一格 `links` 列表,项里是「哪一种桥」(带图标的枚举)/
 * 名字(必填,当标题)/ token(密钥 + 生成 + 等宽)/ 启用(布尔,画成停用 / 启用)。手写的桥页
 * 那一摞测试钉过的每一条行为,在这里对着**照声明画**的那一页再钉一遍 —— 迁移的承诺是「长相
 * 与行为照今天」(决策 24),这些测试就是那句承诺的形状。
 *
 * 假服务端照**真的**那条口说话(`/api/ext/:id/settings`,ADR-0019 决策 35):带版本号、按 ops 改、
 * 对不上回 409、密钥下发时换成遮挡。断言看两样 —— **发出去的请求**与**屏幕上**的东西。
 *
 * ⚠️ `vi.mock(".../services/api", …)` **留在各文件里** —— 它要被提升到 import 之前,搬进这里
 * 就不生效了。这里只是**用**那份 mock;`ApiError` 必须是真的那个类(409 / 400 靠它认)。
 */

import type {
	ExtensionDTO,
	ExtensionField,
	ExtensionListField,
	ExtensionSettingsConflict,
	ExtensionSettingsOp,
	ExtensionSettingsPatch,
	ExtensionSettingsResponse,
	ExtensionSettingsWriteResponse,
	ExtensionsResponse,
	ExtensionView,
} from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vite-plus/test";
import { ApiError, api } from "../../../../services/api";
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

/**
 * 假服务端存着的那份设置(**原文**,密钥也在)与它的版本号。`renderList` 按 setup 摆好;
 * `GET /api/ext/:id/settings` 读它(密钥遮住),`answerPatch` 照 ops 改它。
 */
let served: { ext: ExtensionDTO; revision: number; settings: Record<string, unknown> } = {
	ext: BRIDGE,
	revision: 1,
	settings: {},
};
/** 假服务端给 `add` 生成的 id 的序号 —— 与面板那头无关,面板不许自己生成。 */
let nextId = 0;

/** 版本号:不透明的一串。每写成一次换一个。 */
export function servedRevision(): string {
	return `rev-${served.revision}`;
}

/** 假服务端眼下存着的原文 —— 断言「写成之后存下了什么」用。 */
export function servedSettings(): Record<string, unknown> {
	return structuredClone(served.settings);
}

/**
 * 假服务端的遮法 —— 照真服务端(`settings-io.ts` 的 `maskSecret`):不到 24 位固定 8 个点,24 位
 * 及以上露头尾各四位。面板只画它给的这一串,自己不截。
 */
export function maskOf(value: string): string {
	const dots = "•".repeat(8);
	return value.length < 24 ? dots : `${value.slice(0, 4)}${dots}${value.slice(-4)}`;
}

function isSecretSub(field: ExtensionField): boolean {
	return field.type === "string" && (field.secret === true || field.generate === true);
}

function maskCell(value: unknown): unknown {
	if (value === undefined || value === null || value === "") return value;
	return { masked: typeof value === "string" ? maskOf(value) : "•".repeat(8) };
}

/** 下发的那一份:密钥格(顶层与列表项里)换成遮挡,与真服务端同一个样子。 */
function servedResponse(): ExtensionSettingsResponse {
	const fields = served.ext.settings?.fields ?? [];
	const values: Record<string, unknown> = structuredClone(served.settings);
	for (const field of fields) {
		if (!Object.hasOwn(values, field.key)) continue;
		if (isSecretSub(field)) values[field.key] = maskCell(values[field.key]);
		else if (field.type === "list" && Array.isArray(values[field.key])) {
			const secrets = field.fields.filter(isSecretSub);
			values[field.key] = (values[field.key] as unknown[]).map((item) => {
				if (typeof item !== "object" || item === null) return item;
				const copy = { ...(item as Record<string, unknown>) };
				for (const sub of secrets) {
					if (Object.hasOwn(copy, sub.key)) copy[sub.key] = maskCell(copy[sub.key]);
				}
				return copy;
			});
		}
	}
	return { revision: servedRevision(), values };
}

/** 套上一步 —— 不校验(要 400 的用例自己换掉 `api.patch`),找不到那一项照真服务端回 400。 */
function applyOp(op: ExtensionSettingsOp, added: string[]): void {
	const settings = served.settings;
	const listOf = (key: string) =>
		Array.isArray(settings[key]) ? (settings[key] as Record<string, unknown>[]) : [];
	switch (op.op) {
		case "set":
			if (op.value === null) delete settings[op.key];
			else settings[op.key] = op.value;
			return;
		case "add": {
			nextId += 1;
			const id = `srv-${nextId}`;
			added.push(id);
			settings[op.list] = [...listOf(op.list), { id, ...op.item }];
			return;
		}
		case "update": {
			const items = listOf(op.list);
			const item = items.find((candidate) => candidate.id === op.id);
			if (!item) throw new Error(`假服务端:没有 ${op.id} 这一项`);
			for (const [key, value] of Object.entries(op.values)) {
				if (value === null) delete item[key];
				else item[key] = value;
			}
			return;
		}
		case "remove":
			settings[op.list] = listOf(op.list).filter((item) => item.id !== op.id);
			return;
	}
}

/**
 * `PATCH /api/ext/:id/settings` 的替身:版本号对不上回 409(与真服务端同形),对得上就照 ops 改、
 * 换一个版本号、回**写后的整份**(与 GET 同形)外加 `added`。
 *
 * 各文件在 `beforeEach` 里把它装成 `api.patch` 的默认回答;要失败 / 挂着的用例再各自换掉。
 */
export async function answerPatch(url: string, body?: unknown): Promise<unknown> {
	if (url !== `/api/ext/${served.ext.id}/settings`) throw new Error(`写去了别处:${url}`);
	const { revision, ops } = body as ExtensionSettingsPatch;
	if (revision !== servedRevision()) {
		const conflict: ExtensionSettingsConflict = {
			error: "revision_conflict",
			message: "设置在你打开之后被改过了 —— 重新读一遍再改,别把刚写进去的盖掉",
			revision: servedRevision(),
		};
		throw new ApiError(409, conflict, conflict.message);
	}
	const added: string[] = [];
	for (const op of ops) applyOp(op, added);
	served.revision += 1;
	return { ...servedResponse(), added } satisfies ExtensionSettingsWriteResponse;
}

/** 别人(另一个标签页)在这一页不知道的时候改了一笔:存着的换了、版本号也换了。 */
export function changeBehindTheBack(change: (settings: Record<string, unknown>) => void): void {
	change(served.settings);
	served.revision += 1;
}

function mockApi({ ext = BRIDGE, items = [], extraSettings = {}, view }: ListSetup) {
	served = {
		ext,
		revision: 1,
		settings: structuredClone(
			Array.isArray(items) ? { ...extraSettings, links: items } : { ...extraSettings },
		),
	};
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/ext") {
			return {
				extensions: [ext],
				restart: { can: true, how: "container" },
			} satisfies ExtensionsResponse;
		}
		if (url === `/api/ext/${ext.id}/settings`) {
			if (items === "pending") return new Promise(() => {});
			if (items === null) throw new Error("配置读不出来:500");
			return servedResponse();
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
	const view = render(
		<QueryClientProvider client={qc}>
			<DeclarativeConfig ext={setup.ext ?? BRIDGE} />
		</QueryClientProvider>,
	);
	// 要替 WS 发一帧失效的测试用得到它。
	return Object.assign(view, { qc });
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

/** 读设置那一口被问了几次。 */
export function settingsReads(id = "bridge"): number {
	return vi.mocked(api.get).mock.calls.filter(([url]) => url === `/api/ext/${id}/settings`).length;
}

/**
 * 第 `call` 发写(`PATCH /api/ext/bridge/settings`)带的东西。
 *
 * 🔴 请求体**只有**版本号与 ops:一发只说这一下改了什么,不整份写回 —— 整份写回时两发交错会丢一发,
 * `id` 与密钥占位也会一起被盖掉(ADR-0019 决策 35)。
 */
export function sentWrite(call = 0): ExtensionSettingsPatch {
	const args = vi.mocked(api.patch).mock.calls[call];
	if (!args) throw new Error(`没有第 ${call + 1} 发写`);
	const [url, body] = args as [string, ExtensionSettingsPatch];
	if (url !== "/api/ext/bridge/settings") throw new Error(`写去了别处:${url}`);
	if (JSON.stringify(Object.keys(body).sort()) !== '["ops","revision"]') {
		throw new Error(`请求体带了别的东西:${JSON.stringify(body)}`);
	}
	return body;
}

/** 第 `call` 发写里的那几步。 */
export function sentOps(call = 0): ExtensionSettingsOp[] {
	return sentWrite(call).ops;
}

/** 第 `call` 发写里第 `index` 步 —— 得是一步 `update` —— 带的那几格。 */
export function updatedValues(call = 0, index = 0): Record<string, unknown> {
	const op = sentOps(call)[index];
	if (op?.op !== "update") throw new Error(`不是一步 update:${JSON.stringify(op)}`);
	return op.values;
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
