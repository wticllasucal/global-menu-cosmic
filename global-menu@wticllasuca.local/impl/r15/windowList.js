// A window switcher for the top bar: one click lists the open windows,
// most recently used first, and another click goes to the chosen one.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Windows a user thinks of as "open": no docks, no desktop, nothing that
// asks to be left out of task lists.
function listWindows() {
    return global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
        .filter(window => !window.is_skip_taskbar());
}

export const WindowListButton = GObject.registerClass(
class WindowListButton extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Windows');

        this.add_child(new St.Icon({
            icon_name: 'focus-windows-symbolic',
            style_class: 'system-status-icon',
        }));

        // The list scrolls when there are more windows than fit.
        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        const scrollView = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this.menu.box.remove_child(this._section.actor);
        scrollView.set_child(this._section.actor);
        this.menu.box.add_child(scrollView);

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) this._fill();
        });
        // The list is only kept while it is on screen.
        this._emptyId = 0;
        this.menu.connect('menu-closed', () => {
            if (this._emptyId) return;
            this._emptyId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._emptyId = 0;
                if (!this.menu.isOpen) this._clear();
                return GLib.SOURCE_REMOVE;
            });
        });
        // A menu with nothing in it would not open.
        this._clear();
    }

    _clear() {
        this._section.removeAll();
        const placeholder = new PopupMenu.PopupMenuItem('No Windows', { activate: false });
        placeholder.setSensitive(false);
        this._section.addMenuItem(placeholder);
    }

    _fill() {
        const windows = listWindows();
        if (windows.length === 0) {
            this._clear();
            return;
        }
        this._section.removeAll();

        const tracker = Shell.WindowTracker.get_default();
        const focused = global.display.get_focus_window();
        const activeWorkspace = global.workspace_manager.get_active_workspace();
        // Say where a window is only when there is more than one place.
        const showWorkspace = new Set(windows.map(w => w.get_workspace())).size > 1;

        for (const window of windows) {
            const app = tracker.get_window_app(window);
            const title = window.get_title() || app?.get_name() || 'Untitled';
            const item = new PopupMenu.PopupImageMenuItem(title, app?.get_icon() ?? 'application-x-executable-symbolic');
            item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            item.label.style = 'max-width: 26em;';
            if (window === focused)
                item.setOrnament(PopupMenu.Ornament.DOT);
            if (window.minimized)
                item.label.opacity = 150;

            const workspace = window.get_workspace();
            if (showWorkspace && workspace !== activeWorkspace && !window.is_on_all_workspaces()) {
                item.add_child(new St.Label({
                    text: `${workspace.index() + 1}`,
                    x_expand: true,
                    x_align: Clutter.ActorAlign.END,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: 'padding-left: 2em;',
                    opacity: 150,
                }));
            }

            // Brings the window up wherever it is: other workspace, minimized.
            item.connect('activate', () => Main.activateWindow(window));
            this._section.addMenuItem(item);
        }
    }

    destroy() {
        if (this._emptyId) {
            GLib.source_remove(this._emptyId);
            this._emptyId = 0;
        }
        this._section?.destroy();
        this._section = null;
        this.menu._activeMenuItem = null;
        super.destroy();
    }
});
