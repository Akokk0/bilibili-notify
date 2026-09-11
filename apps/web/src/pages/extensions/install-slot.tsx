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

import type { ExtensionInstallResponse } from "@bilibili-notify/contract";
import { AddFileButton } from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { DEFAULT_RESTART_WAIT, type RestartWait } from "../../components/update/restart";
import { api } from "../../services/api";
import { errorsOf, InstallErrors } from "./install-errors";
import { ExtensionInstallOutcome } from "./install-outcome";

export interface ExtensionInstallSlotProps {
	/** 等待参数,只有测试会给。 */
	wait?: RestartWait;
	className?: string;
}

export function ExtensionInstallSlot({
	wait = DEFAULT_RESTART_WAIT,
	className,
}: ExtensionInstallSlotProps) {
	const qc = useQueryClient();
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

	return (
		<div className={`flex flex-col gap-2 ${className ?? ""}`}>
			<AddFileButton
				accept=".zip,application/zip"
				uploading={install.isPending}
				uploadingLabel="正在装…"
				onFile={(file) => file && install.mutate(file)}
				// 圆角与 AddCard 同一档:它是一整块「空位」,不是行内那颗药丸。
				className="flex flex-col justify-center gap-1 rounded-xl px-4 py-5 text-center"
			>
				<span className="text-bn-sm font-bold text-bn-text-secondary">传一个拓展包</span>
				<span className="text-bn-2xs text-bn-text-tertiary">
					一个 zip,里头是 extension.json 与 index.mjs。
					<strong className="text-bn-text-secondary">只装信得过的包</strong> —— 它会在 BN 进程里跑。
				</span>
			</AddFileButton>

			<InstallErrors lead="这个包装不了:" errors={errors} />

			<ExtensionInstallOutcome done={done} wait={wait} />
		</div>
	);
}
