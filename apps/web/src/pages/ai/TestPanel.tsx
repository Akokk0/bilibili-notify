/**
 * 智能女仆「试一句」面板。
 *
 * 调人格时的即时反馈:拿 AI 页**当前草稿**(未保存的人格改动也算)当 system prompt,
 * 递一句话 / 一个问题给女仆,她的回复真实推到选定的 PushTarget,同时就地显示在页面上
 * —— 不必为了看一句回复跑去 QQ 里翻。
 *
 * 草稿送后端前把没动的密钥格(下发的遮挡)拿掉 —— 不带这一格,后端就用已存的真 key;带着遮挡是 400。
 */

import type { AiTestPushResponse as TestPushResponse } from "@bilibili-notify/contract";
import { withoutMaskedCells } from "@bilibili-notify/internal/patch";
import { Btn, ErrorNote, GlassBox, Icon } from "@bilibili-notify/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Field, TArea, TSelect } from "../../components/forms";
import { targetDisplay } from "../../components/target-display";
import { useT } from "../../i18n";
import { api } from "../../services/api";
import { errorTextOf } from "../../services/error-text";
import type { Connection, PushTarget } from "../../types/domain";
import type { AiSettingsDraft } from "../../types/globals";

const MAX_MESSAGE = 500;

export function AiTestPanel({ draft }: { draft: AiSettingsDraft }) {
	const connectionsQuery = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<Connection[]>("/api/connections"),
	});
	const tx = useT();
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const targets = targetsQuery.data ?? [];

	const [targetId, setTargetId] = useState("");
	const [message, setMessage] = useState("");
	const [reply, setReply] = useState<string | null>(null);
	const [err, setErr] = useState<string | null>(null);

	// 目标到位后默认选第一个 —— 大多数人只配了一个,省一次点击。
	useEffect(() => {
		if (!targetId && targets.length > 0) setTargetId(targets[0]?.id ?? "");
	}, [targets, targetId]);

	const test = useMutation({
		mutationFn: () =>
			api.post<TestPushResponse>("/api/ai/test", {
				targetId,
				message,
				ai: withoutMaskedCells(draft),
			}),
		onMutate: () => {
			setReply(null);
			setErr(null);
		},
		onSuccess: (r) => {
			// 「试了没成」(女仆没答上来、投递没成)是 200 + { ok: false, code, message };请求本身不对
			// (体不对、没这个目标、引擎没起)是非 2xx,走 onError。两条路都得显式接住,
			// 否则失败会静静地什么都不显示,用户以为没点上。
			if (r.ok) setReply(r.reply);
			else setErr(r.message);
		},
		onError: (e: unknown) => setErr(errorTextOf(e)),
	});

	const canSend = targetId !== "" && message.trim() !== "" && !test.isPending;

	return (
		<GlassBox
			title={tx("aiPage.test.title")}
			subtitle={tx("aiPage.test.subtitle")}
			accent="var(--color-bn-pink)"
			icon={<Icon.sparkle size={14} />}
			badge="test"
		>
			<Field code="ai.test.target">
				<TSelect
					value={targetId}
					onChange={setTargetId}
					options={targets.map((target) => targetDisplay(target, connectionsQuery.data ?? []))}
				/>
			</Field>

			<Field code="ai.test.message" full>
				<TArea
					value={message}
					onChange={(v) => setMessage(v.slice(0, MAX_MESSAGE))}
					placeholder={tx("aiPage.test.placeholder")}
					rows={2}
				/>
			</Field>

			<div className="flex items-center gap-2">
				<Btn variant="primary" disabled={!canSend} onClick={() => test.mutate()}>
					{test.isPending ? tx("aiPage.test.thinking") : tx("aiPage.test.title")}
				</Btn>
				{test.data?.ok && reply !== null && (
					<span className="text-bn-xs text-bn-text-tertiary">
						{tx("aiPage.test.delivered", { latencyMs: test.data.latencyMs })}
					</span>
				)}
			</div>

			{reply !== null && (
				<div className="mt-2 rounded-md border border-bn-border-subtle bg-bn-surface/60 px-3 py-2 text-bn-base leading-relaxed text-bn-text-primary">
					{reply || tx("aiPage.test.silent")}
				</div>
			)}
			{err !== null && <ErrorNote className="mt-2">{err}</ErrorNote>}
		</GlassBox>
	);
}
