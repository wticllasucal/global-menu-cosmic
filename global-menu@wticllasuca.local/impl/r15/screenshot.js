// A screenshot button for the top bar. One click does the chosen capture
// (by default it opens GNOME's capture overlay, with whatever an extension
// such as Gradia Capture adds to it); a secondary click offers the rest.
//
// Everything is done by GNOME Shell's own screenshot code: captures are
// saved and copied exactly as with the Print key.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import Gettext from 'gettext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { captureScreenshot } from 'resource:///org/gnome/shell/ui/screenshot.js';

// ScreenshotUI.open() modes (the shell does not export its UIMode).
const MODE_SCREENSHOT = 0;
const MODE_SCREENCAST = 1;

// Extensions whose preferences are the "capture settings", if installed.
const CAPTURE_EXTENSIONS = [
    'gradia-capture@wticllasuca.local',
    'gradia-integration@alexandervanhee.github.io',
];

// Long enough for a closing menu to be gone from the next frame.
const AFTER_MENU_MS = 80;

export const CLICK_ACTIONS = ['interactive', 'screen', 'window', 'menu'];

function screenshotsDir() {
    // The folder the shell saves to, named in the user's language.
    const name = Gettext.domain('gnome-shell').gettext('Screenshots');
    const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || GLib.get_home_dir();
    const dir = Gio.File.new_for_path(GLib.build_filenamev([pictures, name]));
    return dir.query_exists(null) ? dir : Gio.File.new_for_path(pictures);
}

export const ScreenshotButton = GObject.registerClass(
class ScreenshotButton extends PanelMenu.Button {
    _init(settings) {
        super._init(0.5, 'Screenshot');
        this._settings = settings;
        this._pressed = false;
        this._pendingId = 0;
        this._busy = false;

        this.add_child(new St.Icon({
            icon_name: 'screenshooter-symbolic',
            style_class: 'system-status-icon',
        }));

        // Clicks are handled in vfunc_event: the primary button acts at
        // once instead of opening the menu.
        this._clickGesture?.set_enabled(false);

        // No fade between normal and highlighted: the highlight has to be
        // gone in the very next frame, which is the one that gets captured.
        this.style = 'transition-duration: 0ms;';

        this._addItem('Capture Area or Window…', 'screenshot-ui-area-symbolic', () => this._run('interactive'));
        this._addItem('Capture Screen Now', 'screenshot-ui-display-symbolic', () => this._run('screen'));
        this._windowItem = this._addItem('Capture Active Window Now', 'screenshot-ui-window-symbolic', () => this._run('window'));
        this._recordItem = this._addItem('Record Screen…', 'record-screen-symbolic', () => this._run('record'));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._addItem('Open Screenshots Folder', 'folder-pictures-symbolic', () => this._openFolder());
        this._settingsItem = this._addItem('Capture Settings…', 'preferences-system-symbolic', () => this._openCaptureSettings());

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!isOpen) return;
            this._windowItem.setSensitive(!!global.display.focus_window);
            this._recordItem.visible = !!Main.screenshotUI._screencastSupported;
            this._settingsItem.visible = !!this._captureExtension();
        });

        this.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter || symbol === Clutter.KEY_space) {
                this._primary();
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_Down) {
                this.menu.open();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _addItem(label, icon, callback) {
        const item = new PopupMenu.PopupImageMenuItem(label, icon);
        item.connect('activate', callback);
        this.menu.addMenuItem(item);
        return item;
    }

    vfunc_event(event) {
        const type = event.type();

        if (type === Clutter.EventType.BUTTON_PRESS) {
            if (event.get_button() === Clutter.BUTTON_PRIMARY)
                this._pressed = true;
            else
                this.menu.toggle();
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.TOUCH_BEGIN) {
            this._pressed = true;
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END) {
            if (this._pressed) {
                this._pressed = false;
                this._primary();
            }
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.LEAVE || type === Clutter.EventType.TOUCH_CANCEL)
            this._pressed = false;

        return Clutter.EVENT_PROPAGATE;
    }

    _primary() {
        if (this.menu.isOpen) {
            this.menu.close();
            return;
        }

        let action = this._settings.get_string('screenshot-click-action');
        if (!CLICK_ACTIONS.includes(action))
            action = 'interactive';

        if (action === 'menu')
            this.menu.open();
        else
            this._run(action);
    }

    // Waits for an open menu to leave the screen, so it is not in the shot.
    _run(action) {
        if (this._pendingId)
            return;

        const go = () => {
            this._capture(action).catch(e => {
                console.error(`[global-menu] Screenshot failed: ${e.message}\n${e.stack}`);
                Main.notifyError('Screenshot failed', e.message);
            });
        };
        const afterMenu = () => {
            this._pendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AFTER_MENU_MS, () => {
                this._pendingId = 0;
                go();
                return GLib.SOURCE_REMOVE;
            });
        };

        if (this.menu.isOpen) {
            const id = this.menu.connect('menu-closed', () => {
                this.menu.disconnect(id);
                afterMenu();
            });
            this.menu.close();
        } else if (this.menu.actor.visible) {
            // Still fading out.
            afterMenu();
        } else {
            go();
        }
    }

    async _capture(action) {
        // One capture at a time: a second click while the first one is
        // being saved would only queue a duplicate.
        if (this._busy)
            return;
        this._busy = true;
        // The button would otherwise be captured highlighted, with the
        // pointer still on it.
        this.track_hover = false;
        this.hover = false;
        try {
            if (action === 'screen') {
                const shooter = new Shell.Screenshot();
                const [content] = await shooter.screenshot_stage_to_content();
                await captureScreenshot(content.get_texture(), null, 1, null);
            } else if (action === 'window' && global.display.focus_window) {
                const actor = global.display.focus_window.get_compositor_private();
                const content = actor.paint_to_content(null);
                await captureScreenshot(content.get_texture(), null, 1, null);
            } else if (action === 'record' && Main.screenshotUI._screencastSupported) {
                await Main.screenshotUI.open(MODE_SCREENCAST);
            } else {
                await Main.screenshotUI.open(MODE_SCREENSHOT);
            }
        } finally {
            this._busy = false;
            this.track_hover = true;
        }
    }

    _openFolder() {
        try {
            Gio.app_info_launch_default_for_uri(
                screenshotsDir().get_uri(), global.create_app_launch_context(0, -1));
        } catch (e) {
            Main.notifyError('Could not open the screenshots folder', e.message);
        }
    }

    _captureExtension() {
        return CAPTURE_EXTENSIONS.find(uuid => {
            const extension = Main.extensionManager.lookup(uuid);
            // 1: ExtensionState.ACTIVE
            return extension?.state === 1 && extension.hasPrefs;
        }) ?? null;
    }

    _openCaptureSettings() {
        const uuid = this._captureExtension();
        if (uuid)
            Main.extensionManager.openExtensionPrefs(uuid, '', {});
    }

    destroy() {
        if (this._pendingId) {
            GLib.source_remove(this._pendingId);
            this._pendingId = 0;
        }
        this.menu._activeMenuItem = null;
        super.destroy();
    }
});
