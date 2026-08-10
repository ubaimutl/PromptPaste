import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {AiClient} from './ai.js';
import {readActions} from './actions.js';

const SHELL_MAJOR = Number.parseInt(Config.PACKAGE_VERSION, 10);

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
        const box = new St.BoxLayout(SHELL_MAJOR >= 48
            ? {orientation: Clutter.Orientation.VERTICAL, x_expand: true}
            : {vertical: true, x_expand: true});
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
        this._feedbackId = null;
        this._feedbackFollowId = null;
        this._feedback = null;
        this._previewDialog = null;
        this._pendingDelays = new Map();
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

        if (this._feedbackFollowId) {
            GLib.Source.remove(this._feedbackFollowId);
            this._feedbackFollowId = null;
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

        for (const [id, resolve] of this._pendingDelays) {
            GLib.Source.remove(id);
            resolve(false);
        }
        this._pendingDelays.clear();
        this._pendingDelays = null;

        this._actionsSection.destroy();
        this._actionsSection = null;
        this._icon.destroy();
        this._icon = null;
        this._indicator.destroy();
        this._indicator = null;
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
        const focusedWindow = global.display.focus_window;
        this._busy = true;
        this._setIcon('content-loading-symbolic');
        this._showFeedback('Working…', false, 0);
        try {
            const text = await this._readSelection(focusedWindow);
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
        this._pasteWhenReady(delayed ? 200 : 0, message);
    }

    async _pasteWhenReady(initialDelay, message) {
        if (initialDelay > 0 && !await this._delay(initialDelay))
            return;
        const released = await this._waitForModifiersReleased();
        if (!this._keyboard)
            return;
        if (!released) {
            this._setIcon('tools-check-spelling-symbolic');
            this._showFeedback('Release the shortcut keys and try again.', true, 3500);
            return;
        }
        if (!await this._delay(25) || !this._keyboard)
            return;
        this._paste();
        this._setIcon('emblem-ok-symbolic', 1200);
        this._showFeedback(message);
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
        if (this._feedbackFollowId) {
            GLib.Source.remove(this._feedbackFollowId);
            this._feedbackFollowId = null;
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
        const [, naturalWidth] = label.get_preferred_width(-1);
        const [, naturalHeight] = label.get_preferred_height(naturalWidth);

        const position = () => {
            const [pointerX, pointerY] = global.get_pointer();
            const x = Math.max(8, Math.min(pointerX + 16, global.stage.width - naturalWidth - 8));
            const y = Math.max(8, Math.min(pointerY + 20, global.stage.height - naturalHeight - 8));
            label.set_position(x, y);
        };
        position();
        label.ease({opacity: 255, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._feedback = label;

        this._feedbackFollowId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._feedback)
                return GLib.SOURCE_REMOVE;
            position();
            return GLib.SOURCE_CONTINUE;
        });

        if (duration > 0) {
            this._feedbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
                this._feedbackId = null;
                if (this._feedbackFollowId) {
                    GLib.Source.remove(this._feedbackFollowId);
                    this._feedbackFollowId = null;
                }
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

    async _readSelection(focusedWindow) {
        if (this._usesExplicitCopy(focusedWindow))
            return this._readExplicitCopy();

        const text = await this._getClipboardText(St.ClipboardType.PRIMARY);
        if (text?.trim())
            return text;
        if (!this._settings?.get_boolean('clipboard-fallback'))
            return '';
        return this._getClipboardText(St.ClipboardType.CLIPBOARD);
    }

    _usesExplicitCopy(window) {
        if (!window || !this._settings)
            return false;
        const allowed = this._settings.get_string('explicit-copy-apps')
            .split(/[\n,]/)
            .map(value => value.trim().toLowerCase())
            .filter(Boolean);
        if (allowed.length === 0)
            return false;

        const appId = Shell.WindowTracker.get_default()
            .get_window_app(window)?.get_id();
        const values = [
            appId,
            window.get_wm_class(),
            window.get_wm_class_instance(),
            window.get_gtk_application_id(),
        ].filter(Boolean).map(value => value.toLowerCase());
        return allowed.some(name => values.some(value => value.includes(name)));
    }

    async _readExplicitCopy() {
        const previous = await this._getClipboardText(St.ClipboardType.CLIPBOARD);
        const released = await this._waitForModifiersReleased();
        if (!this._keyboard)
            return '';
        if (!released)
            throw new Error('Release the shortcut keys and try again.');
        if (!await this._delay(25))
            return '';

        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, '');
        if (!await this._delay(25))
            return '';
        this._copy();

        for (const delay of [60, 100, 180, 300]) {
            if (!await this._delay(delay))
                return '';
            const text = await this._getClipboardText(St.ClipboardType.CLIPBOARD);
            if (text?.trim())
                return text;
        }

        if (previous)
            this._clipboard.set_text(St.ClipboardType.CLIPBOARD, previous);
        if (this._settings?.get_boolean('clipboard-fallback') && previous?.trim())
            return previous;
        throw new Error('Could not capture selected text. Select it and try again.');
    }

    _getClipboardText(type) {
        const clipboard = this._clipboard;
        return new Promise(resolve => {
            if (!clipboard) {
                resolve('');
                return;
            }
            clipboard.get_text(type, (_clipboard, text) => resolve(text ?? ''));
        });
    }

    _delay(milliseconds) {
        return new Promise(resolve => {
            if (!this._pendingDelays) {
                resolve(false);
                return;
            }
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
                this._pendingDelays?.delete(id);
                resolve(Boolean(this._keyboard));
                return GLib.SOURCE_REMOVE;
            });
            this._pendingDelays.set(id, resolve);
        });
    }

    async _waitForModifiersReleased(timeoutMs = 1500) {
        const modifierMask = [
            Clutter.ModifierType.SHIFT_MASK,
            Clutter.ModifierType.CONTROL_MASK,
            Clutter.ModifierType.MOD1_MASK,
            Clutter.ModifierType.MOD3_MASK,
            Clutter.ModifierType.MOD4_MASK,
            Clutter.ModifierType.MOD5_MASK,
            Clutter.ModifierType.SUPER_MASK,
            Clutter.ModifierType.HYPER_MASK,
            Clutter.ModifierType.META_MASK,
        ].reduce((mask, value) => mask | (value ?? 0), 0);
        const startedAt = GLib.get_monotonic_time();

        while (this._keyboard) {
            const [, , modifiers] = global.get_pointer();
            if ((modifiers & modifierMask) === 0)
                return true;
            const elapsedMs = (GLib.get_monotonic_time() - startedAt) / 1000;
            if (elapsedMs >= timeoutMs)
                return false;
            if (!await this._delay(20))
                return false;
        }
        return false;
    }

    _copy() {
        const time = GLib.get_monotonic_time();
        this._keyboard.notify_keyval(time, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(time, Clutter.KEY_c, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(time, Clutter.KEY_c, Clutter.KeyState.RELEASED);
        this._keyboard.notify_keyval(time, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
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