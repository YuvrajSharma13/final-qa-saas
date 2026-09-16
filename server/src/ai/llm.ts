import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

// Optional model layer. Every agent has a deterministic engine; when an
// ANTHROPIC_API_KEY is configured the agents additionally ask the model for
// structured JSON (plan enrichment, screenshot review, bug write-ups, patches).
// Keys stay server-side and are never sent to the browser.

let client: Anthropic | null = null;
export const llmEnabled = () => Boolean(config.anthropicKey) && !config.aiDisabled;

function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.anthropicKey });
  return client;
}

export interface AskJsonOptions {
  system: string;
  prompt: string;
  images?: Buffer[];
  maxTokens?: number;
}

export async function askJson<T>(opts: AskJsonOptions): Promise<T | null> {
  if (!llmEnabled()) return null;
  try {
    const content: Anthropic.ContentBlockParam[] = [];
    for (const img of opts.images || []) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.toString('base64') } });
    }
    content.push({ type: 'text', text: `${opts.prompt}\n\nRespond with a single JSON value only, no prose.` });
    const msg = await getClient().messages.create({
      model: config.anthropicModel,
      max_tokens: opts.maxTokens ?? 1500,
      system: opts.system,
      messages: [{ role: 'user', content }],
    });
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = (match ? match[1] : text).trim();
    const start = raw.search(/[[{]/);
    return JSON.parse(start > 0 ? raw.slice(start) : raw) as T;
  } catch (err) {
    console.warn('[llm] request failed, falling back to deterministic engine:', (err as Error).message);
    return null;
  }
}
