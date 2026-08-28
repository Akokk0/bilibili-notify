import type { QQOfficialAdapterConfig } from "@bilibili-notify/internal";
import { Hono } from "hono";
import QRCode from "qrcode";
import { createBindTask, pollBindTask } from "../platforms/qq-bind.js";
import { fetchQQGuildChannels } from "../platforms/qq-official.js";
import type { RouteDeps } from "./types.js";

/** 绑定任务 TTL —— 腾讯侧二维码本身会过期,这里只兜「弹层开着人走了」的泄漏。 */
const BIND_TASK_TTL_MS = 10 * 60_000;

/** 轮询间隔(秒),对齐 AstrBot 同通道的默认值。 */
const BIND_POLL_INTERVAL_SEC = 2;

/**
 * `/api/qq` — QQ 官方机器人面板辅助数据(只读)。
 *
 * - `GET /sessions/:adapterId` — 网关从入站事件捞到的群/C2C 会话(openid),供建 target
 *   时的选择器(QQ 无「列我加入的群」接口,只能让机器人先被 @ 一次)。内存发现表,不落盘。
 * - `GET /guilds/:adapterId`   — REST 枚举该 adapter 能见的频道服务器 + 文字子频道,供频道
 *   scope target 选择器。每次实时拉(一次性 token)。
 * - `POST /bind/start` / `POST /bind/poll` — 扫码一键建 bot(借道腾讯 OpenClaw lite
 *   通道,见 `platforms/qq-bind.ts`)。bindKey 只存本路由内存,不出响应、不落盘;
 *   凭据由前端回填表单草稿,保存走既有 PATCH 链路。
 */
export function createQQRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	/** taskId → 绑定密钥与创建时刻。completed/expired 即删;TTL 惰性清扫。 */
	const bindTasks = new Map<string, { bindKey: string; createdAt: number }>();
	const bindHost = (): string | undefined => process.env.BN_QQ_BIND_HOST || undefined;
	const sweepBindTasks = (): void => {
		const now = Date.now();
		for (const [id, t] of bindTasks) {
			if (now - t.createdAt > BIND_TASK_TTL_MS) bindTasks.delete(id);
		}
	};

	app.post("/bind/start", async (c) => {
		sweepBindTasks();
		try {
			const task = await createBindTask(bindHost());
			bindTasks.set(task.taskId, { bindKey: task.bindKey, createdAt: Date.now() });
			const qr = await QRCode.toDataURL(task.qrUrl, { margin: 1, width: 320 });
			return c.json({ taskId: task.taskId, qr, interval: BIND_POLL_INTERVAL_SEC });
		} catch (err) {
			log.warn(`POST /api/qq/bind/start failed: ${String(err)}`);
			return c.json({ error: "bind_start_failed", message: (err as Error).message }, 502);
		}
	});

	app.post("/bind/poll", async (c) => {
		sweepBindTasks();
		const { taskId } = (await c.req.json().catch(() => ({}))) as { taskId?: string };
		const task = taskId ? bindTasks.get(taskId) : undefined;
		if (!taskId || !task) {
			return c.json({ error: "not_found", message: "绑定任务不存在或已过期" }, 404);
		}
		try {
			const result = await pollBindTask(taskId, task.bindKey, bindHost());
			if (result.status === "created" || result.status === "expired") bindTasks.delete(taskId);
			return c.json(result);
		} catch (err) {
			// 上游故障保留任务,前端下一轮继续问。
			log.warn(`POST /api/qq/bind/poll failed: ${String(err)}`);
			return c.json({ error: "bind_poll_failed", message: (err as Error).message }, 502);
		}
	});

	app.get("/sessions/:adapterId", (c) => {
		const id = c.req.param("adapterId");
		return c.json(deps.qqSessionRegistry?.list(id) ?? []);
	});

	app.get("/guilds/:adapterId", async (c) => {
		const id = c.req.param("adapterId");
		const adapter = deps.store.getAdapters().find((a) => a.id === id);
		if (adapter?.platform !== "qq-official") {
			return c.json({ error: "not_found", message: "qq-official adapter not found", id }, 404);
		}
		try {
			const guilds = await fetchQQGuildChannels(adapter.config as QQOfficialAdapterConfig);
			return c.json(guilds);
		} catch (err) {
			log.warn(`GET /api/qq/guilds/${id} failed: ${String(err)}`);
			return c.json({ error: "enumerate_failed", message: String(err) }, 502);
		}
	});

	return app;
}
