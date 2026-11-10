import { useEffect, useRef } from "preact/hooks";
import { attachContainer, boot } from "../controller";
import {
	editor,
	embed,
	historyPanelOpen,
	layerPanelOpen,
	loadError,
} from "../state";
import { uploadOpen } from "../upload";
import { FeatureEditor } from "./FeatureEditor";
import { FeatureHistory, featureHistoryFor } from "./FeatureHistory";
import { HistoryBanner } from "./HistoryBanner";
import { HistoryPanel } from "./HistoryPanel";
import { LayerPanel } from "./LayerPanel";
import { Popup } from "./Popup";
import { StatusBar } from "./StatusBar";
import { Toast } from "./Toast";
import { Toolbar } from "./Toolbar";
import { Tooltip } from "./Tooltip";
import { UploadDialog } from "./UploadDialog";

function SidePanel() {
	const target = editor.value;
	if (target) {
		const key = `${target.mode}-${target.layerId}-${target.mode === "edit" ? target.featureId : 0}`;
		return <FeatureEditor key={key} />;
	}
	if (historyPanelOpen.value) return <HistoryPanel />;
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
					<HistoryBanner />
					<StatusBar />
					<Tooltip />
					{uploadOpen.value && <UploadDialog />}
					{featureHistoryFor.value && <FeatureHistory />}
				</>
			)}
			<Toast />
		</div>
	);
}
