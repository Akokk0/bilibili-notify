import { Btn, ErrorNote, Icon, MenuItem } from "@bilibili-notify/ui";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { api } from "../../services/api";

export interface DeepSeekInputs {
	scope: string;
	files: boolean;
	append: (text: string) => void;
	onDocument: (file: File) => void;
}

const picks = {
	document: ".pdf,.doc,.docx,.ppt,.pptx,.xlsx,.xls,.csv,.md,.txt,.json,.epub,.mobi",
	ocr: ".pdf,.doc,.docx,.ppt,.pptx,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tiff",
	asr: ".wav,.ogg,.opus",
} as const;

// Browsers normally record WebM or MP4. ASR accepts Ogg Opus or 16-bit PCM WAV.
async function recordedFile(chunks: Blob[], type: string): Promise<File> {
	const blob = new Blob(chunks, { type });
	if (type.startsWith("audio/ogg")) return new File([blob], "recording.ogg", { type });
	const decoder = new AudioContext({ sampleRate: 16000 });
	try {
		const audio = await decoder.decodeAudioData(await blob.arrayBuffer());
		const samples = audio.getChannelData(0);
		const wav = new ArrayBuffer(44 + samples.length * 2);
		const view = new DataView(wav);
		const label = (at: number, text: string) =>
			new Uint8Array(wav, at, text.length).set(new TextEncoder().encode(text));
		label(0, "RIFF");
		view.setUint32(4, wav.byteLength - 8, true);
		label(8, "WAVEfmt ");
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 1, true);
		view.setUint32(24, audio.sampleRate, true);
		view.setUint32(28, audio.sampleRate * 2, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		label(36, "data");
		view.setUint32(40, samples.length * 2, true);
		for (let i = 0; i < samples.length; i++)
			view.setInt16(
				44 + i * 2,
				Math.max(-1, Math.min(1, samples[i])) * (samples[i] < 0 ? 32768 : 32767),
				true,
			);
		return new File([wav], "recording.wav", { type: "audio/wav" });
	} finally {
		await decoder.close();
	}
}

export function useDeepSeekInputs(config: DeepSeekInputs | undefined, close: () => void) {
	const tx = useT();
	const controls = useRef<Partial<Record<keyof typeof picks, HTMLInputElement | null>>>({});
	const session = useRef(0);
	const request = useRef<AbortController | null>(null);
	const recorder = useRef<MediaRecorder | null>(null);
	const [state, setState] = useState<"idle" | "working" | "recording">("idle");
	const [error, setError] = useState("");
	// Cancellation belongs to the attachment operation; a changed profile never remounts the text input.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new draft scope invalidates pending work.
	useEffect(() => {
		setState("idle");
		setError("");
		return () => {
			session.current++;
			request.current?.abort();
			if (recorder.current?.state === "recording") recorder.current.stop();
		};
	}, [config?.scope]);
	async function recognize(kind: "ocr" | "asr", file: File, version: number) {
		if (version !== session.current || !config) return;
		setState("working");
		const controller = new AbortController();
		request.current = controller;
		const form = new FormData();
		form.set("file", file);
		try {
			const result = await api.upload<{ text: string }>(
				`/api/ai/tools/${kind}`,
				form,
				controller.signal,
			);
			if (version === session.current) config.append(result.text);
		} catch (e) {
			if (version === session.current) setError(e instanceof Error ? e.message : String(e));
		} finally {
			if (version === session.current) {
				request.current = null;
				setState("idle");
			}
		}
	}
	async function record() {
		close();
		setError("");
		setState("working");
		const version = ++session.current;
		let stream: MediaStream | undefined;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (version !== session.current) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			const rec = new MediaRecorder(stream);
			recorder.current = rec;
			const chunks: Blob[] = [];
			rec.ondataavailable = (e) => {
				if (e.data.size) chunks.push(e.data);
			};
			const timeout = window.setTimeout(() => {
				if (rec.state === "recording") rec.stop();
			}, 118000);
			rec.onstop = async () => {
				clearTimeout(timeout);
				for (const track of rec.stream.getTracks()) track.stop();
				if (recorder.current === rec) recorder.current = null;
				if (version !== session.current) return;
				setState("working");
				try {
					await recognize("asr", await recordedFile(chunks, rec.mimeType), version);
				} catch (e) {
					if (version === session.current) {
						setError(e instanceof Error ? e.message : String(e));
						setState("idle");
					}
				}
			};
			rec.start();
			setState("recording");
		} catch (e) {
			for (const track of stream?.getTracks() ?? []) track.stop();
			if (version === session.current) {
				setError(e instanceof Error ? e.message : String(e));
				setState("idle");
			}
		}
	}
	const labels = {
		document: tx("deepseek.document"),
		asr: tx("deepseek.asr"),
		ocr: tx("deepseek.ocr"),
	};
	const kinds = (Object.keys(picks) as (keyof typeof picks)[]).filter(
		(k) => k !== "document" || config?.files,
	);
	return {
		pending: state !== "idle",
		menu: config && (
			<>
				{kinds.map((kind) => (
					<MenuItem
						key={kind}
						role="menuitem"
						disabled={state !== "idle"}
						icon={kind === "asr" ? <Icon.waveform size={16} /> : <Icon.folder size={16} />}
						onClick={() => {
							controls.current[kind]?.click();
							close();
						}}
					>
						{labels[kind]}
					</MenuItem>
				))}
				{typeof MediaRecorder !== "undefined" &&
					typeof navigator.mediaDevices?.getUserMedia === "function" && (
						<MenuItem
							role="menuitem"
							disabled={state !== "idle"}
							icon={<Icon.mic size={16} />}
							onClick={() => void record()}
						>
							{tx("deepseek.record")}
						</MenuItem>
					)}
			</>
		),
		inputs: config && (
			<>
				{kinds.map((kind) => (
					<input
						key={kind}
						type="file"
						hidden
						ref={(el) => {
							controls.current[kind] = el;
						}}
						accept={picks[kind]}
						aria-label={labels[kind]}
						onChange={(e) => {
							const file = e.target.files?.[0];
							e.target.value = "";
							if (!file) return;
							setError("");
							if (file.size > (kind === "asr" ? 8 : 16) * 1024 * 1024) {
								setError(tx("deepseek.tooLarge"));
								return;
							}
							if (kind === "document") config.onDocument(file);
							else void recognize(kind, file, ++session.current);
						}}
					/>
				))}
				{state === "recording" && (
					<Btn size="sm" onClick={() => recorder.current?.stop()}>
						{tx("deepseek.stop")}
					</Btn>
				)}
				{state === "working" && (
					<span role="status" className="text-bn-xs text-bn-text-secondary">
						{tx("deepseek.working")}
					</span>
				)}
				{error && <ErrorNote>{error}</ErrorNote>}
			</>
		),
	};
}
