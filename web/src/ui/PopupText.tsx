import { Fragment } from "preact";
import { parseText } from "./markdown";

/** Renders popup text through the markup subset as Preact elements; no HTML is ever injected. */
export function PopupText(props: { text: string }) {
	const lines = parseText(props.text);
	return (
		<div class="popup-text">
			{lines.map((line, i) => (
				<Fragment key={i}>
					{i > 0 && <br />}
					{line.map((part, j) =>
						part.kind === "bold" ? (
							<strong key={j}>{part.text}</strong>
						) : part.kind === "link" ? (
							<a
								key={j}
								href={part.href}
								target="_blank"
								rel="noopener noreferrer nofollow"
							>
								{part.text}
							</a>
						) : (
							part.text
						),
					)}
				</Fragment>
			))}
		</div>
	);
}
