import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {AiClient} from './ai.js';

export default class AiAutoCorrectExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._client = new AiClient(this._settings);
        this._clipboard = St.Clipboard.get_default();
        this._keyboard = Clutter.get_default_backend()
            .get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._indicator = new PanelMenu.Button(0, this.metadata.name, false);
        this._icon = new St.Icon({
            icon_name: 'tools-check-spelling-symbolic',
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(this._icon);

        const correct = new PopupMenu.PopupMenuItem('Correct selected text');
        correct.connect('activate', () => this._run('correct'));
        this._indicator.menu.addMenuItem(correct);

        const rewrite = new PopupMenu.PopupMenuItem('Rewrite selected text');
        rewrite.connect('activate', () => this._run('rewrite'));
        this._indicator.menu.addMenuItem(rewrite);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settings = new PopupMenu.PopupMenuItem('Settings');
        settings.connect('activate', () => this.openPreferences());
        this._indicator.menu.addMenuItem(settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._addShortcut('correct-shortcut', 'correct');
        this._addShortcut('rewrite-shortcut', 'rewrite');
    }

    _addShortcut(name, mode) {
        Main.wm.addKeybinding(name, this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._run(mode));
    }

    async _run(mode) {
        if (this._busy)
            return;
        this._busy = true;
        this._setIcon('content-loading-symbolic');
        try {
            const text = await this._readSelection();
            if (!text.trim())
                throw new Error('Select text first.');
            const output = await this._client.transform(text, mode);
            this._clipboard.set_text(St.ClipboardType.CLIPBOARD, output);
            this._paste();
            this._setIcon('emblem-ok-symbolic', 1200);
        } catch (error) {
            this._setIcon('tools-check-spelling-symbolic');
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                Main.notifyError('AI AutoCorrect', error.message ?? String(error));
        } finally {
            this._busy = false;
        }
    }

    _readSelection() {
        return new Promise(resolve => {
            this._clipboard.get_text(St.ClipboardType.PRIMARY, (_clipboard, text) => {
                if (text?.trim()) {
                    resolve(text);
                    return;
                }
                this._clipboard.get_text(St.ClipboardType.CLIPBOARD,
                    (_secondClipboard, fallback) => resolve(fallback ?? ''));
            });
        });
    }

    _paste() {
        const time = GLib.get_monotonic_time();
        this._keyboard.notify_keyval(time, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(time, Clutter.KEY_v, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(time, Clutter.KEY_v, Clutter.KeyState.RELEASED);
        this._keyboard.notify_keyval(time, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
    }

    _setIcon(name, resetAfter = 0) {
        if (this._icon)
            this._icon.icon_name = name;
        if (this._iconResetId) {
            GLib.Source.remove(this._iconResetId);
            this._iconResetId = null;
        }
        if (resetAfter) {
            this._iconResetId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, resetAfter, () => {
                if (this._icon)
                    this._icon.icon_name = 'tools-check-spelling-symbolic';
                this._iconResetId = null;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    disable() {
        Main.wm.removeKeybinding('correct-shortcut');
        Main.wm.removeKeybinding('rewrite-shortcut');
        this._client?.cancel();
        if (this._iconResetId)
            GLib.Source.remove(this._iconResetId);
        this._indicator?.destroy();
        this._indicator = null;
        this._icon = null;
        this._iconResetId = null;
        this._keyboard = null;
        this._clipboard = null;
        this._client = null;
        this._settings = null;
    }
}
