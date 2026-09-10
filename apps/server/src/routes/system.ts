/**
 * 系统级动作。第一件、也是现在唯一一件:**重启一下**。
 *
 * 重启本身不在这一层 —— 它就是「优雅停机 + 退 0」,与应用更新完全同一条路(见 index.ts),
 * 把它拉起来的是外面那位(桌面外壳 / 容器的 `restart:` 策略)。这一层只做两件实质的事,
 * 而两件都是「用户会以为功能坏了」的地方:**先回话再关自己**,以及**拉不起来就别关**。
 */

import type {
	RestartAbility,
	RestartResponse,
	SystemInfoResponse,
} from "@bilibili-notify/contract";
import { Hono } from "hono";

export interface CreateSystemRouteInput {
	/** 这台机器上按重启还回不回得来 —— 判据见 `runtime/restart-ability.ts`。 */
	ability: RestartAbility;
	/** 这个进程的启动时刻(与 `/api/health` 同一个值),面板靠它变了认新进程。 */
	startedAt: string;
	/** 现在跑的版本。重启后 `boot.mjs` 会重新选版,面板拿它当「该回到哪一版」的期望。 */
	version: string;
	/** 优雅停机 + 退 0。由 index.ts 注入 —— 路由不该知道怎么关一个进程。 */
	restart: () => Promise<void>;
}

/** 拉不起来时那句话。**说清是哪一种** —— 面板只有这一条线索,而两种的出路不一样。 */
function refusal(ability: Extract<RestartAbility, { can: false }>): string {
	return ability.reason === "source-run"
		? "开发版是 tsx 直跑的:进程退了 tsx watch 只会停在那儿等文件变,没人把它拉起来。改一行代码就是重启。"
		: "这个进程退了没人拉(没跑在桌面外壳里,也不在容器里)—— 自己在终端里重开一次吧。";
}

export function createSystemRoute(input: CreateSystemRouteInput): Hono {
	const app = new Hono();

	app.get("/", (c) => c.json({ restart: input.ability } satisfies SystemInfoResponse));

	app.post("/restart", (c) => {
		// 🔴 按钮藏起来 ≠ 没人发这个请求(旧标签页、curl)。放过去就是把 BN 关了没人拉,
		// 而那台机器上界面只会显示连不上 —— 最难猜的一种「功能坏了」。
		if (!input.ability.can) return c.json({ err: refusal(input.ability) }, 409);

		const body: RestartResponse = {
			restarting: true,
			startedAt: input.startedAt,
			version: input.version,
		};

		// 先回话,再关。两层保险,与 `/api/update/apply` 一模一样:
		// ① `setTimeout` 而不是微任务 —— 微任务会在响应交给运行时**之前**跑掉,等于没让开;
		// ② 真正保证这条响应写得出去的,是 `restart` 那头的优雅停机会等在途请求收尾。
		// 不 await(等它就是等自己被杀),但要接住 rejection:没人管的话进程会以非 0 退出,
		// 而非 0 会被编排系统当成崩溃去退避重启。
		setTimeout(() => {
			input.restart().catch(() => {
				// index.ts 那头自己记日志并照样退 0。
			});
		}, 0);
		return c.json(body);
	});

	return app;
}
