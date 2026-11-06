// @vitest-environment jsdom
import type { AdapterEntry, ConnectionView } from "@bilibili-notify/contract";
import { PlatformIcon, usePlatformLabel } from "@bilibili-notify/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { snapshotFor } from "../../__tests__/platform-snapshot";
import { buildPlatformTable, DescriptorIcon, PlatformMetaRoot } from "../platform-meta";

vi.mock("../../services/api", () => ({ api: { get: vi.fn() } }));

import { api } from "../../services/api";

const ADAPTER: AdapterEntry = {
	key: "relay",
	descriptor: { label: "中继", shortLabel: "桥", color: "#a855f7", settingsFields: [] },
	has: { connectionAuth: false, listAddressCandidates: false },
};
const IMAGE = "data:image/png;base64,QUJD";
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});
describe("描述与快照提供平台外观", () => {
	it("没有描述时不自带内置或拓展平台表", () => {
		expect(buildPlatformTable([])("onebot")).toBeUndefined();
		expect(buildPlatformTable([])("relay")).toBeUndefined();
	});
	it("适配器的短名、颜色与安全图片照描述读取,不要求适配器正在运行", () => {
		const lookup = buildPlatformTable([
			{ ...ADAPTER, descriptor: { ...ADAPTER.descriptor, icon: IMAGE } },
		]);
		expect(lookup("relay")).toEqual({ label: "桥", tint: "#a855f7", image: IMAGE });
		const unsafe = buildPlatformTable([
			{ ...ADAPTER, descriptor: { ...ADAPTER.descriptor, icon: "https://tracker.test/pixel" } },
		]);
		expect(unsafe("relay")).toEqual({ label: "桥", tint: "#a855f7", icon: undefined });
	});
	it("每条连接保留自己的快照外观,同名平台不会覆盖另一条连接", () => {
		const connection = {
			id: "one",
			adapterKey: "relay",
			platform: "chat",
			name: "n",
			enabled: true,
			settings: {},
			platformSnapshot: { ...snapshotFor("chat"), shortLabel: "甲", color: "#123456" },
		} satisfies ConnectionView;
		const lookup = buildPlatformTable(
			[ADAPTER],
			[
				connection,
				{
					...connection,
					id: "two",
					platformSnapshot: { ...connection.platformSnapshot, shortLabel: "乙" },
				},
			],
		);
		expect(lookup("connection:one")?.label).toBe("甲");
		expect(lookup("connection:two")?.label).toBe("乙");
	});
	it("真正从 /api/adapters 把描述与图片交给组件库", async () => {
		vi.mocked(api.get).mockImplementation(async (url) =>
			url === "/api/adapters"
				? { adapters: [{ ...ADAPTER, descriptor: { ...ADAPTER.descriptor, icon: IMAGE } }] }
				: [],
		);
		function Probe() {
			const label = usePlatformLabel();
			return (
				<>
					<span>{label("relay")}</span>
					<PlatformIcon platform="relay" />
				</>
			);
		}
		render(
			<QueryClientProvider
				client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
			>
				<PlatformMetaRoot>
					<Probe />
				</PlatformMetaRoot>
			</QueryClientProvider>,
		);
		expect(await screen.findByText("桥")).toBeTruthy();
		expect(document.querySelector("img")?.getAttribute("src")).toBe(IMAGE);
	});
});

describe("描述符图标的纯图标兜底", () => {
	it("有安全图片时优先用描述符图片，不被兜底图标替换", () => {
		const { container } = render(
			<DescriptorIcon
				descriptor={{ shortLabel: "桥", color: "#123456", icon: IMAGE }}
				fallbackIcon="globe"
			/>,
		);
		expect(container.querySelector("img")?.getAttribute("src")).toBe(IMAGE);
		expect(container.querySelector("svg")).toBeNull();
		expect(container.textContent).toBe("");
	});

	it.each([undefined, "not-an-icon", "https://tracker.test/icon"])(
		"图标不可用(%s)时用调用方指定的图形，不画短名首字也不请求外图",
		(icon) => {
			const { container } = render(
				<DescriptorIcon
					descriptor={{ shortLabel: "桥", color: "#123456", icon }}
					fallbackIcon="globe"
				/>,
			);
			expect(container.querySelector("svg")).not.toBeNull();
			expect(container.querySelector("img")).toBeNull();
			expect(container.textContent).toBe("");
		},
	);
});
