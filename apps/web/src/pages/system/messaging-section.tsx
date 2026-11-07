import type { ConnectionCapabilitiesMap, SettingsResponse } from "@bilibili-notify/contract";
import { CommandsSettings } from "../../components/commands-settings";
import { LinkPreviewSettings } from "../../components/link-preview-settings";
import type { Connection, PushTarget } from "../../types/domain";
import type { GlobalSettingsPatch } from "../../types/globals";

export function MessagingSection({
	draft,
	targets,
	connections,
	capabilities,
	onPatch,
}: {
	draft: SettingsResponse | null;
	targets: PushTarget[];
	connections: Connection[];
	capabilities: ConnectionCapabilitiesMap;
	onPatch: (delta: GlobalSettingsPatch) => void;
}) {
	return (
		<>
			{draft ? <CommandsSettings draft={draft.core} onPatch={onPatch} /> : null}

			{draft ? (
				<LinkPreviewSettings
					draft={draft.core}
					onPatch={onPatch}
					targets={targets}
					connections={connections}
					capabilities={capabilities}
				/>
			) : null}
		</>
	);
}
