/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 saraaa7447
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { ChannelRouter, ChannelStore, FluxDispatcher, GuildMemberStore, GuildStore, NavigationRouter, UserStore } from "@webpack/common";

import type { TouchBarAction, TouchBarData, TouchBarGuild, TouchBarPerson } from "./native";

const Native = VencordNative.pluginHelpers.TouchBar as PluginNative<typeof import("./native")>;

const AVATAR_SIZE = 64;

const guildIconURL = (guildId: string, icon: string) =>
    `https://cdn.discordapp.com/icons/${guildId}/${icon}.png?size=${AVATAR_SIZE}`;

const settings = definePluginSettings({
    maxServers: {
        type: OptionType.SLIDER,
        default: 8,
        markers: [1, 2, 4, 6, 8, 12, 16, 24],
        description: "Maximum number of servers to show on the Touch Bar"
    },
    maxMembers: {
        type: OptionType.SLIDER,
        default: 12,
        markers: [0, 2, 4, 8, 12, 16, 24, 32],
        description: "Maximum number of members to list inside each server"
    },
    maxDms: {
        type: OptionType.SLIDER,
        default: 20,
        markers: [0, 5, 10, 15, 20, 30],
        description: "Maximum number of DMs to show"
    }
});

const REFRESH_EVENTS = [
    "CONNECTION_OPEN",
    "GUILD_CREATE",
    "GUILD_DELETE",
    "GUILD_UPDATE",
    "GUILD_MEMBERS_CHUNK",
    "GUILD_MEMBER_ADD",
    "GUILD_MEMBER_UPDATE",
    "GUILD_MEMBER_REMOVE",
    "CHANNEL_CREATE",
    "CHANNEL_DELETE",
    "CHANNEL_UPDATE",
    "RELATIONSHIP_ADD",
    "RELATIONSHIP_REMOVE",
    "USER_UPDATE"
] as const;

let refreshTimer: ReturnType<typeof setTimeout>;

function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshTouchBar, 500);
}

const onFlux = () => scheduleRefresh();

function refreshTouchBar() {
    let data: TouchBarData;
    try {
        data = buildTouchBarData();
    } catch (err) {
        console.error("[TouchBar] Failed to build Touch Bar data", err);
        return;
    }

    if (data.guilds.length || data.dms.length) {
        console.info(`[TouchBar] Updating Touch Bar with ${data.guilds.length} servers and ${data.dms.length} DMs`);
        Native.updateTouchBar(data)?.catch(err => console.error("[TouchBar] Failed to update Touch Bar", err));
    } else {
        Native.hideTouchBar()?.catch(err => console.error("[TouchBar] Failed to hide Touch Bar", err));
    }
}

function buildTouchBarData(): TouchBarData {
    const currentUserId = UserStore.getCurrentUser()?.id;
    const guilds: TouchBarGuild[] = [];

    for (const guild of Object.values(GuildStore.getGuilds())) {
        if (guilds.length >= settings.store.maxServers) break;

        const people: TouchBarPerson[] = [];
        for (const member of GuildMemberStore.getMembers(guild.id)) {
            if (people.length >= settings.store.maxMembers) break;
            if (member.userId === currentUserId) continue;

            const user = UserStore.getUser(member.userId);
            if (!user || user.bot) continue;

            const name = member.nick ?? user.globalName ?? user.username;
            people.push({
                name,
                iconUrl: user.getAvatarURL(undefined, AVATAR_SIZE, false),
                action: { type: "openUser", id: member.userId, name }
            });
        }

        guilds.push({
            id: guild.id,
            name: guild.name,
            iconUrl: guild.icon ? guildIconURL(guild.id, guild.icon) : undefined,
            people
        });
    }

    const dms: TouchBarPerson[] = [];
    for (const channel of ChannelStore.getSortedPrivateChannels()) {
        if (dms.length >= settings.store.maxDms) break;
        if (!channel.isDM()) continue;

        const userId = channel.recipients[0];
        const user = userId ? UserStore.getUser(userId) : null;
        if (!user || user.bot) continue;

        const name = user.globalName ?? user.username;
        dms.push({
            name,
            iconUrl: user.getAvatarURL(undefined, AVATAR_SIZE, false),
            action: { type: "openUser", id: userId, name }
        });
    }

    return { guilds, dms };
}

function handleAction(action: TouchBarAction) {
    if (action.type === "openGuild") {
        NavigationRouter.transitionToGuild(action.id);
        return;
    }

    const dmChannelId = ChannelStore.getDMFromUserId(action.id);
    if (dmChannelId) {
        ChannelRouter.transitionToChannel(dmChannelId);
    } else {
        NavigationRouter.transitionTo(`/channels/@me/${action.id}`);
    }
}

const focusHandler = () => scheduleRefresh();

export default definePlugin({
    name: "TouchBar",
    description: "Adds buttons for your servers and DMs to the macOS Touch Bar. Tapping a server or DM shows its members and lets you jump to them.",
    authors: [Devs.saraaa7447],
    settings,

    start() {
        VencordNative.touchBar.onAction(handleAction);
        for (const event of REFRESH_EVENTS) FluxDispatcher.subscribe(event, onFlux);
        window.addEventListener("focus", focusHandler);

        // Wait a moment so stores are populated after login before the first refresh
        refreshTimer = setTimeout(refreshTouchBar, 1000);
    },

    stop() {
        clearTimeout(refreshTimer);
        for (const event of REFRESH_EVENTS) FluxDispatcher.unsubscribe(event, onFlux);
        window.removeEventListener("focus", focusHandler);
        Native.hideTouchBar().catch(() => { });
    }
});
