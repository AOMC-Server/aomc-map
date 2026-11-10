import { useEffect, useRef } from "preact/hooks";
import { attachContainer, boot } from "../controller";
import { editor, embed, layerPanelOpen, loadError } from "../state";
import { FeatureEditor } from "./FeatureEditor";
import { LayerPanel } from "./LayerPanel";
import { Popup } from "./Popup";
import { StatusBar } from "./StatusBar";
import { Toast } from "./Toast";
import { Toolbar } from "./Toolbar";
import { Tooltip } from "./Tooltip";

function SidePanel() {
	const target = editor.value;
	if (target) {
		const key = `${target.mode}-${target.layerId}-${target.mode === "edit" ? target.featureId : 0}`;
		return <FeatureEditor key={key} />;
	}
	return layerPanelOpen.value ? <LayerPanel /> : null;
}

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
			<Popup />
			{!embed.value && (
				<>
					<Toolbar />
					<SidePanel />
					<StatusBar />
					<Tooltip />
				</>
			)}
			<Toast />
		</div>
	);
}
