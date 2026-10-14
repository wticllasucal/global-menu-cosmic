// Cascading submenus, as in a classic menu bar: a submenu opens beside its
// item instead of unfolding inside the menu, so the menu it belongs to
// never changes size.
//
// The shell keeps an input grab on the open panel menu, and only that
// menu's own actors receive events. A submenu is therefore not a popup of
// its own: it is added inside the open menu, as a sibling of the menu's
// content, and laid out beside the item it hangs from.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// How long the pointer rests on an item before its submenu opens, and on
// a sibling before an open submenu closes. The shared delay lets the
// pointer cut across other items on its way into the submenu.
const HOVER_DELAY_MS = 180;
// How far a submenu overlaps the menu it comes out of.
const OVERLAP = 4;
// Space kept between a submenu and the edges of the work area.
const EDGE_MARGIN = 8;

const CascadeLayout = GObject.registerClass(
class CascadeLayout extends Clutter.LayoutManager {
    vfunc_get_preferred_width(layer, forHeight) {
        return layer.menuContent.get_preferred_width(forHeight);
    }

    vfunc_get_preferred_height(layer, forWidth) {
        return layer.menuContent.get_preferred_height(forWidth);
    }

    vfunc_allocate(layer, box) {
        layer.menuContent.allocate(box);

        // Parents come before the submenus that hang from their items.
        for (const menu of layer.openMenus)
            menu.actor.allocate(layer.placeSubmenu(menu));
    }
});

// Replaces a menu's content inside its box pointer, holding that content
// and the submenus opened from it.
const CascadeLayer = GObject.registerClass(
class CascadeLayer extends St.Widget {
    _init(content) {
        super._init({ layout_manager: new CascadeLayout() });
        this.menuContent = content;
        this.openMenus = [];
        this.add_child(content);
        content._cascadeSurface = true;
    }

    addSubmenu(menu) {
        this.add_child(menu.actor);
        this.openMenus.push(menu);
    }

    removeSubmenu(menu) {
        const index = this.openMenus.indexOf(menu);
        if (index === -1) return;
        this.openMenus.splice(index, 1);
        this.remove_child(menu.actor);
    }

    // Where a submenu goes, in this layer's coordinates: beside the item
    // it belongs to, flipped to the other side or shifted up when it would
    // leave the screen.
    placeSubmenu(menu) {
        const item = menu.sourceActor;
        let surface = item.get_parent();
        while (surface && !surface._cascadeSurface)
            surface = surface.get_parent();
        surface ??= this.menuContent;

        const [layerX, layerY] = this.get_transformed_position();
        const [surfaceX] = surface.get_transformed_position();
        const [, itemY] = item.get_transformed_position();

        const monitorIndex = Main.layoutManager.findIndexForActor(this);
        const area = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const maxHeight = area.height - 2 * EDGE_MARGIN;

        const [, naturalWidth] = menu.actor.get_preferred_width(-1);
        const [, naturalHeight] = menu.actor.get_preferred_height(naturalWidth);
        const width = naturalWidth;
        const height = Math.min(naturalHeight, maxHeight);

        let x = surfaceX + surface.width - OVERLAP;
        if (x + width > area.x + area.width - EDGE_MARGIN) {
            const flipped = surfaceX - width + OVERLAP;
            x = flipped >= area.x + EDGE_MARGIN
                ? flipped
                : area.x + area.width - EDGE_MARGIN - width;
        }

        // Line the first row of the submenu up with its item.
        let y = itemY - menu.actor.get_theme_node().get_padding(St.Side.TOP);
        y = Math.min(y, area.y + area.height - EDGE_MARGIN - height);
        y = Math.max(y, area.y + EDGE_MARGIN);

        const box = new Clutter.ActorBox();
        box.set_origin(Math.round(x - layerX), Math.round(y - layerY));
        box.set_size(width, height);
        return box;
    }
});

function ensureLayer(topMenu) {
    if (topMenu._cascadeLayer)
        return topMenu._cascadeLayer;

    const bin = topMenu._boxPointer.bin;
    const content = topMenu.box;
    bin.set_child(null);
    const layer = new CascadeLayer(content);
    bin.set_child(layer);
    topMenu._cascadeLayer = layer;

    // A submenu cannot outlive the menu it is part of.
    topMenu.connect('open-state-changed', (_menu, isOpen) => {
        if (!isOpen)
            [...layer.openMenus].forEach(menu => menu.close());
    });
    return layer;
}

// The submenu of a CascadeMenuItem.
export class CascadeMenu extends PopupMenu.PopupMenuBase {
    constructor(item) {
        super(item);

        const scrollView = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        scrollView.set_child(this.box);

        this.actor = new St.Bin({
            style_class: 'popup-menu-content',
            child: scrollView,
            reactive: true,
            track_hover: true,
        });
        this.actor._delegate = this;
        this.actor._cascadeSurface = true;
        // Up and Down go round the submenu, as in the shell's own menus
        // (GNOME 51 asks for that with keynav flags).
        this.actor.set_keynav_flags?.(St.KeynavFlags.WRAP_VERTICALLY);
        this.actor.connect('key-press-event', (_actor, event) => this._onKeyPress(event));

        this._layer = null;
        global.focus_manager.add_group(this.actor);
    }

    _onKeyPress(event) {
        if (event.get_key_symbol() !== Clutter.KEY_Left)
            return Clutter.EVENT_PROPAGATE;
        this.close();
        this.sourceActor.active = true;
        return Clutter.EVENT_STOP;
    }

    open() {
        if (this.isOpen) return;

        const topMenu = this._getTopMenu();
        if (!topMenu?._boxPointer) return;

        this.isOpen = true;
        // Listeners fill the menu in when told it opens, before it is
        // measured and placed.
        this.emit('open-state-changed', true);

        this._layer = ensureLayer(topMenu);
        this._layer.addSubmenu(this);
    }

    close() {
        if (!this.isOpen) return;

        // Its own submenus go first.
        this._getMenuItems().forEach(item => item.menu?.close?.());
        if (this._activeMenuItem)
            this._activeMenuItem.active = false;

        this._layer?.removeSubmenu(this);
        this._layer = null;
        this.isOpen = false;
        this.emit('open-state-changed', false);
    }

    destroy() {
        this.close();
        global.focus_manager.remove_group(this.actor);
        this.removeAll();
        this.actor.destroy();
        this.emit('destroy');
        Main.sessionMode.disconnectObject(this);
    }
}

// A menu item whose submenu opens beside it.
export const CascadeMenuItem = GObject.registerClass(
class CascadeMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(text) {
        super._init();

        this.label = new St.Label({
            text,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.label);
        this.label_actor = this.label;

        this.add_child(new St.Bin({ style_class: 'popup-menu-item-expander', x_expand: true }));
        this.add_child(PopupMenu.arrowIcon(St.Side.RIGHT));

        this._hoverTimeoutId = 0;
        this._parentActiveChangedId = 0;

        this.menu = new CascadeMenu(this);
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            // The item stays highlighted for as long as its submenu shows.
            if (isOpen)
                this.add_style_pseudo_class('selected');
            else if (!this.active)
                this.remove_style_pseudo_class('selected');
        });
        // Coming into the submenu means the user wants it kept open, even
        // if the pointer brushed a sibling item on the way.
        this.menu.actor.connect('notify::hover', () => {
            if (this.menu.actor.hover)
                this._cancelHoverTimeout();
        });

        this.connect('notify::active', () => {
            if (!this.active && this.menu.isOpen)
                this.add_style_pseudo_class('selected');
        });
        // A handler rather than vfunc_key_press_event: GNOME 51 moved the
        // menu items' own key handling to key bindings, leaving no JS
        // implementation to chain up to. The signal runs before the class
        // handler on 50 and 51 alike.
        this.connect('key-press-event', (_item, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Right)
                return Clutter.EVENT_PROPAGATE;
            this._cancelHoverTimeout();
            this.menu.open();
            this.menu.actor.navigate_focus(null, St.DirectionType.DOWN, false);
            return Clutter.EVENT_STOP;
        });
        this.connect('destroy', () => this._onDestroy());
    }

    _setParent(parent) {
        this._disconnectParent();
        super._setParent(parent);
        this.menu._setParent(parent);
        if (parent) {
            this._parentActiveChangedId = parent.connect('active-changed',
                (_parent, activeItem) => this._onSiblingActive(activeItem));
        }
    }

    _disconnectParent() {
        if (this._parentActiveChangedId && this._parent)
            this._parent.disconnect(this._parentActiveChangedId);
        this._parentActiveChangedId = 0;
    }

    _cancelHoverTimeout() {
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = 0;
        }
    }

    _afterHoverDelay(callback) {
        this._cancelHoverTimeout();
        this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_DELAY_MS, () => {
            this._hoverTimeoutId = 0;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onSiblingActive(activeItem) {
        if (activeItem === this) {
            if (!this.menu.isOpen)
                this._afterHoverDelay(() => this.menu.open());
            else
                this._cancelHoverTimeout();
        } else if (activeItem) {
            if (this.menu.isOpen)
                this._afterHoverDelay(() => this.menu.close());
            else
                this._cancelHoverTimeout();
        } else if (!this.menu.isOpen) {
            // The pointer left the menu before the submenu opened.
            this._cancelHoverTimeout();
        }
    }

    syncSensitive() {
        const sensitive = super.syncSensitive();
        if (!sensitive)
            this.menu.close();
        return sensitive;
    }

    // Clicking opens the submenu at once rather than closing the menu.
    activate(_event) {
        this._cancelHoverTimeout();
        this.menu.open();
    }

    _onDestroy() {
        this._cancelHoverTimeout();
        this._disconnectParent();
        this.menu.destroy();
    }
});
