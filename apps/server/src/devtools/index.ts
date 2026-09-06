import type { UpdateService } from "../update/service.js";
import { isDevBuild } from "../update/version-order.js";
import { createDevRegistry, type DevRegistry } from "./registry.js";
import { updateStateScenario } from "./scenarios/update.js";
import { injectableUpdateService } from "./update-injection.js";

/**
 * devtools 的组装点 + 那道门。
 *
 * **门 = 载荷版本号是不是开发版**(`0.0.0-dev` / `dev`),不是环境变量:环境变量能在生产
 * 镜像里被设上,版本号不能;alpha 也不给 —— 那是发出去给人用的构建。`index.ts` 拿到 null
 * 就什么都不挂,`/api/dev` 404,面板那半(`import.meta.env.DEV` 挡着)也就当它不存在。
 *
 * 注入的高度:**既有边界上套装饰器,引擎与服务本体一行不动**。这里把真服务包一层交回去,
 * `index.ts` 把包好的那份交给路由 —— 面板看到的都从装饰器出,真服务照常跑。
 */
export interface CreateDevtoolsInput {
	payloadVersion: string;
	updateService: UpdateService;
}

export interface Devtools {
	registry: DevRegistry;
	/** 交给 `/api/update` 路由的那份 —— 装饰过的。 */
	updateService: UpdateService;
}

export function createDevtools(input: CreateDevtoolsInput): Devtools | null {
	if (!isDevBuild(input.payloadVersion)) return null;
	const update = injectableUpdateService(input.updateService);
	return {
		registry: createDevRegistry([updateStateScenario(update)]),
		updateService: update.service,
	};
}
