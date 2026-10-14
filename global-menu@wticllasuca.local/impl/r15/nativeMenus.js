// Menus for apps that do not export a menu bar.
//
// Nothing can show a menu an app does not have, so these are built from
// what the app does offer: the GTK actions it exports on the bus (GTK 4
// apps), the keyboard shortcuts it is known to answer to (the profiles
// below), and the window operations the shell itself can perform.

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

const SEPARATOR = { type: 'separator' };

// Conventional GTK action names, grouped by the menu they belong in:
// [names tried in order, label].
const KNOWN_ACTIONS = {
    File: [
        [['new-window'], 'New Window'],
        [['new-tab'], 'New Tab'],
        [['new-document', 'new-file', 'new'], 'New'],
        [['open', 'open-file', 'open-document'], 'Open…'],
        [['save', 'save-document'], 'Save'],
        [['save-as'], 'Save As…'],
        [['print'], 'Print…'],
        [['close-tab', 'close-current-view', 'close-page'], 'Close Tab'],
    ],
    Edit: [
        [['undo'], 'Undo'],
        [['redo'], 'Redo'],
        [['cut'], 'Cut'],
        [['copy'], 'Copy'],
        [['paste'], 'Paste'],
        [['select-all'], 'Select All'],
        [['find', 'search'], 'Find…'],
        [['replace', 'find-and-replace'], 'Replace…'],
    ],
    View: [
        [['zoom-in'], 'Zoom In'],
        [['zoom-out'], 'Zoom Out'],
        [['zoom-normal', 'zoom-one', 'zoom-reset'], 'Actual Size'],
        [['show-hidden-files'], 'Show Hidden Files'],
        [['toggle-sidebar', 'show-sidebar'], 'Sidebar'],
        [['reload', 'refresh'], 'Reload'],
    ],
    Go: [
        [['back', 'go-back'], 'Back'],
        [['forward', 'go-forward'], 'Forward'],
        [['up', 'go-up'], 'Enclosing Folder'],
        [['go-home', 'home'], 'Home'],
    ],
    Help: [
        [['help'], 'Help'],
        [['shortcuts', 'show-help-overlay'], 'Keyboard Shortcuts'],
    ],
};

// Shortcuts that nearly every app honours, used where the app exports no
// matching action.
const DEFAULT_KEYS = {
    'Undo': '<Control>z',
    'Redo': '<Control><Shift>z',
    'Cut': '<Control>x',
    'Copy': '<Control>c',
    'Paste': '<Control>v',
    'Select All': '<Control>a',
    'Find…': '<Control>f',
};

const key = (label, accel) => ({ label, key: accel });

// An item that runs a Zed action. Actions with a default shortcut press it
// (`keys`, one or more chords); the others open the command palette, type
// the action's name and run it. Names and shortcuts are Zed 1.22's own
// (crates/zed/src/zed/app_menus.rs, assets/keymaps/default-linux.json).
const zed = (label, action, ...keys) => keys.length > 0
    ? { label, key: keys }
    : {
        label,
        key: ['<Control><Shift>p', { text: zedPaletteName(action) }, { key: 'Return', delay: 300 }],
        noAccelLabel: true,
    };

// "zed::OpenProjectSettings" -> "zed: open project settings", as the
// command palette lists it.
function zedPaletteName(action) {
    const [namespace, name] = action.split('::');
    const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    return `${namespace.replace(/_/g, ' ')}: ${words}`;
}

const url = (label, address) => ({ label, action: `custom-command:xdg-open ${address}` });

// Zed draws its menus inside its window and does not export them, so they
// are rebuilt here, item for item.
const ZED = {
    name: 'Zed',
    match: /\bdev\.zed\.zed\b|^zed\b|\bzed-editor\b/i,
    // These menus, in this order; Window is the shell's.
    exact: ['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Window', 'Help'],
    app: [
        zed('About Zed', 'zed::About'),
        zed('Check for Updates', 'auto_update::Check'),
        SEPARATOR,
        { type: 'submenu', label: 'Settings', children: [
            zed('Open Settings', 'zed::OpenSettings', '<Control>comma'),
            zed('Open Settings File', 'zed::OpenSettingsFile', '<Control><Alt>comma'),
            zed('Open Project Settings', 'zed::OpenProjectSettings'),
            zed('Open Project Settings File', 'zed::OpenProjectSettingsFile'),
            zed('Open Default Settings', 'zed::OpenDefaultSettings'),
            SEPARATOR,
            zed('Open Keymap', 'zed::OpenKeymap', '<Control>k', '<Control>s'),
            zed('Open Keymap File', 'zed::OpenKeymapFile'),
            zed('Open Default Key Bindings', 'zed::OpenDefaultKeymap'),
            SEPARATOR,
            zed('Select Theme…', 'theme_selector::Toggle', '<Control>k', '<Control>t'),
            zed('Select Icon Theme…', 'icon_theme_selector::Toggle'),
        ] },
        SEPARATOR,
        zed('Extensions', 'zed::Extensions', '<Control><Shift>x'),
        zed('Install CLI', 'cli::InstallCliBinary'),
        SEPARATOR,
        zed('Quit Zed', 'zed::Quit', '<Control>q'),
    ],
    menus: {
        File: [
            zed('New', 'workspace::NewFile', '<Control>n'),
            zed('New Window', 'workspace::NewWindow', '<Control><Shift>n'),
            SEPARATOR,
            zed('Open File…', 'workspace::OpenFiles', '<Control>o'),
            zed('Open Folder…', 'workspace::Open', '<Control>k', '<Control>o'),
            zed('Open Recent…', 'projects::OpenRecent', '<Control>r'),
            zed('Open Remote…', 'projects::OpenRemote', '<Control><Alt><Shift>o'),
            SEPARATOR,
            zed('Add Folder to Project…', 'workspace::AddFolderToProject'),
            SEPARATOR,
            zed('Save', 'workspace::Save', '<Control>s'),
            zed('Save As…', 'workspace::SaveAs', '<Control><Shift>s'),
            zed('Save All', 'workspace::SaveAll', '<Control><Alt>s'),
            SEPARATOR,
            zed('Close Editor', 'pane::CloseActiveItem', '<Control>w'),
            zed('Close Project', 'workspace::CloseProject'),
            zed('Close Window', 'workspace::CloseWindow', '<Control><Shift>w'),
        ],
        Edit: [
            zed('Undo', 'editor::Undo', '<Control>z'),
            zed('Redo', 'editor::Redo', '<Control><Shift>z'),
            SEPARATOR,
            zed('Cut', 'editor::Cut', '<Control>x'),
            zed('Copy', 'editor::Copy', '<Control>c'),
            zed('Copy and Trim', 'editor::CopyAndTrim'),
            zed('Paste', 'editor::Paste', '<Control>v'),
            SEPARATOR,
            zed('Find', 'buffer_search::Deploy', '<Control>f'),
            zed('Find in Project', 'pane::DeploySearch', '<Control><Shift>f'),
            SEPARATOR,
            zed('Toggle Line Comment', 'editor::ToggleComments', '<Control>slash'),
        ],
        Selection: [
            zed('Select All', 'editor::SelectAll', '<Control>a'),
            zed('Expand Selection', 'editor::SelectLargerSyntaxNode', '<Alt><Shift>Right'),
            zed('Shrink Selection', 'editor::SelectSmallerSyntaxNode', '<Alt><Shift>Left'),
            zed('Select Next Sibling', 'editor::SelectNextSyntaxNode'),
            zed('Select Previous Sibling', 'editor::SelectPreviousSyntaxNode'),
            SEPARATOR,
            zed('Add Cursor Above', 'editor::AddSelectionAbove', '<Shift><Alt>Up'),
            zed('Add Cursor Below', 'editor::AddSelectionBelow', '<Shift><Alt>Down'),
            zed('Select Next Occurrence', 'editor::SelectNext', '<Control>d'),
            zed('Select Previous Occurrence', 'editor::SelectPrevious', '<Control><Shift>Up'),
            zed('Select All Occurrences', 'editor::SelectAllMatches', '<Control><Shift>l'),
            SEPARATOR,
            zed('Move Line Up', 'editor::MoveLineUp', '<Alt>Up'),
            zed('Move Line Down', 'editor::MoveLineDown', '<Alt>Down'),
            zed('Duplicate Selection', 'editor::DuplicateLineDown', '<Control><Alt><Shift>Down'),
        ],
        View: [
            zed('Zoom In', 'zed::IncreaseBufferFontSize', '<Control>equal'),
            zed('Zoom Out', 'zed::DecreaseBufferFontSize', '<Control>minus'),
            zed('Reset Zoom', 'zed::ResetBufferFontSize', '<Control>0'),
            zed('Reset All Zoom', 'zed::ResetAllZoom'),
            SEPARATOR,
            zed('Toggle Left Dock', 'workspace::ToggleLeftDock', '<Control>b'),
            zed('Toggle Right Dock', 'workspace::ToggleRightDock', '<Control><Alt>b'),
            zed('Toggle Bottom Dock', 'workspace::ToggleBottomDock', '<Control>j'),
            zed('Toggle All Docks', 'workspace::ToggleAllDocks', '<Control><Alt>y'),
            { type: 'submenu', label: 'Editor Layout', children: [
                zed('Split Up', 'pane::SplitUp', '<Control>k', 'Up'),
                zed('Split Down', 'pane::SplitDown', '<Control>k', 'Down'),
                zed('Split Left', 'pane::SplitLeft', '<Control>k', 'Left'),
                zed('Split Right', 'pane::SplitRight', '<Control>k', 'Right'),
            ] },
            SEPARATOR,
            zed('Project Panel', 'project_panel::ToggleFocus', '<Control><Shift>e'),
            zed('Outline Panel', 'outline_panel::ToggleFocus', '<Control><Shift>b'),
            zed('Collab Panel', 'collab_panel::ToggleFocus', '<Control><Shift>c'),
            zed('Terminal Panel', 'terminal_panel::Toggle', '<Control>grave'),
            zed('Debugger Panel', 'debug_panel::ToggleFocus', '<Control><Shift>d'),
            zed('Agent Panel', 'agent::ToggleFocus', '<Control>question'),
            zed('Git Panel', 'git_panel::ToggleFocus', '<Control><Shift>g'),
            SEPARATOR,
            zed('Diagnostics', 'diagnostics::Deploy', '<Control><Shift>m'),
        ],
        Go: [
            zed('Back', 'pane::GoBack', '<Control><Alt>minus'),
            zed('Forward', 'pane::GoForward', '<Control><Alt>underscore'),
            SEPARATOR,
            zed('Command Palette…', 'command_palette::Toggle', '<Control><Shift>p'),
            SEPARATOR,
            zed('Go to File…', 'file_finder::Toggle', '<Control>p'),
            zed('Go to Symbol in Editor…', 'outline::Toggle', '<Control><Shift>o'),
            zed('Go to Line/Column…', 'go_to_line::Toggle', '<Control>g'),
            SEPARATOR,
            zed('Go to Definition', 'editor::GoToDefinition', 'F12'),
            zed('Go to Declaration', 'editor::GoToDeclaration'),
            zed('Go to Type Definition', 'editor::GoToTypeDefinition', '<Control>F12'),
            zed('Find All References', 'editor::FindAllReferences', '<Alt><Shift>F12'),
            zed('Show Incoming Calls', 'call_hierarchy::ShowIncomingCalls'),
            zed('Show Outgoing Calls', 'call_hierarchy::ShowOutgoingCalls'),
            SEPARATOR,
            zed('Next Problem', 'editor::GoToDiagnostic', 'F8'),
            zed('Previous Problem', 'editor::GoToPreviousDiagnostic', '<Shift>F8'),
        ],
        Run: [
            zed('Spawn Task', 'task::Spawn', '<Alt><Shift>t'),
            zed('Start Debugger', 'debugger::Start', 'F4'),
            SEPARATOR,
            zed('Edit tasks.json…', 'zed::OpenProjectTasks'),
            zed('Edit debug.json…', 'debugger::OpenProjectDebugTasks'),
            SEPARATOR,
            zed('Continue', 'debugger::Continue', 'F5'),
            zed('Step Over', 'debugger::StepOver', 'F10'),
            zed('Step Into', 'debugger::StepInto', 'F11'),
            zed('Step Out', 'debugger::StepOut', '<Shift>F11'),
            SEPARATOR,
            zed('Toggle Breakpoint', 'editor::ToggleBreakpoint', 'F9'),
            zed('Edit Breakpoint', 'editor::EditLogBreakpoint', '<Shift>F9'),
            zed('Clear All Breakpoints', 'debugger::ClearAllBreakpoints'),
        ],
        Help: [
            zed('View Release Notes Locally', 'auto_update::ViewReleaseNotesLocally'),
            zed('View Telemetry', 'zed::OpenTelemetryLog'),
            zed('View Dependency Licenses', 'zed::OpenLicenses'),
            zed('Show Welcome', 'zed::ShowWelcome'),
            SEPARATOR,
            zed('File Bug Report…', 'feedback::FileBugReport'),
            zed('Request Feature…', 'feedback::RequestFeature'),
            zed('Email Us…', 'feedback::EmailZed'),
            SEPARATOR,
            url('Documentation', 'https://zed.dev/docs'),
            zed('Zed Repository', 'zed::OpenZedRepo'),
            url('Zed Twitter', 'https://twitter.com/zeddotdev'),
            url('Join the Team', 'https://zed.dev/jobs'),
        ],
    },
};

// Menus for apps known by their shortcuts. A profile replaces the menus
// it names; any other menu is built the generic way.
const PROFILES = [
    ZED,
    {
        match: /ptyxis|gnome-terminal|org\.gnome\.terminal|org\.gnome\.console|\bkgx\b|tilix|xfce4-terminal|terminator/i,
        menus: {
            File: [
                key('New Tab', '<Control><Shift>t'), key('New Window', '<Control><Shift>n'), SEPARATOR,
                key('Close Tab', '<Control><Shift>w'),
            ],
            Edit: [
                key('Copy', '<Control><Shift>c'), key('Paste', '<Control><Shift>v'), SEPARATOR,
                key('Select All', '<Control><Shift>a'), SEPARATOR,
                key('Find…', '<Control><Shift>f'),
            ],
            View: [
                key('Zoom In', '<Control>plus'), key('Zoom Out', '<Control>minus'),
                key('Actual Size', '<Control>0'),
            ],
            Tabs: [
                key('Next Tab', '<Control>Page_Down'), key('Previous Tab', '<Control>Page_Up'), SEPARATOR,
                key('Move Tab Right', '<Control><Shift>Page_Down'),
                key('Move Tab Left', '<Control><Shift>Page_Up'),
            ],
        },
    },
    {
        match: /obsidian/i,
        menus: {
            File: [
                key('New Note', '<Control>n'), key('New Tab', '<Control>t'),
                key('Quick Switcher…', '<Control>o'), SEPARATOR,
                key('Save', '<Control>s'), key('Close Tab', '<Control>w'), SEPARATOR,
                key('Settings…', '<Control>comma'),
            ],
            Edit: [
                key('Undo', '<Control>z'), key('Redo', '<Control><Shift>z'), SEPARATOR,
                key('Cut', '<Control>x'), key('Copy', '<Control>c'), key('Paste', '<Control>v'),
                key('Select All', '<Control>a'), SEPARATOR,
                key('Find…', '<Control>f'), key('Find in All Files…', '<Control><Shift>f'), SEPARATOR,
                key('Bold', '<Control>b'), key('Italic', '<Control>i'), key('Insert Link', '<Control>k'),
            ],
            View: [
                key('Command Palette…', '<Control>p'), key('Toggle Reading View', '<Control>e'),
                key('Graph View', '<Control>g'), SEPARATOR,
                key('Zoom In', '<Control>plus'), key('Zoom Out', '<Control>minus'),
                key('Actual Size', '<Control>0'),
            ],
            Go: [
                key('Back', '<Control><Alt>Left'), key('Forward', '<Control><Alt>Right'),
            ],
        },
    },
    {
        match: /\bcode\b|code-oss|codium|cursor|windsurf|antigravity/i,
        menus: {
            File: [
                key('New File', '<Control>n'), key('New Window', '<Control><Shift>n'), SEPARATOR,
                key('Open File…', '<Control>o'), key('Quick Open…', '<Control>p'), SEPARATOR,
                key('Save', '<Control>s'), key('Save As…', '<Control><Shift>s'), SEPARATOR,
                key('Close Editor', '<Control>w'), key('Settings…', '<Control>comma'),
            ],
            Edit: [
                key('Undo', '<Control>z'), key('Redo', '<Control><Shift>z'), SEPARATOR,
                key('Cut', '<Control>x'), key('Copy', '<Control>c'), key('Paste', '<Control>v'),
                key('Select All', '<Control>a'), SEPARATOR,
                key('Find…', '<Control>f'), key('Replace…', '<Control>h'),
                key('Find in Files…', '<Control><Shift>f'),
            ],
            View: [
                key('Command Palette…', '<Control><Shift>p'), SEPARATOR,
                key('Explorer', '<Control><Shift>e'), key('Search', '<Control><Shift>f'),
                key('Source Control', '<Control><Shift>g'), key('Extensions', '<Control><Shift>x'),
                key('Toggle Sidebar', '<Control>b'), key('Toggle Terminal', '<Control>grave'), SEPARATOR,
                key('Zoom In', '<Control>plus'), key('Zoom Out', '<Control>minus'),
                key('Actual Size', '<Control>0'),
            ],
            Go: [
                key('Go to File…', '<Control>p'), key('Go to Line…', '<Control>g'),
                key('Go to Symbol…', '<Control><Shift>o'), SEPARATOR,
                key('Back', '<Control><Alt>minus'), key('Forward', '<Control><Shift>minus'),
            ],
        },
    },
    {
        // Browsers, for the windows that do not export their own menu yet.
        match: /firefox|chrome|chromium|brave|vivaldi|microsoft-edge|epiphany|org\.gnome\.epiphany/i,
        menus: {
            File: [
                key('New Tab', '<Control>t'), key('New Window', '<Control>n'),
                key('New Private Window', '<Control><Shift>p'), SEPARATOR,
                key('Open File…', '<Control>o'), key('Save Page As…', '<Control>s'),
                key('Print…', '<Control>p'), SEPARATOR,
                key('Close Tab', '<Control>w'),
            ],
            Edit: [
                key('Undo', '<Control>z'), key('Redo', '<Control><Shift>z'), SEPARATOR,
                key('Cut', '<Control>x'), key('Copy', '<Control>c'), key('Paste', '<Control>v'),
                key('Select All', '<Control>a'), SEPARATOR,
                key('Find…', '<Control>f'),
            ],
            View: [
                key('Reload', 'F5'), SEPARATOR,
                key('Zoom In', '<Control>plus'), key('Zoom Out', '<Control>minus'),
                key('Actual Size', '<Control>0'),
            ],
            History: [
                key('Back', '<Alt>Left'), key('Forward', '<Alt>Right'), SEPARATOR,
                key('Show History', '<Control>h'), key('Reopen Closed Tab', '<Control><Shift>t'),
            ],
        },
    },
];

function findProfile(...identifiers) {
    const haystack = identifiers.filter(Boolean).join(' ');
    return PROFILES.find(profile => profile.match.test(haystack)) ?? null;
}

// Builds the menus for a window whose app exports no menu bar.
//   actions: the app's exported GTK actions (GtkAppActions) or null
// Returns { menus: [{label, children}], leftovers: [items] }, the latter
// being exported actions that found no place in a menu.
export function buildNativeMenus({ appId, wmClass, actions }) {
    const profile = findProfile(appId, wmClass);

    // A profile that rebuilds the app's own menus gives them all, in its
    // order, and the items of the app menu.
    if (profile?.exact) {
        const menus = profile.exact.map(label => label === 'Window'
            ? { type: 'submenu', label, window: true }
            : { type: 'submenu', label, children: profile.menus[label] });
        return { menus, leftovers: [], appItems: profile.app ?? null, appName: profile.name ?? null };
    }
    const used = new Set();

    const fromActions = menu => KNOWN_ACTIONS[menu].flatMap(([names, label]) => {
        for (const name of names) {
            for (const prefix of ['win', 'app']) {
                if (actions?.has(prefix, name)) {
                    used.add(`${prefix}.${name}`);
                    return [{ label, appAction: { actions, prefix, name } }];
                }
            }
        }
        return [];
    });
    // The app's own action when it has one, the usual shortcut otherwise.
    const actionOrKey = (menu, labels) => {
        const available = fromActions(menu);
        return labels.map(label =>
            available.find(item => item.label === label) ??
            (DEFAULT_KEYS[label] ? key(label, DEFAULT_KEYS[label]) : null)).filter(Boolean);
    };
    const sections = (...groups) => groups.filter(group => group.length > 0)
        .flatMap((group, index) => index === 0 ? group : [SEPARATOR, ...group]);

    const menus = [];
    const add = (label, children) => {
        if (children.length > 0) menus.push({ type: 'submenu', label, children });
    };

    add('File', sections(
        profile?.menus.File ?? fromActions('File'),
        [{ label: 'Close Window', window: 'close' }]));

    if (profile?.menus.Edit) {
        add('Edit', profile.menus.Edit);
    } else {
        const extra = fromActions('Edit').filter(item => !(item.label in DEFAULT_KEYS));
        add('Edit', sections(
            actionOrKey('Edit', ['Undo', 'Redo']),
            actionOrKey('Edit', ['Cut', 'Copy', 'Paste', 'Select All']),
            [...actionOrKey('Edit', ['Find…']), ...extra]));
    }

    add('View', sections(
        profile?.menus.View ?? fromActions('View'),
        [{ label: 'Full Screen', window: 'fullscreen' }]));

    add('Go', profile?.menus.Go ?? fromActions('Go'));

    // Menus only a profile knows about (a terminal's Tabs, a browser's History).
    for (const [label, children] of Object.entries(profile?.menus ?? {})) {
        if (!['File', 'Edit', 'View', 'Go', 'Help'].includes(label))
            add(label, children);
    }

    menus.push({ type: 'submenu', label: 'Window', window: true });
    add('Help', profile?.menus.Help ?? fromActions('Help'));

    const leftovers = [];
    for (const prefix of ['app', 'win']) {
        for (const name of actions?.list(prefix) ?? []) {
            if (!used.has(`${prefix}.${name}`))
                leftovers.push({ prefix, name });
        }
    }
    return { menus, leftovers };
}

const MODIFIER_KEYS = {
    control: Clutter.KEY_Control_L, primary: Clutter.KEY_Control_L, ctrl: Clutter.KEY_Control_L,
    shift: Clutter.KEY_Shift_L, alt: Clutter.KEY_Alt_L, mod1: Clutter.KEY_Alt_L,
    super: Clutter.KEY_Super_L, meta: Clutter.KEY_Super_L,
};

// The menu is still closing and holds the keyboard when an item is chosen;
// the window has it back a moment later. Keys of a sequence are spaced the
// same, so that a menu opened by one has appeared before the next.
const KEY_DELAY_MS = 150;

// A key name as people write it ("t", "T", "return", "F5") -> keyval.
function lookupKeyval(name) {
    // "<Control>T" means Ctrl+T, not Ctrl+Shift+T.
    if (/^[A-Z]$/.test(name)) name = name.toLowerCase();
    const candidates = [name, name.toLowerCase(),
        name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()];
    for (const candidate of candidates) {
        const keyval = Clutter[`KEY_${candidate}`];
        if (typeof keyval === 'number') return keyval;
    }
    return null;
}

// "<Control><Shift>t" -> { keyval, modifiers: [keyvals] }, or null.
function parseAccelerator(accel) {
    if (typeof accel !== 'string') return null;
    const modifiers = [];
    let unknownModifier = false;
    const name = accel.trim().replace(/<([^>]+)>/g, (_match, modifier) => {
        const keyval = MODIFIER_KEYS[modifier.toLowerCase()];
        if (keyval) modifiers.push(keyval);
        else unknownModifier = true;
        return '';
    });
    if (!name || unknownModifier) return null;
    const keyval = lookupKeyval(name);
    return keyval !== null ? { keyval, modifiers } : null;
}

// One step of what a menu item types: a shortcut ("<Control>s"), some text
// ({ text: "zed: about" }), or a shortcut after a longer pause
// ({ key: "Return", delay: 250 }). -> { delay, shortcut } or { delay, text }
function parseStep(step) {
    if (typeof step === 'string') {
        const shortcut = parseAccelerator(step);
        return shortcut && { delay: KEY_DELAY_MS, shortcut };
    }
    if (typeof step?.text === 'string') {
        const keyvals = [...step.text].map(c => Clutter.unicode_to_keysym(c.codePointAt(0)));
        return { delay: step.delay ?? KEY_DELAY_MS, text: keyvals };
    }
    if (typeof step?.key === 'string') {
        const shortcut = parseAccelerator(step.key);
        return shortcut && { delay: step.delay ?? KEY_DELAY_MS, shortcut };
    }
    return null;
}

// Types keyboard shortcuts and text into the focused window, for menu items
// that stand in for them.
export class KeySender {
    constructor() {
        this._device = null;
        this._timeoutId = 0;
    }

    // send('<Control>c'); several in a row, as a chord: send('<Control>k',
    // '<Control>s'); or with text: send('<Control><Shift>p', { text: 'x' },
    // 'Return'). See parseStep().
    send(...steps) {
        const shortcuts = steps.map(parseStep);
        if (shortcuts.length === 0 || shortcuts.includes(null)) {
            console.warn(`[globalmenu] Cannot type '${JSON.stringify(steps)}'`);
            return;
        }

        // Created ahead of the key presses: the first events of a brand new
        // device can get lost.
        // Through the stage's context: GNOME 51 dropped Clutter.get_default_backend().
        this._device ??= global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        const next = () => {
            this._timeoutId = 0;
            const current = shortcuts.shift();
            if (current.text)
                this._type(current.text);
            else
                this._press(current.shortcut);
            if (shortcuts.length > 0)
                this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, shortcuts[0].delay, next);
            return GLib.SOURCE_REMOVE;
        };
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, shortcuts[0].delay, next);
    }

    _press({ keyval, modifiers }) {
        // An item of the closing menu may still hold the keyboard focus,
        // which would keep the keys from reaching the window.
        if (global.stage.get_key_focus())
            global.stage.set_key_focus(null);

        let time = GLib.get_monotonic_time();
        const step = (key, state) => {
            this._device.notify_keyval(time, key, state);
            time += 2000;
        };
        modifiers.forEach(modifier => step(modifier, Clutter.KeyState.PRESSED));
        step(keyval, Clutter.KeyState.PRESSED);
        step(keyval, Clutter.KeyState.RELEASED);
        [...modifiers].reverse().forEach(modifier => step(modifier, Clutter.KeyState.RELEASED));
    }

    // Each character as its key; the shell adds Shift or AltGr where the
    // keyboard layout needs them.
    _type(keyvals) {
        let time = GLib.get_monotonic_time();
        for (const keyval of keyvals) {
            this._device.notify_keyval(time, keyval, Clutter.KeyState.PRESSED);
            this._device.notify_keyval(time + 1000, keyval, Clutter.KeyState.RELEASED);
            time += 2000;
        }
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._device = null;
    }
}
