// Real application menus for the global menu bar.
//
// Two menu formats are supported, which together cover every toolkit that
// can export its menu bar on a GNOME/Wayland session:
//
//  * GTK (org.gtk.Menus + org.gtk.Actions): the app hands the object
//    paths to the compositor and Mutter exposes them on the Meta.Window.
//    Used by GtkApplication menubars, appmenu-gtk-module and LibreOffice.
//  * DBusMenu (com.canonical.dbusmenu), whose address reaches us either
//    through the org_kde_kwin_appmenu Wayland protocol (native Wayland
//    clients: Chromium, Firefox, Qt 6; served by native/libgmappmenu.so)
//    or through com.canonical.AppMenu.Registrar (X11 clients and Qt),
//    both of which this extension provides.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { CascadeMenuItem } from './cascade.js';

const REGISTRAR_NAME = 'com.canonical.AppMenu.Registrar';
const REGISTRAR_PATH = '/com/canonical/AppMenu/Registrar';
const REGISTRAR_IFACE = `
<node>
  <interface name="com.canonical.AppMenu.Registrar">
    <method name="RegisterWindow">
      <arg type="u" name="windowId" direction="in"/>
      <arg type="o" name="menuObjectPath" direction="in"/>
    </method>
    <method name="UnregisterWindow">
      <arg type="u" name="windowId" direction="in"/>
    </method>
    <method name="GetMenuForWindow">
      <arg type="u" name="windowId" direction="in"/>
      <arg type="s" name="service" direction="out"/>
      <arg type="o" name="menuObjectPath" direction="out"/>
    </method>
  </interface>
</node>`;

const DBUSMENU_IFACE = 'com.canonical.dbusmenu';

const DBUSMENU_PROPERTIES = [
    'label', 'enabled', 'visible', 'type', 'toggle-type', 'toggle-state',
    'children-display', 'shortcut',
];

const PLACEHOLDER_LABEL = '…';
const REFRESH_DELAY_MS = 50;
// An app that keeps announcing changes is asked again at most this often,
// and less and less often while it does not stop.
const MIN_REFRESH_INTERVAL_MS = 300;
const MAX_REFRESH_INTERVAL_MS = 4000;
// An app whose menu cannot be read this many times in a row is left alone.
const MAX_FAILED_REFRESHES = 3;
const DBUS_TIMEOUT_MS = 3000;

// Menus are described by other processes, and none of it is trusted:
// these bound what a broken or hostile app can make the shell build.
const MAX_LABEL_LENGTH = 200;
const MAX_TITLE_LENGTH = 32;
const MAX_ITEMS_PER_MENU = 400;
const MAX_TOP_LEVEL_MENUS = 40;
const MAX_MENU_DEPTH = 12;
const MAX_NODES_PER_REPLY = 5000;
const MAX_REPLY_BYTES = 512 * 1024;
const MAX_REGISTRATIONS_PER_SENDER = 64;
const MAX_REGISTRATIONS = 1024;

// Text from an app, made safe to show: a string of sane length, on one line.
function cleanText(value) {
    if (typeof value !== 'string') return '';
    return value.slice(0, MAX_LABEL_LENGTH).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

// "_File" -> "File", "Save __As" -> "Save _As"
function stripMnemonic(label) {
    return cleanText(label).replace(/_(_?)/g, '$1');
}

// A menu's title in the bar, where room is scarce.
function cleanTitle(label) {
    const title = stripMnemonic(label);
    return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
}

// One item of a DBusMenu reply as plain, validated data. The reply is a
// tree of variants that may hold anything; only the properties used
// here are kept, each checked for its type.
function sanitizeDBusMenuNode(raw, budget, depth) {
    const [id, props, children] = raw;
    const clean = {};
    if (props && typeof props === 'object') {
        if (typeof props.label === 'string') clean.label = cleanText(props.label);
        if (props.enabled === false) clean.enabled = false;
        if (props.visible === false) clean.visible = false;
        if (props.type === 'separator') clean.type = 'separator';
        if (props['toggle-type'] === 'checkmark' || props['toggle-type'] === 'radio')
            clean['toggle-type'] = props['toggle-type'];
        if (Number.isInteger(props['toggle-state'])) clean['toggle-state'] = props['toggle-state'];
        if (props['children-display'] === 'submenu') clean['children-display'] = 'submenu';
        // A shortcut may be a sequence of key combinations (Ctrl+K Ctrl+O).
        const combos = Array.isArray(props.shortcut) ? props.shortcut.slice(0, 4) : [];
        if (combos.length > 0 && combos.every(combo => Array.isArray(combo) && combo.length > 0 &&
            combo.length <= 6 && combo.every(k => typeof k === 'string' && k.length <= 24)))
            clean.shortcut = combos;
    }

    const node = { id: Number.isInteger(id) ? id : 0, props: clean, children: [] };
    if (depth < MAX_MENU_DEPTH && Array.isArray(children)) {
        for (const child of children) {
            if (node.children.length >= MAX_ITEMS_PER_MENU || budget.nodes <= 0) break;
            if (!Array.isArray(child) || child.length !== 3) continue;
            budget.nodes--;
            node.children.push(sanitizeDBusMenuNode(child, budget, depth + 1));
        }
    }
    return node;
}

function addPlaceholder(menu) {
    const item = new PopupMenu.PopupMenuItem(PLACEHOLDER_LABEL, { activate: false });
    item.setSensitive(false);
    menu.addMenuItem(item);
}

// Runs release() once the menu has settled after closing. 'menu-closed'
// can arrive before the menu is marked closed (no animation) or long after
// (animation), by which time it may have been opened again.
function queueRelease(binding) {
    if (binding._releaseId) return;
    binding._releaseId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        binding._releaseId = 0;
        binding._release();
        return GLib.SOURCE_REMOVE;
    });
}

function cancelRelease(binding) {
    if (binding._releaseId) {
        GLib.source_remove(binding._releaseId);
        binding._releaseId = 0;
    }
}

// Empties a menu whose items may include the one under the pointer. The
// enclosing menus remember the active item even when it lives in a section
// or submenu, and would touch it after it is gone.
export function removeAllItems(menu) {
    const doomed = new Set(menu._getMenuItems());
    for (let m = menu; m; m = m._parent) {
        if (m._activeMenuItem)
            m._activeMenuItem.active = false;
    }
    menu.removeAll();
    // Destroying the item under the pointer hands the hover, and with it
    // the "active item", to the next one about to be destroyed.
    for (let m = menu; m; m = m._parent) {
        if (doomed.has(m._activeMenuItem))
            m._activeMenuItem = null;
    }
}

export function addAccelLabel(item, text) {
    if (!text) return;
    const label = new St.Label({
        text,
        x_expand: true,
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
        style: 'padding-left: 2em;',
        opacity: 150,
    });
    item.add_child(label);
}

const ACCEL_MODIFIERS = {
    primary: 'Ctrl', control: 'Ctrl', ctrl: 'Ctrl', shift: 'Shift',
    alt: 'Alt', mod1: 'Alt', super: 'Super', meta: 'Meta',
};

const KEY_SYMBOLS = {
    plus: '+', minus: '-', equal: '=', comma: ',', period: '.', slash: '/',
    backslash: '\\', semicolon: ';', apostrophe: "'", bracketleft: '[',
    bracketright: ']', grave: '`', question: '?', underscore: '_',
};

// Chromium sends some keys as the control character they produce.
const CONTROL_KEYS = {
    '\u001b': 'Esc', '\u007f': 'Delete', '\t': 'Tab', '\r': 'Enter', '\n': 'Enter',
    '\b': 'Backspace', ' ': 'Space',
};

function prettyKey(key) {
    if (CONTROL_KEYS[key]) return CONTROL_KEYS[key];
    if (key.length === 1) return key.toUpperCase();
    return KEY_SYMBOLS[key.toLowerCase()] ?? key.replace(/_/g, ' ');
}

// GTK accelerator syntax: "<Primary><Shift>s" -> "Ctrl+Shift+S"
export function formatGtkAccel(accel) {
    if (typeof accel !== 'string' || !accel || accel.length > 64) return '';
    const parts = [];
    const key = accel.replace(/<([^>]+)>/g, (_match, mod) => {
        parts.push(ACCEL_MODIFIERS[mod.toLowerCase()] ?? mod);
        return '';
    });
    if (!key) return '';
    parts.push(prettyKey(key));
    return parts.join('+');
}

// DBusMenu "shortcut" property: [["Control", "Shift", "S"]], or a sequence
// of such combinations to press one after the other.
function formatDBusMenuShortcut(shortcut) {
    if (!Array.isArray(shortcut))
        return '';
    return shortcut
        .filter(keys => Array.isArray(keys) && keys.length > 0)
        .map(keys => keys.map((k, i) => i === keys.length - 1
            ? prettyKey(k)
            : ACCEL_MODIFIERS[k.toLowerCase()] ?? k).join('+'))
        .join(' ');
}

// Registrations survive disable()/enable() cycles, and reloads of this
// code: Qt registers its menu bar only once, so forgetting it would leave
// those apps without any menu. The store is owned by the extension loader.
let registrationStore = { registrations: [], seq: 0 };

export function useRegistrationStore(store) {
    store.registrations ??= [];
    store.seq ??= 0;
    registrationStore = store;
}

// The registrar and the Wayland global belong to the shell process rather
// than to one enable() cycle: the shell disables extensions on the lock
// screen, and apps that saw them vanish would not all export again.
let sharedRegistrar = null;
let sharedWaylandAppmenu = null;
let waylandAppmenuLoad = null;

export function acquireRegistrar(onChanged) {
    if (!sharedRegistrar)
        sharedRegistrar = new AppMenuRegistrar();
    sharedRegistrar.setChangedCallback(onChanged);
    return sharedRegistrar;
}

export function releaseRegistrar(keepRunning) {
    if (!sharedRegistrar) return;
    sharedRegistrar.setChangedCallback(null);
    if (!keepRunning) {
        sharedRegistrar.destroy();
        sharedRegistrar = null;
    }
}

async function loadWaylandAppmenu(extensionPath) {
    const dir = GLib.build_filenamev([extensionPath, 'native']);
    if (!GLib.file_test(GLib.build_filenamev([dir, 'GmAppmenu-1.0.typelib']), GLib.FileTest.EXISTS))
        return null;

    const { default: GIRepository } = await import('gi://GIRepository');
    // GIRepository 3 has a default instance; version 2 used static methods.
    const repository = GIRepository.Repository.dup_default?.() ?? GIRepository.Repository;
    repository.prepend_search_path(dir);
    repository.prepend_library_path(dir);

    const { default: GmAppmenu } = await import('gi://GmAppmenu?version=1.0');
    return GmAppmenu.AppmenuManager.get_default(global.context.get_wayland_compositor());
}

// Resolves to the native appmenu manager with its Wayland global
// advertised, or to null when the helper is missing or cannot be loaded
// (for instance when it was built for another Mutter version).
export async function acquireWaylandAppmenu(extensionPath) {
    if (!sharedWaylandAppmenu) {
        waylandAppmenuLoad ??= loadWaylandAppmenu(extensionPath).catch(e => {
            console.warn(`[globalmenu] Wayland appmenu helper unavailable: ${e}`);
            return null;
        });
        sharedWaylandAppmenu = await waylandAppmenuLoad;
    }
    sharedWaylandAppmenu?.set_advertised(true);
    return sharedWaylandAppmenu;
}

export function releaseWaylandAppmenu(keepRunning) {
    if (!keepRunning)
        sharedWaylandAppmenu?.set_advertised(false);
}

class AppMenuRegistrar {
    constructor() {
        this._onChanged = null;
        this._registrations = registrationStore.registrations;
        registrationStore.registrations = [];

        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(REGISTRAR_IFACE, this);
        this._dbusImpl.export(Gio.DBus.session, REGISTRAR_PATH);

        this._nameOwnerChangedId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [name, , newOwner] = params.deepUnpack();
                if (newOwner === '' && name.startsWith(':'))
                    this._dropSender(name);
            });

        this._pruneDeadSenders();

        this._ownerId = Gio.DBus.session.own_name(
            REGISTRAR_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    }

    setChangedCallback(onChanged) {
        this._onChanged = onChanged;
    }

    RegisterWindowAsync(params, invocation) {
        const [windowId, path] = params;
        const sender = invocation.get_sender();

        this._registrations = this._registrations.filter(r =>
            !(r.sender === sender && r.windowId === windowId));
        // Any session client can call this; keep what one can pile up bounded.
        if (this._registrations.length >= MAX_REGISTRATIONS ||
            this._registrations.filter(r => r.sender === sender).length >= MAX_REGISTRATIONS_PER_SENDER) {
            invocation.return_dbus_error('com.canonical.AppMenu.Registrar.Error.LimitReached',
                'Too many registered menus');
            return;
        }
        const registration = { sender, path, windowId, pid: 0, seq: ++registrationStore.seq };
        this._registrations.push(registration);
        invocation.return_value(null);

        Gio.DBus.session.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'GetConnectionUnixProcessID', new GLib.Variant('(s)', [sender]),
            new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    [registration.pid] = conn.call_finish(res).deepUnpack();
                } catch (_e) {
                    // The sender is already gone; NameOwnerChanged drops it.
                }
                this._onChanged?.();
            });
    }

    UnregisterWindowAsync(params, invocation) {
        const [windowId] = params;
        const sender = invocation.get_sender();
        this._registrations = this._registrations.filter(r =>
            !(r.sender === sender && r.windowId === windowId));
        invocation.return_value(null);
        this._onChanged?.();
    }

    GetMenuForWindow(windowId) {
        const registration = this._registrations.findLast(r => r.windowId === windowId);
        return registration ? [registration.sender, registration.path] : ['', '/'];
    }

    _dropSender(sender) {
        const before = this._registrations.length;
        this._registrations = this._registrations.filter(r => r.sender !== sender);
        if (this._registrations.length !== before)
            this._onChanged?.();
    }

    _pruneDeadSenders() {
        for (const sender of new Set(this._registrations.map(r => r.sender))) {
            Gio.DBus.session.call(
                'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                'NameHasOwner', new GLib.Variant('(s)', [sender]),
                new GLib.VariantType('(b)'), Gio.DBusCallFlags.NONE, -1, null,
                (conn, res) => {
                    try {
                        const [hasOwner] = conn.call_finish(res).deepUnpack();
                        if (!hasOwner) this._dropSender(sender);
                    } catch (_e) {
                        this._dropSender(sender);
                    }
                });
        }
    }

    // Returns the {sender, path} of the menu registered for a window.
    lookup(window) {
        if (window.get_client_type() === Meta.WindowClientType.X11) {
            const match = /^0x([0-9a-f]+)/i.exec(window.get_description() ?? '');
            if (match) {
                const xid = parseInt(match[1], 16);
                // X11 window ids are public: only believe a registration
                // that comes from the process owning the window. Sandboxed
                // apps talk through a proxy, so their pids cannot match.
                const windowPid = window.get_pid();
                const registration = this._registrations.findLast(r => r.windowId === xid &&
                    (windowPid <= 0 || r.pid <= 0 || r.pid === windowPid ||
                     window.get_sandboxed_app_id() !== null));
                if (registration) return registration;
            }
        }

        const pid = window.get_pid();
        if (pid <= 0) return null;

        const candidates = this._registrations.filter(r => r.pid === pid);
        if (candidates.length <= 1) return candidates[0] ?? null;

        // Wayland clients register with an id the compositor cannot map to
        // a surface, so pair the windows and the registrations of a process
        // by creation order.
        const siblings = global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(w => w.get_pid() === pid && w.get_window_type() === Meta.WindowType.NORMAL)
            .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
        const index = siblings.indexOf(window);
        if (candidates.length === siblings.length && index >= 0)
            return candidates[index];
        return candidates[candidates.length - 1];
    }

    destroy() {
        if (this._ownerId) {
            Gio.DBus.session.unown_name(this._ownerId);
            this._ownerId = 0;
        }
        if (this._nameOwnerChangedId) {
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerChangedId);
            this._nameOwnerChangedId = 0;
        }
        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            this._dbusImpl = null;
        }
        registrationStore.registrations = this._registrations;
        this._registrations = [];
        this._onChanged = null;
    }
}

// Says where the window's real menu bar lives, or null when the app does
// not export one.
export function describeRealMenu(window, registrar, waylandAppmenu) {
    const busName = window.get_gtk_unique_bus_name();
    const menubarPath = window.get_gtk_menubar_object_path();
    if (busName && menubarPath)
        return { kind: 'gtk', busName, path: menubarPath };

    if (waylandAppmenu) {
        const [found, service, path] = waylandAppmenu.lookup(window);
        if (found && Gio.dbus_is_name(service) && GLib.Variant.is_object_path(path))
            return { kind: 'dbusmenu', busName: service, path };
    }

    const registration = registrar?.lookup(window);
    if (registration)
        return { kind: 'dbusmenu', busName: registration.sender, path: registration.path };

    return null;
}

export function createRealMenuSource(window, description) {
    return description.kind === 'gtk'
        ? new GtkMenuSource(window)
        : new DBusMenuSource(description.busName, description.path);
}

// The actions a GTK app exports on the bus (org.gtk.Actions). GTK 4 apps
// have no menu bar to mirror, but their actions are real and can be put in
// a menu: activating one is the same as using the app's own UI.
export class GtkAppActions {
    static supports(window) {
        return Boolean(window.get_gtk_unique_bus_name() &&
            (window.get_gtk_application_object_path() || window.get_gtk_window_object_path()));
    }

    constructor(window, onChanged) {
        const busName = window.get_gtk_unique_bus_name();
        this._onChanged = onChanged;
        this._groups = new Map();
        this._signals = [];
        this._changedId = 0;

        const paths = {
            app: window.get_gtk_application_object_path(),
            win: window.get_gtk_window_object_path(),
        };
        for (const [prefix, path] of Object.entries(paths)) {
            if (!path) continue;
            const group = Gio.DBusActionGroup.get(Gio.DBus.session, busName, path);
            for (const signal of ['action-added', 'action-removed'])
                this._signals.push([group, group.connect(signal, () => this._queueChanged())]);
            // The first query is what makes GDBusActionGroup fetch its actions.
            group.list_actions();
            this._groups.set(prefix, group);
        }
    }

    _queueChanged() {
        if (this._changedId) return;
        this._changedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY_MS, () => {
            this._changedId = 0;
            this._onChanged?.();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Only actions that can be triggered from a plain menu item: no
    // parameter, and either stateless or a boolean toggle.
    _isPlain(group, name) {
        if (group.get_action_parameter_type(name) !== null) return false;
        const state = group.get_action_state(name);
        return state === null || state.is_of_type(GLib.VariantType.new('b'));
    }

    has(prefix, name) {
        const group = this._groups.get(prefix);
        return Boolean(group?.has_action(name)) && this._isPlain(group, name);
    }

    list(prefix) {
        const group = this._groups.get(prefix);
        if (!group) return [];
        return group.list_actions().slice(0, MAX_ITEMS_PER_MENU)
            .filter(name => typeof name === 'string' && name.length <= MAX_LABEL_LENGTH && this._isPlain(group, name))
            .sort();
    }

    isEnabled(prefix, name) {
        return this._groups.get(prefix)?.get_action_enabled(name) ?? false;
    }

    // true/false for toggles, null for plain actions.
    getChecked(prefix, name) {
        return this._groups.get(prefix)?.get_action_state(name)?.get_boolean() ?? null;
    }

    activate(prefix, name) {
        this._groups.get(prefix)?.activate_action(name, null);
    }

    signature() {
        return JSON.stringify([this.list('app'), this.list('win')]);
    }

    destroy() {
        if (this._changedId) {
            GLib.source_remove(this._changedId);
            this._changedId = 0;
        }
        this._signals.forEach(([group, id]) => group.disconnect(id));
        this._signals = [];
        this._groups.clear();
        this._onChanged = null;
    }
}

// Keeps one PopupMenu (or submenu) in sync with a Gio.MenuModel. The menu
// items only exist while the menu is in use: they are built when it opens
// and, for a top-level menu, given back once it has closed.
class GtkMenuBinding {
    constructor(source, menu, model, submenuAction, isTopLevel) {
        this._source = source;
        this._menu = menu;
        this._model = model;
        this._submenuAction = submenuAction;
        this._modelSignals = [];
        this._children = [];
        this._entries = [];
        this._rebuildId = 0;
        this._signature = null;

        addPlaceholder(this._menu);

        this._openStateId = this._menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen && this._signature === null)
                this._rebuild();
            // Apps such as LibreOffice fill a submenu only once told that
            // it is about to be shown.
            if (this._submenuAction)
                this._source.setSubmenuShown(this._submenuAction, isOpen);
        });
        if (isTopLevel)
            this._closedId = this._menu.connect('menu-closed', () => queueRelease(this));
    }

    _unwatch() {
        this._modelSignals.forEach(([model, id]) => model.disconnect(id));
        this._modelSignals = [];
    }

    _scheduleRebuild() {
        if (this._rebuildId) return;
        const sinceLast = (GLib.get_monotonic_time() - (this._lastRebuild ?? 0)) / 1000;
        const delay = Math.max(REFRESH_DELAY_MS, Math.round(MIN_REFRESH_INTERVAL_MS - sinceLast));
        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._rebuildId = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearItems() {
        this._children.forEach(child => child.destroy());
        this._children = [];
        this._entries.forEach(entry => this._source.untrackItem(entry));
        this._entries = [];
    }

    _collect(model, out, depth = 0) {
        const id = model.connect('items-changed', () => this._scheduleRebuild());
        this._modelSignals.push([model, id]);

        const count = Math.min(model.get_n_items(), MAX_ITEMS_PER_MENU);
        for (let i = 0; i < count && out.length < MAX_ITEMS_PER_MENU; i++) {
            const section = model.get_item_link(i, Gio.MENU_LINK_SECTION);
            if (section) {
                // Sections may nest, even into themselves.
                if (depth >= MAX_MENU_DEPTH) continue;
                out.push({ type: 'separator' });
                this._collect(section, out, depth + 1);
                out.push({ type: 'separator' });
                continue;
            }

            const attribute = name =>
                model.get_item_attribute_value(i, name, GLib.VariantType.new('s'))?.unpack() ?? null;
            out.push({
                type: 'item',
                label: stripMnemonic(attribute(Gio.MENU_ATTRIBUTE_LABEL)),
                action: attribute(Gio.MENU_ATTRIBUTE_ACTION),
                target: model.get_item_attribute_value(i, Gio.MENU_ATTRIBUTE_TARGET, null),
                accel: attribute('accel'),
                hiddenWhen: attribute('hidden-when'),
                submenu: model.get_item_link(i, Gio.MENU_LINK_SUBMENU),
                submenuAction: attribute('submenu-action'),
            });
        }
    }

    _rebuild() {
        this._lastRebuild = GLib.get_monotonic_time();
        this._unwatch();
        const collected = [];
        this._collect(this._model, collected);

        // Apps re-send a menu every time it is shown; when nothing in it
        // changed, keep the items (their state is tracked per action).
        const signature = JSON.stringify(collected.map(entry => entry.type === 'separator' ? 0 : [
            entry.label, entry.action, entry.target?.print(true) ?? null, entry.accel,
            entry.hiddenWhen, Boolean(entry.submenu), entry.submenuAction,
        ]));
        if (signature === this._signature) return;
        this._signature = signature;

        this._clearItems();
        removeAllItems(this._menu);

        let pendingSeparator = false;
        let hasItems = false;
        for (const entry of collected) {
            if (entry.type === 'separator') {
                pendingSeparator = hasItems;
                continue;
            }
            if (!entry.label) continue;

            if (pendingSeparator) {
                this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                pendingSeparator = false;
            }
            hasItems = true;

            if (entry.submenu) {
                const item = new CascadeMenuItem(entry.label);
                this._menu.addMenuItem(item);
                this._children.push(new GtkMenuBinding(
                    this._source, item.menu, entry.submenu, entry.submenuAction, false));
                continue;
            }

            const item = new PopupMenu.PopupMenuItem(entry.label);
            addAccelLabel(item, formatGtkAccel(entry.accel));
            if (entry.action) {
                const tracked = {
                    item, action: entry.action, target: entry.target, hiddenWhen: entry.hiddenWhen,
                };
                item.connect('activate', () => this._source.activate(tracked.action, tracked.target));
                this._source.trackItem(tracked);
                this._entries.push(tracked);
            } else {
                item.setSensitive(false);
            }
            this._menu.addMenuItem(item);
        }

        if (!hasItems)
            addPlaceholder(this._menu);
    }

    _release() {
        if (this._signature === null || this._menu._getTopMenu().isOpen) return;

        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        this._unwatch();
        this._clearItems();
        removeAllItems(this._menu);
        addPlaceholder(this._menu);
        this._signature = null;
    }

    destroy() {
        cancelRelease(this);
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        if (this._openStateId) {
            this._menu.disconnect(this._openStateId);
            this._openStateId = 0;
        }
        if (this._closedId) {
            this._menu.disconnect(this._closedId);
            this._closedId = 0;
        }
        this._unwatch();
        this._clearItems();
    }
}

class GtkMenuSource {
    constructor(window) {
        const connection = Gio.DBus.session;
        const busName = window.get_gtk_unique_bus_name();
        const menubarPath = window.get_gtk_menubar_object_path();

        this._model = Gio.DBusMenuModel.get(connection, busName, menubarPath);
        this._modelSignals = [];
        this._groups = new Map();
        this._trackedItems = new Map();
        this._topLevel = [];
        this._callback = null;
        this._topLevelChangedId = 0;

        const addGroup = (prefix, path) => {
            if (!path) return;
            const group = Gio.DBusActionGroup.get(connection, busName, path);
            const refresh = (_group, name) => this._refreshAction(`${prefix}.${name}`);
            const record = { group, loaded: false, signalIds: [] };
            record.signalIds = [
                group.connect('action-added', (_group, name) => {
                    record.loaded = true;
                    refresh(_group, name);
                }),
                group.connect('action-removed', refresh),
                group.connect('action-enabled-changed', refresh),
                group.connect('action-state-changed', refresh),
            ];
            // The first query is what makes GDBusActionGroup fetch its actions.
            record.loaded = group.list_actions().length > 0;
            this._groups.set(prefix, record);
        };
        addGroup('app', window.get_gtk_application_object_path());
        addGroup('win', window.get_gtk_window_object_path());
        // appmenu-gtk-module publishes its "unity." actions next to the menu.
        addGroup('unity', menubarPath);
    }

    start() {
        this._watchTopLevel();
    }

    // Called with null while another window's menus are on screen.
    setCallback(callback) {
        this._callback = callback;
    }

    // Apps rewrite their menu bar by removing everything and adding it
    // back; only look at it again once that has settled.
    _queueTopLevelChanged() {
        if (this._topLevelChangedId) return;
        this._topLevelChangedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY_MS, () => {
            this._topLevelChangedId = 0;
            const previous = JSON.stringify(this.getTopLevel());
            this._watchTopLevel();
            if (previous !== JSON.stringify(this.getTopLevel()))
                this._callback?.();
            return GLib.SOURCE_REMOVE;
        });
    }

    _watchTopLevel() {
        this._modelSignals.forEach(([model, id]) => model.disconnect(id));
        this._modelSignals = [];
        this._topLevel = [];

        const walk = (model, depth) => {
            const id = model.connect('items-changed', () => this._queueTopLevelChanged());
            this._modelSignals.push([model, id]);

            const count = Math.min(model.get_n_items(), MAX_ITEMS_PER_MENU);
            for (let i = 0; i < count && this._topLevel.length < MAX_TOP_LEVEL_MENUS; i++) {
                const section = model.get_item_link(i, Gio.MENU_LINK_SECTION);
                if (section) {
                    if (depth < MAX_MENU_DEPTH) walk(section, depth + 1);
                    continue;
                }
                const submenu = model.get_item_link(i, Gio.MENU_LINK_SUBMENU);
                const string = name =>
                    model.get_item_attribute_value(i, name, GLib.VariantType.new('s'))?.unpack() ?? null;
                const label = cleanTitle(string(Gio.MENU_ATTRIBUTE_LABEL));
                if (!submenu || !label) continue;
                // Asking for the size is what subscribes to a menu; do it
                // for the submenu and its sections so that the items are
                // already here when it is first opened.
                const subscribe = () => {
                    const size = submenu.get_n_items();
                    for (let j = 0; j < size; j++)
                        submenu.get_item_link(j, Gio.MENU_LINK_SECTION)?.get_n_items();
                };
                this._modelSignals.push([submenu, submenu.connect('items-changed', subscribe)]);
                subscribe();
                this._topLevel.push({
                    key: `${this._topLevel.length}:${label}`,
                    label,
                    model: submenu,
                    submenuAction: string('submenu-action'),
                });
            }
        };
        walk(this._model, 0);
    }

    getTopLevel() {
        return this._topLevel.map(({ key, label }) => ({ key, label }));
    }

    attach(key, menu) {
        const entry = this._topLevel.find(t => t.key === key);
        if (!entry) {
            addPlaceholder(menu);
            return null;
        }
        return new GtkMenuBinding(this, menu, entry.model, entry.submenuAction, true);
    }

    _resolve(fullName) {
        const dot = fullName.indexOf('.');
        if (dot <= 0) return null;
        const record = this._groups.get(fullName.slice(0, dot));
        return record ? { record, name: fullName.slice(dot + 1) } : null;
    }

    activate(fullName, target) {
        const ref = this._resolve(fullName);
        if (ref) ref.record.group.activate_action(ref.name, target);
    }

    setSubmenuShown(fullName, shown) {
        const ref = this._resolve(fullName);
        if (ref && ref.record.group.has_action(ref.name))
            ref.record.group.change_action_state(ref.name, GLib.Variant.new_boolean(shown));
    }

    trackItem(tracked) {
        let items = this._trackedItems.get(tracked.action);
        if (!items) {
            items = new Set();
            this._trackedItems.set(tracked.action, items);
        }
        items.add(tracked);
        this._applyState(tracked);
    }

    untrackItem(tracked) {
        const items = this._trackedItems.get(tracked.action);
        if (!items) return;
        items.delete(tracked);
        if (items.size === 0) this._trackedItems.delete(tracked.action);
    }

    _refreshAction(fullName) {
        this._trackedItems.get(fullName)?.forEach(tracked => this._applyState(tracked));
    }

    _applyState(tracked) {
        const ref = this._resolve(tracked.action);
        const exists = ref?.record.group.has_action(ref.name) ?? false;
        // Until the group has answered, an unknown action is just "not
        // loaded yet" rather than missing.
        const missing = !exists && (ref === null || ref.record.loaded);

        let enabled = !missing;
        let ornament = PopupMenu.Ornament.HIDDEN;
        if (exists) {
            enabled = ref.record.group.get_action_enabled(ref.name);
            const state = ref.record.group.get_action_state(ref.name);
            if (state && tracked.target)
                ornament = state.equal(tracked.target) ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT;
            else if (state && state.is_of_type(GLib.VariantType.new('b')))
                ornament = state.get_boolean() ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE;
        }

        tracked.item.setSensitive(enabled);
        tracked.item.setOrnament(ornament);
        tracked.item.visible = !(
            (tracked.hiddenWhen === 'action-missing' && missing) ||
            (tracked.hiddenWhen === 'action-disabled' && !enabled));
    }

    destroy() {
        this._callback = null;
        if (this._topLevelChangedId) {
            GLib.source_remove(this._topLevelChangedId);
            this._topLevelChangedId = 0;
        }
        this._modelSignals.forEach(([model, id]) => model.disconnect(id));
        this._modelSignals = [];
        for (const record of this._groups.values())
            record.signalIds.forEach(id => record.group.disconnect(id));
        this._groups.clear();
        this._trackedItems.clear();
        this._topLevel = [];
    }
}

function dbusMenuItems(node) {
    return node.children.filter(child => child.props.visible !== false &&
        (child.props.type === 'separator' || stripMnemonic(child.props.label)));
}

function dbusMenuIsSubmenu(node) {
    return node.props['children-display'] === 'submenu' || node.children.length > 0;
}

// What one level of a menu looks like, leaving out the item ids: some apps
// (Firefox) renumber every item whenever anything in the menu bar changes.
function dbusMenuLevelSignature(node) {
    return JSON.stringify(dbusMenuItems(node).map(child => [child.props, dbusMenuIsSubmenu(child)]));
}

// Keeps one PopupMenu (or submenu) in sync with one level of a DBusMenu.
// The menu items only exist while the menu is in use: they are built when
// it opens and, for a top-level menu, given back once it has closed.
class DBusMenuBinding {
    constructor(source, menu, node, topLevelKey) {
        this._source = source;
        this._menu = menu;
        this._node = node;
        this.topLevelKey = topLevelKey;
        this._rows = [];
        this._signature = null;
        this._isOpen = false;

        addPlaceholder(this._menu);

        this._openStateId = this._menu.connect('open-state-changed', (_menu, isOpen) => {
            this._isOpen = isOpen;
            if (isOpen && this._signature === null && this._node)
                this._fill();
            this._source.menuShown(this, isOpen);
        });
        if (topLevelKey !== null)
            this._closedId = this._menu.connect('menu-closed', () => queueRelease(this));
    }

    get id() {
        return this._node?.id ?? null;
    }

    setNode(node) {
        this._node = node;

        if (this._signature === null) {
            // Opened before the app had answered.
            if (this._isOpen) this._fill();
            return;
        }
        if (dbusMenuLevelSignature(node) !== this._signature) {
            this._fill();
            return;
        }

        // Same items: only their ids and the deeper levels can have changed.
        const items = dbusMenuItems(node).filter(child => child.props.type !== 'separator');
        this._rows.forEach((row, index) => {
            row.node = items[index];
            row.binding?.setNode(items[index]);
        });
    }

    _dropRows() {
        this._rows.forEach(row => {
            row.dead = true;
            row.binding?.destroy();
        });
        this._rows = [];
    }

    _fill() {
        this._dropRows();
        removeAllItems(this._menu);
        this._signature = dbusMenuLevelSignature(this._node);

        let pendingSeparator = false;
        let hasItems = false;
        for (const child of dbusMenuItems(this._node)) {
            const props = child.props;
            if (props.type === 'separator') {
                pendingSeparator = hasItems;
                continue;
            }

            if (pendingSeparator) {
                this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                pendingSeparator = false;
            }
            hasItems = true;

            const row = { node: child, binding: null, dead: false };
            const label = stripMnemonic(props.label);
            if (dbusMenuIsSubmenu(child)) {
                const item = new CascadeMenuItem(label);
                item.setSensitive(props.enabled !== false);
                this._menu.addMenuItem(item);
                row.binding = new DBusMenuBinding(this._source, item.menu, child, null);
            } else {
                const item = new PopupMenu.PopupMenuItem(label);
                item.setSensitive(props.enabled !== false);
                if (props['toggle-type'] === 'checkmark')
                    item.setOrnament(props['toggle-state'] === 1 ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
                else if (props['toggle-type'] === 'radio')
                    item.setOrnament(props['toggle-state'] === 1 ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
                addAccelLabel(item, formatDBusMenuShortcut(props.shortcut));
                item.connect('activate', () => this._source.click(row));
                this._menu.addMenuItem(item);
            }
            this._rows.push(row);
        }

        if (!hasItems)
            addPlaceholder(this._menu);
    }

    _release() {
        if (this._destroyed || this._signature === null || this._menu._getTopMenu().isOpen) return;
        // The menu closes as soon as an item is chosen, and the click may
        // still be waiting for the app's current item ids; it needs the rows.
        if (this._source.deferRelease(this)) return;

        this._dropRows();
        removeAllItems(this._menu);
        addPlaceholder(this._menu);
        this._signature = null;
    }

    destroy() {
        this._destroyed = true;
        cancelRelease(this);
        if (this._openStateId) {
            this._menu.disconnect(this._openStateId);
            this._openStateId = 0;
        }
        if (this._closedId) {
            this._menu.disconnect(this._closedId);
            this._closedId = 0;
        }
        this._dropRows();
    }
}

class DBusMenuSource {
    constructor(busName, path) {
        this._busName = busName;
        this._path = path;
        this._cancellable = new Gio.Cancellable();
        this._signalIds = [];
        this._callback = null;
        this._announced = false;

        // Top-level menus, each with its first level of items; the full
        // tree of a menu is only fetched once that menu is used.
        this._top = [];
        this._subtrees = new Map();
        this._bindings = new Map();
        this._activeKey = null;

        this._dirty = false;
        this._refreshing = false;
        this._refreshId = 0;
        this._lastRefresh = 0;
        this._stormLevel = 0;
        this._failures = 0;
        // The first answer brings each menu's first level along, so that a
        // menu has something to show the first time it opens.
        this._needsFirstLevels = true;
        this._pendingClicks = [];
        this._deferredEvents = [];
        this._deferredReleases = new Set();
    }

    start() {
        this._refresh();
    }

    // Holds back the release of a closed menu while a click is waiting for
    // fresh item ids; it is retried once the click has gone out.
    deferRelease(binding) {
        if (this._pendingClicks.length === 0) return false;
        this._deferredReleases.add(binding);
        return true;
    }

    // "Something changed" only needs to be heard once: the signals are
    // dropped again until the menu has been asked for anew, so an app that
    // announces changes in a loop costs nothing.
    _listen() {
        if (this._signalIds.length > 0) return;
        for (const signal of ['LayoutUpdated', 'ItemsPropertiesUpdated']) {
            this._signalIds.push(Gio.DBus.session.signal_subscribe(
                this._busName, DBUSMENU_IFACE, signal, this._path, null,
                Gio.DBusSignalFlags.NONE, () => {
                    this._dirty = true;
                    this._stopListening();
                    // Nobody is looking at the menus of a window in the
                    // background; catch up when it is shown again.
                    if (this._callback) this._scheduleRefresh();
                }));
        }
    }

    _stopListening() {
        this._signalIds.forEach(id => Gio.DBus.session.signal_unsubscribe(id));
        this._signalIds = [];
    }

    // Called with null while another window's menus are on screen.
    setCallback(callback) {
        this._callback = callback;
        if (callback && this._dirty)
            this._scheduleRefresh();
    }

    _call(method, parameters, replyType, callback) {
        Gio.DBus.session.call(
            this._busName, this._path, DBUSMENU_IFACE, method, parameters,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, DBUS_TIMEOUT_MS, this._cancellable,
            (conn, res) => {
                let reply = null;
                try {
                    reply = conn.call_finish(res);
                } catch (_e) {
                    // The app went away, is busy, or the item no longer exists.
                }
                if (!this._cancellable.is_cancelled())
                    callback?.(reply);
            });
    }

    _getLayout(id, depth, callback) {
        this._call('GetLayout', new GLib.Variant('(iias)', [id, depth, DBUSMENU_PROPERTIES]),
            '(u(ia{sv}av))', reply => {
                if (!reply) {
                    callback(null);
                    return;
                }
                // Refuse to even unpack an absurdly large answer.
                if (reply.get_size() > MAX_REPLY_BYTES) {
                    callback(null);
                    return;
                }
                callback(sanitizeDBusMenuNode(
                    reply.recursiveUnpack()[1], { nodes: MAX_NODES_PER_REPLY }, 0));
            });
    }

    _sendEvent(id, name) {
        // Not tied to the cancellable: a click must still reach the app
        // when activating the item switches focus and tears this source down.
        Gio.DBus.session.call(
            this._busName, this._path, DBUSMENU_IFACE, 'Event',
            new GLib.Variant('(isvu)',
                [id, name, new GLib.Variant('i', 0), global.get_current_time()]),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    _scheduleRefresh() {
        if (this._refreshId || this._refreshing) return;
        if (this._failures >= MAX_FAILED_REFRESHES) return;

        const interval = Math.min(MAX_REFRESH_INTERVAL_MS, MIN_REFRESH_INTERVAL_MS << this._stormLevel);
        const sinceLast = (GLib.get_monotonic_time() - this._lastRefresh) / 1000;
        const delay = Math.max(REFRESH_DELAY_MS, Math.round(interval - sinceLast));
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        this._refreshing = true;
        this._dirty = false;
        this._lastRefresh = GLib.get_monotonic_time();
        // Before asking, so that a change made while the answer is on its
        // way is not missed.
        this._listen();

        const withFirstLevels = this._needsFirstLevels;
        this._getLayout(0, withFirstLevels ? 2 : 1, root => {
            if (root && withFirstLevels) this._needsFirstLevels = false;
            // No answer, or one too large to be a real menu.
            this._failures = root ? 0 : this._failures + 1;
            if (this._failures >= MAX_FAILED_REFRESHES)
                this._stopListening();
            this._setTopLevel(root ?? { id: 0, props: {}, children: [] });

            const active = this._top.find(entry => entry.key === this._activeKey);
            if (!active || !this._bindings.get(active.key)?.size) {
                this._finishRefresh();
                return;
            }
            this._getLayout(active.node.id, -1, subtree => {
                if (subtree) {
                    this._subtrees.set(active.key, subtree);
                    this._bindings.get(active.key)?.forEach(binding => binding.setNode(subtree));
                }
                this._finishRefresh();
            });
        });
    }

    _finishRefresh() {
        this._refreshing = false;
        // Still changing after being asked: back off.
        this._stormLevel = this._dirty ? Math.min(this._stormLevel + 1, 4) : 0;

        // Whatever was waiting for current item ids goes out now, in the
        // order it happened.
        const clicks = this._pendingClicks;
        this._pendingClicks = [];
        clicks.forEach(row => {
            if (!row.dead) this._sendEvent(row.node.id, 'clicked');
        });
        const events = this._deferredEvents;
        this._deferredEvents = [];
        events.forEach(([binding, name]) => {
            const id = this._currentId(binding);
            if (id !== null) this._sendEvent(id, name);
        });
        const releases = this._deferredReleases;
        this._deferredReleases = new Set();
        releases.forEach(binding => queueRelease(binding));

        // Asked again right away only for a reason: the app changed
        // something meanwhile, or the last answer could not be used.
        if ((this._dirty || this._failures > 0 || this._needsFirstLevels && this._top.length > 0) &&
            this._callback)
            this._scheduleRefresh();
    }

    _setTopLevel(root) {
        const previous = JSON.stringify(this.getTopLevel());
        const known = new Map(this._top.map(entry => [entry.key, entry.node]));
        this._top = dbusMenuItems(root)
            .filter(child => child.props.type !== 'separator')
            .slice(0, MAX_TOP_LEVEL_MENUS)
            .map((child, index) => {
                const label = cleanTitle(child.props.label);
                const key = `${index}:${label}`;
                // A later answer names the menus only; each keeps the
                // first level it already had, and a new menu asks for its own.
                if (child.children.length === 0 && dbusMenuIsSubmenu(child)) {
                    if (known.has(key))
                        child.children = known.get(key).children;
                    else
                        this._needsFirstLevels = true;
                }
                return { key, label, node: child };
            });

        for (const key of [...this._subtrees.keys()]) {
            if (!this._top.some(entry => entry.key === key))
                this._subtrees.delete(key);
        }
        // Menus not fetched in full yet show their first level meanwhile.
        for (const entry of this._top) {
            if (!this._subtrees.has(entry.key))
                this._bindings.get(entry.key)?.forEach(binding => binding.setNode(entry.node));
        }

        if (previous !== JSON.stringify(this.getTopLevel()) || !this._announced) {
            this._announced = true;
            this._callback?.();
        }
    }

    getTopLevel() {
        return this._top.map(({ key, label }) => ({ key, label }));
    }

    attach(key, menu) {
        const node = this._subtrees.get(key) ??
            this._top.find(entry => entry.key === key)?.node ?? null;
        const binding = new DBusMenuBinding(this, menu, node, key);

        let bindings = this._bindings.get(key);
        if (!bindings) {
            bindings = new Set();
            this._bindings.set(key, bindings);
        }
        bindings.add(binding);

        return {
            destroy: () => {
                binding.destroy();
                bindings.delete(binding);
            },
        };
    }

    // A top-level menu is addressed by the id the app gives it right now.
    _currentId(binding) {
        if (binding.topLevelKey === null) return binding.id;
        return this._top.find(entry => entry.key === binding.topLevelKey)?.node.id ?? null;
    }

    menuShown(binding, isOpen) {
        const id = this._currentId(binding);
        if (id === null) return;

        if (!isOpen) {
            // A click on one of its items must reach the app before this.
            if (this._pendingClicks.length > 0)
                this._deferredEvents.push([binding, 'closed']);
            else
                this._sendEvent(id, 'closed');
            return;
        }

        if (binding.topLevelKey !== null)
            this._activeKey = binding.topLevelKey;
        // Apps fill in or update a menu (recent files, check marks) when
        // told that it is being shown; fetch what it looks like afterwards.
        this._call('AboutToShow', new GLib.Variant('(i)', [id]), '(b)', null);
        this._sendEvent(id, 'opened');
        this._dirty = true;
        if (binding.topLevelKey !== null && !this._subtrees.has(binding.topLevelKey) && !this._refreshing)
            this._refresh();
        else
            this._scheduleRefresh();
    }

    click(row) {
        // While the app is changing its menu the ids we hold may be stale;
        // wait for the refresh so that the click lands on the right item.
        if (this._dirty || this._refreshing) {
            this._pendingClicks.push(row);
            if (!this._refreshing) this._refresh();
        } else {
            this._sendEvent(row.node.id, 'clicked');
        }
    }

    destroy() {
        this._callback = null;
        this._cancellable.cancel();
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        this._stopListening();
        this._deferredReleases.clear();
        this._bindings.forEach(bindings => bindings.forEach(binding => binding.destroy()));
        this._bindings.clear();
        this._subtrees.clear();
        this._top = [];
    }
}
