import type { HistoryStore } from "../history/store.js";
import type { PlatformAdapter } from "../platforms/types.js";
import type { DevCapturesApi } from "../routes/dev.js";
import type { UpdateService } from "../update/service.js";
import { isDevBuild } from "../update/version-order.js";
import { createCaptureGate } from "./capture.js";
import { createDevRegistry, type DevRegistry } from "./registry.js";
import { pushCaptureScenario } from "./scenarios/capture.js";
import { updateStateScenario } from "./scenarios/update.js";
import { injectableUpdateService } from "./update-injection.js";

/**
 * devtools 的组装点 + 那道门。
 *
 * **门 = 载荷版本号是不是开发版**(`0.0.0-dev` / `dev`),不是环境变量:环境变量能在生产
 * 镜像里被设上,版本号不能;alpha 也不给 —— 那是发出去给人用的构建。`index.ts` 拿到 null
 * 就什么都不挂,`/api/dev` 404,面板那半(`import.meta.env.DEV` 挡着)也就当它不存在。
 *
 * 注入的高度:**既有边界上套装饰器,引擎与服务本体一行不动**。这里把真服务 / 真 adapter
 * 各包一层交回去,`index.ts` 把包好的那份往下传 —— 面板看到的、出网的都从装饰器过,本体照常跑。
 */
export interface CreateDevtoolsInput {
	payloadVersion: string;
	updateService: UpdateService;
	/** 推送出口。交回去的是包过截流闸的那份。 */
	adapters: readonly PlatformAdapter[];
	/** 「清掉截流期间历史行」要它。 */
	historyStore: Pick<HistoryStore, "deleteRange">;
}

export interface Devtools {
	registry: DevRegistry;
	/** 交给 `/api/update` 路由的那份 —— 装饰过的。 */
	updateService: UpdateService;
	/** 交给引擎 / 链接回卡的那份 —— 包过截流闸的。 */
	adapters: PlatformAdapter[];
	captures: DevCapturesApi;
}

export function createDevtools(input: CreateDevtoolsInput): Devtools | null {
	if (!isDevBuild(input.payloadVersion)) return null;
	const update = injectableUpdateService(input.updateService);
	const gate = createCaptureGate();
	const captures: DevCapturesApi = {
		status: () => ({ enabled: gate.enabled(), entries: gate.entries() }),
		clear: () => gate.clear(),
		// 每一段截流窗各删一遍;开着的那段截到现在。删完把窗归零 —— 再清一次不该把同一段又删一遍。
		async purgeHistory() {
			const now = Date.now();
			let deleted = 0;
			for (const { from, to } of gate.windows()) {
				deleted += await input.historyStore.deleteRange({ fromMs: from, toMs: to ?? now });
			}
			gate.resetWindows();
			return deleted;
		},
	};
	return {
		registry: createDevRegistry([updateStateScenario(update), pushCaptureScenario(gate)]),
		updateService: update.service,
		adapters: input.adapters.map((a) => gate.wrap(a)),
		captures,
	};
}
