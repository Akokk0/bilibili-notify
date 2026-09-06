import type { UpdateState } from "@bilibili-notify/contract";
import type { UpdateService, UpdateStatus } from "../update/service.js";

/**
 * 更新服务的注入装饰器 —— devtools 的 B1(更新 9 相 8 归因)。
 *
 * 包在真服务外面,**只换 `getStatus()` 报出去的 `state`**,服务本体一行不动:面板、概览
 * 系统状态卡、右下角通知卡看的都是 `getStatus()`,换这一处它们就全跟着走。
 *
 * **假状态只由 devtools 收摊,真动作(检查 / 下载 / 回退)原样转发、不碰它。** 上一版的规矩是
 * 「真动作一按就顶掉」,栽在 `useUpdateCheckOnOpen` 上:面板每次打开都自动 `check()` 一次,
 * 于是刷新一下页面注入就没了 —— 而「打开面板弹出有新版那张卡」恰恰是最想看的一条。开发版
 * 上真动作本来也做不了事(功能是关的),转发过去只是让路由那头照常回话。
 *
 * 注意 `POST /api/update/apply` 读的也是 `getStatus()`:注入 `ready` / `rolled-back` 之后
 * 按「立即重启并应用」**会真的优雅停机退 0**。这是刻意的 —— 重启那条链路(等新进程 →
 * 整页刷新 → 弹「已更新到」)正是靠 devtools 才验得到;场景说明里写明这一句就够。
 */
export interface InjectableUpdateService {
	/** 交给路由的那份 —— 面板看到的都从它出。 */
	service: UpdateService;
	inject(state: UpdateState): void;
	clear(): void;
	/** 当前注入着的假状态,没有就 null。 */
	injected(): UpdateState | null;
}

export function injectableUpdateService(real: UpdateService): InjectableUpdateService {
	let fake: UpdateState | null = null;

	function status(): UpdateStatus {
		const actual = real.getStatus();
		return fake === null ? actual : { ...actual, state: fake };
	}

	/**
	 * 真动作:转发给真服务跑,**回的却是装饰过的状态**。面板把动作的响应直接写进缓存
	 * (`useUpdateCheckOnOpen` 的 `setQueryData`、系统页几个 mutation 都是),回真状态的话
	 * 那一写就把假的冲掉了 —— 注入还在服务端,面板却已经看不见它。
	 */
	async function forward(action: () => Promise<UpdateStatus>): Promise<UpdateStatus> {
		await action();
		return status();
	}

	const service: UpdateService = {
		getStatus: status,
		check: () => forward(() => real.check()),
		download: () => forward(() => real.download()),
		rollback: () => forward(() => real.rollback()),
		probeMirrors: (prefixes) => real.probeMirrors(prefixes),
	};

	return {
		service,
		inject(state) {
			fake = state;
		},
		clear() {
			fake = null;
		},
		injected: () => fake,
	};
}
