import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

export const PROVIDERS = [
    {id: 'ollama', name: 'Ollama (local)', key: null},
    {id: 'groq', name: 'Groq', key: 'groq-api-key'},
    {id: 'gemini', name: 'Gemini', key: 'gemini-api-key'},
    {id: 'openrouter', name: 'OpenRouter', key: 'openrouter-api-key'},
    {id: 'cerebras', name: 'Cerebras', key: 'cerebras-api-key'},
    {id: 'openai', name: 'OpenAI', key: 'openai-api-key'},
    {id: 'vercel', name: 'Vercel AI Gateway', key: 'vercel-api-key'},
];

function getJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const session = new Soup.Session({timeout: 20});
        const message = Soup.Message.new('GET', url);
        for (const [name, value] of Object.entries(headers))
            message.request_headers.append(name, value);
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                const text = new TextDecoder().decode(bytes.get_data());
                const data = JSON.parse(text);
                if (message.status_code < 200 || message.status_code >= 300)
                    throw new Error(data?.error?.message ?? data?.error ?? `Request failed (${message.status_code})`);
                resolve(data);
            } catch (error) {
                reject(error);
            } finally {
                session.abort();
            }
        });
    });
}

function requiredKey(settings, key, provider) {
    const value = settings.get_string(key).trim();
    if (!value)
        throw new Error(`Add a ${provider} API key first.`);
    return value;
}

function uniqueModels(models) {
    const seen = new Set();
    return models
        .filter(model => model.id && !seen.has(model.id) && seen.add(model.id))
        .map(model => ({id: model.id, name: model.name ?? model.id}))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchModels(settings, provider) {
    let data;
    let models;
    if (provider === 'ollama') {
        const baseUrl = settings.get_string('ollama-url').replace(/\/$/, '');
        data = await getJson(`${baseUrl}/api/tags`);
        models = (data.models ?? []).map(model => ({id: model.model ?? model.name, name: model.name}));
    } else if (provider === 'gemini') {
        const key = requiredKey(settings, 'gemini-api-key', 'Gemini');
        data = await getJson(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`);
        models = (data.models ?? [])
            .filter(model => model.supportedGenerationMethods?.includes('generateContent'))
            .map(model => ({id: model.name.replace(/^models\//, ''), name: model.displayName}));
    } else {
        const info = PROVIDERS.find(item => item.id === provider);
        const key = provider === 'vercel'
            ? settings.get_string('vercel-api-key').trim()
            : info?.key ? requiredKey(settings, info.key, info.name) : '';
        const endpoints = {
            groq: 'https://api.groq.com/openai/v1/models',
            openrouter: 'https://openrouter.ai/api/v1/models?output_modalities=text',
            cerebras: 'https://api.cerebras.ai/v1/models',
            openai: 'https://api.openai.com/v1/models',
            vercel: 'https://ai-gateway.vercel.sh/v1/models',
        };
        data = await getJson(endpoints[provider], key ? {Authorization: `Bearer ${key}`} : {});
        models = (data.data ?? [])
            .filter(model => model.type ? model.type === 'language' : true)
            .map(model => ({id: model.id, name: model.name ?? model.id}));
        if (provider === 'openai') {
            models = models.filter(model => /^(gpt-|o\d)/.test(model.id) &&
                !/(audio|image|realtime|search|transcribe|tts)/.test(model.id));
        } else if (provider === 'groq') {
            models = models.filter(model => !/(guard|whisper|tts)/i.test(model.id));
        }
    }
    return uniqueModels(models);
}
