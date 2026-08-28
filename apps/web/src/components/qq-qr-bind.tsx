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

interface BindSession {
	taskId: string;
	qr: string;
	/** 轮询间隔,秒(server 给,当前恒 2)。 */
	interval: number;
}

type PollResult =
	| { status: "pending" }
	| { status: "expired" }
	| { status: "created"; appId: string; appSecret: string }
	| { status: "error"; message: string };

export function QQQrBindButton({
	onCredentials,
}: {
	onCredentials: (creds: { appId: string; appSecret: string }) => void;
}) {
	const [phase, setPhase] = useState<Phase>("closed");
	const [session, setSession] = useState<BindSession | null>(null);
	const [err, setErr] = useState<string | null>(null);
	// 回调走 ref:轮询 effect 不因父组件每次渲染换回调而重启。
	const onCredentialsRef = useRef(onCredentials);
	onCredentialsRef.current = onCredentials;

	async function start() {
		setPhase("starting");
		setErr(null);
		setSession(null);
		try {
			const s = await api.post<BindSession>("/api/qq/bind/start", {});
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
		const tick = async () => {
			try {
				const r = await api.post<PollResult>("/api/qq/bind/poll", { taskId: session.taskId });
				if (!alive) return;
				if (r.status === "created") {
					onCredentialsRef.current({ appId: r.appId, appSecret: r.appSecret });
					setPhase("closed");
					return;
				}
				if (r.status === "expired") {
					setPhase("expired");
					return;
				}
				if (r.status === "error") {
					setErr(r.message);
					setPhase("error");
					return;
				}
				timer = setTimeout(tick, session.interval * 1000);
			} catch (e) {
				if (!alive) return;
				if (e instanceof ApiError && e.status === 404) {
					// server 重启/任务超时被清,任务已不在 —— 当过期处理,请用户重开。
					setPhase("expired");
					return;
				}
				// 瞬时故障(网络抖动 / 上游 502,server 保留了任务)→ 下一轮接着问。
				timer = setTimeout(tick, session.interval * 1000);
			}
		};
		timer = setTimeout(tick, session.interval * 1000);
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
						<div className="text-bn-xs text-bn-text-tertiary">
							扫码后页面显示 OpenClaw / 小龙虾属正常 —— 借道的是腾讯给 OpenClaw
							开的官方绑定通道(实验性)。通道失效时,请到 q.qq.com 开发设置里手动填写 AppID 与
							AppSecret。
						</div>
						<div className="text-bn-xs text-bn-text-tertiary">
							注意:此通道创建的机器人<b>仅创建者私聊可用,暂不能拉进群</b>
							(以腾讯当前政策为准)。群推送请手动填写正式注册的机器人凭据。
						</div>
					</div>
				</ModalShell>
			) : null}
		</div>
	);
}
