import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {AiClient} from './ai.js';
import {readActions} from './actions.js';

class ResultDialog extends ModalDialog.ModalDialog {
    constructor(result, onReplace, onCopy, onClose) {
        super({destroyOnClose: true});
        this._finished = false;
        this._onClose = onClose;

        const title = new St.Label({
            text: 'PromptPaste result',
            style_class: 'modal-dialog-headline',
        });
        this.contentLayout.add_child(title);

        const scroll = new St.ScrollView({
            overlay_scrollbars: true,
            width: 560,
            height: 280,
        });
        const label = new St.Label({text: result, x_expand: true});
        label.clutter_text.line_wrap = true;
        scroll.add_child(label);
        this.contentLayout.add_child(scroll);

        this.setButtons([
            {
                label: 'Cancel',
                key: Clutter.KEY_Escape,
                action: () => this._finish(),
            },
            {
                label: 'Copy',
                action: () => this._finish(onCopy),
            },
            {
                label: 'Replace',
                default: true,
                action: () => this._finish(onReplace),
            },
        ]);
    }

    _finish(action = null) {
        if (this._finished)
            return;
        this._finished = true;
        this.close();
        this._onClose();
        action?.();
    }
}

export default class PromptPasteExtension extends Extension {
    enable() {
        this._busy = false;
        this._iconResetId = null;
        this._pasteId = null;
        this._previewDialog = null;
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

        this._actionsSection = new PopupMenu.PopupMenuSection();
        this._indicator.menu.addMenuItem(this._actionsSection);
        this._rebuildActions();
        this._actionsChangedId = this._settings.connect('changed::custom-actions',
            () => this._rebuildActions());

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settings = new PopupMenu.PopupMenuItem('Settings');
        settings.connect('activate', () => this.openPreferences());
        this._indicator.menu.addMenuItem(settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._addShortcut('correct-shortcut', 'correct');
        this._addShortcut('rewrite-shortcut', 'rewrite');
        Main.wm.addKeybinding('actions-shortcut', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._indicator.menu.open());
    }

    disable() {
        Main.wm.removeKeybinding('correct-shortcut');
        Main.wm.removeKeybinding('rewrite-shortcut');
        Main.wm.removeKeybinding('actions-shortcut');
        this._settings.disconnect(this._actionsChangedId);
        this._actionsChangedId = null;
        this._client.destroy();
        this._client = null;

        if (this._previewDialog) {
            this._previewDialog.destroy();
            this._previewDialog = null;
        }

        if (this._pasteId) {
            GLib.Source.remove(this._pasteId);
            this._pasteId = null;
        }

        if (this._iconResetId) {
            GLib.Source.remove(this._iconResetId);
            this._iconResetId = null;
        }

        this._icon.destroy();
        this._icon = null;
        this._indicator.destroy();
        this._indicator = null;
        this._actionsSection = null;
        this._keyboard = null;
        this._clipboard = null;
        this._settings = null;
    }

    _addShortcut(name, mode) {
        Main.wm.addKeybinding(name, this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._run(mode));
    }

    _rebuildActions() {
        this._actionsSection.removeAll();
        for (const action of readActions(this._settings)) {
            const item = new PopupMenu.PopupMenuItem(action.name);
            item.connect('activate', () => this._run('custom', action.prompt));
            this._actionsSection.addMenuItem(item);
        }
    }

    async _run(mode, customPrompt = null) {
        if (this._busy)
            return;
        const client = this._client;
        this._busy = true;
        this._setIcon('content-loading-symbolic');
        try {
            const text = await this._readSelection();
            if (this._client !== client)
                return;
            if (!text.trim())
                throw new Error('Select text first.');
            const output = await client.transform(text, mode, customPrompt);
            if (this._client !== client)
                return;
            if (this._settings.get_boolean('preview-results'))
                this._showPreview(output);
            else
                this._replace(output, false);
        } catch (error) {
            if (this._client !== client)
                return;
            if (error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._setIcon('tools-check-spelling-symbolic');
            Main.notifyError('PromptPaste', error.message ?? String(error));
        } finally {
            this._busy = false;
        }
    }

    _showPreview(output) {
        if (this._previewDialog)
            this._previewDialog.destroy();
        const dialog = new ResultDialog(output,
            () => this._replace(output, true),
            () => {
                this._clipboard.set_text(St.ClipboardType.CLIPBOARD, output);
                this._setIcon('emblem-ok-symbolic', 1200);
            },
            () => {
                if (this._previewDialog === dialog)
                    this._previewDialog = null;
            });
        this._previewDialog = dialog;
        dialog.open();
        this._setIcon('tools-check-spelling-symbolic');
    }

    _replace(output, delayed) {
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, output);
        if (!delayed) {
            this._paste();
            this._setIcon('emblem-ok-symbolic', 1200);
            return;
        }
        if (this._pasteId)
            GLib.Source.remove(this._pasteId);
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._pasteId = null;
            if (this._keyboard) {
                this._paste();
                this._setIcon('emblem-ok-symbolic', 1200);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _readSelection() {
        const clipboard = this._clipboard;
        return new Promise(resolve => {
            clipboard.get_text(St.ClipboardType.PRIMARY, (_clipboard, text) => {
                if (text?.trim()) {
                    resolve(text);
                    return;
                }
                clipboard.get_text(St.ClipboardType.CLIPBOARD,
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
        this._icon.icon_name = name;
        if (this._iconResetId) {
            GLib.Source.remove(this._iconResetId);
            this._iconResetId = null;
        }
        if (resetAfter) {
            this._iconResetId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, resetAfter, () => {
                this._icon.icon_name = 'tools-check-spelling-symbolic';
                this._iconResetId = null;
                return GLib.SOURCE_REMOVE;
            });
        }
    }
}
