/**
 * 桥接面板那一摞测试共用的摆台。
 *
 * 九个文件此前各抄一份 `globalsWith` 与 `renderPanel` —— 抄的是**同一句事实**:接入住桥
 * 自己的设置里(`globals.extensions.bridge.settings.links`,ADR-0012 决策 45)。那句事实
 * 变形状时(它已经变过一次:从连接表搬进拓展设置),九份得一起改,漏一份的下场是那个
 * 文件对着一张再也不存在的形状全绿。
 *
 * ⚠️ `vi.mock("../../../services/api", …)` **留在各文件里** —— 它要被提升到 import 之前,
 * 搬进这里就不生效了。这里只是**用**那份 mock。
 */

import type { PlatformMeta } from "@bilibili-notify/ui";
import { PlatformMetaProvider } from "@bilibili-notify/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { vi } from "vite-plus/test";
import { api } from "../../../services/api";
import { BridgeAddressRow, BridgeConnections } from "../bridge-panel";

/** 接入住桥的设置里(`globals.extensions.bridge.settings.links`),不在连接表里。 */
export function globalsWith(links: unknown[]) {
	return { extensions: { bridge: { enabled: true, settings: { links } } } };
}

export interface BridgePanelSetup {
	/** 那份接入名单;`null` = 那一口读不到(401 / 服务端炸了 / 断网)。 */
	links?: unknown[] | null;
	/** 拓展交上来的状态。**不给 = 那一口拿不到** —— 关着的、崩了的都走这条。 */
	status?: unknown;
	/** 拓展本身开没开。 */
	enabled?: boolean;
	/** 平台注册表;只有对着 bot 行那几枚方块的测试要,别的退「谁都不认得」。 */
	platforms?: (platform: string) => PlatformMeta | undefined;
	/** 地址行住在详情页头卡上 —— 要连它一起验(两处的「复制」是同一件事)时才挂。 */
	withAddressRow?: boolean;
}

export function renderPanel({
	links = [],
	status,
	enabled = true,
	platforms,
	withAddressRow = false,
}: BridgePanelSetup = {}) {
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === "/api/globals") {
			if (links === null) throw new Error("配置读不出来:500");
			return globalsWith(links);
		}
		// 关着 / 没跑起来的拓展,`/status` 就是 404 —— 两者在这条路上一模一样。
		if (path.startsWith("/api/ext/")) {
			if (status === undefined) throw new Error("拓展没跑起来");
			return status;
		}
		throw new Error(`没有这个口:${path}`);
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const tree = (
		<QueryClientProvider client={qc}>
			{withAddressRow ? <BridgeAddressRow extensionId="bridge" /> : null}
			<BridgeConnections extensionId="bridge" enabled={enabled} />
		</QueryClientProvider>
	);
	return render(
		platforms ? <PlatformMetaProvider value={platforms}>{tree}</PlatformMetaProvider> : tree,
	);
}
