/**
 * 系统级动作:**重启一下**;开机之后要告诉主人的事(⑧,`GET /notices`、`POST /notices/:id/acknowledge`);
 * 主人要求开新代(全新开始 / 从旧代重新迁移,`POST /generations` —— 写下标记再重启,开代在重启后的开机里做)。
 *
 * 重启本身不在这一层 —— 它就是「优雅停机 + 退 0」,与应用更新完全同一条路(见 index.ts),
 * 把它拉起来的是外面那位(桌面外壳 / 容器的 `restart:` 策略)。这一层只做两件实质的事,
 * 而两件都是「用户会以为功能坏了」的地方:**先回话再关自己**,以及**拉不起来就别关**。
 *
 * ⛔ **面板上没有「重启」这颗常驻按钮**(主人 2026-09-10 拍板):重启是**某个动作的后果**,
 * 只在刚做完一件需要它的事之后就地提示一次。所以这里**不开只读的判据口** —— 要不要给那颗
 * 按钮,由**做那件事的那个回话**自己带上。开新代就是这样一件事:它的重启是后果,不是一颗按钮。
 */

import type {
	GenerationSourceKind,
	RestartAbility,
	RestartResponse,
	SystemNoticesResponse,
} from "@bilibili-notify/contract";
import { fail, formatZodIssues, issuesFromZod } from "@bilibili-notify/internal";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { SystemNoticeStore } from "../runtime/system-notices.js";
import { respondFailure } from "./respond-failure.js";

export interface CreateSystemRouteInput {
	/** 这台机器上按重启还回不回得来 —— 判据见 `runtime/restart-ability.ts`。 */
	ability: RestartAbility;
	/** 这个进程的启动时刻(与 `/api/health` 同一个值),面板靠它变了认新进程。 */
	startedAt: string;
	/** 现在跑的版本。重启后 `boot.mjs` 会重新选版,面板拿它当「该回到哪一版」的期望。 */
	version: string;
	/** 优雅停机 + 退 0。由 index.ts 注入 —— 路由不该知道怎么关一个进程。 */
	restart: () => Promise<void>;
	/** 开机之后要告诉主人的事,记在用着的那一代里。 */
	notices: Pick<SystemNoticeStore, "list" | "acknowledge">;
	/** 写下「下次开机开这种新代」的标记。由 index.ts 注入 —— 路由不碰宿主根。 */
	requestGeneration: (source: GenerationSourceKind) => Promise<void>;
	/** 第 0 代(0.x 的数据)还在不在:从旧代重新迁移要它。 */
	zeroGenerationExists: () => Promise<boolean>;
}

const GenerationCreateSchema = z.strictObject({ source: z.enum(["empty", "zero"]) });

/** 拉不起来时那句话。**说清是哪一种** —— 面板只有这一条线索,而两种的出路不一样。 */
function refusal(ability: Extract<RestartAbility, { can: false }>): string {
	return ability.reason === "source-run"
		? "开发版是 tsx 直跑的:进程退了 tsx watch 只会停在那儿等文件变,没人把它拉起来。改一行代码就是重启。"
		: "这个进程退了没人拉(没跑在桌面外壳里,也不在容器里)—— 自己在终端里重开一次吧。";
}

export function createSystemRoute(input: CreateSystemRouteInput): Hono {
	const app = new Hono();

	/** 回话,然后关自己 —— 重启与开新代共用。调用前先判过拉不拉得起来。 */
	function respondThenRestart(c: Context) {
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
	}

	app.post("/restart", (c) => {
		// 🔴 按钮藏起来 ≠ 没人发这个请求(旧标签页、curl)。放过去就是把 BN 关了没人拉,
		// 而那台机器上界面只会显示连不上 —— 最难猜的一种「功能坏了」。
		// `unsupported`:这台机器不支持重启;`message` 说清是哪一种(面板原样显示)。
		if (!input.ability.can) return respondFailure(c, fail("unsupported", refusal(input.ability)));
		return respondThenRestart(c);
	});

	app.get("/notices", async (c) => {
		const body: SystemNoticesResponse = { notices: await input.notices.list() };
		return c.json(body);
	});

	app.post("/notices/:id/acknowledge", async (c) => {
		if (!(await input.notices.acknowledge(c.req.param("id")))) {
			return respondFailure(c, fail("not_found", "没有这条提示"));
		}
		const body: SystemNoticesResponse = { notices: await input.notices.list() };
		return c.json(body);
	});

	app.post("/generations", async (c) => {
		const parsed = GenerationCreateSchema.safeParse(await c.req.json().catch(() => undefined));
		if (!parsed.success) {
			return respondFailure(
				c,
				fail("invalid", `请求体不合规矩:${formatZodIssues(parsed.error).join(";")}`, {
					issues: issuesFromZod(parsed.error),
				}),
			);
		}
		// 拒绝的几种一律在写标记之前:标记写下了却没重启,下次不知道哪一回开机就开了一代。
		if (!input.ability.can) return respondFailure(c, fail("unsupported", refusal(input.ability)));
		const { source } = parsed.data;
		if (source === "zero" && !(await input.zeroGenerationExists())) {
			return respondFailure(c, fail("not_found", "第 0 代(0.x 的数据)已经不在了,没法从它重新迁移"));
		}
		// 标记没写成就抛出去、不重启:重启回来什么都没变,主人还以为点过了。
		await input.requestGeneration(source);
		return respondThenRestart(c);
	});

	return app;
}
