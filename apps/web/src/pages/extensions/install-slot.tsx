/**
 * 拓展页上的「传一个包上来装」。
 *
 * 装完那句话是这一块的全部意义,三种结局的出路完全不同:
 * - **热装好了** —— 什么都不用做,它已经在跑(开关另说);
 * - **盖掉了一份已经装着的** —— 那份代码已经 import 过,ESM 在这个进程里换不掉
 *   (ADR-0012 决策 10),得重启一次;
 * - **包不合规** —— 服务端那几句是主人手里那个包哪里不对的唯一线索,逐条摆出来。
 *
 * ⛔ **那颗重启按钮只在这里、只在这一刻出现**(ADR-0005 决策 22):面板上没有常驻的重启
 * 入口 —— 重启是**刚做完这件事**的后果,不是一个随时可按的动作。这台机器上按了回不来
 * (开发版 / 裸跑)就不给按钮,但要把原因写出来。
 */

import type { ExtensionInstallResponse, RestartResponse } from "@bilibili-notify/contract";
import { AddFileButton, Btn, ErrorNote, HintNote, LoadingBlock } from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type RestartWait, useRestartStore } from "../../components/update/restart";
import { ApiError, api } from "../../services/api";

/** 与「立即重启并应用」同一组等待参数 —— 重启的代价两边一样。 */
const DEFAULT_WAIT: RestartWait = { intervalMs: 1_000, timeoutMs: 90_000 };

export interface ExtensionInstallSlotProps {
	/** 等待参数,只有测试会给。 */
	wait?: RestartWait;
	className?: string;
}

/** 服务端那几句拒绝。拿不到就退回一句 message —— 但**别把它伪装成服务端说的**。 */
function errorsOf(err: unknown): string[] {
	if (err instanceof ApiError) {
		const body = err.body as { errors?: unknown } | null;
		if (Array.isArray(body?.errors)) return body.errors.map((e) => String(e));
	}
	return [err instanceof Error ? err.message : String(err)];
}

/** 重启回不来的那两档各自的出路不一样,所以不能合成一句「不支持」。 */
function whyNoButton(reason: "source-run" | "unsupervised"): string {
	return reason === "source-run"
		? "开发版是 tsx 直跑的:进程退了 tsx watch 只等文件变,没人把它拉起来 —— 随便改一行代码存一下,那本来就是一次重启。"
		: "这个进程退了没人拉(既没跑在桌面外壳里,也不在容器里)—— 自己在终端里停掉再起一次。";
}

export function ExtensionInstallSlot({
	wait = DEFAULT_WAIT,
	className,
}: ExtensionInstallSlotProps) {
	const qc = useQueryClient();
	const { view, begin } = useRestartStore();
	const [done, setDone] = useState<ExtensionInstallResponse | null>(null);
	const [errors, setErrors] = useState<string[]>([]);

	const install = useMutation({
		mutationFn: (file: File) => {
			const form = new FormData();
			form.set("file", file);
			return api.upload<ExtensionInstallResponse>("/api/ext/install", form);
		},
		onMutate: () => {
			setErrors([]);
			setDone(null);
		},
		onSuccess: (res) => {
			setDone(res);
			// 热装的那一份**已经在跑了** —— 列表要跟着换,不然主人以为没装上。
			void qc.invalidateQueries({ queryKey: ["extensions"] });
		},
		onError: (err) => setErrors(errorsOf(err)),
	});

	const restart = useMutation({
		mutationFn: () => api.post<RestartResponse>("/api/system/restart", {}),
		onSuccess: ({ startedAt, version }) =>
			begin({ before: startedAt, target: version, mode: "restart" }, wait),
	});

	const waiting = view?.intent.mode === "restart" && view.kind === "waiting";

	return (
		<div className={`flex flex-col gap-2 ${className ?? ""}`}>
			<AddFileButton
				accept=".zip,application/zip"
				uploading={install.isPending}
				uploadingLabel="正在装…"
				onFile={(file) => file && install.mutate(file)}
				className="flex flex-col justify-center gap-1 px-4 py-5 text-center"
			>
				<span className="text-bn-sm font-bold text-bn-text-secondary">传一个拓展包</span>
				<span className="text-bn-2xs text-bn-text-tertiary">
					一个 zip,里头是 extension.json 与 index.mjs。
					<strong className="text-bn-text-secondary">只装信得过的包</strong> —— 它会在 BN 进程里跑。
				</span>
			</AddFileButton>

			{errors.length > 0 ? (
				<ErrorNote size="sm">
					<span className="font-semibold">这个包装不了:</span>
					<ul className="mt-1 ml-4 list-disc">
						{errors.map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
				</ErrorNote>
			) : null}

			{done && !done.needsRestart ? (
				<HintNote tone="success">
					<strong className="text-bn-text-secondary">{done.name}</strong> {done.version}{" "}
					装好了,已经在跑 —— 开关在它自己那张卡上。
				</HintNote>
			) : null}

			{done?.needsRestart ? (
				<HintNote tone="neutral" className="flex flex-wrap items-center gap-2">
					<span>
						<strong className="text-bn-text-secondary">{done.name}</strong> 换成了 {done.version}
						,但它的旧代码已经在这个进程里跑着、换不掉 ——{" "}
						<strong className="text-bn-text-secondary">重启一次</strong>才会用上新的。
						{done.restart.can ? "" : ` ${whyNoButton(done.restart.reason)}`}
					</span>
					{done.restart.can ? (
						<Btn
							variant="outline"
							size="sm"
							disabled={restart.isPending || waiting}
							onClick={() => restart.mutate()}
						>
							重启一次
						</Btn>
					) : null}
				</HintNote>
			) : null}

			{waiting ? (
				<LoadingBlock variant="inset" label="正在重启" hint="服务回来后这一页会自动刷新。" />
			) : null}

			{restart.isError ? (
				<ErrorNote size="sm">没能发出重启指令:{restart.error.message}</ErrorNote>
			) : null}
		</div>
	);
}
