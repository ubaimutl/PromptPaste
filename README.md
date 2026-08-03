# PromptPaste

Use AI on selected text anywhere in GNOME. Correct writing, rewrite a sentence, translate, summarize, or create your own action by changing the prompts. Select the text, use your shortcut, and the result is pasted back automatically.

![PromptPaste demo](demo.gif)

Supports local Ollama plus Groq, Gemini, OpenRouter, Cerebras, OpenAI, and Vercel AI Gateway. Add your own API key in the extension settings:

- Ollama: https://ollama.com
- Groq: https://console.groq.com/keys
- Gemini: https://ai.google.dev/aistudio
- OpenRouter: https://openrouter.ai/keys
- Cerebras: https://cloud.cerebras.ai
- OpenAI: https://platform.openai.com/api-keys
- Vercel AI Gateway: https://vercel.com/ai-gateway

Clipboard text is sent to your chosen provider only when you run an action.

Create your own actions, reuse `${language}`, `${tone}`, `${style}`, or `${selection}` in prompts, and optionally preview results before replacing text.

Settings show only the active provider. Refresh its searchable model list or enter a custom model ID. Optional pointer feedback shows progress and results beside the cursor.

[Install from GNOME Extensions](https://extensions.gnome.org/extension/10540/ai-autocorrect/)
