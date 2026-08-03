import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {readActions, writeActions} from './actions.js';

const PROVIDERS = ['ollama', 'groq', 'gemini', 'openrouter', 'cerebras', 'openai', 'vercel'];

function entry(group, settings, key, title, password = false) {
    const row = password ? new Adw.PasswordEntryRow({title}) : new Adw.EntryRow({title});
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
}

export default class PromptPastePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        const providerGroup = new Adw.PreferencesGroup({title: 'Provider'});
        const model = Gtk.StringList.new([
            'Ollama (local)', 'Groq', 'Gemini', 'OpenRouter', 'Cerebras', 'OpenAI', 'Vercel AI Gateway',
        ]);
        const provider = new Adw.ComboRow({title: 'Active provider', model});
        provider.selected = Math.max(0, PROVIDERS.indexOf(settings.get_string('provider')));
        provider.connect('notify::selected', () => settings.set_string('provider', PROVIDERS[provider.selected]));
        providerGroup.add(provider);
        page.add(providerGroup);

        const keys = new Adw.PreferencesGroup({title: 'API keys and models'});
        entry(keys, settings, 'ollama-url', 'Ollama address');
        entry(keys, settings, 'ollama-model', 'Ollama model');
        for (const [name, label] of [
            ['groq', 'Groq'],
            ['gemini', 'Gemini'],
            ['openrouter', 'OpenRouter'],
            ['cerebras', 'Cerebras'],
            ['openai', 'OpenAI'],
            ['vercel', 'Vercel AI Gateway'],
        ]) {
            entry(keys, settings, `${name}-api-key`, `${label} API key`, true);
            entry(keys, settings, `${name}-model`, `${label} model`);
        }
        page.add(keys);

        const actions = new Adw.PreferencesGroup({
            title: 'Custom actions',
            description: 'Create actions for the panel menu. Use the Open actions shortcut for quick access.',
        });
        this._actionsGroup = actions;
        this._actionRows = [];
        this._renderActions(settings);
        page.add(actions);

        const shortcuts = new Adw.PreferencesGroup({
            title: 'Shortcuts',
            description: 'Click an action, then press the shortcut you want.',
        });
        this._shortcutRow(shortcuts, settings, 'correct-shortcut', 'Correct');
        this._shortcutRow(shortcuts, settings, 'rewrite-shortcut', 'Rewrite');
        this._shortcutRow(shortcuts, settings, 'actions-shortcut', 'Open actions');
        page.add(shortcuts);

        const behavior = new Adw.PreferencesGroup({title: 'Result'});
        const preview = new Adw.SwitchRow({
            title: 'Preview before replacing',
            subtitle: 'Confirm, copy, or cancel the generated result.',
        });
        settings.bind('preview-results', preview, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(preview);
        page.add(behavior);

        const prompts = new Adw.PreferencesGroup({title: 'Prompts'});
        entry(prompts, settings, 'prompt-correct', 'Correction prompt');
        entry(prompts, settings, 'prompt-rewrite', 'Rewrite prompt');
        page.add(prompts);

        const variables = new Adw.PreferencesGroup({
            title: 'Prompt variables',
            description: 'Available as ${language}, ${tone}, ${style}, and ${selection}.',
        });
        entry(variables, settings, 'variable-language', 'Language');
        entry(variables, settings, 'variable-tone', 'Tone');
        entry(variables, settings, 'variable-style', 'Style');
        page.add(variables);

        window.add(page);
    }

    _renderActions(settings) {
        for (const row of this._actionRows)
            this._actionsGroup.remove(row);
        this._actionRows = [];

        for (const action of readActions(settings)) {
            const row = new Adw.ActionRow({title: action.name, subtitle: action.prompt});
            const edit = new Gtk.Button({
                icon_name: 'document-edit-symbolic',
                tooltip_text: 'Edit action',
                valign: Gtk.Align.CENTER,
            });
            edit.add_css_class('flat');
            edit.connect('clicked', () => this._editAction(settings, action));
            row.add_suffix(edit);
            this._actionsGroup.add(row);
            this._actionRows.push(row);
        }

        const add = new Adw.ActionRow({title: 'Add action', activatable: true});
        add.add_suffix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
        add.connect('activated', () => this._editAction(settings));
        this._actionsGroup.add(add);
        this._actionRows.push(add);
    }

    _editAction(settings, action = null) {
        const page = new Adw.PreferencesPage();
        const fields = new Adw.PreferencesGroup({title: action ? 'Edit action' : 'New action'});
        const name = new Adw.EntryRow({title: 'Name', text: action?.name ?? ''});
        const prompt = new Adw.EntryRow({title: 'Prompt', text: action?.prompt ?? ''});
        fields.add(name);
        fields.add(prompt);
        page.add(fields);

        const buttons = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            halign: Gtk.Align.END,
            margin_start: 18,
            margin_end: 18,
            margin_bottom: 18,
        });
        const cancel = new Gtk.Button({label: 'Cancel'});
        const save = new Gtk.Button({label: 'Save'});
        save.add_css_class('suggested-action');
        buttons.append(cancel);
        if (action) {
            const remove = new Gtk.Button({label: 'Delete'});
            remove.add_css_class('destructive-action');
            buttons.prepend(remove);
            remove.connect('clicked', () => {
                writeActions(settings, readActions(settings).filter(item => item.id !== action.id));
                dialog.close();
                this._renderActions(settings);
            });
        }
        buttons.append(save);

        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        content.append(page);
        content.append(buttons);
        const dialog = new Adw.Window({
            title: action ? 'Edit action' : 'New action',
            modal: true,
            transient_for: this._actionsGroup.get_root(),
            default_width: 520,
            default_height: 260,
            content,
        });
        cancel.connect('clicked', () => dialog.close());
        save.connect('clicked', () => {
            const actionName = name.text.trim();
            const actionPrompt = prompt.text.trim();
            if (!actionName || !actionPrompt)
                return;
            const actions = readActions(settings);
            const next = {id: action?.id ?? GLib.uuid_string_random(), name: actionName, prompt: actionPrompt};
            const index = actions.findIndex(item => item.id === next.id);
            if (index >= 0)
                actions[index] = next;
            else
                actions.push(next);
            writeActions(settings, actions);
            dialog.close();
            this._renderActions(settings);
        });
        dialog.present();
    }

    _shortcutRow(group, settings, key, title) {
        const row = new Adw.ActionRow({title, activatable: true});
        const label = new Gtk.ShortcutLabel({
            accelerator: settings.get_strv(key)[0] ?? '',
            disabled_text: 'Not set',
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(label);
        row.connect('activated', () => {
            const content = new Adw.StatusPage({
                title: `Set ${title.toLowerCase()} shortcut`,
                description: 'Press a key combination. Backspace clears it; Escape cancels.',
                icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            });
            const dialog = new Adw.Window({
                modal: true,
                transient_for: row.get_root(),
                default_width: 480,
                default_height: 300,
                content,
            });
            const controller = new Gtk.EventControllerKey();
            controller.connect('key-pressed', (_controller, keyval, keycode, state) => {
                let mask = state & Gtk.accelerator_get_default_mod_mask();
                mask &= ~Gdk.ModifierType.LOCK_MASK;

                if (!mask && keyval === Gdk.KEY_Escape) {
                    dialog.close();
                    return Gdk.EVENT_STOP;
                }
                if (!mask && keyval === Gdk.KEY_BackSpace) {
                    settings.set_strv(key, []);
                    label.accelerator = '';
                    dialog.close();
                    return Gdk.EVENT_STOP;
                }
                if (!mask || !Gtk.accelerator_valid(keyval, mask))
                    return Gdk.EVENT_STOP;

                const accelerator = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
                settings.set_strv(key, [accelerator]);
                label.accelerator = accelerator;
                dialog.close();
                return Gdk.EVENT_STOP;
            });
            dialog.add_controller(controller);
            dialog.present();
        });
        group.add(row);
    }
}
