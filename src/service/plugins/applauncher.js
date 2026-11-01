// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import Plugin from '../plugin.js';


export const Metadata = {
    label: _('App Launcher'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.AppLauncher',
    description: _('Let the paired device browse and launch the applications installed on this PC'),
    incomingCapabilities: ['kdeconnect.applauncher.request'],
    outgoingCapabilities: ['kdeconnect.applauncher'],
    actions: {},
};


// Icons are sent inline as base64, a few per packet to keep packets small
const ICONS_PER_PACKET = 20;
const DEFAULT_ICON_SIZE = 96;
const MIN_ICON_SIZE = 16;
const MAX_ICON_SIZE = 256;

// The app database changes in bursts during installs, so wait for it to settle
const APPS_CHANGED_DELAY = 2; // seconds


/**
 * App Launcher Plugin
 *
 * The device asks for the applications shown in the app grid, their icons, and
 * to launch one of them by its desktop file ID. Only IDs from that same list
 * are launched, so the device can't run arbitrary commands.
 */
const AppLauncherPlugin = GObject.registerClass({
    GTypeName: 'GSConnectAppLauncherPlugin',
}, class AppLauncherPlugin extends Plugin {

    _init(device) {
        super._init(device, 'applauncher');

        this._appsChangedId = 0;
        this._monitor = Gio.AppInfoMonitor.get();
        this._monitorId = this._monitor.connect(
            'changed',
            this._onAppsChanged.bind(this)
        );
    }

    handlePacket(packet) {
        if (packet.body.requestAppList)
            this._sendAppList();

        else if (Array.isArray(packet.body.requestIcons))
            this._sendIcons(packet.body.requestIcons, packet.body.iconSize);

        else if (typeof packet.body.launch === 'string')
            this._handleLaunch(packet.body.launch);
    }

    /**
     * The applications a user can see in the app grid, by desktop file ID
     *
     * @returns {Map<string, Gio.DesktopAppInfo>} The visible applications
     */
    _getApps() {
        const apps = new Map();

        for (const app of Gio.AppInfo.get_all()) {
            const id = app.get_id();

            if (id && app.should_show())
                apps.set(id, app);
        }

        return apps;
    }

    _onAppsChanged() {
        if (this._appsChangedId)
            GLib.source_remove(this._appsChangedId);

        this._appsChangedId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT_IDLE,
            APPS_CHANGED_DELAY,
            () => {
                this._appsChangedId = 0;
                this._sendAppList();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _sendAppList() {
        const appList = [];

        for (const [id, app] of this._getApps()) {
            const entry = {id: id, name: app.get_name()};
            const icon = app.get_icon();

            // Lets the device tell when a cached icon is stale
            if (icon)
                entry.icon = icon.to_string();

            appList.push(entry);
        }

        appList.sort((a, b) => a.name.localeCompare(b.name));

        this.device.sendPacket({
            type: 'kdeconnect.applauncher',
            body: {appList: appList},
        });
    }

    /**
     * The desktop's icon theme. Without a display there is no default theme,
     * so fall back to one named by the desktop settings.
     *
     * @returns {Gtk.IconTheme} The icon theme
     */
    _getIconTheme() {
        if (Gdk.Screen.get_default() !== null)
            return Gtk.IconTheme.get_default();

        if (this._iconTheme === undefined) {
            this._iconTheme = new Gtk.IconTheme();

            const schema = Gio.SettingsSchemaSource.get_default()
                ?.lookup('org.gnome.desktop.interface', true);

            if (schema) {
                const settings = new Gio.Settings({settings_schema: schema});
                this._iconTheme.set_custom_theme(settings.get_string('icon-theme'));
            }
        }

        return this._iconTheme;
    }

    /**
     * Render an application's icon as a base64 encoded PNG
     *
     * @param {Gio.AppInfo} app - The application
     * @param {number} size - The icon size, in pixels
     * @returns {string|null} The encoded icon, or %null if it has none
     */
    _renderIcon(app, size) {
        const theme = this._getIconTheme();
        const icon = app.get_icon();

        if (icon === null)
            return null;

        try {
            const info = theme.lookup_by_gicon(icon, size,
                Gtk.IconLookupFlags.FORCE_SIZE);

            if (info === null)
                return null;

            const [, buffer] = info.load_icon().save_to_bufferv('png', [], []);
            return GLib.base64_encode(buffer);
        } catch (e) {
            debug(e, `${this.device.name}: ${app.get_id()}`);
            return null;
        }
    }

    /**
     * Send the icons for the requested applications. Unknown IDs and
     * applications without an icon are left out.
     *
     * @param {string[]} ids - Desktop file IDs
     * @param {number} [iconSize] - The icon size, in pixels
     */
    async _sendIcons(ids, iconSize) {
        const apps = this._getApps();
        const size = Number.isInteger(iconSize)
            ? Math.min(Math.max(iconSize, MIN_ICON_SIZE), MAX_ICON_SIZE)
            : DEFAULT_ICON_SIZE;
        let icons = {};
        let count = 0;

        for (const id of new Set(ids)) {
            const app = apps.get(id);
            const data = app ? this._renderIcon(app, size) : null;

            if (data === null)
                continue;

            icons[id] = data;

            if (++count === ICONS_PER_PACKET) {
                this._sendIconPacket(icons, size);
                icons = {};
                count = 0;

                // Rendering is synchronous, so let the service breathe
                await new Promise(resolve => {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        resolve();
                        return GLib.SOURCE_REMOVE;
                    });
                });
            }
        }

        if (count > 0)
            this._sendIconPacket(icons, size);
    }

    _sendIconPacket(icons, size) {
        this.device.sendPacket({
            type: 'kdeconnect.applauncher',
            body: {icons: icons, iconSize: size},
        });
    }

    /**
     * Launch an application by its desktop file ID, if it's one we'd list
     *
     * @param {string} id - A desktop file ID
     */
    _handleLaunch(id) {
        let success = false;

        try {
            const app = this._getApps().get(id);

            if (app === undefined) {
                throw new Gio.IOErrorEnum({
                    code: Gio.IOErrorEnum.PERMISSION_DENIED,
                    message: `Unknown application: ${id}`,
                });
            }

            success = this._launchApp(app);
        } catch (e) {
            logError(e, this.device.name);
        }

        this.device.sendPacket({
            type: 'kdeconnect.applauncher',
            body: {launched: id, success: success},
        });
    }

    /**
     * Launch an application
     *
     * @param {Gio.AppInfo} app - The application
     * @returns {boolean} %true on success
     */
    _launchApp(app) {
        const display = Gdk.Display.get_default();
        const context = display ? display.get_app_launch_context() : null;

        return app.launch([], context);
    }

    destroy() {
        if (this._appsChangedId)
            GLib.source_remove(this._appsChangedId);

        this._monitor.disconnect(this._monitorId);

        super.destroy();
    }
});

export default AppLauncherPlugin;
