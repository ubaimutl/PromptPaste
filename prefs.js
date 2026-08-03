import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PROVIDERS = ['groq', 'gemini', 'openrouter', 'cerebras', 'openai', 'vercel'];

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
        const model = Gtk.StringList.new(['Groq', 'Gemini', 'OpenRouter', 'Cerebras', 'OpenAI', 'Vercel AI Gateway']);
        const provider = new Adw.ComboRow({title: 'Active provider', model});
        provider.selected = Math.max(0, PROVIDERS.indexOf(settings.get_string('provider')));
        provider.connect('notify::selected', () => settings.set_string('provider', PROVIDERS[provider.selected]));
        providerGroup.add(provider);
        page.add(providerGroup);

        const keys = new Adw.PreferencesGroup({title: 'API keys and models'});
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

        const shortcuts = new Adw.PreferencesGroup({
            title: 'Shortcuts',
            description: 'Click an action, then press the shortcut you want.',
        });
        this._shortcutRow(shortcuts, settings, 'correct-shortcut', 'Correct');
        this._shortcutRow(shortcuts, settings, 'rewrite-shortcut', 'Rewrite');
        page.add(shortcuts);

        const prompts = new Adw.PreferencesGroup({title: 'Prompts'});
        entry(prompts, settings, 'prompt-correct', 'Correction prompt');
        entry(prompts, settings, 'prompt-rewrite', 'Rewrite prompt');
        page.add(prompts);

        window.add(page);
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
