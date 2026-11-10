import { notice } from "../state";

export function Toast() {
	const n = notice.value;
	if (!n) return null;
	return (
		<div
			class={`toast ${n.kind}`}
			role={n.kind === "error" ? "alert" : "status"}
		>
			{n.text}
		</div>
	);
}
