import { useEffect, useRef } from "preact/hooks";
import { attachContainer, boot } from "../controller";
import { embed, loadError } from "../state";
import { StatusBar } from "./StatusBar";
import { Toolbar } from "./Toolbar";

export function App() {
	const host = useRef<HTMLDivElement>(null);

	useEffect(() => {
		attachContainer(host.current);
		void boot();
		return () => attachContainer(null);
	}, []);

	return (
		<div class={`app ${embed.value ? "embed" : ""}`}>
			<div class="map-host" ref={host} />
			{loadError.value && <div class="load-error">{loadError.value}</div>}
			{!embed.value && (
				<>
					<Toolbar />
					<StatusBar />
				</>
			)}
		</div>
	);
}
