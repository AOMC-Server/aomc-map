import { useEffect, useRef } from "preact/hooks";
import { selectDimension } from "../controller";
import { currentMap, dimSlug, visibleDimensions } from "../state";
import { BlockIcon } from "./icons";
import { LoginButton } from "./LoginButton";

/** Map title, dimension picker and account, along the top edge. Tools live in the hotbar. */
export function Toolbar() {
	const detail = currentMap.value;
	const dims = visibleDimensions.value;
	const ref = useRef<HTMLElement>(null);

	// The bar wraps on narrow screens; panels and the boss bar position themselves below it.
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const publish = () =>
			document.documentElement.style.setProperty(
				"--toolbar-h",
				`${el.offsetHeight}px`,
			);
		publish();
		const observer = new ResizeObserver(publish);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	return (
		<header class="topbar" ref={ref}>
			<div class="topbar-left">
				{detail && <h1 class="map-title sign">{detail.map.name}</h1>}
				<div class="dimensions" role="tablist" aria-label="Dimension">
					{dims.map((d) => {
						const active = d.slug === dimSlug.value;
						return (
							<button
								key={d.slug}
								type="button"
								role="tab"
								aria-selected={active}
								title={d.name}
								class={`btn dim ${active ? "active" : ""}`}
								onClick={() => selectDimension(d.slug)}
							>
								<BlockIcon slug={d.slug} />
								<span class="dim-name">{d.name}</span>
							</button>
						);
					})}
				</div>
			</div>
			<LoginButton />
		</header>
	);
}
