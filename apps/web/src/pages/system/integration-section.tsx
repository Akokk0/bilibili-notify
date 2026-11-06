import type {
	IntegrationIdentityResetResponse,
	IntegrationSettingsDescriptor,
	SettingsResponse,
	SettingsScalarField,
} from "@bilibili-notify/contract";
import {
	Btn,
	ConfirmDialog,
	ErrorNote,
	GlassBox,
	HintNote,
	Icon,
	KindMark,
} from "@bilibili-notify/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Field } from "../../components/forms";
import { SettingsFieldControl } from "../../components/settings-field-control";
import { i18n, useT } from "../../i18n";
import { api } from "../../services/api";
import { useDraftStore } from "../../store/draft";
import type { SettingsPatch } from "../../types/globals";
import { clientErrorOf, decimalOf } from "../../utils/settings-field-validation";

function valuesOf(settings: SettingsResponse, key: string): Record<string, unknown> {
	const value = settings[key];
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function editOf(field: SettingsScalarField, value: unknown): string | boolean {
	if (field.type === "boolean") return value === true;
	return typeof value === "string" || typeof value === "number"
		? String(value)
		: String(field.default ?? "");
}

export function integrationDraftIssue(
	descriptors: readonly IntegrationSettingsDescriptor[],
	draft: SettingsResponse,
	baseline: SettingsResponse,
): string | undefined {
	for (const descriptor of descriptors) {
		const values = valuesOf(draft, descriptor.key),
			previous = valuesOf(baseline, descriptor.key);
		for (const field of descriptor.fields) {
			if (Object.is(values[field.key], previous[field.key])) continue;
			if (field.type === "list") return i18n.t("integrationSettings.unsupported");
			const error = clientErrorOf(field, editOf(field, values[field.key]));
			if (error) return `${field.label}: ${error}`;
		}
	}
}

/** One description-driven section; draft state remains owned by System across navigation. */
export function IntegrationSection({
	descriptor,
	draft,
	onPatch,
}: {
	descriptor: IntegrationSettingsDescriptor;
	draft: SettingsResponse;
	onPatch: (patch: SettingsPatch) => void;
}) {
	const t = useT();
	const values = valuesOf(draft, descriptor.key);
	const [confirming, setConfirming] = useState(false);
	const dirty = useDraftStore((state) => (state.current?.diff.length ?? 0) > 0);
	const reset = useMutation({
		mutationFn: async () => {
			if ((useDraftStore.getState().current?.diff.length ?? 0) > 0)
				throw new Error(t("integrationSettings.dirty"));
			const result = await api.post<IntegrationIdentityResetResponse>(
				`/api/settings/integrations/${encodeURIComponent(descriptor.key)}/reset-identity`,
			);
			if (!result.ok) throw new Error(result.message);
		},
	});
	return (
		<>
			<GlassBox
				title={descriptor.label}
				subtitle={t("integrationSettings.subtitle")}
				badge={descriptor.key}
				mark={
					descriptor.icon ? (
						<KindMark text={descriptor.label} logo={descriptor.icon} size={32} />
					) : undefined
				}
				icon={<Icon.sliders size={14} />}
			>
				{descriptor.fields.map((field) => {
					if (field.type === "list")
						return <ErrorNote key={field.key}>{t("integrationSettings.unsupported")}</ErrorNote>;
					const value = editOf(field, values[field.key]);
					return (
						<Field
							key={field.key}
							code={`${descriptor.key}.${field.key}`}
							label={field.label}
							hint={field.description}
							required={field.required}
							fromDescriptor
						>
							<div className="min-w-0">
								<SettingsFieldControl
									field={field}
									value={value}
									onChange={(next) =>
										onPatch({
											[descriptor.key]: {
												[field.key]:
													field.type === "number" && typeof next === "string"
														? (decimalOf(next) ?? next)
														: next,
											},
										})
									}
								/>
								{clientErrorOf(field, value) ? (
									<ErrorNote size="sm" className="mt-2">
										{clientErrorOf(field, value)}
									</ErrorNote>
								) : null}
							</div>
						</Field>
					);
				})}
			</GlassBox>
			{descriptor.identityReset ? (
				<GlassBox
					title={t("integrationSettings.identityTitle")}
					subtitle={t("integrationSettings.identityHint")}
					icon={<Icon.refresh size={14} />}
				>
					<Btn
						variant="outline"
						disabled={dirty || reset.isPending}
						onClick={() => setConfirming(true)}
					>
						{t("integrationSettings.reset")}
					</Btn>
					{dirty ? <HintNote className="mt-3">{t("integrationSettings.dirty")}</HintNote> : null}
					{reset.isSuccess ? (
						<HintNote className="mt-3">{t("integrationSettings.resetDone")}</HintNote>
					) : null}
					{reset.error ? <ErrorNote className="mt-3">{reset.error.message}</ErrorNote> : null}
				</GlassBox>
			) : null}
			{confirming ? (
				<ConfirmDialog
					title={t("integrationSettings.resetConfirm")}
					message={t("integrationSettings.identityHint")}
					confirmLabel={t("integrationSettings.reset")}
					onCancel={() => setConfirming(false)}
					onConfirm={() => {
						setConfirming(false);
						reset.mutate();
					}}
				/>
			) : null}
		</>
	);
}
