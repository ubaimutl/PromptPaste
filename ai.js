import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const RETRYABLE = new Set([408, 429, 502, 503, 504, 529]);

function payload(text, mode) {
    const action = mode === 'rewrite' ? 'Rewrite' : 'Correct';
    return `${action} only the text inside the tags.\nReturn only the transformed text. Preserve the original language.\n<text>\n${text}\n</text>`;
}

function maxTokens(text) {
    return Math.min(900, Math.max(220, Math.ceil(text.length / 4) + 180));
}

function cleanOutput(text) {
    let output = text.trim();
    const tagged = output.match(/^<text>\s*([\s\S]*?)\s*<\/text>$/i);
    if (tagged)
        output = tagged[1].trim();
    const fenced = output.match(/^```(?:text)?\s*\n?([\s\S]*?)\n?```$/i);
    if (fenced)
        output = fenced[1].trim();
    return output;
}

function requestJson(session, url, headers, body, cancellable) {
    return new Promise((resolve, reject) => {
        const message = Soup.Message.new('POST', url);
        for (const [name, value] of Object.entries(headers))
            message.request_headers.append(name, value);
        message.set_request_body_from_bytes('application/json', new GLib.Bytes(JSON.stringify(body)));
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (_session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                const text = new TextDecoder().decode(bytes.get_data());
                let data = {};
                try {
                    data = JSON.parse(text);
                } catch {
                    throw new Error(`Invalid response (${message.status_code})`);
                }
                resolve({status: message.status_code, data});
            } catch (error) {
                reject(error);
            }
        });
    });
}

function openAiBody(model, prompt, text, mode, cerebras = false) {
    const body = {
        model,
        messages: [
            {role: 'system', content: prompt},
            {role: 'user', content: payload(text, mode)},
        ],
        temperature: 0,
        top_p: 1,
    };
    body[cerebras ? 'max_completion_tokens' : 'max_tokens'] = maxTokens(text);
    return body;
}

function outputOrError(result) {
    const output = result.data?.choices?.[0]?.message?.content?.trim();
    if (output)
        return cleanOutput(output);
    throw new Error(result.data?.error?.message ?? `Provider error (${result.status})`);
}

export class AiClient {
    constructor(settings) {
        this._settings = settings;
        this._session = new Soup.Session({timeout: 45});
        this._cancellable = null;
    }

    cancel() {
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    async transform(text, mode) {
        this.cancel();
        this._cancellable = new Gio.Cancellable();
        const provider = this._settings.get_string('provider');
        const prompt = this._settings.get_string(mode === 'rewrite' ? 'prompt-rewrite' : 'prompt-correct');
        if (provider === 'gemini')
            return this._gemini(text, mode, prompt);
        if (provider === 'openrouter')
            return this._openRouter(text, mode, prompt);
        if (provider === 'cerebras')
            return this._cerebras(text, mode, prompt);
        return this._groq(text, mode, prompt);
    }

    _required(key, label) {
        const value = this._settings.get_string(key).trim();
        if (!value)
            throw new Error(`Add a ${label} API key in Settings.`);
        return value;
    }

    async _groq(text, mode, prompt) {
        const key = this._required('groq-api-key', 'Groq');
        const model = this._settings.get_string('groq-model');
        const body = openAiBody(model, prompt, text, mode);
        if (model.startsWith('openai/gpt-oss-')) {
            body.reasoning_effort = 'low';
            body.include_reasoning = false;
        }
        const result = await requestJson(this._session,
            'https://api.groq.com/openai/v1/chat/completions',
            {Authorization: `Bearer ${key}`},
            body, this._cancellable);
        return outputOrError(result);
    }

    async _gemini(text, mode, prompt) {
        const key = this._required('gemini-api-key', 'Gemini');
        const model = encodeURIComponent(this._settings.get_string('gemini-model'));
        const result = await requestJson(this._session,
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
            {}, {
                systemInstruction: {parts: [{text: prompt}]},
                contents: [{role: 'user', parts: [{text: payload(text, mode)}]}],
                generationConfig: {maxOutputTokens: maxTokens(text), temperature: 0, topP: 1},
            }, this._cancellable);
        const output = result.data?.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('').trim();
        if (output)
            return cleanOutput(output);
        throw new Error(result.data?.error?.message ?? `Gemini error (${result.status})`);
    }

    async _openRouter(text, mode, prompt) {
        const key = this._required('openrouter-api-key', 'OpenRouter');
        for (let attempt = 0; attempt < 2; attempt++) {
            const result = await requestJson(this._session,
                'https://openrouter.ai/api/v1/chat/completions',
                {Authorization: `Bearer ${key}`, 'X-Title': 'AI AutoCorrect'},
                openAiBody(this._settings.get_string('openrouter-model'), prompt, text, mode), this._cancellable);
            if (result.data?.choices?.[0]?.message?.content)
                return outputOrError(result);
            if (attempt === 0 && RETRYABLE.has(result.status)) {
                await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
                    resolve();
                    return GLib.SOURCE_REMOVE;
                }));
                continue;
            }
            return outputOrError(result);
        }
        throw new Error('OpenRouter request failed.');
    }

    async _cerebras(text, mode, prompt) {
        const key = this._required('cerebras-api-key', 'Cerebras');
        const result = await requestJson(this._session,
            'https://api.cerebras.ai/v1/chat/completions',
            {Authorization: `Bearer ${key}`},
            openAiBody(this._settings.get_string('cerebras-model'), prompt, text, mode, true), this._cancellable);
        return outputOrError(result);
    }
}
