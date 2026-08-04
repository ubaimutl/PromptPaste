import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {readActions, writeActions} from './actions.js';
import {fetchModels, PROVIDERS} from './models.js';

function entry(group, settings, key, title, password = false) {
    const row = password ? new Adw.PasswordEntryRow({title}) : new Adw.EntryRow({title});
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

export default class PromptPastePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        const providerGroup = new Adw.PreferencesGroup({title: 'Provider'});
        const model = Gtk.StringList.new(PROVIDERS.map(item => item.name));
        const provider = new Adw.ComboRow({title: 'Active provider', model});
        provider.selected = Math.max(0, PROVIDERS.findIndex(item => item.id === settings.get_string('provider')));
        providerGroup.add(provider);
        page.add(providerGroup);

        this._providerSettings = new Adw.PreferencesGroup({title: 'Provider settings'});
        this._providerRows = [];
        this._renderProviderSettings(settings);
        page.add(this._providerSettings);
        provider.connect('notify::selected', () => {
            const selected = PROVIDERS[provider.selected];
            if (!selected)
                return;
            settings.set_string('provider', selected.id);
            this._renderProviderSettings(settings);
        });

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

        const capture = new Adw.PreferencesGroup({
            title: 'Selection capture',
            description:
                'GNOME normally reads the PRIMARY selection. Some apps—especially ' +
                'Firefox on Wayland—do not update it reliably. For listed apps, ' +
                'PromptPaste sends Ctrl+C and reads the regular clipboard instead. ' +
                'This changes the clipboard. Avoid adding terminals unless Ctrl+C ' +
                'copies text there.',
        });
        entry(capture, settings, 'explicit-copy-apps', 'Compatibility apps');
        page.add(capture);

        const behavior = new Adw.PreferencesGroup({title: 'Result'});
        const preview = new Adw.SwitchRow({
            title: 'Preview before replacing',
            subtitle: 'Confirm, copy, or cancel the generated result.',
        });
        settings.bind('preview-results', preview, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(preview);
        const clipboardFallback = new Adw.SwitchRow({
            title: 'Use clipboard when no text is selected',
            subtitle: 'Allow actions to use previously copied text.',
        });
        settings.bind('clipboard-fallback', clipboardFallback, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(clipboardFallback);
        const pointerFeedback = new Adw.SwitchRow({
            title: 'Show feedback near pointer',
            subtitle: 'Show progress, success, and errors where you are working.',
        });
        settings.bind('pointer-feedback', pointerFeedback, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(pointerFeedback);
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

        window.connect('close-request', () => {
            this._providerSettings = null;
            this._providerRows = null;
            this._modelRow = null;
            this._actionsGroup = null;
            this._actionRows = null;
            return false;
        });
        window.add(page);
    }

    _renderProviderSettings(settings) {
        for (const row of this._providerRows)
            this._providerSettings.remove(row);
        this._providerRows = [];

        let provider = settings.get_string('provider');
        const info = PROVIDERS.find(item => item.id === provider) ?? PROVIDERS[0];
        provider = info.id;
        this._providerSettings.title = info.name;
        if (provider === 'ollama')
            this._providerRows.push(entry(this._providerSettings, settings, 'ollama-url', 'Address'));
        else
            this._providerRows.push(entry(this._providerSettings, settings, info.key, 'API key', true));

        const modelRow = new Adw.ComboRow({title: 'Model', enable_search: true});
        const refresh = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Refresh models',
            valign: Gtk.Align.CENTER,
        });
        refresh.add_css_class('flat');
        const custom = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            tooltip_text: 'Enter a custom model',
            valign: Gtk.Align.CENTER,
        });
        custom.add_css_class('flat');
        modelRow.add_suffix(refresh);
        modelRow.add_suffix(custom);
        this._providerSettings.add(modelRow);
        this._providerRows.push(modelRow);
        this._modelRow = modelRow;

        const cached = this._cachedModels(settings, provider);
        this._setModelOptions(modelRow, settings, provider, cached);
        modelRow.connect('notify::selected', () => {
            if (modelRow._updating)
                return;
            const id = modelRow._modelIds?.[modelRow.selected];
            if (id)
                settings.set_string(`${provider}-model`, id);
        });
        refresh.connect('clicked', () => this._refreshModels(settings, provider, modelRow, refresh));
        custom.connect('clicked', () => this._customModel(settings, provider, modelRow));
    }

    _cachedModels(settings, provider) {
        try {
            const cache = JSON.parse(settings.get_string('model-cache'));
            return Array.isArray(cache[provider]) ? cache[provider] : [];
        } catch {
            return [];
        }
    }

    _cacheModels(settings, provider, models) {
        let cache = {};
        try {
            const parsed = JSON.parse(settings.get_string('model-cache'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                cache = parsed;
        } catch {
            // Replace an invalid cache.
        }
        cache[provider] = models;
        settings.set_string('model-cache', JSON.stringify(cache));
    }

    _setModelOptions(row, settings, provider, models) {
        const current = settings.get_string(`${provider}-model`);
        const options = [...models];
        if (current && !options.some(model => model.id === current))
            options.unshift({id: current, name: current});
        row._modelIds = options.map(model => model.id);
        row._updating = true;
        row.model = Gtk.StringList.new(options.map(model =>
            model.name && model.name !== model.id ? `${model.name} — ${model.id}` : model.id));
        row.selected = Math.max(0, row._modelIds.indexOf(current));
        row._updating = false;
    }

    async _refreshModels(settings, provider, row, button) {
        button.sensitive = false;
        row.subtitle = 'Loading…';
        try {
            const models = await fetchModels(settings, provider);
            if (this._modelRow !== row)
                return;
            this._cacheModels(settings, provider, models);
            this._setModelOptions(row, settings, provider, models);
            row.subtitle = `${models.length} available`;
        } catch (error) {
            if (this._modelRow === row)
                row.subtitle = error.message ?? String(error);
        } finally {
            if (this._modelRow === row)
                button.sensitive = true;
        }
    }

    _customModel(settings, provider, modelRow) {
        const field = new Adw.EntryRow({
            title: 'Model ID',
            text: settings.get_string(`${provider}-model`),
            show_apply_button: true,
        });
        const group = new Adw.PreferencesGroup();
        group.add(field);
        const page = new Adw.PreferencesPage();
        page.add(group);
        const dialog = new Adw.Window({
            title: 'Custom model',
            modal: true,
            destroy_with_parent: true,
            transient_for: this._providerSettings.get_root(),
            default_width: 480,
            default_height: 160,
            content: page,
        });
        const save = () => {
            const id = field.text.trim();
            if (!id)
                return;
            settings.set_string(`${provider}-model`, id);
            this._setModelOptions(modelRow, settings, provider, this._cachedModels(settings, provider));
            dialog.close();
        };
        field.connect('entry-activated', save);
        field.connect('apply', save);
        dialog.present();
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
            destroy_with_parent: true,
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
                destroy_with_parent: true,
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
