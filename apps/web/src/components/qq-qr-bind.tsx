import type { QQBindPollResult, QQBindStartResponse } from "@bilibili-notify/contract";
import { Btn, ErrorNote, LoadingBlock, ModalShell, Pill } from "@bilibili-notify/ui";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../services/api";

/**
 * QQ 官方机器人「扫码一键创建」—— 适配器表单里 appId/appSecret 的旁路入口。
 *
 * 借道腾讯给 OpenClaw 开的 lite 绑定通道(server 代理,见 server 端
 * `platforms/qq-bind.ts`):扫码进的是腾讯 H5,建 bot 全程在腾讯页面里发生;
 * 完成后凭据回填**表单草稿**,保存仍走用户点保存的既有 PATCH 链路 —— 这里
 * 绝不直写配置。通道属实验性(预期消费者是 OpenClaw,可能哪天收紧),失效
 * 时手填 appid/secret 是永远在的降级路径。
 */

type Phase = "closed" | "starting" | "waiting" | "expired" | "error";

/** 缺失 / 不是数的时候按 server 当前的口径来。 */
const POLL_FALLBACK_SEC = 2;
const POLL_MIN_SEC = 1;
const POLL_MAX_SEC = 60;

/**
 * 把 server 给的秒数夹成能用的毫秒。
 *
 * **不夹会出事**:`0` 或字段缺失(`undefined * 1000 = NaN`,setTimeout 当 0 处理)
 * 都会让浏览器以网络极限速度重发 `POST /api/qq/bind/poll`,而每一发服务端都转成
 * 一次对腾讯的请求,一路持续到任务 10 分钟 TTL 到期。上限那头则是防呆:上游多写
 * 一个零,弹窗看起来就跟死了一样。
 */
export function pollDelayMs(interval: unknown): number {
	const sec = Number(interval);
	if (!Number.isFinite(sec)) return POLL_FALLBACK_SEC * 1000;
	return Math.min(Math.max(sec, POLL_MIN_SEC), POLL_MAX_SEC) * 1000;
}

export function QQQrBindButton({
	onCredentials,
}: {
	onCredentials: (creds: { appId: string; appSecret: string }) => void;
}) {
	const [phase, setPhase] = useState<Phase>("closed");
	const [session, setSession] = useState<QQBindStartResponse | null>(null);
	const [err, setErr] = useState<string | null>(null);
	// 回调走 ref:轮询 effect 不因父组件每次渲染换回调而重启。
	const onCredentialsRef = useRef(onCredentials);
	onCredentialsRef.current = onCredentials;

	async function start() {
		setPhase("starting");
		setErr(null);
		setSession(null);
		try {
			const s = await api.post<QQBindStartResponse>("/api/qq/bind/start", {});
			setSession(s);
			setPhase("waiting");
		} catch (e) {
			setErr(`创建绑定任务失败:${(e as Error).message}`);
			setPhase("error");
		}
	}

	useEffect(() => {
		if (phase !== "waiting" || !session) return;
		let alive = true;
		let timer: ReturnType<typeof setTimeout>;
		// session 换了 effect 就重跑,所以一轮问询期间间隔是定死的 —— 算一次就够
		const delay = pollDelayMs(session.interval);
		const tick = async () => {
			try {
				const r = await api.post<QQBindPollResult>("/api/qq/bind/poll", { taskId: session.taskId });
				if (!alive) return;
				// 穷尽 switch 而不是 if 链:两端现在共用 QQBindPollResult,server 哪天多一个
				// status(比如 rate_limited),default 里的 never 会让**前端编译不过** ——
				// if 链的话它会静静地落到「继续轮询」上,一个类型错误都没有。
				switch (r.status) {
					case "created":
						onCredentialsRef.current({ appId: r.appId, appSecret: r.appSecret });
						setPhase("closed");
						return;
					case "expired":
						setPhase("expired");
						return;
					case "error":
						setErr(r.message);
						setPhase("error");
						return;
					case "pending":
						break;
					default: {
						const unhandled: never = r;
						setErr(`未知的绑定状态:${JSON.stringify(unhandled)}`);
						setPhase("error");
						return;
					}
				}
				timer = setTimeout(tick, delay);
			} catch (e) {
				if (!alive) return;
				if (e instanceof ApiError && e.status === 404) {
					// server 重启/任务超时被清,任务已不在 —— 当过期处理,请用户重开。
					setPhase("expired");
					return;
				}
				// 瞬时故障(网络抖动 / 上游 502,server 保留了任务)→ 下一轮接着问。
				timer = setTimeout(tick, delay);
			}
		};
		timer = setTimeout(tick, delay);
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [phase, session]);

	const open = phase !== "closed";
	return (
		<div className="flex items-center gap-2">
			<Btn variant="outline" size="sm" onClick={() => void start()}>
				扫码一键创建
			</Btn>
			<Pill subtle size="sm">
				实验性
			</Pill>
			{open ? (
				<ModalShell
					width={400}
					onCancel={() => setPhase("closed")}
					title="扫码一键创建机器人"
					description="手机 QQ 扫码,在腾讯页面里完成创建(每个 QQ 号最多 5 个)"
				>
					<div className="flex flex-col items-center gap-3">
						{phase === "starting" ? (
							<div className="flex h-56 w-56 items-center justify-center">
								<LoadingBlock variant="inset" label="正在创建绑定任务" />
							</div>
						) : null}
						{phase === "waiting" && session ? (
							<img
								alt="QQ 机器人绑定二维码"
								className="h-56 w-56 rounded-sm bg-bn-surface p-2 shadow-bn-card"
								src={session.qr}
							/>
						) : null}
						{phase === "expired" ? (
							<div className="text-bn-sm text-bn-text-secondary">二维码已过期</div>
						) : null}
						{phase === "error" && err ? <ErrorNote>{err}</ErrorNote> : null}
						{phase === "expired" || phase === "error" ? (
							<Btn variant="outline" size="sm" onClick={() => void start()}>
								重新生成
							</Btn>
						) : null}
						{/* 只留能力注意这一段(2026-08-30 主人拍板砍掉 OpenClaw/通道失效说明,嫌话多) */}
						<div className="text-bn-xs text-bn-text-tertiary">
							注意:此通道创建的机器人能力有限,目前<b>限创建者私聊与创建者当群主的群</b>
							(以腾讯当前政策为准)。要更宽的能力请手动填写正式注册的机器人凭据。
						</div>
					</div>
				</ModalShell>
			) : null}
		</div>
	);
}
