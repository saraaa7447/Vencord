/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 saraaa7447
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcEvents } from "@shared/IpcEvents";
import { BrowserWindow, type IpcMainInvokeEvent, type NativeImage, nativeImage, net, TouchBar, type WebContents } from "electron";

// Electron only type-exports these classes, so we grab their constructors at runtime
const { TouchBarPopover, TouchBarScrubber } = require("electron") as {
    TouchBarPopover: typeof Electron.TouchBarPopover;
    TouchBarScrubber: typeof Electron.TouchBarScrubber;
};

export interface TouchBarAction {
    type: "openGuild" | "openUser";
    id: string;
    name: string;
}

export interface TouchBarPerson {
    name: string;
    iconUrl?: string;
    action: TouchBarAction;
}

export interface TouchBarGuild {
    id: string;
    name: string;
    iconUrl?: string;
    people: TouchBarPerson[];
}

export interface TouchBarData {
    guilds: TouchBarGuild[];
    dms: TouchBarPerson[];
}

const ICON_SIZE = 32;

function sendAction(sender: WebContents, action?: TouchBarAction) {
    if (action) sender.send(IpcEvents.TOUCHBAR_ACTION, action);
}

async function loadNativeImage(url?: string): Promise<NativeImage | null> {
    if (!url) return null;
    try {
        const res = await net.fetch(url);
        if (!res.ok) return null;
        const image = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
        return image.isEmpty() ? null : image;
    } catch {
        return null;
    }
}

function makeScrubber(sender: WebContents, people: TouchBarPerson[]): Electron.TouchBarScrubber {
    const items = people.map(p => ({ label: p.name, icon: nativeImage.createEmpty() }));
    const scrubber = new TouchBarScrubber({
        items,
        mode: "free",
        select: index => sendAction(sender, people[index]?.action)
    });

    for (const [index, person] of people.entries()) {
        loadNativeImage(person.iconUrl).then(image => {
            if (!image) return;
            const icon = image.resize({ width: ICON_SIZE, height: ICON_SIZE, quality: "best" });
            items[index] = { label: person.name, icon };
            // Electron only syncs the control when the items array is reassigned
            scrubber.items = items;
        });
    }

    return scrubber;
}

function makePopover(sender: WebContents, label: string, iconUrl: string | undefined, people: TouchBarPerson[]) {
    const popover = new TouchBarPopover({
        label,
        showCloseButton: true,
        items: new TouchBar({ items: [makeScrubber(sender, people)] })
    });

    loadNativeImage(iconUrl).then(image => {
        if (image) popover.icon = image.resize({ width: ICON_SIZE, height: ICON_SIZE, quality: "best" });
    });

    return popover;
}

export function updateTouchBar(event: IpcMainInvokeEvent, data: TouchBarData) {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;

    const popovers: Electron.TouchBarPopover[] = [];

    for (const guild of data.guilds) {
        const people: TouchBarPerson[] = [
            { name: guild.name, iconUrl: guild.iconUrl, action: { type: "openGuild", id: guild.id, name: guild.name } },
            ...guild.people
        ];
        popovers.push(makePopover(event.sender, guild.name, guild.iconUrl, people));
    }

    if (data.dms.length) {
        popovers.push(makePopover(event.sender, "DMs", undefined, data.dms));
    }

    win.setTouchBar(new TouchBar({ items: popovers }));
}

export function hideTouchBar(event: IpcMainInvokeEvent) {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    win.setTouchBar(null);
}
