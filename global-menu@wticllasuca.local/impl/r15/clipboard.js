// Clipboard history, in the spirit of the one in recent macOS: what was
// copied lately, searchable, one click to paste it again.
//
// What is copied can be private, so the history lives in memory only (it
// is gone when the session ends), entries expire, anything marked as
// coming from a password manager is skipped, and it can be paused.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Larger texts are left alone: they are data, not something to pick from a list.
const MAX_ENTRY_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const PREVIEW_LENGTH = 70;
// Set by password managers on what they put on the clipboard.
const PASSWORD_HINT = 'x-kde-passwordManagerHint';
// A copy is announced in steps, and the hint may only be in the last one;
// wait for the announcements to settle before looking.
const CAPTURE_DELAY_MS = 250;

const RETENTION_SECONDS = {
    '30m': 30 * 60,
    '8h': 8 * 60 * 60,
    '7d': 7 * 24 * 60 * 60,
    'session': Infinity,
};

export class ClipboardHistory {
    // store: an object that outlives this instance (reloads, screen lock),
    // but not the session.
    constructor(settings, store) {
        this._settings = settings;
        this._store = store;
        store.entries ??= [];
        store.paused ??= false;
        this._listeners = new Set();
        this._selection = global.display.get_selection();
        this._captureId = 0;
        this._ownerChangedId = this._selection.connect('owner-changed', (_selection, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._queueCapture();
        });
    }

    _queueCapture() {
        if (this._captureId)
            GLib.source_remove(this._captureId);
        this._captureId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CAPTURE_DELAY_MS, () => {
            this._captureId = 0;
            this._capture();
            return GLib.SOURCE_REMOVE;
        });
    }

    _isSecret() {
        return this._selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD)
            .includes(PASSWORD_HINT);
    }

    get paused() {
        return this._store.paused;
    }

    set paused(paused) {
        this._store.paused = paused;
        this._changed();
    }

    onChanged(callback) {
        this._listeners.add(callback);
        return () => this._listeners.delete(callback);
    }

    _changed() {
        this._listeners.forEach(callback => callback());
    }

    _capture() {
        if (this._store.paused || this._isSecret()) return;

        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
            // Checked again: the clipboard may have changed hands meanwhile.
            if (this._store && !this._store.paused && !this._isSecret())
                this._add(text);
        });
    }

    _add(text) {
        if (typeof text !== 'string' || text.trim() === '') return;
        if (text.length > MAX_ENTRY_BYTES) return;

        const entries = this._store.entries;
        const existing = entries.findIndex(entry => entry.text === text);
        if (existing !== -1) entries.splice(existing, 1);
        entries.unshift({ text, time: GLib.get_real_time() / 1e6 });
        this._prune();
        this._changed();
    }

    // Drops what is too old or too much.
    _prune() {
        const entries = this._store.entries;
        const retention = RETENTION_SECONDS[this._settings.get_string('clipboard-retention')] ?? RETENTION_SECONDS['8h'];
        const now = GLib.get_real_time() / 1e6;
        const limit = this._settings.get_int('clipboard-history-size');

        let total = 0;
        let keep = 0;
        for (const entry of entries) {
            total += entry.text.length;
            if (keep >= limit || total > MAX_TOTAL_BYTES || now - entry.time > retention) break;
            keep++;
        }
        entries.length = keep;
    }

    entries() {
        this._prune();
        return this._store.entries;
    }

    // Puts an entry back on the clipboard.
    select(entry) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, entry.text);
    }

    clear() {
        this._store.entries.length = 0;
        this._changed();
    }

    destroy() {
        if (this._captureId) {
            GLib.source_remove(this._captureId);
            this._captureId = 0;
        }
        this._selection.disconnect(this._ownerChangedId);
        this._listeners.clear();
        // The entries stay in the store for the next instance.
        this._store = null;
    }
}

// "3 min", "2 h": how long ago something was copied.
function formatAge(seconds) {
    if (seconds < 60) return 'now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
    return `${Math.floor(seconds / 86400)} d`;
}

function preview(text) {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH - 1)}…` : line;
}

// The clipboard button in the top bar and its menu.
export const ClipboardButton = GObject.registerClass(
class ClipboardButton extends PanelMenu.Button {
    // onPaste: called after an entry was put back on the clipboard, to
    // paste it into the focused window.
    _init(history, onPaste) {
        super._init(0.5, 'Clipboard History');
        this._history = history;
        this._onPaste = onPaste;

        this.add_child(new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        }));

        const searchItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        this._search = new St.Entry({
            hint_text: 'Search',
            x_expand: true,
            can_focus: true,
            style: 'min-width: 22em;',
        });
        // Only when the query really changes: the list must not be rebuilt
        // under the pointer because the field lost the keyboard focus.
        this._query = null;
        this._search.clutter_text.connect('text-changed', () => {
            if (this._search.get_text().trim().toLowerCase() !== this._query)
                this._fill();
        });
        this._search.clutter_text.connect('key-press-event', (_text, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Down)
                return Clutter.EVENT_PROPAGATE;
            this._section.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
            return Clutter.EVENT_STOP;
        });
        searchItem.add_child(this._search);
        this.menu.addMenuItem(searchItem);

        // The list scrolls; the search field and the footer stay put.
        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        const scrollView = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            style: 'max-height: 26em;',
        });
        this.menu.box.remove_child(this._section.actor);
        scrollView.set_child(this._section.actor);
        this.menu.box.add_child(scrollView);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._pauseItem = new PopupMenu.PopupSwitchMenuItem('Pause History', history.paused);
        this._pauseItem.connect('toggled', (_item, paused) => (this._history.paused = paused));
        this.menu.addMenuItem(this._pauseItem);
        const clearItem = new PopupMenu.PopupMenuItem('Clear History');
        clearItem.connect('activate', () => this._history.clear());
        this.menu.addMenuItem(clearItem);

        this._stopListening = history.onChanged(() => {
            if (this.menu.isOpen) this._fill();
        });
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                this._query = null;
                this._search.set_text('');
                this._pauseItem.setToggleState(this._history.paused);
                if (this._query === null) this._fill();
                this._search.grab_key_focus();
            }
        });
        // Nothing copied stays in actors while the menu is closed. Emptied
        // once it has finished closing: changing it while it fades out
        // would move other items under the pointer.
        this._emptyId = 0;
        this.menu.connect('menu-closed', () => {
            if (this._emptyId) return;
            this._emptyId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._emptyId = 0;
                if (!this.menu.isOpen) this._section.removeAll();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _fill() {
        this._section.removeAll();

        const query = this._search.get_text().trim().toLowerCase();
        this._query = query;
        const now = GLib.get_real_time() / 1e6;
        const entries = this._history.entries()
            .filter(entry => !query || entry.text.toLowerCase().includes(query));

        if (entries.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(
                query ? 'No matches' : 'Nothing copied yet', { activate: false });
            empty.setSensitive(false);
            this._section.addMenuItem(empty);
            return;
        }

        for (const entry of entries) {
            const item = new PopupMenu.PopupMenuItem(preview(entry.text));
            item.add_child(new St.Label({
                text: formatAge(now - entry.time),
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'padding-left: 2em;',
                opacity: 150,
            }));
            item.connect('activate', () => {
                this._history.select(entry);
                this._onPaste?.();
            });
            this._section.addMenuItem(item);
        }
    }

    destroy() {
        if (this._emptyId) {
            GLib.source_remove(this._emptyId);
            this._emptyId = 0;
        }
        this._stopListening?.();
        this._stopListening = null;
        this._section?.destroy();
        this._section = null;
        this.menu._activeMenuItem = null;
        super.destroy();
    }
});
