import { useEffect, useRef } from "preact/hooks";
import { boot } from "../controller";
import { editor, embed, loadError, sidePanel } from "../state";
import { uploadOpen } from "../upload";
import { FeatureEditor } from "./FeatureEditor";
import { FeatureHistory, featureHistoryFor } from "./FeatureHistory";
import { HistoryBanner } from "./HistoryBanner";
import { HistoryPanel } from "./HistoryPanel";
import { LayerPanel } from "./LayerPanel";
import { LayerSharing, layerSharingFor } from "./LayerSharing";
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
	switch (sidePanel.value) {
		case "layers":
			return <LayerPanel />;
		case "history":
			return <HistoryPanel />;
		default:
			return null;
	}
}

export function App() {
	const host = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (host.current) void boot(host.current);
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
					{layerSharingFor.value && <LayerSharing />}
				</>
			)}
			<Toast />
		</div>
	);
}
