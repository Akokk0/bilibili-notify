import { isDeepSeekSpeechEndpoint } from "@bilibili-notify/internal/ai";
import {
	Btn,
	DraftSecretInput,
	EmptyNote,
	ErrorNote,
	GlassBox,
	Icon,
	LoadingBlock,
	Picker,
	TInput,
} from "@bilibili-notify/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Field } from "../../components/forms";
import { TargetExceptions } from "../../components/target-exceptions";
import { AI_PURPLE } from "../../config/colors";
import { useT } from "../../i18n";
import { api } from "../../services/api";
import type { Connection, PushTarget } from "../../types/domain";
import type { AiSettingsDraft } from "../../types/globals";

function originOf(value: string | undefined) {
	try {
		return new URL(value ?? "").origin;
	} catch {
		return undefined;
	}
}

type Speech = AiSettingsDraft["speech"];
export function SpeechSettings({
	speech,
	saved,
	onChange,
}: {
	speech: Speech;
	saved?: Speech;
	onChange: (speech: Speech) => void;
}) {
	const tx = useT();
	const targets = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const connections = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<Connection[]>("/api/connections"),
	});
	const serviceId = JSON.stringify([saved?.baseUrl, saved?.model, saved?.voice]);
	const preview = useMutation({
		mutationFn: (_id: string) => api.blob("/api/ai/speech/preview", "POST"),
	});
	const [audio, setAudio] = useState("");
	useEffect(() => {
		if (!preview.data) return;
		const url = URL.createObjectURL(preview.data);
		setAudio(url);
		return () => URL.revokeObjectURL(url);
	}, [preview.data]);
	const labels = { text: tx("speech.text"), both: tx("speech.both"), voice: tx("speech.voice") };
	const options = (["text", "both", "voice"] as const).map((value) => ({
		value,
		label: labels[value],
		color: AI_PURPLE,
	}));
	const native = isDeepSeekSpeechEndpoint(speech.baseUrl);
	const ready =
		Boolean(
			saved?.baseUrl &&
				(native || saved.model) &&
				(native ? saved.apiKey && ["stella", "tide"].includes(saved.voice) : saved.voice),
		) &&
		(["baseUrl", "apiKey", "model", "voice"] as const).every((key) => speech[key] === saved?.[key]);
	return (
		<div className="flex flex-col gap-4">
			<GlassBox title={tx("speech.service")} accent={AI_PURPLE} icon={<Icon.link size={14} />}>
				<Field code="ai.speech.baseUrl" hint={tx("deepseek.speechEndpoint")} full>
					<TInput
						value={speech.baseUrl}
						onChange={(baseUrl) => {
							const nextOrigin = originOf(baseUrl);
							const previousOrigin = originOf(speech.baseUrl) ?? originOf(saved?.baseUrl);
							const changedService = previousOrigin && nextOrigin && previousOrigin !== nextOrigin;
							onChange({
								...speech,
								baseUrl,
								...(changedService ? { apiKey: "" } : {}),
								...(isDeepSeekSpeechEndpoint(baseUrl) && !["stella", "tide"].includes(speech.voice)
									? { voice: "stella" }
									: {}),
							});
						}}
						placeholder="https://api.openai.com/v1"
					/>
				</Field>
				<Field code="ai.speech.apiKey" full>
					<DraftSecretInput
						value={speech.apiKey}
						saved={
							originOf(saved?.baseUrl) === originOf(speech.baseUrl) ? saved?.apiKey : undefined
						}
						onChange={(apiKey) => onChange({ ...speech, apiKey })}
					/>
				</Field>
				{!native && (
					<Field code="ai.speech.model">
						<TInput
							value={speech.model}
							onChange={(model) => onChange({ ...speech, model })}
							placeholder="gpt-4o-mini-tts"
						/>
					</Field>
				)}
				<Field code="ai.speech.voice">
					{native ? (
						<Picker
							value={speech.voice}
							options={[
								{ value: "stella", label: tx("deepseek.speechStella"), color: AI_PURPLE },
								{ value: "tide", label: tx("deepseek.speechTide"), color: AI_PURPLE },
							]}
							onChange={(voice) => onChange({ ...speech, voice })}
						/>
					) : (
						<TInput
							value={speech.voice}
							onChange={(voice) => onChange({ ...speech, voice })}
							placeholder="alloy"
						/>
					)}
				</Field>
				<div className="flex flex-wrap items-center gap-3">
					<Btn
						size="sm"
						variant="outline"
						disabled={!ready || preview.isPending}
						onClick={() => preview.mutate(serviceId)}
					>
						{tx("speech.preview")}
					</Btn>
					{!ready ? (
						<span className="text-bn-xs text-bn-text-secondary">{tx("speech.saveFirst")}</span>
					) : null}
					{audio &&
					ready &&
					preview.variables === serviceId &&
					!preview.isPending &&
					!preview.isError ? (
						<audio controls src={audio} aria-label={tx("speech.preview")}>
							<track
								kind="captions"
								label={tx("speech.preview")}
								src={`data:text/vtt;charset=utf-8,${encodeURIComponent(`WEBVTT\n\n00:00:00.000 --> 00:01:00.000\n${tx("speech.sample")}`)}`}
							/>
						</audio>
					) : null}
					{preview.error && ready && preview.variables === serviceId ? (
						<ErrorNote>{preview.error.message}</ErrorNote>
					) : null}
				</div>
			</GlassBox>
			<GlassBox
				title={tx("speech.delivery")}
				subtitle={tx("speech.detail")}
				accent={AI_PURPLE}
				icon={<Icon.feather size={14} />}
			>
				<fieldset
					aria-label={tx("speech.default")}
					data-code="ai.speech.mode"
					className="mb-4 min-w-0 border-0 p-0"
				>
					<legend className="mb-2 text-bn-sm font-semibold">{tx("speech.default")}</legend>
					<Picker
						value={speech.mode}
						options={options}
						onChange={(mode) => onChange({ ...speech, mode })}
					/>
				</fieldset>
				{targets.isError || connections.isError ? (
					<ErrorNote>
						{tx("aiWriting.failed")}{" "}
						<Btn
							size="sm"
							onClick={() => {
								void targets.refetch();
								void connections.refetch();
							}}
						>
							{tx("aiWriting.retry")}
						</Btn>
					</ErrorNote>
				) : targets.isPending || connections.isPending ? (
					<LoadingBlock variant="inset" label={tx("aiWriting.loading")} />
				) : targets.data.length === 0 ? (
					<EmptyNote size="sm">{tx("speech.empty")}</EmptyNote>
				) : (
					<TargetExceptions
						targets={targets.data}
						connections={connections.data}
						color={AI_PURPLE}
						expandLabel={tx("aiWriting.expand")}
						collapseLabel={tx("aiWriting.collapse")}
						summary={tx("aiWriting.exceptions")}
						renderCells={(target) => (
							<div data-code={`ai.speech.byTarget.${target.id}`}>
								<Picker<Speech["mode"] | "inherit">
									value={speech.byTarget[target.id] ?? "inherit"}
									options={[
										{
											value: "inherit",
											label: tx("aiWriting.inherit", { value: labels[speech.mode] }),
											color: AI_PURPLE,
										},
										...options,
									]}
									onChange={(value) => {
										const byTarget = { ...speech.byTarget };
										if (value === "inherit") delete byTarget[target.id];
										else byTarget[target.id] = value;
										onChange({ ...speech, byTarget });
									}}
								/>
							</div>
						)}
					/>
				)}
			</GlassBox>
		</div>
	);
}
