import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { MenuManager } from './menuManager.js';
import { ClipboardHistory, ClipboardButton } from './clipboard.js';
import { WindowListButton } from './windowList.js';
import { ScreenshotButton } from './screenshot.js';
import { KeySender } from './nativeMenus.js';
import { SystemMenuButton } from './systemMenu.js';
import { useRegistrationStore } from './realMenu.js';

// The extension itself. It is instantiated by the loader in ../../extension.js,
// which hands over the Extension object and a store that outlives reloads.
export class GlobalMenu {
    constructor(extension, store) {
        this._extension = extension;
        this.uuid = extension.uuid;
        this.path = extension.path;
        useRegistrationStore(store);
        // The clipboard history outlives reloads and the lock screen, in
        // memory; it is never written anywhere.
        store.clipboard ??= {};
        this._clipboardStore = store.clipboard;
        this._clipboard = null;
        this._clipboardButton = null;
        this._clipboardKeys = null;
        this._windowListButton = null;
        this._screenshotButton = null;
        this._menuManager = null;
        this._settings = null;
        this._settingsChangedId = null;
        this._logoButton = null;
        this._overviewHidden = false;
        this._clockMoved = false;
    }

    enable() {
        console.log(`[${this.uuid}] Enabling extension.`);

        this._settings = this._extension.getSettings();

        const uuid = this.uuid;

        this._menuManager = new MenuManager(uuid, this._settings, this.path);

        const ICON_ONLY_KEYS = ['logo-icon-name', 'logo-custom-icon-path', 'logo-distro-icon', 'logo-distro-icon-symbolic', 'logo-icon-size'];

        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'hide-overview-button') {
                this._syncOverviewButton();
            } else if (key.startsWith('window-list-')) {
                if (key === 'window-list-enabled') {
                    this._syncWindowList();
                    this._syncScreenshot(true);
                }
            } else if (key.startsWith('screenshot-')) {
                if (key === 'screenshot-button-enabled') this._syncScreenshot();
            } else if (key.startsWith('clipboard-')) {
                if (key === 'clipboard-enabled') {
                    this._syncClipboard();
                    // They keep their places right after the clipboard.
                    this._syncWindowList(true);
                    this._syncScreenshot(true);
                }
            } else if (key === 'clock-position') {
                this._syncClockPosition();
                // The room left for the menus changed with it.
                this._syncMenuVisibility();
            } else if (key === 'show-logo-menu') {
                this._syncLogoButton();
            } else if (!ICON_ONLY_KEYS.includes(key)) {
                // Any other key (menu toggles, custom menus, indicator,
                // logo-menu item toggles) affects what the bar should show
                // right now. Icon-only keys are handled internally by
                // SystemMenuButton itself.
                this._syncMenuVisibility();
            }
        });

        global.display.connectObject('notify::focus-window', () => {
            if (this._settings.get_boolean('show-indicator'))
                this._menuManager?.focusChanged(global.display.get_focus_window());
        }, this);

        // The panel puts its items back where the session mode says
        // whenever that mode changes.
        Main.sessionMode.connectObject('updated', () => this._syncClockPosition(), this);

        this._syncLogoButton();
        this._syncOverviewButton();
        this._syncClockPosition();
        this._syncMenuVisibility();
        this._syncClipboard();
        this._syncWindowList();
        this._syncScreenshot();
        this._adoptPending().catch(e => console.error(`[${this.uuid}] Could not load pending extensions: ${e}`));
    }

    // An extension installed while the session runs is unknown to the shell
    // until the next login. Its UUID, written to the file adopt-once in
    // this extension's directory, gets it loaded on the next enable() the
    // way the shell itself loads extensions at startup. The file is used
    // once and removed.
    async _adoptPending() {
        const path = GLib.build_filenamev([this.path, 'adopt-once']);
        let contents;
        try {
            [, contents] = GLib.file_get_contents(path);
        } catch {
            return;
        }
        GLib.unlink(path);

        const manager = Main.extensionManager;
        for (const uuid of new TextDecoder().decode(contents).split('\n').map(l => l.trim())) {
            if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(uuid) || manager.lookup(uuid))
                continue;
            const dir = Gio.File.new_for_path(
                GLib.build_filenamev([global.userdatadir, 'extensions', uuid]));
            if (!dir.get_child('metadata.json').query_exists(null))
                continue;
            console.log(`[${this.uuid}] Loading newly installed extension ${uuid}.`);
            // 2: ExtensionType.PER_USER
            await manager.loadExtension(manager.createExtensionObject(uuid, dir, 2));
        }
    }

    // The screenshot button comes after the clipboard and the window
    // switcher.
    _syncScreenshot(replace = false) {
        let enabled = this._settings?.get_boolean('screenshot-button-enabled') ?? false;
        if (this._screenshotButton && (!enabled || replace)) {
            this._screenshotButton.destroy();
            this._screenshotButton = null;
        }
        if (enabled && !this._screenshotButton) {
            this._screenshotButton = new ScreenshotButton(this._settings);
            Main.panel.addToStatusArea('global-menu-screenshot', this._screenshotButton,
                (this._clipboardButton ? 1 : 0) + (this._windowListButton ? 1 : 0), 'right');
        }
    }

    // The window switcher sits right after the clipboard button.
    _syncWindowList(replace = false) {
        let enabled = this._settings?.get_boolean('window-list-enabled') ?? false;
        if (this._windowListButton && (!enabled || replace)) {
            Main.wm.removeKeybinding('window-list-shortcut');
            this._windowListButton.destroy();
            this._windowListButton = null;
        }
        if (enabled && !this._windowListButton) {
            this._windowListButton = new WindowListButton();
            Main.panel.addToStatusArea('global-menu-windows', this._windowListButton,
                this._clipboardButton ? 1 : 0, 'right');
            Main.wm.addKeybinding('window-list-shortcut', this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._windowListButton?.menu.toggle());
        }
    }

    _syncClipboard() {
        let enabled = this._settings?.get_boolean('clipboard-enabled') ?? false;
        if (enabled && !this._clipboard) {
            this._clipboard = new ClipboardHistory(this._settings, this._clipboardStore);
            this._clipboardKeys = new KeySender();
            this._clipboardButton = new ClipboardButton(this._clipboard, () => this._pasteClipboard());
            Main.panel.addToStatusArea('global-menu-clipboard', this._clipboardButton, 0, 'right');
            Main.wm.addKeybinding('clipboard-shortcut', this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._clipboardButton?.menu.toggle());
        } else if (!enabled && this._clipboard) {
            Main.wm.removeKeybinding('clipboard-shortcut');
            this._clipboardButton.destroy();
            this._clipboardButton = null;
            this._clipboardKeys.destroy();
            this._clipboardKeys = null;
            this._clipboard.destroy();
            this._clipboard = null;
        }
    }

    // Choosing an entry pastes it, as picking it from a menu suggests.
    _pasteClipboard() {
        if (!this._settings.get_boolean('clipboard-paste-on-select')) return;
        let window = global.display.get_focus_window();
        if (!window) return;
        // Terminals keep Ctrl+V for the shell.
        let identity = `${window.get_wm_class() ?? ''} ${window.get_wm_class_instance() ?? ''}`;
        let isTerminal = /ptyxis|terminal|console|kgx|tilix|konsole|alacritty|kitty|foot|wezterm/i.test(identity);
        this._clipboardKeys.send(isTerminal ? '<Control><Shift>v' : '<Control>v');
    }

    // Moves the clock out of the center so that the menu bar and the clock
    // do not compete for the middle of the panel.
    _syncClockPosition() {
        let dateMenu = Main.panel.statusArea['dateMenu'];
        if (!dateMenu) return;

        let position = this._settings ? this._settings.get_string('clock-position') : 'center';
        let container = dateMenu.container;
        let rightBox = Main.panel._rightBox;
        let targetBox = position === 'center' ? Main.panel._centerBox : rightBox;

        if (position === 'center' && !this._clockMoved) return;

        container.get_parent()?.remove_child(container);
        if (position === 'right') {
            // Just before the system indicators (network, volume, battery).
            let quickSettings = Main.panel.statusArea['quickSettings'];
            let index = quickSettings
                ? rightBox.get_children().indexOf(quickSettings.container)
                : -1;
            targetBox.insert_child_at_index(container, index);
        } else if (position === 'far-right') {
            targetBox.add_child(container);
        } else {
            targetBox.insert_child_at_index(container, 0);
        }
        this._clockMoved = position !== 'center';

        // In the center the clock keeps wide margins on both sides. Next
        // to the system indicators that reads as a hole, so close up the
        // side that faces them: drop the clock's padding there, and trim
        // the indicators' own padding, giving it back on their far side.
        let facing = { 'right': 'right', 'far-right': 'left' }[position];
        dateMenu.style = facing ? '-natural-hpadding: 0px; -minimum-hpadding: 0px;' : null;
        dateMenu._clockDisplay?.set_style(facing
            ? `padding-${facing}: 0px; padding-${facing === 'left' ? 'right' : 'left'}: 12px;`
            : null);

        let quickSettings = Main.panel.statusArea['quickSettings'];
        if (quickSettings) {
            const TRIMMED = 4;
            quickSettings.style = null;
            let themed = quickSettings.get_theme_node().get_length('-natural-hpadding');
            let giveBack = Math.max(0, themed - TRIMMED);
            if (facing)
                quickSettings.style = `-natural-hpadding: ${TRIMMED}px; -minimum-hpadding: ${TRIMMED}px;`;
            // As a style, not as an actor margin: St resets those from CSS.
            let farSide = { 'right': 'right', 'far-right': 'left' }[position];
            quickSettings.container.style = farSide && giveBack > 0
                ? `margin-${farSide}: ${giveBack}px;`
                : null;
            // A panel button picks up new padding when its style is
            // resolved, but does not ask for a new layout by itself.
            quickSettings.ensure_style();
            quickSettings.queue_relayout();
        }
    }

    _syncLogoButton() {
        let shouldShow = this._settings.get_boolean('show-logo-menu');

        if (shouldShow && !this._logoButton) {
            this._logoButton = new SystemMenuButton(this._settings, this.path);
            Main.panel.addToStatusArea('globalmenu-logo', this._logoButton, 0, 'left');
        } else if (!shouldShow && this._logoButton) {
            this._logoButton.destroy();
            this._logoButton = null;
        }
    }

    _syncOverviewButton() {
        let activities = Main.panel.statusArea['activities'];
        if (!activities) return;

        let shouldHide = this._settings.get_boolean('hide-overview-button');
        if (shouldHide && !this._overviewHidden) {
            activities.hide();
            this._overviewHidden = true;
        } else if (!shouldHide && this._overviewHidden) {
            activities.show();
            this._overviewHidden = false;
        }
    }

    _syncMenuVisibility() {
        if (!this._menuManager) return;

        if (this._settings.get_boolean('show-indicator')) {
            let activeWindow = global.display.get_focus_window();
            this._menuManager.updateMenuForWindow(activeWindow);
        } else {
            this._menuManager.clear();
        }
    }

    disable() {
        console.log(`[${this.uuid}] Disabling extension.`);

        global.display.disconnectObject(this);

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        if (this._menuManager) {
            this._menuManager.destroy();
            this._menuManager = null;
        }

        if (this._logoButton) {
            this._logoButton.destroy();
            this._logoButton = null;
        }

        if (this._overviewHidden) {
            let activities = Main.panel.statusArea['activities'];
            if (activities) activities.show();
            this._overviewHidden = false;
        }

        Main.sessionMode.disconnectObject(this);
        this._settings = null;
        this._syncClockPosition();
        this._syncClipboard();
        this._syncWindowList();
        this._syncScreenshot();
    }
}
