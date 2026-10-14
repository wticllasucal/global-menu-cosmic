import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// The shell imports an extension's modules once per session and never
// again, so the code proper lives in impl/<revision>/ and is imported from
// here by path: writing a new revision directory, pointing impl/current at
// it and toggling the extension off and on runs the new code without
// logging out.
export default class GlobalMenuLoader extends Extension {
    constructor(metadata) {
        super(metadata);
        this._impl = null;
        this._enabled = false;
        // Handed to every revision; holds what must survive a reload.
        this._store = {};
    }

    enable() {
        this._enabled = true;
        this._load().catch(e => console.error(`[${this.uuid}] Could not start: ${e}\n${e.stack}`));
    }

    async _load() {
        const [, contents] = GLib.file_get_contents(GLib.build_filenamev([this.path, 'impl', 'current']));
        const revision = new TextDecoder().decode(contents).trim();
        const uri = GLib.filename_to_uri(
            GLib.build_filenamev([this.path, 'impl', revision, 'main.js']), null);
        const { GlobalMenu } = await import(uri);

        // disable() may have run while the module was loading.
        if (!this._enabled || this._impl) return;
        console.log(`[${this.uuid}] Enabling revision ${revision}.`);
        this._impl = new GlobalMenu(this, this._store);
        this._impl.enable();
    }

    disable() {
        this._enabled = false;
        if (this._impl) {
            this._impl.disable();
            this._impl = null;
        }
    }
}
