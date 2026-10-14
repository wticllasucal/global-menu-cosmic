import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import {
    acquireRegistrar, releaseRegistrar, acquireWaylandAppmenu, releaseWaylandAppmenu,
    describeRealMenu, createRealMenuSource, GtkAppActions,
    addAccelLabel, formatGtkAccel, removeAllItems,
} from './realMenu.js';
import { CascadeMenuItem } from './cascade.js';
import { buildNativeMenus, KeySender } from './nativeMenus.js';

// How long to wait for an app to answer with its real menus before
// falling back to the generic ones.
const REAL_MENU_TIMEOUT_MS = 400;

// Label of the button that collects the app menus that do not fit in the bar,
// and roughly how wide that button is.
const OVERFLOW_LABEL = '»';
const OVERFLOW_BUTTON_WIDTH = 32;

// A menu that is open must not have its button rebuilt under it; changes
// to the bar wait this long before checking again.
const BUSY_RETRY_MS = 200;

// How many windows keep their menu connection while not focused, so that
// switching back to them shows their menus at once.
const MAX_CACHED_SOURCES = 4;

// Conventional GTK action names that get a proper place in the app menu;
// everything else an app exports is listed in the "Actions" menu.
const APP_MENU_ACTIONS = [
    ['app', 'about'], ['app', 'preferences'], ['app', 'shortcuts'],
    ['win', 'show-help-overlay'], ['app', 'help'], ['app', 'quit'], ['app', 'new-window'],
];
// Exported for debugging or scripting, not meant for a menu.
const HIDDEN_ACTIONS = ['kill', 'inspector'];

// Items of the generic menus that stand in for a keyboard shortcut.
const NATIVE_ACTION_KEYS = {
    'copy': '<Control>c',
    'paste': '<Control>v',
    'cut': '<Control>x',
    'undo': '<Control>z',
    'redo': '<Control>y',
    'select-all': '<Control>a',
    'new-tab': '<Control>Return',
    'print': '<Control>p',
    'emoji-picker': '<Control>period',
    'toggle-fullscreen': 'F11',
    'go-back': '<Alt>Left',
    'go-forward': '<Alt>Right',
    'delete-item': 'Delete',
    'virtual-open': 'Return',
    'properties': '<Alt>Return',
};

// Window and app identities that never get app menus: the shell's own
// processes, and the file manager, whose menus are the desktop's.
const NO_APP_MENU = new Set([
    'gjs', 'org.gnome.gjs', 'gnome-shell', 'org.gnome.shell', 'mutter',
    'nautilus', 'org.gnome.nautilus', 'com.rastersoft.ding',
]);

// "close-other-tabs" -> "Close Other Tabs", "tab.read-only" -> "Tab Read Only"
function humanizeActionName(name) {
    return name.split(/[-._]+/).filter(word => word)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// Error logging is gated behind the "debug-logging" setting (off by
// default) so the extension doesn't spam the journal in normal use.
// MenuManager keeps this in sync with the setting; toggled live.
let debugLoggingEnabled = false;

function logError(message) {
    if (debugLoggingEnabled) console.error(message);
}

// Spawn a command safely using an argv array so no shell parsing/injection
// can occur, and so arguments with spaces or special characters are passed
// through intact.
function spawnCommand(argv) {
    try {
        GLib.spawn_async(
            null,
            argv,
            null,
            GLib.SpawnFlags.SEARCH_PATH,
            null
        );
    } catch (e) {
        logError(`[globalmenu] Failed to spawn '${argv.join(' ')}': ${e}`);
    }
}

// Stands in for the items of a menu until they are made.
function addPlaceholderItem(menu) {
    let item = new PopupMenu.PopupMenuItem('…', { activate: false });
    item.setSensitive(false);
    menu.addMenuItem(item);
}

// Scrolls just enough to bring an item of a scrolling menu into view
// (the shell's own helper for this moved between modules across versions).
function scrollItemIntoView(scrollView, item) {
    let adjustment = scrollView.vadjustment ?? scrollView.vscroll?.adjustment;
    if (!adjustment) return;

    let box = item.get_allocation_box();
    let y1 = box.y1;
    let y2 = box.y2;
    for (let parent = item.get_parent(); parent && parent !== scrollView; parent = parent.get_parent()) {
        let offset = parent.get_allocation_box().y1;
        y1 += offset;
        y2 += offset;
    }

    let value = adjustment.value;
    let pageSize = adjustment.page_size;
    if (y1 < value)
        adjustment.value = y1;
    else if (y2 > value + pageSize)
        adjustment.value = Math.min(adjustment.upper - pageSize, y2 - pageSize);
}

const TopLevelMenuButton = GObject.registerClass(
  class TopLevelMenuButton extends PanelMenu.Button {
    // look: { padding, bold, icon } — how the title is drawn.
    // children: the items, or a function returning them, called each
    // time the menu opens (for menus that describe the current state).
    _init(label, children, appInstance = null, look = {}) {
      super._init(0.5, label);

      // The icon only shows for the app's own menu; a hidden child takes
      // no room and no spacing.
      this._icon = new St.Icon({
          style_class: 'system-status-icon',
          y_align: Clutter.ActorAlign.CENTER,
          visible: false,
      });
      this._title = new St.Label({
          y_align: Clutter.ActorAlign.CENTER,
          style_class: 'panel-button-label',
      });
      let box = new St.BoxLayout({ style: 'spacing: 6px;' });
      box.add_child(this._icon);
      box.add_child(this._title);
      this.add_child(box);

      this.setContent(label, children, appInstance, look);

      if (this.menu) {
          this.menu.connectObject('open-state-changed', (_menu, isOpen) => {
              if (isOpen && this._pendingChildren) {
                  removeAllItems(this.menu);
                  this._buildSubMenu(this._pendingChildren, this.menu);
                  this._pendingChildren = null;
              }
              if (isOpen && this._dynamicChildren) {
                  this._actionItems = [];
                  removeAllItems(this.menu);
                  this._buildSubMenu(this._dynamicChildren(), this.menu);
              }
              if (isOpen) this._syncActionItems();
              this._alignMenuToLeft();
          }, this);
      }
    }

    // Gives the button another title and menu. The bar keeps its buttons
    // from one focused window to the next and refills them, which is far
    // cheaper than making new ones.
    setContent(label, children, appInstance = null, look = {}) {
      this._appInstance = appInstance;
      this._actionItems = [];
      this._keys = look.keys ?? null;
      this._dynamicChildren = typeof children === 'function' ? children : null;
      this.accessible_name = label;

      // Menu bars pack their titles tighter than regular panel buttons,
      // which leaves room for apps with many menus.
      let padding = look.padding ?? 8;
      this.style = `-natural-hpadding: ${padding}px; -minimum-hpadding: ${Math.max(2, Math.floor(padding / 2))}px;`;

      this._title.text = label;
      this._title.style = look.bold ? 'font-weight: bold;' : null;
      this._icon.gicon = look.icon ?? null;
      this._icon.visible = Boolean(look.icon);

      // Most menus are never opened before the focus moves on: their items
      // are only made the first time the menu opens. A placeholder keeps
      // the menu from counting as empty, which would stop it from opening.
      removeAllItems(this.menu);
      this._pendingChildren = null;
      if (this._dynamicChildren) {
          // Built afresh each time it opens.
          addPlaceholderItem(this.menu);
      } else if (children.length > 0) {
          this._pendingChildren = children;
          addPlaceholderItem(this.menu);
      }
    }

    _alignMenuToLeft() {
        if (!this.menu || !this.menu.actor) return;
        try {
            let buttonWidth = Math.round(this.get_width() || 0);
            let menuWidth = Math.round(this.menu.actor.get_width() || 0);
            if (buttonWidth <= 0 || menuWidth <= 0) return;

            let offset = Math.round((menuWidth - buttonWidth) / 2);

            // Clamp so the menu never gets pushed off-screen near a
            // monitor edge (matters most on smaller/secondary displays).
            let [buttonX] = this.get_transformed_position();
            let monitor = Main.layoutManager.findMonitorForActor(this) ||
                          Main.layoutManager.primaryMonitor;
            if (monitor) {
                let menuLeft = buttonX - offset;
                let menuRight = menuLeft + menuWidth;
                if (menuLeft < monitor.x)
                    offset -= (monitor.x - menuLeft);
                else if (menuRight > monitor.x + monitor.width)
                    offset += (menuRight - (monitor.x + monitor.width));
            }

            this.menu.actor.translation_x = offset;
        } catch (e) {
            logError(`[globalmenu] Error aligning menu: ${e}`);
        }
    }

    // Items backed by one of the app's own GTK actions follow its enabled
    // and toggle state.
    _syncActionItems() {
        for (const [menuItem, { actions, prefix, name }] of this._actionItems) {
            menuItem.setSensitive(actions.isEnabled(prefix, name));
            let checked = actions.getChecked(prefix, name);
            if (checked !== null)
                menuItem.setOrnament(checked ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
    }

    _executeNativeAction(action) {
        let display = global.display;
        let window = display.get_focus_window();

        if (action === "close") {
            if (window) window.delete(global.get_current_time());
            return true;
        } else if (action === "minimize") {
            if (window) window.minimize();
            return true;
        } else if (action === "maximize") {
            if (window) {
                if (window.is_maximized()) window.unmaximize();
                else window.maximize();
            }
            return true;
        }

        if (action.startsWith("custom-command:")) {
            let cmd = action.slice("custom-command:".length);
            try {
                let [, argv] = GLib.shell_parse_argv(cmd);
                spawnCommand(argv);
            } catch (e) {
                logError(`[globalmenu] Invalid custom command '${cmd}': ${e}`);
            }
            return true;
        }

        if (action.startsWith("custom-shortcut:")) {
            let accel = action.slice("custom-shortcut:".length);
            this._sendAccelerator(accel);
            return true;
        }

        if (action.startsWith("activate-window:")) {
            let winId = action.split(":")[1];
            if (this._appInstance) {
                let appWindows = this._appInstance.get_windows();
                let targetWin = appWindows.find(w => w.get_id().toString() === winId);
                if (targetWin) {
                    targetWin.activate(global.get_current_time());
                    return true;
                }
            }
            return false;
        }

        if (action === "new-app-window") {
            if (this._appInstance) {
                this._appInstance.open_new_window(-1);
                return true;
            }
            return false;
        }

        if (action.startsWith("app-details:")) {
            let appId = action.split(":")[1];
            if (appId) {
                spawnCommand(['gnome-software', `--details=${appId}`]);
                return true;
            }
        }

        try {
            if (action === "open-file-manager" || action === "new-file-manager-win" || action === "go-home") {
                spawnCommand(['xdg-open', GLib.get_home_dir()]);
                return true;
            } else if (action === "new-folder") {
                this._createNewFolder();
                return true;
            } else if (action === "open-settings") {
                spawnCommand(['gnome-control-center']);
                return true;
            } else if (action === "empty-bin") {
                spawnCommand(['gio', 'trash', '--empty']);
                return true;
            } else if (action === "open-system-help") {
                spawnCommand(['yelp']);
                return true;
            } else if (action === "go-recents") {
                spawnCommand(['xdg-open', 'recent:///']);
                return true;
            } else if (action === "go-documents") {
                let path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS) || `${GLib.get_home_dir()}/Documents`;
                spawnCommand(['xdg-open', path]);
                return true;
            } else if (action === "go-desktop") {
                let path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP) || `${GLib.get_home_dir()}/Desktop`;
                spawnCommand(['xdg-open', path]);
                return true;
            } else if (action === "go-downloads") {
                let path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) || `${GLib.get_home_dir()}/Downloads`;
                spawnCommand(['xdg-open', path]);
                return true;
            }
        } catch (e) {
            logError(`[globalmenu] Process execution error: ${e}`);
        }

        // Shift+F10 opens the context menu of the selection, whose
        // "Open With" item answers to H.
        if (action === "native-open-with") {
            this._keys?.send('<Shift>F10', 'h');
            return true;
        }

        let accel = NATIVE_ACTION_KEYS[action];
        if (accel) {
            this._keys?.send(accel);
            return true;
        }

        return false;
    }

    // Sends a GTK-style accelerator string (e.g. "<Control><Alt>t") as real
    // key events, for user-defined custom shortcuts.
    _sendAccelerator(accel) {
        this._keys?.send(accel);
    }

    _createNewFolder() {
        try {
            let desktopPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP)
                || `${GLib.get_home_dir()}/Desktop`;
            let baseName = "Untitled Folder";
            let folderName = baseName;
            let counter = 2;
            let file = Gio.File.new_for_path(GLib.build_filenamev([desktopPath, folderName]));

            while (file.query_exists(null)) {
                folderName = `${baseName} ${counter}`;
                file = Gio.File.new_for_path(GLib.build_filenamev([desktopPath, folderName]));
                counter++;
            }

            file.make_directory(null);
        } catch (e) {
            logError(`[globalmenu] Failed to create new folder: ${e}`);
        }
    }

    _buildSubMenu(menuItems, parentMenu) {
      for (const item of menuItems) {
        if (item.type === "separator") {
          parentMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        } else if (item.type === "section-header") {
          let headerItem = new PopupMenu.PopupMenuItem(item.label, { activate: false });
          headerItem.setSensitive(false);
          headerItem.label.add_style_class_name('popup-subtitle-menu-item');
          parentMenu.addMenuItem(headerItem);
        } else if (item.type === "submenu") {
          const subMenu = new CascadeMenuItem(item.label);
          this._buildSubMenu(item.children, subMenu.menu);
          parentMenu.addMenuItem(subMenu);
        } else {
          const menuItem = new PopupMenu.PopupMenuItem(item.label);
          if (item.enabled === false) {
            // Unimplemented placeholder item.
            menuItem.setSensitive(false);
          } else if (item.appAction) {
            let { actions, prefix, name } = item.appAction;
            menuItem.connect("activate", () => actions.activate(prefix, name));
            this._actionItems.push([menuItem, item.appAction]);
          } else if (item.key) {
            // Stands in for a keyboard shortcut of the app: one, a chord of
            // several ("Ctrl+K Ctrl+S"), or what reaches a command palette.
            let keys = [].concat(item.key);
            if (!item.noAccelLabel)
                addAccelLabel(menuItem, keys.map(formatGtkAccel).join(' '));
            menuItem.connect("activate", () => this._keys?.send(...keys));
          } else if (item.window) {
            menuItem.connect("activate", () => this._windowAction(item.window));
          } else if (item.action) {
            menuItem.connect("activate", () => {
              this._executeNativeAction(item.action);
            });
          }
          if (item.checked !== undefined)
            menuItem.setOrnament(item.checked ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
          parentMenu.addMenuItem(menuItem);
        }
      }
    }

    // Things the shell does to the focused window itself.
    _windowAction(action) {
        let window = global.display.get_focus_window();
        if (!window) return;
        let time = global.get_current_time();

        if (action === 'close') {
            window.delete(time);
        } else if (action === 'minimize') {
            window.minimize();
        } else if (action === 'zoom') {
            if (window.is_maximized()) window.unmaximize();
            else window.maximize();
        } else if (action === 'fullscreen') {
            if (window.is_fullscreen()) window.unmake_fullscreen();
            else window.make_fullscreen();
        } else if (action === 'above') {
            if (window.is_above()) window.unmake_above();
            else window.make_above();
        } else if (action === 'workspace-left' || action === 'workspace-right') {
            let direction = action === 'workspace-left'
                ? Meta.MotionDirection.LEFT : Meta.MotionDirection.RIGHT;
            let workspace = window.get_workspace().get_neighbor(direction);
            window.change_workspace(workspace);
            workspace.activate_with_focus(window, time);
        } else if (action === 'next-monitor') {
            window.move_to_monitor((window.get_monitor() + 1) % global.display.get_n_monitors());
        } else if (action === 'all-to-front') {
            this._appInstance?.get_windows().slice().reverse().forEach(w => w.activate(time));
        } else if (action === 'hide-app') {
            (this._appInstance?.get_windows() ?? [window]).forEach(w => w.minimize());
        } else if (action === 'quit-app') {
            // Asks every window of the app to close, as its own Quit would;
            // an app with unsaved work can still ask first.
            if (!this._appInstance?.request_quit())
                window.delete(time);
        }
    }

  }
);

// A button with a menu of our own (not one of the app's), which can be
// given new content instead of being made again.
function isPlainButton(btn) {
    return btn?.constructor === TopLevelMenuButton;
}

// A top-level button whose menu mirrors one of the app's own menus.
const RealMenuButton = GObject.registerClass(
  class RealMenuButton extends TopLevelMenuButton {
    _init(label, source, key, look) {
      super._init(label, [], null, look);

      // App menus can be taller than the screen, so their content scrolls.
      this._section = new PopupMenu.PopupMenuSection();
      this.menu.addMenuItem(this._section);
      this._scrollView = new St.ScrollView({
          hscrollbar_policy: St.PolicyType.NEVER,
          vscrollbar_policy: St.PolicyType.AUTOMATIC,
          overlay_scrollbars: true,
      });
      this.menu.box.remove_child(this._section.actor);
      this._scrollView.set_child(this._section.actor);
      this.menu.box.add_child(this._scrollView);
      this._section.connect('active-changed', (_section, item) => {
          if (item) scrollItemIntoView(this._scrollView, item);
      });

      this._binding = source.attach(key, this._section);

      // The content arrives after the menu is first laid out.
      this.menu.actor.connectObject('notify::width', () => {
          if (this.menu.isOpen) this._alignMenuToLeft();
      }, this);
    }

    destroy() {
        this.menu.actor.disconnectObject(this);
        // The menu remembers the item under the pointer and would touch it
        // on its way out, after the section holding it is gone.
        if (this.menu._activeMenuItem)
            this.menu._activeMenuItem.active = false;
        if (this._binding) {
            this._binding.destroy();
            this._binding = null;
        }
        if (this._section) {
            this._section.destroy();
            this._section = null;
        }
        // Destroying the item under the pointer hands the hover, and with
        // it the menu's "active item", to another item of the same doomed
        // section; the menu must not reach for it while closing.
        this.menu._activeMenuItem = null;
        super.destroy();
    }
  }
);

// Collects, as submenus, the app menus that do not fit in the bar.
const OverflowMenuButton = GObject.registerClass(
  class OverflowMenuButton extends TopLevelMenuButton {
    _init(source, menus, look) {
      super._init(OVERFLOW_LABEL, [], null, look);
      this._bindings = [];
      for (const { label, key } of menus) {
          const item = new CascadeMenuItem(label);
          this.menu.addMenuItem(item);
          this._bindings.push(source.attach(key, item.menu));
      }
    }

    destroy() {
        this._bindings.forEach(binding => binding?.destroy());
        this._bindings = [];
        super.destroy();
    }
  }
);

export class MenuManager {
    constructor(uuid, settings, extensionPath) {
        this.uuid = uuid;
        this._settings = settings;
        this._extensionPath = extensionPath;
        this._buttons = [];
        this._nextRole = 0;
        this._registrar = null;
        this._waylandAppmenu = null;
        this._realSource = null;
        this._realSourceId = null;
        this._sources = new Map();
        this._keys = new KeySender();
        this._busyRetryId = 0;
        this._pendingChange = null;
        this._pendingRebuildsEverything = false;
        this._realMenuKeys = null;
        this._realMenuTimeoutId = 0;
        this._trackedWindow = null;
        this._appActions = null;
        this._appActionsWindow = null;
        this._appActionsSignature = null;

        debugLoggingEnabled = settings.get_boolean('debug-logging');
        this._debugLoggingChangedId = settings.connect('changed::debug-logging', () => {
            debugLoggingEnabled = settings.get_boolean('debug-logging');
        });

        this._syncMenuServices();
        this._useRealMenusChangedId = settings.connect('changed::use-real-menus', () => {
            this._syncMenuServices();
        });
    }

    // Apps only export their menu bar (and hide their own) while the
    // registrar and the Wayland global exist, so both follow the setting.
    _syncMenuServices() {
        let wanted = this._settings.get_boolean('use-real-menus');
        if (wanted && !this._registrar) {
            try {
                this._registrar = acquireRegistrar(() => this._refreshIfSourceChanged());
            } catch (e) {
                logError(`[globalmenu] Could not start the menu registrar: ${e}`);
            }
            this._connectWaylandAppmenu();
        } else if (!wanted && this._registrar) {
            this._releaseMenuServices(false);
        }
    }

    async _connectWaylandAppmenu() {
        let appmenu = await acquireWaylandAppmenu(this._extensionPath);
        // The setting may have been turned off, or the extension disabled,
        // while the helper was loading.
        if (!appmenu || !this._registrar || this._waylandAppmenu) return;

        this._waylandAppmenu = appmenu;
        this._waylandAppmenuChangedId = appmenu.connect('changed', () => this._refreshIfSourceChanged());
        this._refreshIfSourceChanged();
    }

    _releaseMenuServices(keepRunning) {
        if (this._waylandAppmenu) {
            this._waylandAppmenu.disconnect(this._waylandAppmenuChangedId);
            this._waylandAppmenu = null;
        }
        releaseWaylandAppmenu(keepRunning);
        releaseRegistrar(keepRunning);
        this._registrar = null;
    }

    _isMenuOpen() {
        return this._buttons.some(btn => btn.menu?.isOpen);
    }

    // Runs a change to the bar now, or as soon as no menu of ours is open:
    // destroying the button of an open menu leaves the shell's menu
    // manager holding a dead menu.
    _whenIdle(change, rebuildsEverything = false) {
        if (!this._busyRetryId && !this._isMenuOpen()) {
            change();
            return;
        }

        // One change waits at a time; a full rebuild covers anything else.
        if (rebuildsEverything || !this._pendingRebuildsEverything) {
            this._pendingChange = change;
            this._pendingRebuildsEverything = rebuildsEverything;
        }
        if (this._busyRetryId) return;
        this._busyRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BUSY_RETRY_MS, () => {
            if (this._isMenuOpen()) return GLib.SOURCE_CONTINUE;

            this._busyRetryId = 0;
            let pending = this._pendingChange;
            this._pendingChange = null;
            this._pendingRebuildsEverything = false;
            pending?.();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        this._whenIdle(() => {
            if (this._settings.get_boolean('show-indicator'))
                this.updateMenuForWindow(global.display.get_focus_window());
        }, true);
    }

    // Menu announcements come from every app; only rebuild the bar (which
    // closes an open menu) when the one for the focused window changed.
    _refreshIfSourceChanged() {
        let window = this._trackedWindow;
        let description = window
            ? describeRealMenu(window, this._registrar, this._waylandAppmenu)
            : null;
        let id = description ? JSON.stringify(description) : null;
        if (id !== this._realSourceId)
            this._refresh();
    }

    // Apps may publish their menu bar after the window is already focused.
    _trackWindow(window) {
        if (this._trackedWindow === window) return;
        this._untrackWindow();
        this._trackedWindow = window;
        if (window) {
            window.connectObject(
                'notify::gtk-menubar-object-path', () => this._refreshIfSourceChanged(),
                'notify::gtk-unique-bus-name', () => this._refreshIfSourceChanged(),
                'unmanaged', () => this._untrackWindow(),
                this);
        }
    }

    _untrackWindow() {
        if (this._trackedWindow) {
            this._trackedWindow.disconnectObject(this);
            this._trackedWindow = null;
        }
    }

    // The app's exported GTK actions are kept across rebuilds of the bar
    // for the same window: they load asynchronously, and their arrival is
    // what triggers the rebuild that shows them.
    _syncAppActions(window) {
        if (this._appActionsWindow === window) return;

        if (this._appActions) {
            this._appActions.destroy();
            this._appActions = null;
        }
        this._appActionsWindow = window;
        if (window && GtkAppActions.supports(window)) {
            this._appActions = new GtkAppActions(window, () => {
                if (this._appActions.signature() !== this._appActionsSignature)
                    this._refresh();
            });
        }
    }

    // The Window menu: what the shell can do to the focused window. Built
    // when the menu opens, since it reflects the window's current state.
    _windowMenuItems(detectedApp) {
        let window = global.display.get_focus_window();
        if (!window) return [{ label: 'No Window', enabled: false }];

        let items = [
            { label: 'Minimize', window: 'minimize' },
            { label: window.is_maximized() ? 'Restore' : 'Zoom', window: 'zoom' },
            { label: window.is_fullscreen() ? 'Exit Full Screen' : 'Enter Full Screen', window: 'fullscreen' },
            { type: 'separator' },
            { label: 'Always on Top', window: 'above', checked: window.is_above() },
        ];
        if (global.workspace_manager.get_n_workspaces() > 1) {
            items.push(
                { label: 'Move to Workspace Left', window: 'workspace-left' },
                { label: 'Move to Workspace Right', window: 'workspace-right' });
        }
        if (global.display.get_n_monitors() > 1)
            items.push({ label: 'Move to Next Display', window: 'next-monitor' });

        let windows = detectedApp?.get_windows() ?? [];
        if (windows.length > 1)
            items.push({ type: 'separator' }, { label: 'Bring All to Front', window: 'all-to-front' });
        if (windows.length > 0) {
            items.push({ type: 'separator' });
            windows.forEach(w => items.push({
                label: w.get_title() || 'Untitled',
                action: `activate-window:${w.get_id()}`,
                checked: w === window,
            }));
        }
        return items;
    }

    _windowMenu(detectedApp) {
        return { type: 'submenu', label: 'Window', children: () => this._windowMenuItems(detectedApp) };
    }

    _appActionItem(label, prefix, name) {
        return { label, appAction: { actions: this._appActions, prefix, name } };
    }

    // The connection to a window's menus outlives the buttons in the bar:
    // it is reused when the window is focused again, and dropped when the
    // window closes, its menu address changes, or too many pile up.
    _acquireSource(window, description) {
        for (const cachedWindow of [...this._sources.keys()]) {
            if (!cachedWindow.get_compositor_private())
                this._dropSource(cachedWindow);
        }

        let id = JSON.stringify(description);
        let cached = this._sources.get(window);
        if (cached && cached.id !== id) {
            this._dropSource(window);
            cached = null;
        }

        if (!cached) {
            let source = createRealMenuSource(window, description);
            source.start();
            cached = { id, source };
        }
        // Most recently used last.
        this._sources.delete(window);
        this._sources.set(window, cached);
        while (this._sources.size > MAX_CACHED_SOURCES)
            this._dropSource(this._sources.keys().next().value);

        return cached.source;
    }

    _dropSource(window) {
        let cached = this._sources.get(window);
        if (!cached) return;
        this._sources.delete(window);
        if (this._realSource === cached.source)
            this._realSource = null;
        cached.source.destroy();
    }

    _detachRealSource() {
        if (this._realMenuTimeoutId) {
            GLib.source_remove(this._realMenuTimeoutId);
            this._realMenuTimeoutId = 0;
        }
        if (this._busyRetryId) {
            GLib.source_remove(this._busyRetryId);
            this._busyRetryId = 0;
        }
        this._pendingChange = null;
        this._pendingRebuildsEverything = false;
        if (this._realSource) {
            this._realSource.setCallback(null);
            this._realSource = null;
        }
        this._realMenuKeys = null;
        this._realSourceId = null;
    }

    // Dialogs and other transients keep the menus of the window they
    // belong to.
    _menuWindow(window) {
        while (window && window.get_window_type() !== Meta.WindowType.NORMAL && window.get_transient_for())
            window = window.get_transient_for();
        return window;
    }

    // Called when the focus moves. Moving within the window whose menus
    // are already shown (a dialog closing, the focus coming back from the
    // panel) leaves the bar alone.
    focusChanged(window) {
        if (this._buttons.length > 0 && this._menuWindow(window) === this._shownWindow)
            return;
        this.updateMenuForWindow(window);
    }

    updateMenuForWindow(window) {
        let appName = this._settings.get_string('desktop-app-name') || 'Nautilus';
        let isAppFocused = false;
        let desktopId = "";
        let detectedApp = null;

        window = this._menuWindow(window);

        if (window) {
            let windowType = window.get_window_type();

            if (windowType === 0) {
                let tracker = Shell.WindowTracker.get_default();
                detectedApp = tracker.get_window_app(window);

                let checkId = detectedApp ? (detectedApp.get_id() || "") : "";
                let wmClass = window.get_wm_class() || "";

                // Whole identities only: a browser tab or a document whose
                // title merely mentions one of these keeps its menus.
                // A GTK 3 app run by an interpreter (gjs, python) has the
                // interpreter's name as its class; the application id it
                // announces says which app it really is.
                let gtkAppId = window.get_gtk_application_id();
                let identities = (gtkAppId
                    ? [checkId.replace(/\.desktop$/i, ''), gtkAppId]
                    : [checkId.replace(/\.desktop$/i, ''), wmClass, window.get_wm_class_instance() ?? ''])
                    .map(identity => identity.toLowerCase());
                let isBlacklisted = identities.some(identity => NO_APP_MENU.has(identity));

                if (!isBlacklisted && (detectedApp || wmClass)) {
                    if (detectedApp) {
                        appName = detectedApp.get_name();
                        // An app with no .desktop file is named after its
                        // window class, which may be its interpreter's.
                        if (detectedApp.is_window_backed() && gtkAppId)
                            appName = humanizeActionName(gtkAppId.split('.').pop());
                        desktopId = detectedApp.get_id();
                        isAppFocused = true;
                    } else if (wmClass) {
                        appName = wmClass.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                        desktopId = wmClass.toLowerCase() + ".desktop";
                        isAppFocused = true;
                    }
                } else {
                    detectedApp = null;
                }
            }
        }

        let desktopAppName = this._settings.get_string('desktop-app-name') || 'Nautilus';

        let useRealMenus = isAppFocused && this._settings.get_boolean('use-real-menus');
        this._syncAppActions(useRealMenus ? window : null);
        let appActions = this._appActions;
        this._appActionsSignature = appActions ? appActions.signature() : null;

        // Apps that export no menu bar get menus made of what they do
        // offer: their exported actions, known shortcuts, window operations.
        let native = isAppFocused
            ? buildNativeMenus({
                appId: desktopId,
                wmClass: `${window.get_wm_class() ?? ''} ${window.get_wm_class_instance() ?? ''}`,
                actions: appActions,
            })
            : null;

        let firstMenuChildren = [];
        if (isAppFocused) {
            let about = appActions?.has('app', 'about')
                ? [this._appActionItem(`About ${appName}`, 'app', 'about')] : [];
            let preferences = appActions?.has('app', 'preferences')
                ? [this._appActionItem("Preferences…", 'app', 'preferences')] : [];

            let more = [];
            if (this._settings.get_boolean('show-actions-menu')) {
                let hidden = name => HIDDEN_ACTIONS.includes(name) ||
                    APP_MENU_ACTIONS.some(([, known]) => known === name);
                let extra = native.leftovers.filter(({ name }) => !hidden(name))
                    .map(({ prefix, name }) => this._appActionItem(humanizeActionName(name), prefix, name));
                if (extra.length > 0)
                    more.push({ type: "submenu", label: "More Actions", children: extra });
            }

            let sections = [
                about,
                [...preferences, ...more],
                [
                    { label: "New Window", action: "new-app-window" },
                    { label: "App Details", action: `app-details:${desktopId}` },
                ],
                [{ label: `Hide ${appName}`, window: 'hide-app' }],
                [appActions?.has('app', 'quit')
                    ? this._appActionItem(`Quit ${appName}`, 'app', 'quit')
                    : { label: `Quit ${appName}`, window: detectedApp ? 'quit-app' : 'close' }],
            ];
            firstMenuChildren = sections.filter(section => section.length > 0)
                .flatMap((section, index) => index === 0 ? section : [{ type: "separator" }, ...section]);

            // An app whose own menus are rebuilt brings its name and app menu
            // too (About, Settings, Quit...); the shell adds hiding it.
            if (native?.appName && detectedApp?.is_window_backed())
                appName = native.appName;
            if (native?.appItems) {
                let quit = native.appItems.length - 1;
                firstMenuChildren = [
                    ...native.appItems.slice(0, quit),
                    { label: `Hide ${appName}`, window: 'hide-app' },
                    { type: "separator" },
                    native.appItems[quit],
                ];
            }
        } else {
            firstMenuChildren = [
                { label: `About ${desktopAppName}`, enabled: false },
                { type: "separator" },
                { label: `Open ${desktopAppName}`, action: "open-file-manager" },
                { label: "Settings", action: "open-settings" },
                { type: "separator" },
                { label: "Empty Bin...", action: "empty-bin" }
            ];
        }

        const fileMenu = {
            type: "submenu",
            label: "File",
            children: [
                { label: `New ${desktopAppName} Window`, action: "new-file-manager-win" },
                { label: "New Folder", action: "new-folder" },
                { label: "New Tab", action: "new-tab" },
                { label: "Open", action: "virtual-open" },
                { label: "Open With", action: "native-open-with" },
                { label: "Print", action: "print" },
                { type: "separator" },
                { label: "Get Info", action: "properties" },
                { label: "Compress", enabled: false },
                { label: "Duplicate", enabled: false },
                { type: "separator" },
                { label: "Move to Trash", action: "delete-item" },
                { type: "separator" },
                { label: "Close Window", action: "close" }
            ]
        };

        const editMenu = {
            type: "submenu",
            label: "Edit",
            children: [
                { label: "Undo", action: "undo" },
                { label: "Redo", action: "redo" },
                { type: "separator" },
                { label: "Cut", action: "cut" },
                { label: "Copy", action: "copy" },
                { label: "Paste", action: "paste" },
                { label: "Delete", action: "delete-item" },
                { type: "separator" },
                { label: "Select All", action: "select-all" },
                { type: "separator" },
                { label: "Emoji & Symbols", action: "emoji-picker" }
            ]
        };

        const viewMenu = {
            type: "submenu",
            label: "View",
            children: [
                { label: "as Icons", enabled: false },
                { label: "as List", enabled: false },
                { type: "separator" },
                { label: "Enter Full Screen", action: "toggle-fullscreen" }
            ]
        };

        const goMenu = {
            type: "submenu",
            label: "Go",
            children: [
                { label: "Back", action: "go-back" },
                { label: "Forward", action: "go-forward" },
                { type: "separator" },
                { label: "Recents", action: "go-recents" },
                { label: "Documents", action: "go-documents" },
                { label: "Desktop", action: "go-desktop" },
                { label: "Downloads", action: "go-downloads" },
                { label: "Home", action: "go-home" }
            ]
        };

        const windowMenu = {
            type: "submenu",
            label: "Window",
            children: [
                { label: "Minimize", action: "minimize" },
                { label: "Maximize", action: "maximize" },
                { type: "separator" },
                { label: "Close", action: "close" }
            ]
        };

        const helpMenu = {
            type: "submenu",
            label: "Help",
            children: [
                { label: "GNOME Help", action: "open-system-help" }
            ]
        };

        let appMenus = [];
        if (this._settings.get_boolean('menu-app-enabled')) {
            appMenus.push({
                type: "submenu", label: appName, children: firstMenuChildren, isAppMenu: true,
            });
        }

        let genericMenus = [];
        if (this._settings.get_boolean('generic-menus-enabled')) {
            let wanted = label => {
                let toggle = { File: 'file', Edit: 'edit', View: 'view', Go: 'go', Window: 'window', Help: 'help' }[label];
                return !toggle || this._settings.get_boolean(`menu-${toggle}-enabled`);
            };
            // With no window focused these are the desktop's own menus.
            let menus = native
                ? native.menus.map(menu => menu.window ? this._windowMenu(detectedApp) : menu)
                : [fileMenu, editMenu, viewMenu, goMenu, windowMenu, helpMenu];
            genericMenus = menus.filter(menu => wanted(menu.label));
        }

        let customMenus = this._buildCustomMenus();

        // Plain buttons stay to be refilled by _showMenus(); the ones showing
        // the app's own menus belong to the connection about to be replaced.
        this._buttons = this._buttons.filter(btn => {
            if (isPlainButton(btn)) return true;
            btn.destroy();
            return false;
        });
        this._detachRealSource();
        this._shownWindow = window;

        this._trackWindow(useRealMenus ? window : null);

        let source = null;
        if (useRealMenus) {
            try {
                let description = describeRealMenu(window, this._registrar, this._waylandAppmenu);
                if (description) {
                    source = this._acquireSource(window, description);
                    this._realSourceId = JSON.stringify(description);
                } else {
                    this._dropSource(window);
                }
            } catch (e) {
                logError(`[globalmenu] Could not read the app menu: ${e}`);
            }
        }

        if (!source) {
            this._showMenus([...appMenus, ...genericMenus, ...customMenus], detectedApp);
            return;
        }

        // The app exports its own menu bar: show that instead of the generic
        // menus, which only come back if the app turns out to have none.
        this._realSource = source;
        let timedOut = false;
        let apply = () => this._whenIdle(() => {
            if (this._realSource !== source) return;

            let realMenus = source.getTopLevel();
            if (realMenus.length === 0 && !timedOut) return;

            let keys = JSON.stringify(realMenus);
            if (keys === this._realMenuKeys) return;
            this._realMenuKeys = keys;

            let middleMenus = realMenus.length > 0
                ? realMenus.map(menu => ({ label: menu.label, realKey: menu.key }))
                : genericMenus;
            // An app whose first menu is named after it (Zed) gives that
            // menu as its app menu, as on macOS, rather than a second one.
            let leading = appMenus;
            if (appMenus.length > 0 && realMenus.length > 0 &&
                realMenus[0].label.replace(/_/g, '').toLowerCase() === appName.toLowerCase()) {
                leading = [{ ...middleMenus.shift(), label: appName, isAppMenu: true }];
            }
            if (realMenus.length > 0 && this._settings.get_boolean('menu-window-enabled') &&
                !realMenus.some(menu => /^(window|ventana|fen[eê]tre|fenster|janela|finestra)/i.test(menu.label)))
                middleMenus.push(this._windowMenu(detectedApp));
            this._showMenus([...leading, ...middleMenus, ...customMenus], detectedApp);
            if (realMenus.length > 0)
                this._foldOverflowingMenus(realMenus, leading === appMenus ? appMenus.length : 0);
        });

        if (source.getTopLevel().length > 0) {
            // Already known from an earlier visit to this window.
            apply();
        } else {
            this._showMenus([...appMenus, ...customMenus], detectedApp);
            this._realMenuTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REAL_MENU_TIMEOUT_MS, () => {
                this._realMenuTimeoutId = 0;
                timedOut = true;
                apply();
                return GLib.SOURCE_REMOVE;
            });
        }
        source.setCallback(apply);
    }

    // How the titles in the bar are drawn; the app's own menu stands out.
    _look(item, detectedApp) {
        let look = { padding: this._settings.get_int('button-padding'), keys: this._keys };
        if (item?.isAppMenu) {
            look.bold = this._settings.get_boolean('app-name-bold');
            if (this._settings.get_boolean('show-app-icon'))
                look.icon = detectedApp?.get_icon() ?? null;
        }
        return look;
    }

    // Puts these menus in the bar, in order, refilling the buttons already
    // there where it can and making the others.
    _showMenus(menuData, detectedApp) {
        let previous = this._buttons;
        this._buttons = [];
        menuData.forEach((item, index) => {
            let look = this._look(item, detectedApp);
            let old = previous[index];
            previous[index] = null;

            if (item.realKey === undefined && isPlainButton(old) && !old.menu.isOpen) {
                old.setContent(item.label, item.children, detectedApp, look);
                this._buttons.push(old);
                return;
            }

            old?.destroy();
            let btn = item.realKey !== undefined
                ? new RealMenuButton(item.label, this._realSource, item.realKey, look)
                : new TopLevelMenuButton(item.label, item.children, detectedApp, look);
            // Roles must be unique while the buttons they named may live on.
            Main.panel.addToStatusArea(`${this.uuid}-${this._nextRole++}`, btn, index + 1, 'left');
            this._buttons.push(btn);
        });
        previous.forEach(btn => btn?.destroy());
    }

    // The panel gives its left side at most half of the space around the
    // clock; anything wider gets its labels squeezed. Move the app menus
    // that do not fit into a single overflow button instead.
    _foldOverflowingMenus(realMenus, firstRealIndex) {
        let [, leftWidth] = Main.panel._leftBox.get_preferred_width(-1);
        let [, centerWidth] = Main.panel._centerBox.get_preferred_width(-1);
        let excess = leftWidth - Math.floor((Main.panel.width - centerWidth) / 2);
        if (excess <= 0) return;
        excess += OVERFLOW_BUTTON_WIDTH;

        // Always keep at least the first app menu in the bar.
        let foldFrom = realMenus.length;
        while (excess > 0 && foldFrom > 1) {
            foldFrom--;
            let btn = this._buttons[firstRealIndex + foldFrom];
            excess -= btn.container.get_preferred_width(-1)[1];
        }
        if (foldFrom === realMenus.length) return;

        this._buttons.splice(firstRealIndex + foldFrom, realMenus.length - foldFrom)
            .forEach(btn => btn.destroy());
        let overflowBtn = new OverflowMenuButton(
            this._realSource, realMenus.slice(foldFrom), this._look(null, null));
        Main.panel.addToStatusArea(`${this.uuid}-${this._nextRole++}`, overflowBtn,
            firstRealIndex + foldFrom + 1, 'left');
        this._buttons.push(overflowBtn);
    }

    _buildCustomMenus() {
        let raw = this._settings.get_string('custom-menus') || '[]';
        let sections = [];
        try {
            sections = JSON.parse(raw);
        } catch (e) {
            sections = [];
        }

        return sections
            .filter(section => section && section.enabled !== false)
            .map(section => {
                let items = Array.isArray(section.items) ? section.items : [];
                let children = items
                    .filter(entry => entry && entry.value)
                    .map(entry => ({
                        label: entry.label || '(untitled)',
                        action: entry.kind === 'shortcut'
                            ? `custom-shortcut:${entry.value}`
                            : `custom-command:${entry.value}`,
                    }));

                if (children.length === 0) {
                    children.push({ label: 'No items configured', enabled: false });
                }

                return { type: "submenu", label: section.label || 'Custom', children };
            });
    }

    _destroyButtons() {
        this._buttons.forEach(btn => btn.destroy());
        this._buttons = [];
    }

    clear() {
        this._destroyButtons();
        this._detachRealSource();
        this._shownWindow = undefined;
    }

    destroy() {
        if (this._settings && this._debugLoggingChangedId) {
            this._settings.disconnect(this._debugLoggingChangedId);
            this._debugLoggingChangedId = null;
        }
        if (this._settings && this._useRealMenusChangedId) {
            this._settings.disconnect(this._useRealMenusChangedId);
            this._useRealMenusChangedId = null;
        }
        this.clear();
        for (const window of [...this._sources.keys()])
            this._dropSource(window);
        this._untrackWindow();
        this._syncAppActions(null);
        this._keys.destroy();
        // Locking the screen disables the extension; apps must keep seeing
        // the registrar and the Wayland global or they stop exporting.
        this._releaseMenuServices(Main.sessionMode.currentMode === 'unlock-dialog');
    }
}
