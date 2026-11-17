import { Btn, GlassBox, Icon, TArea } from "@bilibili-notify/ui";
import { useEffect, useState } from "react";
import { Field } from "../../components/forms";
import { useT } from "../../i18n";

const entries = (value: string) =>
	value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

export function ImageNetworkSettings({
	ranges,
	onChange,
}: {
	ranges: readonly string[];
	onChange: (ranges: string[]) => void;
}) {
	const t = useT();
	const [text, setText] = useState(ranges.join("\n"));
	useEffect(() => {
		setText((value) =>
			JSON.stringify(entries(value)) === JSON.stringify(ranges) ? value : ranges.join("\n"),
		);
	}, [ranges]);
	const change = (value: string) => {
		setText(value);
		onChange(entries(value));
	};
	return (
		<GlassBox
			title={t("network.images.title")}
			subtitle={t("network.images.subtitle")}
			accent="var(--color-bn-blue)"
			icon={<Icon.link size={14} />}
			badge="core"
		>
			<Field code="core.network.imageAllowedCidrs" full>
				<TArea
					value={text}
					onChange={change}
					rows={3}
					mono
					ariaLabel={t("network.images.label")}
					placeholder="198.18.0.0/16"
				/>
				<div className="mt-2">
					<Btn
						variant="outline"
						size="sm"
						onClick={() => {
							const next = entries(text);
							if (!next.includes("198.18.0.0/16")) next.push("198.18.0.0/16");
							change(next.join("\n"));
						}}
					>
						{t("network.images.preset")}
					</Btn>
				</div>
			</Field>
		</GlassBox>
	);
}
