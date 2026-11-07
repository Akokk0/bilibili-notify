import type { InvalidSettingView } from "@bilibili-notify/contract";
import { Btn, ErrorNote, WarnNote } from "@bilibili-notify/ui";
import { useInvalidSettings } from "../hooks/useInvalidSettings";
import { useT } from "../i18n";

/** Only the server's safe projection is rendered; secret cells never get a value view. */
function InvalidSettingsNote({ entries }: { entries: readonly InvalidSettingView[] }) {
	const t = useT();
	if (entries.length === 0) return null;
	return (
		<WarnNote className="space-y-3">
			<p className="font-semibold">{t("invalidSettings.title")}</p>
			<p>{t("invalidSettings.help")}</p>
			<ul className="space-y-3">
				{entries.map((entry) => (
					<li key={JSON.stringify(entry.path)} className="min-w-0 space-y-1">
						<code className="break-all">{entry.path.join(".") || t("invalidSettings.file")}</code>
						{entry.secret ? (
							<p>{t("invalidSettings.secret")}</p>
						) : (
							<>
								<p>{t("invalidSettings.original")}</p>
								<pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-bn-sm bg-bn-surface/60 p-2 text-bn-xs">
									{entry.missing
										? t("invalidSettings.missing")
										: JSON.stringify(entry.raw, null, 2)}
								</pre>
							</>
						)}
						<ul className="space-y-1">
							{Array.from(
								new Map(
									entry.issues.map((issue) => [JSON.stringify([issue.path, issue.message]), issue]),
								),
							).map(([key, issue]) => (
								<li key={key}>
									{issue.path?.length ? (
										<code className="mr-1 break-all">{issue.path.join(".")}</code>
									) : null}
									<span>{issue.message}</span>
								</li>
							))}
						</ul>
					</li>
				))}
			</ul>
		</WarnNote>
	);
}

export function InvalidSettingsPanel({ path }: { path: string }) {
	const t = useT();
	const query = useInvalidSettings(path);
	if (query.error)
		return (
			<ErrorNote>
				{t("invalidSettings.loadFailed", { reason: query.error.message })}
				<Btn variant="outline" size="sm" onClick={() => void query.refetch()}>
					{t("invalidSettings.retry")}
				</Btn>
			</ErrorNote>
		);
	return <InvalidSettingsNote entries={query.data?.entries ?? []} />;
}
