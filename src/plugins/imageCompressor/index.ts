/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { approvedFiles } from "@plugins/imageEditor";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, FluxDispatcher, SelectedChannelStore, showToast, Toasts, UploadHandler } from "@webpack/common";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UPLOAD_ACTION = "UPLOAD_ATTACHMENT_ADD_FILES";
const DEFAULT_TARGET_MB = 20;

const COMPRESSIBLE_RE = /\.(jpe?g|png|webp|avif|bmp)$/i;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const settings = definePluginSettings({
    targetMB: {
        type: OptionType.SLIDER,
        default: DEFAULT_TARGET_MB,
        markers: [5, 10, 15, 20, 25, 50],
        description: "Target maximum file size in MB. Images above this size will be compressed.",
    },
});

// ---------------------------------------------------------------------------
// Compression helpers
// ---------------------------------------------------------------------------

function isCompressible(file: File): boolean {
    if (!file || file.size <= 0) return false;
    if (file.type === "image/gif" || file.type === "image/svg+xml") return false;
    return file.type.startsWith("image/") || COMPRESSIBLE_RE.test(file.name);
}

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(src); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(src); reject(new Error("Failed to load image for compression")); };
        img.src = src;
    });
}

function drawToCanvas(img: HTMLImageElement, w: number, h: number): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);
    return c;
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number, type: string = "image/jpeg"): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error("Canvas toBlob returned null"));
        }, type, quality);
    });
}

async function compressImage(file: File, maxBytes: number): Promise<File> {
    const url = URL.createObjectURL(file);
    let img: HTMLImageElement;
    try {
        img = await loadImage(url);
    } catch {
        return file; // undecodable (heic, svg, etc.) – let Discord handle it as-is
    }

    const baseName = file.name.replace(/\.[^/.]+$/, "");
    let bestBlob: Blob | null = null;

    const found = (blob: Blob): boolean => {
        if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob;
        return blob.size <= maxBytes;
    };

    const toFile = (blob: Blob): File => {
        const ext = blob.type === "image/webp" ? ".webp" : ".jpg";
        return new File([blob], baseName + ext, { type: blob.type });
    };

    const tryEncode = async (type: string, w: number, h: number, qualities: number[]): Promise<File | null> => {
        for (const quality of qualities) {
            const blob = await canvasToBlob(drawToCanvas(img, w, h), quality, type);
            if (found(blob)) return toFile(blob);
        }
        return null;
    };

    // Pass 1: full resolution, JPEG then WebP at decreasing quality.
    // WebP is meaningfully smaller than JPEG at the same visual quality.
    let result = await tryEncode("image/jpeg", img.naturalWidth, img.naturalHeight, [0.85, 0.7, 0.55, 0.4]);
    if (result) return result;
    result = await tryEncode("image/webp", img.naturalWidth, img.naturalHeight, [0.85, 0.65, 0.45, 0.25]);
    if (result) return result;

    // Pass 2: keep halving the dimensions until we land under the limit.
    let w = Math.round(img.naturalWidth / 2);
    let h = Math.round(img.naturalHeight / 2);
    while (w > 200 && h > 200) {
        result = await tryEncode("image/jpeg", w, h, [0.7, 0.45]);
        if (result) return result;
        result = await tryEncode("image/webp", w, h, [0.65, 0.4]);
        if (result) return result;
        w = Math.round(w / 2);
        h = Math.round(h / 2);
    }

    // Couldn't get under the limit – return the smallest attempt we found.
    if (bestBlob) return toFile(bestBlob);

    return file;
}

// ---------------------------------------------------------------------------
// Upload interception
// ---------------------------------------------------------------------------

let fluxInterceptor: ((action: unknown) => void) | null = null;

function extractFiles(value: unknown): File[] {
    if (value instanceof File) return [value];
    if (!Array.isArray(value)) return [];

    return value.flatMap(entry => {
        if (entry instanceof File) return [entry];
        if (!entry || typeof entry !== "object") return [];

        if ("file" in entry && (entry as any).file instanceof File) return [(entry as any).file];

        const { item } = entry as any;
        if (item && typeof item === "object" && "file" in item && item.file instanceof File) return [item.file];

        return [];
    });
}

function handleAction(action: unknown): void {
    if (!action || typeof action !== "object" || !("type" in action)) return;
    const payload = action as { type: string; channelId?: string; draftType?: number; files?: unknown; uploads?: unknown; items?: unknown };
    if (payload.type !== UPLOAD_ACTION) return;

    const maxBytes = (settings.store.targetMB ?? DEFAULT_TARGET_MB) * 1024 * 1024;

    const files = Array.from(new Set([
        ...extractFiles(payload.files),
        ...extractFiles(payload.uploads),
        ...extractFiles(payload.items),
    ]));

    if (!files.some(f => f.size > maxBytes && isCompressible(f))) return;

    const oversize = files.filter(f => f.size > maxBytes && isCompressible(f));
    // Immediate visible signal that interception happened (esp. for users without DevTools).
    showToast(`ImageCompressor: compressing ${oversize.length} image(s)…`, Toasts.Type.Custom);
    for (const f of oversize) console.info("[ImageCompressor]", "intercepted", f.name, f.size);

    // Neutralise the action so no oversized file ever reaches Discord;
    // everything is re-added afterwards.
    payload.files = [];
    payload.uploads = [];
    payload.items = [];

    const channelId = payload.channelId ?? SelectedChannelStore.getChannelId();
    const draftType = payload.draftType ?? 0;

    (async () => {
        try {
            const finalFiles: File[] = [];
            const successes: { name: string; before: number; after: number }[] = [];
            const dropped: string[] = [];

            for (const file of files) {
                if (file.size <= maxBytes || !isCompressible(file)) {
                    finalFiles.push(file);
                    continue;
                }

                const compressed = await compressImage(file, maxBytes);

                if (compressed.size <= maxBytes) {
                    approvedFiles.add(compressed);
                    finalFiles.push(compressed);
                    successes.push({ name: file.name, before: file.size, after: compressed.size });
                } else {
                    // Compression couldn't get under the limit; don't re-add an oversized file.
                    dropped.push(file.name);
                }
            }

            if (successes.length > 0) {
                const summary = successes
                    .map(({ name, before, after }) => {
                        const reduction = Math.max(0, Math.round((1 - after / before) * 100));
                        return `${name} −${reduction}% (${formatSize(before)} → ${formatSize(after)})`;
                    })
                    .join("\n");
                showToast(`Compressed:\n${summary}`, Toasts.Type.SUCCESS);
            }

            if (dropped.length > 0) {
                showToast(
                    `Couldn't compress ${dropped.join(", ")} below ${settings.store.targetMB ?? DEFAULT_TARGET_MB} MB – removed from your attachments.`,
                    Toasts.Type.FAILURE,
                );
            }

            if (finalFiles.length === 0) return;

            const channel = channelId ? ChannelStore.getChannel(channelId) : null;
            if (!channel) {
                showToast("Couldn't find the channel to add your image to.", Toasts.Type.FAILURE);
                return;
            }

            UploadHandler.promptToUpload(finalFiles, channel, draftType);
        } catch (err) {
            console.error("[ImageCompressor] Compression failed\n", err);
            showToast("Failed to compress image – it will not be added.", Toasts.Type.FAILURE);
        }
    })();
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export default definePlugin({
    name: "ImageCompressor",
    description: "Automatically compress images over 20 MB before sending so they don't get rejected by Discord",
    tags: ["Media", "Chat"],
    authors: [Devs.saraaa7447],
    settings,

    start() {
        if (fluxInterceptor) return;
        fluxInterceptor = action => {
            try {
                handleAction(action);
            } catch (err) {
                console.error("[ImageCompressor] Interceptor error\n", err);
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
