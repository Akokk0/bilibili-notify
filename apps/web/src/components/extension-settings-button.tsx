import { Icon, IconButton } from "@bilibili-notify/ui";
import { useNavigate } from "react-router-dom";
import { useExtensions } from "../hooks/useExtensions";
import { useT } from "../i18n";

/** Resolve ownership independently of the extension's runtime state. */
export function ExtensionSettingsButton({ id }: { id: string }) {
	const { data } = useExtensions();
	const extension = data?.extensions?.find((entry) => entry.id === id);
	return extension ? (
		<InstalledExtensionSettingsButton id={extension.id} name={extension.name} />
	) : null;
}

function InstalledExtensionSettingsButton({ id, name }: { id: string; name: string }) {
	const t = useT();
	const navigate = useNavigate();
	return (
		<IconButton
			icon={<Icon.extension size={16} />}
			label={t("extensionSettings.link", { name })}
			size="lg"
			shape="pill"
			surface="filled"
			onClick={(event) => {
				event.stopPropagation();
				navigate(`/extensions/${encodeURIComponent(id)}`);
			}}
			onKeyDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => event.stopPropagation()}
			onContextMenu={(event) => event.stopPropagation()}
			className="active:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bn-pink"
		/>
	);
}
