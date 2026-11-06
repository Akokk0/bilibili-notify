import type { GlobalConfigView } from "@bilibili-notify/contract";
import { DEFAULT_VOICE, LOCALES, type Locale, type Voice } from "@bilibili-notify/internal/i18n";
import { GlassBox, Icon } from "@bilibili-notify/ui";
import { Field, Picker, TInput } from "../../components/forms";
import { useT, useTextOptions } from "../../i18n";
import type { GlobalConfigPatch } from "../../types/globals";

/** 只编辑系统共用草稿；保存成功之前不切全局字典或浏览器偏好。 */
export function PreferencesSection({
	draft,
	onPatch,
}: {
	draft: GlobalConfigView;
	onPatch: (patch: GlobalConfigPatch) => void;
}) {
	const t = useT();
	const textOptions = useTextOptions();
	const locale = draft.locale ?? textOptions.locale;
	const locales: Record<Locale, string> = {
		"zh-CN": t("preferences.locale.zhCN"),
		"zh-TW": t("preferences.locale.zhTW"),
		en: t("preferences.locale.en"),
		ja: t("preferences.locale.ja"),
	};
	const voices: Record<Voice, string> = {
		maid: t("preferences.voice.maid"),
		plain: t("preferences.voice.plain"),
	};
	return (
		<GlassBox
			title={t("preferences.title")}
			subtitle={t("preferences.subtitle")}
			icon={<Icon.globe size={14} />}
		>
			<Field code="core.locale" full>
				<fieldset aria-label={t("preferences.locale.label")}>
					<Picker
						value={locale}
						onChange={(locale) => onPatch({ locale })}
						options={LOCALES.map((value) => ({ value, label: locales[value] }))}
					/>
				</fieldset>
			</Field>
			{textOptions.maidLocales.includes(locale) ? (
				<Field code="core.voice" full>
					<fieldset aria-label={t("preferences.voice.label")}>
						<Picker<Voice>
							value={draft.voice ?? DEFAULT_VOICE}
							onChange={(voice) => onPatch({ voice: voice === DEFAULT_VOICE ? null : voice })}
							options={[
								{ value: "maid", label: voices.maid },
								{ value: "plain", label: voices.plain },
							]}
						/>
					</fieldset>
				</Field>
			) : null}
			<Field code="core.timezone" full>
				<TInput
					value={draft.timezone}
					onChange={(timezone) => onPatch({ timezone })}
					ariaLabel={t("preferences.timezone.label")}
					placeholder="Asia/Shanghai"
					mono
				/>
			</Field>
		</GlassBox>
	);
}
