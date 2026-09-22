/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import ErrorBoundary from "@components/ErrorBoundary";
import { settings } from "@plugins/imageZoom";
import { ELEMENT_ID } from "@plugins/imageZoom/constants";
import { waitFor } from "@plugins/imageZoom/utils/waitFor";
import { classNameFactory } from "@utils/css";
import { FluxDispatcher, useLayoutEffect, useMemo, useRef, useState } from "@webpack/common";

interface Vec2 {
    x: number,
    y: number;
}

export interface MagnifierProps {
    zoom: number;
    size: number,
    instance: any;
}

const cl = classNameFactory("vc-imgzoom-");

const MAX_IMAGE_SCALE = 15;

// Persists the whole-image zoom across Magnifier remounts so that clicks,
// re-renders, and updates don't reset it while the plugin is active.
let fullZoomScale = 1;
let fullZoomSrc: string | null = null;
let fullZoomOffset = { x: 0, y: 0 };
export const Magnifier = ErrorBoundary.wrap<MagnifierProps>(({ instance, size: initialSize, zoom: initalZoom }) => {
    const [ready, setReady] = useState(false);

    const [lensPosition, setLensPosition] = useState<Vec2>({ x: 0, y: 0 });
    const [imagePosition, setImagePosition] = useState<Vec2>({ x: 0, y: 0 });
    const [opacity, setOpacity] = useState(0);

    const isShiftDown = useRef(false);

    const zoom = useRef(initalZoom);
    const size = useRef(initialSize);

    // carry the whole-image zoom across remounts, but only for the same image
    const imageSrc = useMemo(() => {
        try {
            const imageUrl = new URL(instance.props.src);
            if (imageUrl.pathname.startsWith("/attachments/"))
                imageUrl.hostname = "cdn.discordapp.com";

            imageUrl.searchParams.set("animated", "true");
            return imageUrl.toString();
        } catch {
            return instance.props.src;
        }
    }, [instance.props.src]);
    if (fullZoomSrc !== imageSrc) {
        fullZoomSrc = imageSrc;
        fullZoomScale = 1;
        fullZoomOffset = { x: 0, y: 0 };
    }
    const scale = useRef(fullZoomScale);
    const panOffset = useRef(fullZoomOffset);
    const dragStart = useRef<{ x: number, y: number } | null>(null);

    const element = useRef<HTMLDivElement | null>(null);
    const currentVideoElementRef = useRef<HTMLVideoElement | null>(null);
    const originalVideoElementRef = useRef<HTMLVideoElement | null>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);

    // since we accessing document im gonna use useLayoutEffect
    useLayoutEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Shift") {
                isShiftDown.current = true;
            }
        };
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.key === "Shift") {
                isShiftDown.current = false;
            }
        };
        const syncVideos = () => {
            if (currentVideoElementRef.current && originalVideoElementRef.current)
                currentVideoElementRef.current.currentTime = originalVideoElementRef.current.currentTime;
        };

        const showLens = () => setOpacity(1);

        const hideLens = () => setOpacity(0);

        const applyTransform = () => {
            if (!element.current) return;
            if (settings.store.fullZoom && (scale.current !== 1 || panOffset.current.x || panOffset.current.y)) {
                element.current.style.transformOrigin = "0 0";
                element.current.style.transform = `translate(${panOffset.current.x}px, ${panOffset.current.y}px) scale(${scale.current})`;
            } else {
                element.current.style.transform = "";
            }
        };

        const resetImageZoom = (persist = false) => {
            if (element.current) element.current.style.transform = "";
            scale.current = 1;
            panOffset.current = { x: 0, y: 0 };
            // when persisting (component unmount/remount), keep the zoom value across remounts;
            // otherwise (mouse leaving the image) clear it so the zoom actually resets
            if (!persist) fullZoomScale = 1;
            fullZoomOffset = { x: 0, y: 0 };
        };

        const zoomImage = (e: WheelEvent, delta: number, direction: number) => {
            if (!element.current) return;

            const rect = element.current.getBoundingClientRect();
            const S_old = scale.current;
            const S_new = Math.min(Math.max(S_old + (delta / 100 * direction) * settings.store.zoomSpeed, 1), MAX_IMAGE_SCALE);

            // keep the point under the cursor fixed by adjusting the translate
            const localX = (e.clientX - rect.left - panOffset.current.x) / S_old;
            const localY = (e.clientY - rect.top - panOffset.current.y) / S_old;
            panOffset.current = {
                x: panOffset.current.x + localX * (S_old - S_new),
                y: panOffset.current.y + localY * (S_old - S_new),
            };

            scale.current = S_new;
            fullZoomScale = S_new;
            fullZoomOffset = panOffset.current;
            applyTransform();
        };

        const updateMousePosition = (e: MouseEvent) => {
            if (!element.current) return;

            // in full-zoom mode, dragging pans the (already zoomed) whole image.
            // this must run even when the cursor moves off the element, since panning
            // does exactly that
            if (settings.store.fullZoom && dragStart.current) {
                const dx = e.clientX - dragStart.current.x;
                const dy = e.clientY - dragStart.current.y;
                panOffset.current = { x: fullZoomOffset.x + dx, y: fullZoomOffset.y + dy };
                applyTransform();
                return;
            }

            if (!instance.state.mouseOver) {
                if (!settings.store.fullZoom) setOpacity(0);
                return;
            }

            const offset = size.current / 2;
            const pos = { x: e.pageX, y: e.pageY };

            // find the position in the ORIGINAL (unscaled) image so the lens keeps a
            // fixed magnification even while the whole image is zoomed with scroll
            const rect = element.current.getBoundingClientRect();
            const sc = Math.max(scale.current, 1);
            const localX = (pos.x - rect.left) / sc;
            const localY = (pos.y - rect.top) / sc;
            const x = -(localX * zoom.current - offset);
            const y = -(localY * zoom.current - offset);
            setLensPosition({ x: e.x - offset, y: e.y - offset });
            setImagePosition({ x, y });
        };

        const onMouseDown = (e: MouseEvent) => {
            if (instance.state.mouseOver && e.button === 0 /* left click */) {
                zoom.current = settings.store.zoom;
                size.current = settings.store.size;

                // close context menu if open
                if (document.getElementById("image-context")) {
                    FluxDispatcher.dispatch({ type: "CONTEXT_MENU_CLOSE" });
                }

                if (settings.store.fullZoom) {
                    // start a drag-pan only if the image is actually zoomed in
                    if (scale.current !== 1) {
                        dragStart.current = { x: e.clientX, y: e.clientY };
                    }
                } else {
                    updateMousePosition(e);
                    showLens();
                }
            }
        };

        const onMouseUp = () => {
            if (dragStart.current) {
                fullZoomOffset = panOffset.current;
                dragStart.current = null;
            }
            if (!settings.store.fullZoom) hideLens();
        };

        // macOS (and shift on Windows) can remap scroll to the horizontal axis,
        // and trackpads send much smaller deltas (often deltaMode: 1 = "lines")
        // than a physical wheel, so use whichever axis moved and normalise the mode.
        const getScrollDelta = (e: WheelEvent) => {
            const multiplier = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 100 : 1;
            return (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * multiplier;
        };

        const onWheel = (e: WheelEvent) => {
            if (!instance.state.mouseOver) return;

            const delta = getScrollDelta(e);
            const direction = settings.store.invertScroll ? -1 : 1;

            if (!isShiftDown.current) {
                if (settings.store.fullZoom) {
                    zoomImage(e, delta, direction);
                } else {
                    const val = zoom.current + (delta / 100 * direction) * settings.store.zoomSpeed;
                    zoom.current = val <= 1 ? 1 : val;
                    if (settings.store.saveZoomValues) settings.store.zoom = zoom.current;
                    updateMousePosition(e);
                }
            } else {
                const val = size.current + (delta * direction) * settings.store.zoomSpeed;
                size.current = val <= 50 ? 50 : val;
                if (settings.store.saveZoomValues) settings.store.size = size.current;
                updateMousePosition(e);
            }
        };

        waitFor(() => instance.state.readyState === "READY", () => {
            const elem = document.getElementById(ELEMENT_ID) as HTMLDivElement;
            element.current = elem;
            elem.querySelector("img,video")?.setAttribute("draggable", "false");
            if (instance.props.animated) {
                originalVideoElementRef.current = elem!.querySelector("video")!;
                originalVideoElementRef.current.addEventListener("timeupdate", syncVideos);
            }

            // re-apply the persisted whole-image zoom after a remount
            if (settings.store.fullZoom && (fullZoomScale !== 1 || fullZoomOffset.x || fullZoomOffset.y)) {
                elem.style.transformOrigin = "0 0";
                elem.style.transform = `translate(${fullZoomOffset.x}px, ${fullZoomOffset.y}px) scale(${fullZoomScale})`;
            }

            setReady(true);
        });

        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("keyup", onKeyUp);
        document.addEventListener("mousemove", updateMousePosition);
        document.addEventListener("mousedown", onMouseDown);
        document.addEventListener("mouseup", onMouseUp);
        document.addEventListener("wheel", onWheel);

        return () => {
            resetImageZoom(true);
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("keyup", onKeyUp);
            document.removeEventListener("mousemove", updateMousePosition);
            document.removeEventListener("mousedown", onMouseDown);
            document.removeEventListener("mouseup", onMouseUp);
            document.removeEventListener("wheel", onWheel);
        };
    }, []);

    if (!ready) return null;

    const box = element.current?.getBoundingClientRect();
    const sc = Math.max(scale.current, 1);

    if (!box) return null;

    return (
        <div
            className={cl("lens", { "nearest-neighbor": settings.store.nearestNeighbour, square: settings.store.square })}
            style={{
                opacity: settings.store.fullZoom ? 0 : opacity,
                width: size.current + "px",
                height: size.current + "px",
                transform: `translate(${lensPosition.x}px, ${lensPosition.y}px)`,
                pointerEvents: settings.store.fullZoom ? "none" : "auto",
            }}
        >
            {!settings.store.fullZoom && (instance.props.animated ?
                (
                    <video
                        ref={currentVideoElementRef}
                        style={{
                            position: "absolute",
                            left: `${imagePosition.x}px`,
                            top: `${imagePosition.y}px`
                        }}
                        width={`${box.width / sc * zoom.current}px`}
                        height={`${box.height / sc * zoom.current}px`}
                        poster={instance.props.src}
                        src={originalVideoElementRef.current?.src ?? instance.props.src}
                        autoPlay
                        loop
                        muted
                    />
                ) : (
                    <img
                        className={cl("image")}
                        ref={imageRef}
                        style={{
                            position: "absolute",
                            transform: `translate(${imagePosition.x}px, ${imagePosition.y}px)`
                        }}
                        width={`${box.width / sc * zoom.current}px`}
                        height={`${box.height / sc * zoom.current}px`}
                        src={imageSrc}
                        alt=""
                    />
                ))}
        </div>
    );
}, { noop: true });
