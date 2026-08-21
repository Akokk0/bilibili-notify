/**
 * 智能女仆「试一句」面板。
 *
 * 调人格时的即时反馈:拿 AI 页**当前草稿**(未保存的人格改动也算)当 system prompt,
 * 递一句话 / 一个问题给女仆,她的回复真实推到选定的 PushTarget,同时就地显示在页面上
 * —— 不必为了看一句回复跑去 QQ 里翻。
 *
 * 草稿原样送后端;apiKey 若还是 REDACTED 占位,后端会回落到已存的真 key。
 */

import type { AiTestPushResponse as TestPushResponse } from "@bilibili-notify/contract";
import { Btn, ErrorNote, GlassBox, Icon } from "@bilibili-notify/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Field, TArea, TSelect } from "../../components/forms";
import { api } from "../../services/api";
import type { PushTarget } from "../../types/domain";
import type { AISettings } from "../../types/globals";

const MAX_MESSAGE = 500;

export function AiTestPanel({ draft }: { draft: AISettings }) {
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
			api.post<TestPushResponse>("/api/ai/test-push", { targetId, message, ai: draft }),
		onMutate: () => {
			setReply(null);
			setErr(null);
		},
		onSuccess: (r) => {
			// 后端把失败也包成 200 之外的码 + {ok:false};两条路都得显式接住,
			// 否则失败会静静地什么都不显示,用户以为没点上。
			if (r.ok) setReply(r.reply ?? "(女仆没说话)");
			else setErr(r.err ?? "未知错误");
		},
		onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
	});

	const canSend = targetId !== "" && message.trim() !== "" && !test.isPending;

	return (
		<GlassBox
			title="试一句"
			subtitle="拿当前人格(含未保存的改动)问女仆一句 · 回复会真实推到选定目标"
			accent="var(--color-bn-pink)"
			icon={<Icon.sparkle size={14} />}
			badge="test-push"
		>
			<Field code="ai.test.target">
				<TSelect
					value={targetId}
					onChange={setTargetId}
					options={targets.map((t) => ({ value: t.id, label: t.name }))}
				/>
			</Field>

			<Field code="ai.test.message" full>
				<TArea
					value={message}
					onChange={(v) => setMessage(v.slice(0, MAX_MESSAGE))}
					placeholder="今天过得怎么样?"
					rows={2}
				/>
			</Field>

			<div className="flex items-center gap-2">
				<Btn variant="primary" disabled={!canSend} onClick={() => test.mutate()}>
					{test.isPending ? "女仆思考中…" : "试一句"}
				</Btn>
				{test.isSuccess && reply !== null && (
					<span className="text-bn-xs text-bn-text-tertiary">
						已送达 · {test.data?.latencyMs}ms
					</span>
				)}
			</div>

			{reply !== null && (
				<div className="mt-2 rounded-md border border-bn-border-subtle bg-bn-surface/60 px-3 py-2 text-bn-base leading-relaxed text-bn-text-primary">
					{reply}
				</div>
			)}
			{err !== null && <ErrorNote className="mt-2">{err}</ErrorNote>}
		</GlassBox>
	);
}
