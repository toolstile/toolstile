import { CaretRightIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useState } from "react";
import { dashboardStyles as styles } from "./Dashboard.styles";

/** Collapsed section for optional fields; open state is transient UI state. */
export function Disclosure({
	summary,
	children,
	compact = false,
}: {
	summary: string;
	children: ReactNode;
	compact?: boolean;
}) {
	const [open, setOpen] = useState(false);
	return (
		<details
			{...stylex.props(styles.disclosure, compact && spacing.compact)}
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary {...stylex.props(styles.disclosureSummary)}>
				<CaretRightIcon
					size={14}
					aria-hidden="true"
					{...stylex.props(
						styles.disclosureIcon,
						open && styles.disclosureIconOpen,
					)}
				/>
				{summary}
			</summary>
			<div
				{...stylex.props(
					styles.disclosureBody,
					open && styles.disclosureBodyOpen,
				)}
			>
				{children}
			</div>
		</details>
	);
}

const spacing = stylex.create({ compact: { marginBlock: 0 } });
