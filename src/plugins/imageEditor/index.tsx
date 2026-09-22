/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { DeleteIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import definePlugin, { IconComponent, IconProps, OptionType } from "@utils/types";
import type { CloudUpload, RenderModalProps } from "@vencord/discord-types";
import { ChannelStore, DraftType, FluxDispatcher, Menu, Modal, openModal, SelectedChannelStore, showToast, Toasts, UploadAttachmentStore, UploadHandler, useEffect, useRef, useState } from "@webpack/common";
import type { PointerEvent as ReactPointerEvent } from "react";

import managedStyle from "./style.css?managed";

const cl = classNameFactory("vc-img-editor-");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Rect { x: number; y: number; w: number; h: number; }
interface Point { x: number; y: number; }

interface Stroke {
    color: string;
    size: number;
    points: Point[];
}

interface TextItem {
    id: string;
    text: string;
    x: number;
    y: number;
    size: number;
    color: string;
    font: string;
    bold: boolean;
    italic: boolean;
}

interface EditorSnapshot {
    crop: Rect | null;
    strokes: Stroke[];
    texts: TextItem[];
}

interface EditorProps {
    rootProps: RenderModalProps;
    file: File;
    /** Called with the edited image. The caller is responsible for re-adding it to the composer */
    onSave(edited: File): void;
    /** Called when the user discards the edits. If undefined, nothing happens on cancel */
    onCancel?(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type Tool = "crop" | "text" | "scribble";
type CropRatio = "free" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16";

const CROP_RATIOS: Record<CropRatio, number | null> = {
    "free": null,
    "1:1": 1,
    "4:3": 4 / 3,
    "3:4": 3 / 4,
    "16:9": 16 / 9,
    "9:16": 9 / 16,
};

const FONTS = [
    { label: "Sans-serif", value: "Inter, 'Helvetica Neue', system-ui, sans-serif" },
    { label: "Serif", value: "Georgia, 'Times New Roman', serif" },
    { label: "Monospace", value: "'Courier New', monospace" },
    { label: "Cursive", value: "'Comic Sans MS', 'Chalkboard SE', cursive" },
    { label: "Fat", value: "'Arial Black', Impact, sans-serif" }
] as const;

const EDITABLE_IMAGE_RE = /\.(png|jpe?g|webp|avif|bmp)$/i;

const UPLOAD_ATTACHMENT_ADD_FILES = "UPLOAD_ATTACHMENT_ADD_FILES";

const MAX_HISTORY = 100;
const MIN_CROP_SIZE = 20;

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const strokeProps = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
} as const;

const CropIcon: IconComponent = ({ height = 18, width = 18, className }) => (
    <svg width={width} height={height} className={className} viewBox="0 0 24 24" {...strokeProps} aria-hidden="true">
        <path d="M6 2v14a2 2 0 0 0 2 2h14" />
        <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </svg>
);

const TypeIcon: IconComponent = ({ height = 18, width = 18, className }) => (
    <svg width={width} height={height} className={className} viewBox="0 0 24 24" {...strokeProps} aria-hidden="true">
        <polyline points="4 7 4 4 20 4 20 7" />
        <line x1="9" x2="15" y1="20" y2="20" />
        <line x1="12" x2="12" y1="4" y2="20" />
    </svg>
);

const UndoIcon: IconComponent = ({ height = 18, width = 18, className }) => (
    <svg width={width} height={height} className={className} viewBox="0 0 24 24" {...strokeProps} aria-hidden="true">
        <path d="M9 14 4 9l5-5" />
        <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
);

const RedoIcon: IconComponent = ({ height = 18, width = 18, className }) => (
    <svg width={width} height={height} className={className} viewBox="0 0 24 24" {...strokeProps} aria-hidden="true">
        <path d="m15 14 5-5-5-5" />
        <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </svg>
);

const ResetIcon: IconComponent = ({ height = 18, width = 18, className }) => (
    <svg width={width} height={height} className={className} viewBox="0 0 24 24" {...strokeProps} aria-hidden="true">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5" />
    </svg>
);

const CheckIcon: IconComponent = ({ height = 18, width = 18, className }) => (
    <svg width={width} height={height} className={className} viewBox="0 0 24 24" {...strokeProps} aria-hidden="true">
        <polyline points="20 6 9 17 4 12" />
    </svg>
);

function Paintbrush({ height = 18, width = 18, className }: IconProps) {
    return (
        <svg width={width} height={height} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M15.35 7.24C15.9 6.67 16 5.8 16 5a3 3 0 1 1 3 3c-.8 0-1.67.09-2.24.65a1.5 1.5 0 0 0 0 2.11l1.12 1.12a3 3 0 0 1 0 4.24l-5 5a3 3 0 0 1-4.25 0l-5.76-5.75a3 3 0 0 1 0-4.24l4.04-4.04.97-.97a3 3 0 0 1 4.24 0l1.12 1.12c.58.58 1.52.58 2.1 0ZM6.9 9.9 4.3 12.54a1 1 0 0 0 0 1.42l2.17 2.17.83-.84a1 1 0 0 1 1.42 1.42l-.84.83.59.59 1.83-1.84a1 1 0 0 1 1.42 1.42l-1.84 1.83.17.17a1 1 0 0 0 1.42 0l2.63-2.62L6.9 9.9Z" />
        </svg>
    );
}

function ToolButton({ label, active, onClick, icon: Icon }: {
    label: string;
    active: boolean;
    onClick(): void;
    icon: IconComponent;
}) {
    return (
        <button
            type="button"
            className={cl("tool-btn", active && "tool-active")}
            onClick={onClick}
        >
            <Icon height={16} width={16} />
            <span>{label}</span>
        </button>
    );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const settings = definePluginSettings({
    openEditorOnAttach: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Automatically open the image editor whenever you attach an image to a message",
    },
});

// ---------------------------------------------------------------------------
// Upload interception
// ---------------------------------------------------------------------------

/** Files that are fine to pass through the upload pipeline without opening the editor again */
const approvedFiles = new WeakSet<File>();
export { approvedFiles };

interface UploadContext {
    channelId: string;
    draftType: number;
}

type AddFilesAction = {
    type: string;
    channelId?: string;
    draftType?: number;
    files?: unknown;
    uploads?: unknown;
    items?: unknown;
};

function isEditableImage(file: File): boolean {
    if (!file || file.size <= 0 || file.type === "image/gif") return false;
    return file.type.startsWith("image/") || EDITABLE_IMAGE_RE.test(file.name);
}

function extractFiles(value: unknown): File[] {
    if (value instanceof File) return [value];
    if (!Array.isArray(value)) return [];

    return value.flatMap(entry => {
        if (entry instanceof File) return [entry];
        if (!entry || typeof entry !== "object") return [];

        if ("file" in entry && entry.file instanceof File) return [entry.file];

        const { item } = entry as any;
        if (item && typeof item === "object" && "file" in item && item.file instanceof File) return [item.file];

        return [];
    });
}

function reAddFiles(ctx: UploadContext, files: File[]): void {
    if (files.length === 0) return;

    const channel = ChannelStore.getChannel(ctx.channelId);
    if (!channel) {
        showToast("Couldn't find the channel to add your image to.", Toasts.Type.FAILURE);
        return;
    }

    files.forEach(f => approvedFiles.add(f));
    UploadHandler.promptToUpload(files, channel, ctx.draftType);
}

let fluxInterceptor: ((action: unknown) => void) | null = null;

function handleAddFilesAction(action: unknown): void {
    if (!action || typeof action !== "object" || !("type" in action)) return;

    const payload = action as AddFilesAction;
    if (payload.type !== UPLOAD_ATTACHMENT_ADD_FILES) return;
    if (!settings.store.openEditorOnAttach) return;

    const draftType = payload.draftType ?? DraftType.ChannelMessage;
    if (draftType !== DraftType.ChannelMessage) return;

    const allFiles = Array.from(new Set([
        ...extractFiles(payload.files),
        ...extractFiles(payload.uploads),
        ...extractFiles(payload.items),
    ]));

    const target = allFiles.find(f => !approvedFiles.has(f) && isEditableImage(f));
    if (!target) return;

    const channelId = payload.channelId ?? SelectedChannelStore.getChannelId();
    if (!channelId) return;

    // Neutralise the original action so the unedited file never lands in the
    // composer; we re-add it (edited or untouched) once the user is done.
    payload.files = [];
    payload.uploads = [];
    payload.items = [];

    const others = allFiles.filter(f => f !== target);

    // Defer opening the modal: we're running inside a Flux dispatch, and
    // opening a modal dispatches too, which would throw.
    setTimeout(() => {
        openModal(props => (
            <ImageEditorModal
                rootProps={props}
                file={target}
                onSave={edited => reAddFiles({ channelId, draftType }, [edited, ...others])}
                onCancel={() => reAddFiles({ channelId, draftType }, [target, ...others])}
            />
        ));
    }, 0);
}

const channelAttachMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const channel = props?.channel;
    if (!channel) return;
    if (children.some(c => c?.props?.id === "image-editor")) return;

    const uploads = UploadAttachmentStore.getUploads(channel.id, DraftType.ChannelMessage);
    const editable = uploads.filter(u => {
        const file = u.item?.file;
        return !!file && isEditableImage(file);
    });
    if (editable.length === 0) return;

    const editUpload = (upload: CloudUpload) => {
        openModal(modalProps => (
            <ImageEditorModal
                rootProps={modalProps}
                file={upload.item.file}
                onSave={edited => {
                    void upload.removeFromMsgDraft();
                    reAddFiles({ channelId: channel.id, draftType: DraftType.ChannelMessage }, [edited]);
                }}
            />
        ));
    };

    children.push(
        <Menu.MenuItem
            id="image-editor"
            key="image-editor"
            label="Edit Image"
            iconLeft={CropIcon}
            leadingAccessory={{ type: "icon", icon: CropIcon }}
        >
            {editable.map(upload => (
                <Menu.MenuItem
                    id={`image-editor-${upload.id}`}
                    key={upload.id}
                    label={upload.filename}
                    action={() => editUpload(upload)}
                />
            ))}
        </Menu.MenuItem>
    );
};

// ---------------------------------------------------------------------------
// Editor modal
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function newTextItem(pos: Point, size: number, color: string, font: string, bold: boolean, italic: boolean): TextItem {
    return {
        id: Math.random().toString(36).slice(2),
        text: "Text",
        x: pos.x,
        y: pos.y,
        size,
        color,
        font,
        bold,
        italic,
    };
}

function ImageEditorModal({ rootProps, file, onSave, onCancel }: EditorProps) {
    const [img, setImg] = useState<HTMLImageElement | null>(null);
    const [loadError, setLoadError] = useState(false);
    const [saving, setSaving] = useState(false);
    const doneRef = useRef(false);

    const [tool, setTool] = useState<Tool>("crop");
    const [crop, setCrop] = useState<Rect | null>(null);
    const [strokes, setStrokes] = useState<Stroke[]>([]);
    const [texts, setTexts] = useState<TextItem[]>([]);
    const [selectedTextId, setSelectedTextId] = useState<string | null>(null);

    const [selRect, setSelRect] = useState<Rect | null>(null);
    const [cropRatio, setCropRatio] = useState<CropRatio>("free");

    const [color, setColor] = useState("#ffffff");
    const [brushSize, setBrushSize] = useState(12);
    const [textSize, setTextSize] = useState(48);
    const [fontFamily, setFontFamily] = useState<string>(FONTS[0].value);
    const [bold, setBold] = useState(false);
    const [italic, setItalic] = useState(false);

    const [history, setHistory] = useState<EditorSnapshot[]>([]);
    const [redoStack, setRedoStack] = useState<EditorSnapshot[]>([]);

    const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

    const containerRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const drawingRef = useRef(false);
    const cropDragRef = useRef<{ mode: "move" | "draw"; } | { mode: "resize"; handle: string; } | null>(null);
    const cropStartRef = useRef<{ rect: Rect; px: number; py: number; } | null>(null);
    const textDragRef = useRef<{ id: string; px: number; py: number; origX: number; origY: number; } | null>(null);

    // Load the image
    useEffect(() => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            setImg(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            setLoadError(true);
        };
        image.src = url;
        return () => URL.revokeObjectURL(url);
    }, [file]);

    // Measure the stage container
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const ro = new ResizeObserver(entries => {
            const { width, height } = entries[0].contentRect;
            setContainerSize({ w: width, h: height });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Restore the crop selection when re-entering crop tool, but do NOT
    // default to the full image – the user should draw their own selection.
    useEffect(() => {
        if (!img || tool !== "crop") return;
        setSelRect(prev => prev ?? crop ?? null);
    }, [tool, img, crop]);

    const imgW = img?.naturalWidth ?? 1;
    const imgH = img?.naturalHeight ?? 1;

    // The region of the image currently shown on the stage (in source pixels)
    const view: Rect = tool === "crop"
        ? { x: 0, y: 0, w: imgW, h: imgH }
        : (crop ?? { x: 0, y: 0, w: imgW, h: imgH });

    const scale = (containerSize.w && containerSize.h)
        ? Math.min(containerSize.w / view.w, containerSize.h / view.h)
        : 1;
    const stageW = Math.max(1, Math.round(view.w * scale));
    const stageH = Math.max(1, Math.round(view.h * scale));

    // Redraw the canvas whenever anything that's drawn on it changes
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !img) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, view.x, view.y, view.w, view.h, 0, 0, canvas.width, canvas.height);

        for (const stroke of strokes) {
            if (stroke.points.length === 0) continue;
            ctx.beginPath();
            ctx.strokeStyle = stroke.color;
            ctx.lineWidth = Math.max(1, stroke.size * (canvas.width / view.w));
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.moveTo(
                (stroke.points[0].x - view.x) * (canvas.width / view.w),
                (stroke.points[0].y - view.y) * (canvas.height / view.h)
            );
            for (let i = 1; i < stroke.points.length; i++) {
                ctx.lineTo(
                    (stroke.points[i].x - view.x) * (canvas.width / view.w),
                    (stroke.points[i].y - view.y) * (canvas.height / view.h)
                );
            }
            ctx.stroke();
        }
    }, [img, strokes, view, stageW, stageH]);

    function stagePos(e: ReactPointerEvent): Point {
        const stage = stageRef.current!;
        const rect = stage.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) / scale + view.x,
            y: (e.clientY - rect.top) / scale + view.y,
        };
    }

    function pushHistory(): void {
        setHistory(h => {
            const next = [...h, { crop, strokes, texts }];
            return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
        });
        setRedoStack([]);
    }

    function undo(): void {
        const prev = history[history.length - 1];
        if (!prev) return;
        setHistory(h => h.slice(0, -1));
        setRedoStack(r => [...r, { crop, strokes, texts }]);
        setCrop(prev.crop);
        setStrokes(prev.strokes);
        setTexts(prev.texts);
        setSelectedTextId(null);
    }

    function redo(): void {
        const next = redoStack[redoStack.length - 1];
        if (!next) return;
        setRedoStack(r => r.slice(0, -1));
        setHistory(h => [...h, { crop, strokes, texts }]);
        setCrop(next.crop);
        setStrokes(next.strokes);
        setTexts(next.texts);
        setSelectedTextId(null);
    }

    function reset(): void {
        pushHistory();
        setCrop(null);
        setStrokes([]);
        setTexts([]);
        setSelectedTextId(null);
        setSelRect(null);
    }

    // --- Scribble ---

    function onCanvasPointerDown(e: ReactPointerEvent) {
        if (!img || e.button !== 0) return;
        const pos = stagePos(e);

        if (tool === "crop" && !selRect) {
            (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
            drawingRef.current = true;
            cropDragRef.current = { mode: "draw" };
            cropStartRef.current = { rect: { x: pos.x, y: pos.y, w: 0, h: 0 }, px: pos.x, py: pos.y };
            setSelRect({ x: pos.x, y: pos.y, w: 0, h: 0 });
        } else if (tool === "scribble") {
            (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
            drawingRef.current = true;
            pushHistory();
            setStrokes(prev => [...prev, { color, size: brushSize, points: [pos] }]);
        } else if (tool === "text") {
            pushHistory();
            const item = newTextItem(pos, textSize, color, fontFamily, bold, italic);
            setTexts(prev => [...prev, item]);
            setSelectedTextId(item.id);
        }
    }

    function onCanvasPointerMove(e: ReactPointerEvent) {
        if (tool === "crop" && cropDragRef.current?.mode === "draw" && cropStartRef.current) {
            const pos = stagePos(e);
            const start = cropStartRef.current;
            const ratio = CROP_RATIOS[cropRatio];

            let x = start.px;
            let y = start.py;
            let w = pos.x - start.px;
            let h = pos.y - start.py;

            if (w < 0) { x += w; w = -w; }
            if (h < 0) { y += h; h = -h; }

            if (ratio != null && w > 0 && h > 0) {
                if (w / h > ratio) w = h * ratio;
                else h = w / ratio;
            }

            w = Math.max(MIN_CROP_SIZE, w);
            h = Math.max(MIN_CROP_SIZE, h);

            x = clamp(x, 0, Math.max(0, imgW - w));
            y = clamp(y, 0, Math.max(0, imgH - h));

            setSelRect({ x, y, w: Math.min(w, imgW - x), h: Math.min(h, imgH - y) });
            return;
        }

        if (!drawingRef.current || tool !== "scribble") return;
        const pos = stagePos(e);
        setStrokes(prev => {
            const copy = [...prev];
            const last = { ...copy[copy.length - 1] };
            last.points = [...last.points, pos];
            copy[copy.length - 1] = last;
            return copy;
        });
    }

    function onCanvasPointerUp() {
        drawingRef.current = false;
        if (cropDragRef.current?.mode === "draw") {
            cropDragRef.current = null;
            cropStartRef.current = null;
        }
    }

    // --- Crop tool ---

    function resizeRect(rect: Rect, handle: string, dx: number, dy: number): Rect {
        const ratio = CROP_RATIOS[cropRatio];
        const { x: rectX, y: rectY, w: rectW, h: rectH } = rect;
        let x = rectX;
        let y = rectY;
        let w = rectW;
        let h = rectH;

        const setMin = (v: number) => Math.max(MIN_CROP_SIZE, v);

        switch (handle) {
            case "e":
                w = setMin(rectW + dx);
                break;
            case "w": {
                const right = rectX + rectW;
                x = clamp(right - setMin(rectW - dx), 0, right - MIN_CROP_SIZE);
                w = right - x;
                break;
            }
            case "s":
                h = setMin(rectH + dy);
                break;
            case "n": {
                const bottom = rectY + rectH;
                y = clamp(bottom - setMin(rectH - dy), 0, bottom - MIN_CROP_SIZE);
                h = bottom - y;
                break;
            }
            case "nw":
            case "ne":
            case "sw":
            case "se": {
                // The corner opposite of the one being dragged stays anchored
                let fx: number;
                let fy: number;
                if (handle.includes("w")) fx = rectX + rectW; else fx = rectX;
                if (handle.includes("n")) fy = rectY + rectH; else fy = rectY;

                const px = fx + dx;
                const py = fy + dy;

                w = Math.abs(px - fx);
                h = Math.abs(py - fy);

                if (ratio != null) {
                    if (w / Math.max(1, h) > ratio) h = w / ratio;
                    else w = h * ratio;
                }

                w = Math.max(MIN_CROP_SIZE, w);
                h = Math.max(MIN_CROP_SIZE, h);
                x = px >= fx ? fx : fx - w;
                y = py >= fy ? fy : fy - h;
                break;
            }
        }

        x = clamp(x, 0, Math.max(0, imgW - w));
        y = clamp(y, 0, Math.max(0, imgH - h));

        return { x, y, w: Math.min(w, imgW - x), h: Math.min(h, imgH - y) };
    }

    function onCropPointerDown(e: ReactPointerEvent) {
        if (!selRect || tool !== "crop") return;
        e.preventDefault();
        e.stopPropagation();
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);

        const pos = stagePos(e);
        const rect = selRect;
        const t = 10 / scale;
        const near = (a: number, b: number) => Math.abs(a - b) <= t;

        let handle: string | null = null;
        if (near(pos.x, rect.x) && near(pos.y, rect.y)) handle = "nw";
        else if (near(pos.x, rect.x + rect.w) && near(pos.y, rect.y)) handle = "ne";
        else if (near(pos.x, rect.x) && near(pos.y, rect.y + rect.h)) handle = "sw";
        else if (near(pos.x, rect.x + rect.w) && near(pos.y, rect.y + rect.h)) handle = "se";
        else if (near(pos.x, rect.x) && pos.y > rect.y && pos.y < rect.y + rect.h) handle = "w";
        else if (near(pos.x, rect.x + rect.w) && pos.y > rect.y && pos.y < rect.y + rect.h) handle = "e";
        else if (near(pos.y, rect.y) && pos.x > rect.x && pos.x < rect.x + rect.w) handle = "n";
        else if (near(pos.y, rect.y + rect.h) && pos.x > rect.x && pos.x < rect.x + rect.w) handle = "s";

        if (handle) {
            cropDragRef.current = { mode: "resize", handle };
        } else if (
            pos.x >= rect.x && pos.x <= rect.x + rect.w
            && pos.y >= rect.y && pos.y <= rect.y + rect.h
        ) {
            cropDragRef.current = { mode: "move" };
        } else {
            // Clicked outside the selection: start drawing a new crop area
            cropDragRef.current = { mode: "draw" };
        }

        cropStartRef.current = { rect: { ...rect }, px: pos.x, py: pos.y };
    }

    function onCropPointerMove(e: ReactPointerEvent) {
        const drag = cropDragRef.current;
        const start = cropStartRef.current;
        if (!drag || !start || !selRect) return;

        const pos = stagePos(e);
        const dx = pos.x - start.px;
        const dy = pos.y - start.py;

        if (drag.mode === "move") {
            setSelRect({
                x: clamp(start.rect.x + dx, 0, imgW - start.rect.w),
                y: clamp(start.rect.y + dy, 0, imgH - start.rect.h),
                w: start.rect.w,
                h: start.rect.h,
            });
        } else if (drag.mode === "draw") {
            const ratio = CROP_RATIOS[cropRatio];
            let x = start.px;
            let y = start.py;
            let w = dx;
            let h = dy;

            if (w < 0) { x += w; w = -w; }
            if (h < 0) { y += h; h = -h; }

            if (ratio != null && w > 0 && h > 0) {
                if (w / h > ratio) w = h * ratio;
                else h = w / ratio;
            }

            w = Math.max(MIN_CROP_SIZE, w);
            h = Math.max(MIN_CROP_SIZE, h);

            x = clamp(x, 0, Math.max(0, imgW - w));
            y = clamp(y, 0, Math.max(0, imgH - h));

            setSelRect({ x, y, w: Math.min(w, imgW - x), h: Math.min(h, imgH - y) });
        } else if (drag.mode === "resize") {
            setSelRect(resizeRect(start.rect, drag.handle, dx, dy));
        }
    }

    function onCropPointerUp() {
        cropDragRef.current = null;
        cropStartRef.current = null;
    }

    function applyCrop() {
        if (!selRect) return;
        pushHistory();
        setCrop({ ...selRect });
        setTool("scribble");
    }

    function chooseRatio(r: CropRatio) {
        setCropRatio(r);
        if (!selRect) return;
        const ratio = CROP_RATIOS[r];
        if (ratio == null) return;

        const { w, h } = selRect;
        let nw = w;
        let nh = h;
        if (w / h > ratio) nh = Math.max(MIN_CROP_SIZE, w / ratio);
        else nw = Math.max(MIN_CROP_SIZE, h * ratio);

        const x = clamp(selRect.x, 0, Math.max(0, imgW - nw));
        const y = clamp(selRect.y, 0, Math.max(0, imgH - nh));
        setSelRect({ x, y, w: Math.min(nw, imgW - x), h: Math.min(nh, imgH - y) });
    }

    // --- Text tool ---

    function onTextPointerDown(e: ReactPointerEvent, item: TextItem) {
        if (tool !== "text") return;
        e.stopPropagation();
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        setSelectedTextId(item.id);
        pushHistory();
        const pos = stagePos(e);
        textDragRef.current = { id: item.id, px: pos.x, py: pos.y, origX: item.x, origY: item.y };
    }

    function onTextPointerMove(e: ReactPointerEvent) {
        const drag = textDragRef.current;
        if (!drag) return;
        const pos = stagePos(e);
        setTexts(prev => prev.map(t => t.id === drag.id
            ? { ...t, x: clamp(drag.origX + (pos.x - drag.px), 0, imgW), y: clamp(drag.origY + (pos.y - drag.py), 0, imgH) }
            : t
        ));
    }

    function onTextPointerUp() {
        textDragRef.current = null;
    }

    function updateSelectedText(mutator: (t: TextItem) => TextItem) {
        setTexts(prev => prev.map(t => t.id === selectedTextId ? mutator(t) : t));
    }

    function deleteSelectedText() {
        if (!selectedTextId) return;
        pushHistory();
        setTexts(prev => prev.filter(t => t.id !== selectedTextId));
        setSelectedTextId(null);
    }

    // --- Export ---

    function exportFile(): Promise<File> {
        return new Promise((resolve, reject) => {
            if (!img) return reject(new Error("Image not loaded"));

            const outW = crop ? Math.round(crop.w) : img.naturalWidth;
            const outH = crop ? Math.round(crop.h) : img.naturalHeight;
            const canvas = document.createElement("canvas");
            canvas.width = outW;
            canvas.height = outH;
            const ctx = canvas.getContext("2d");
            if (!ctx) return reject(new Error("Failed to create canvas"));

            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";

            if (crop) {
                ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, outW, outH);
            } else {
                ctx.drawImage(img, 0, 0, outW, outH);
            }

            const cropX = crop?.x ?? 0;
            const cropY = crop?.y ?? 0;

            for (const stroke of strokes) {
                if (stroke.points.length === 0) continue;
                ctx.beginPath();
                ctx.strokeStyle = stroke.color;
                ctx.lineWidth = Math.max(1, stroke.size);
                ctx.lineCap = "round";
                ctx.lineJoin = "round";
                ctx.moveTo(stroke.points[0].x - cropX, stroke.points[0].y - cropY);
                for (let i = 1; i < stroke.points.length; i++) {
                    ctx.lineTo(stroke.points[i].x - cropX, stroke.points[i].y - cropY);
                }
                ctx.stroke();
            }

            for (const t of texts) {
                ctx.font = `${t.italic ? "italic " : ""}${t.bold ? "700 " : ""}${t.size}px ${t.font}`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillStyle = t.color;
                ctx.fillText(t.text, t.x - cropX, t.y - cropY);
            }

            canvas.toBlob(blob => {
                if (!blob) return reject(new Error("Failed to export image"));
                const base = file.name.replace(/\.[^/.]+$/, "") || "image";
                resolve(new File([blob], `${base}_edited.png`, { type: "image/png" }));
            }, "image/png");
        });
    }

    async function handleSave() {
        if (doneRef.current || saving || !img) return;
        doneRef.current = true;
        setSaving(true);
        try {
            const edited = await exportFile();
            onSave(edited);
            rootProps.onClose();
        } catch (err) {
            console.error("[ImageEditor] Failed to export image\n", err);
            showToast("Failed to save the edited image. Try again.", Toasts.Type.FAILURE);
            doneRef.current = false;
            setSaving(false);
        }
    }

    function handleCancel() {
        if (doneRef.current) return;
        doneRef.current = true;
        onCancel?.();
        rootProps.onClose();
    }

    const selectedText = texts.find(t => t.id === selectedTextId);

    const ratioButtons: CropRatio[] = ["free", "1:1", "4:3", "3:4", "16:9", "9:16"];

    return (
        <Modal
            {...rootProps}
            title={"Edit Image"}
            subtitle={file.name}
            size="lg"
            onClose={handleCancel}
            actions={[
                { text: "Cancel", variant: "secondary", onClick: handleCancel },
                { text: "Save", variant: "primary", onClick: handleSave, loading: saving, disabled: !img || loadError },
            ]}
        >
            <div className={cl("content")}>
                <div className={cl("toolbar")}>
                    <div className={cl("tool-group")}>
                        <ToolButton label="Crop" active={tool === "crop"} onClick={() => setTool("crop")} icon={CropIcon} />
                        <ToolButton label="Text" active={tool === "text"} onClick={() => setTool("text")} icon={TypeIcon} />
                        <ToolButton label="Scribble" active={tool === "scribble"} onClick={() => setTool("scribble")} icon={Paintbrush} />
                    </div>
                    <div className={cl("tool-group")}>
                        <Button size="small" variant="secondary" onClick={undo} disabled={history.length === 0} title="Undo" className={cl("icon-btn")}>
                            <UndoIcon />
                        </Button>
                        <Button size="small" variant="secondary" onClick={redo} disabled={redoStack.length === 0} title="Redo" className={cl("icon-btn")}>
                            <RedoIcon />
                        </Button>
                        <Button size="small" variant="secondary" onClick={reset} title="Reset all edits" className={cl("icon-btn")}>
                            <ResetIcon />
                        </Button>
                    </div>
                </div>

                <div className={cl("stage-wrap")} ref={containerRef}>
                    {img === null && !loadError && (
                        <div className={cl("loading")}>Loading image…</div>
                    )}
                    {loadError && (
                        <div className={cl("loading")}>Failed to load this image. Click Cancel to keep it unedited.</div>
                    )}
                    {img !== null && (
                        <div
                            className={cl("stage")}
                            ref={stageRef}
                            style={{ width: stageW, height: stageH }}
                        >
                            <canvas
                                ref={canvasRef}
                                className={cl("canvas")}
                                width={stageW}
                                height={stageH}
                                style={{ width: stageW, height: stageH }}
                                onPointerDown={onCanvasPointerDown}
                                onPointerMove={onCanvasPointerMove}
                                onPointerUp={onCanvasPointerUp}
                                onPointerCancel={onCanvasPointerUp}
                            />

                            {texts.length > 0 && (
                                <div className={cl("text-layer")}>
                                    {texts.map(item => (
                                        <div
                                            key={item.id}
                                            className={cl("text-item", { draggable: tool === "text", selected: item.id === selectedTextId && tool === "text" })}
                                            style={{
                                                left: (item.x - view.x) * scale,
                                                top: (item.y - view.y) * scale,
                                                fontSize: item.size * scale,
                                                fontFamily: item.font,
                                                fontWeight: item.bold ? 700 : 400,
                                                fontStyle: item.italic ? "italic" : "normal",
                                                color: item.color,
                                            }}
                                            onPointerDown={e => onTextPointerDown(e, item)}
                                            onPointerMove={onTextPointerMove}
                                            onPointerUp={onTextPointerUp}
                                            onPointerCancel={onTextPointerUp}
                                        >
                                            {item.text}
                                        </div>
                                    ))}
                                </div>
                            )}

                            {tool === "crop" && selRect && (
                                <div
                                    className={cl("crop-layer")}
                                    onPointerDown={onCropPointerDown}
                                    onPointerMove={onCropPointerMove}
                                    onPointerUp={onCropPointerUp}
                                    onPointerCancel={onCropPointerUp}
                                >
                                    <div
                                        className={cl("crop-rect")}
                                        style={{
                                            left: (selRect.x - view.x) * scale,
                                            top: (selRect.y - view.y) * scale,
                                            width: selRect.w * scale,
                                            height: selRect.h * scale,
                                        }}
                                    >
                                        {["nw", "n", "ne", "e", "se", "s", "sw", "w"].map(h => (
                                            <div key={h} className={cl("crop-handle", h)} />
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div className={cl("controls")}>
                    {tool === "crop" && (
                        <>
                            <div className={cl("tool-group")}>
                                {ratioButtons.map(r => (
                                    <button
                                        key={r}
                                        type="button"
                                        className={cl("ratio-btn", cropRatio === r && "ratio-active")}
                                        onClick={() => chooseRatio(r)}
                                    >
                                        {r}
                                    </button>
                                ))}
                            </div>
                            <Button size="small" onClick={applyCrop} disabled={!selRect}>
                                <CheckIcon height={16} width={16} /> Apply Crop
                            </Button>
                            <span className={cl("hint")}>Drag on the image to choose what to keep</span>
                        </>
                    )}

                    {tool === "scribble" && (
                        <>
                            <label className={cl("control")}>
                                <input
                                    type="color"
                                    className={cl("color")}
                                    value={color}
                                    onChange={e => setColor(e.target.value)}
                                    title="Brush color"
                                />
                            </label>
                            <label className={cl("control")}>
                                <span className={cl("control-label")}>Size</span>
                                <input
                                    type="range"
                                    className={cl("range")}
                                    min={2}
                                    max={60}
                                    value={brushSize}
                                    onChange={e => setBrushSize(Number(e.target.value))}
                                />
                                <span className={cl("control-value")}>{brushSize}</span>
                            </label>
                            <span className={cl("hint")}>Draw on the image with your pointer</span>
                        </>
                    )}

                    {tool === "text" && (
                        <>
                            <select
                                className={cl("select")}
                                value={fontFamily}
                                onChange={e => { setFontFamily(e.target.value); if (selectedText) updateSelectedText(t => ({ ...t, font: e.target.value })); }}
                                title="Font"
                            >
                                {FONTS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                            </select>
                            <label className={cl("control")}>
                                <input
                                    type="color"
                                    className={cl("color")}
                                    value={color}
                                    onChange={e => {
                                        setColor(e.target.value);
                                        if (selectedText) updateSelectedText(t => ({ ...t, color: e.target.value }));
                                    }}
                                    title="Text color"
                                />
                            </label>
                            <label className={cl("control")}>
                                <span className={cl("control-label")}>Size</span>
                                <input
                                    type="range"
                                    className={cl("range")}
                                    min={14}
                                    max={120}
                                    value={textSize}
                                    onChange={e => {
                                        const size = Number(e.target.value);
                                        setTextSize(size);
                                        if (selectedText) updateSelectedText(t => ({ ...t, size }));
                                    }}
                                />
                                <span className={cl("control-value")}>{textSize}</span>
                            </label>
                            <button
                                type="button"
                                className={cl("style-btn", bold && "style-active")}
                                onClick={() => {
                                    setBold(b => !b);
                                    if (selectedText) updateSelectedText(t => ({ ...t, bold: !t.bold }));
                                }}
                                title="Bold"
                            >
                                <strong>B</strong>
                            </button>
                            <button
                                type="button"
                                className={cl("style-btn", italic && "style-active")}
                                onClick={() => {
                                    setItalic(i => !i);
                                    if (selectedText) updateSelectedText(t => ({ ...t, italic: !t.italic }));
                                }}
                                title="Italic"
                            >
                                <em>I</em>
                            </button>
                            <Button
                                size="small"
                                variant="dangerSecondary"
                                className={cl("icon-btn")}
                                onClick={deleteSelectedText}
                                disabled={!selectedText}
                                title="Delete selected text"
                            >
                                <DeleteIcon height={16} width={16} />
                            </Button>
                            {selectedText
                                ? <input
                                    type="text"
                                    className={cl("text-input")}
                                    value={selectedText.text}
                                    placeholder="Type your text"
                                    onChange={e => updateSelectedText(t => ({ ...t, text: e.target.value }))}
                                />
                                : <span className={cl("hint")}>Click the image to add text, then click a text to edit it</span>}
                        </>
                    )}
                </div>
            </div>
        </Modal>
    );
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export default definePlugin({
    name: "ImageEditor",
    description: "Edit images before sending them in a message: crop, add text, and scribble on them",
    tags: ["Media", "Chat"],
    authors: [Devs.saraaa7447],
    settings,
    managedStyle,

    contextMenus: {
        "channel-attach": channelAttachMenuPatch,
    },

    start() {
        if (fluxInterceptor) return;
        fluxInterceptor = action => {
            try {
                handleAddFilesAction(action);
            } catch (err) {
                console.error("[ImageEditor] Failed to intercept upload\n", err);
            }
        };
        FluxDispatcher.addInterceptor(fluxInterceptor);
    },

    stop() {
        if (!fluxInterceptor) return;
        const idx = FluxDispatcher._interceptors?.indexOf(fluxInterceptor);
        if (idx != null && idx > -1) FluxDispatcher._interceptors.splice(idx, 1);
        fluxInterceptor = null;
    },
});
