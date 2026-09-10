// @vitest-environment jsdom
/**
 * 把「画谁」这张表喂给组件库。
 *
 * 🔴 拓展那一档的短名与标识色**是拓展自己报的**(`activate` 里那份 descriptor,经
 * `/api/ext` 下来)。面板这边一度手抄了一份桥的粉紫色 —— 手抄的副本会跟拓展报的悄悄
 * 漂开(改了拓展、面板还是旧色),而那种漂移**门禁一片绿,只有眼睛看得出来**。
 * 所以这里钉两条:表里没有写死的拓展,以及交上来的那份真的进得了表。
 */

import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { PLATFORM_REGISTRY } from "@bilibili-notify/internal/constants";
import { Icon, type IconName, usePlatformLabel } from "@bilibili-notify/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";
import { buildPlatformTable, PlatformMetaRoot } from "../platform-meta";

const BRIDGE: ExtensionsResponse["extensions"][number] = {
	id: "bridge",
	name: "机器人框架桥接",
	enabled: true,
	state: "running",
	dir: "/data/extensions/bridge",
	descriptor: {
		label: "机器人框架桥接",
		shortLabel: "桥接",
		tint: "#a855f7",
		targetKind: "session",
		scopes: ["private", "group"],
		addressNouns: {},
		inbound: true,
		atAll: false,
	},
};

describe("平台元信息表", () => {
	it("内置平台照旧从注册表来", () => {
		const table = buildPlatformTable([]);
		expect(table("onebot")).toBeTruthy();
	});

	/** 🔴 手抄那一行删了:没人报的拓展就退灰方章,而不是面板自己记得一个颜色。 */
	it("没有拓展报上来时,拓展 id 查不到东西 —— 退灰方章,不是手抄一份", () => {
		expect(buildPlatformTable([])("bridge")).toBeUndefined();
	});

	it("拓展自己报的短名与标识色进得了表,清单里的图标也一起", () => {
		const icon = '<svg viewBox="0 0 24 24"><path d="M4 4h16"/></svg>';
		const table = buildPlatformTable([{ ...BRIDGE, icon }]);
		expect(table("bridge")).toEqual({ tint: "#a855f7", label: "桥接", svg: icon });
	});

	/**
	 * 🔴 注册表里写的图标名要真在图标表里 —— 写错一个字母不会有任何编译错,
	 * 只是那个平台在推送目标页悄悄退成首字方章。
	 */
	it("内置平台声明的图标名,组件库的图标表里都有", () => {
		for (const [code, meta] of Object.entries(PLATFORM_REGISTRY)) {
			if (meta.icon) expect(Icon[meta.icon as IconName], `${code} → ${meta.icon}`).toBeTruthy();
		}
	});

	/** 没跑起来的拓展没有 descriptor(那是 activate 里报的)—— 不能因此塞一份空壳进去。 */
	it("没跑起来的那条不进表", () => {
		const table = buildPlatformTable([{ ...BRIDGE, descriptor: undefined, state: "disabled" }]);
		expect(table("bridge")).toBeUndefined();
	});
});

/**
 * 🔴 **接线守卫。** 表算对了、`PlatformMetaProvider` 没接上,症状是桥的卡片退成灰方章 ——
 * 而这一层的单元测试照样全绿。这条从 Provider 那一头真取一次。
 */
describe("表真的喂给了组件库", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	function Probe() {
		const label = usePlatformLabel();
		return <span>{label("bridge")}</span>;
	}

	it("拓展报的短名,组件库那一侧真取得到", async () => {
		vi.mocked(api.get).mockResolvedValue({ extensions: [BRIDGE] } satisfies ExtensionsResponse);
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<PlatformMetaRoot>
					<Probe />
				</PlatformMetaRoot>
			</QueryClientProvider>,
		);
		expect(await screen.findByText("桥接")).toBeTruthy();
	});
});
