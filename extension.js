import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {AiClient} from './ai.js';
import {readActions} from './actions.js';

const ResultDialog = GObject.registerClass(
class ResultDialog extends ModalDialog.ModalDialog {
    _init(result, onReplace, onCopy, onCancel, onClose) {
        super._init({destroyOnClose: true});
        this._finished = false;
        this._onClose = onClose;

        const title = new St.Label({
            text: 'PromptPaste result',
            style_class: 'modal-dialog-headline',
        });
        this.contentLayout.add_child(title);

        const estimatedLines = result.split('\n').reduce((total, line) =>
            total + Math.max(1, Math.ceil(line.length / 70)), 0);
        const scroll = new St.ScrollView({
            overlay_scrollbars: true,
            width: 560,
            height: Math.min(320, Math.max(120, estimatedLines * 24 + 24)),
            style_class: 'vfade',
        });
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const label = new St.Label({
            text: result,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            style_class: 'promptpaste-result',
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(label);
        scroll.set_child(box);
        this.contentLayout.add_child(scroll);

        this.setButtons([
            {
                label: 'Cancel',
                key: Clutter.KEY_Escape,
                action: () => this._finish(onCancel),
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
});

export default class PromptPasteExtension extends Extension {
    enable() {
        this._busy = false;
        this._iconResetId = null;
        this._pasteId = null;
        this._feedbackId = null;
        this._feedback = null;
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

        if (this._feedbackId) {
            GLib.Source.remove(this._feedbackId);
            this._feedbackId = null;
        }
        if (this._feedback) {
            this._feedback.destroy();
            this._feedback = null;
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
            item.connect('activate', () => this._run('custom', action.prompt, action.name));
            this._actionsSection.addMenuItem(item);
        }
    }

    async _run(mode, customPrompt = null, actionName = null) {
        if (this._busy)
            return;
        const client = this._client;
        this._busy = true;
        this._setIcon('content-loading-symbolic');
        this._showFeedback('Working…', false, 0);
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
                this._replace(output, false, actionName ?? (mode === 'rewrite' ? 'Rewritten' : 'Corrected'));
        } catch (error) {
            if (this._client !== client)
                return;
            if (error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._setIcon('tools-check-spelling-symbolic');
            this._showFeedback(error.message ?? String(error), true, 3500);
        } finally {
            this._busy = false;
        }
    }

    _showPreview(output) {
        if (this._previewDialog)
            this._previewDialog.destroy();
        const dialog = new ResultDialog(output,
            () => this._replace(output, true, 'Replaced'),
            () => {
                this._clipboard.set_text(St.ClipboardType.CLIPBOARD, output);
                this._setIcon('emblem-ok-symbolic', 1200);
                this._showFeedback('Copied');
            },
            () => this._showFeedback('Cancelled'),
            () => {
                if (this._previewDialog === dialog)
                    this._previewDialog = null;
            });
        this._previewDialog = dialog;
        dialog.open();
        this._setIcon('tools-check-spelling-symbolic');
        this._showFeedback('Ready to review');
    }

    _replace(output, delayed, message) {
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, output);
        if (!delayed) {
            this._paste();
            this._setIcon('emblem-ok-symbolic', 1200);
            this._showFeedback(message);
            return;
        }
        if (this._pasteId)
            GLib.Source.remove(this._pasteId);
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._pasteId = null;
            if (this._keyboard) {
                this._paste();
                this._setIcon('emblem-ok-symbolic', 1200);
                this._showFeedback(message);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _showFeedback(message, error = false, duration = 1500) {
        if (!this._settings?.get_boolean('pointer-feedback')) {
            if (error)
                Main.notifyError('PromptPaste', message);
            return;
        }
        if (this._feedbackId) {
            GLib.Source.remove(this._feedbackId);
            this._feedbackId = null;
        }
        if (this._feedback) {
            this._feedback.destroy();
            this._feedback = null;
        }

        const label = new St.Label({
            text: message,
            style_class: error ? 'promptpaste-feedback error' : 'promptpaste-feedback',
            opacity: 0,
        });
        label.clutter_text.line_wrap = true;
        Main.uiGroup.add_child(label);
        const [pointerX, pointerY] = global.get_pointer();
        const [, naturalWidth] = label.get_preferred_width(-1);
        const [, naturalHeight] = label.get_preferred_height(naturalWidth);
        const x = Math.max(8, Math.min(pointerX + 16, global.stage.width - naturalWidth - 8));
        const y = Math.max(8, Math.min(pointerY + 20, global.stage.height - naturalHeight - 8));
        label.set_position(x, y);
        label.ease({opacity: 255, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._feedback = label;

        if (duration > 0) {
            this._feedbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
                this._feedbackId = null;
                label.ease({
                    opacity: 0,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (this._feedback === label)
                            this._feedback = null;
                        label.destroy();
                    },
                });
                return GLib.SOURCE_REMOVE;
            });
        }
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
