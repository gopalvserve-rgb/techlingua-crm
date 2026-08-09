import { Injectable } from '@nestjs/common';
import { ChannelConfigService, ResolvedConfig } from '../messaging/channel-config.service';
import { NotConfiguredException } from '../common/not-configured.exception';

export type AiProvider = 'deepseek' | 'gemini';
export const AI_PROVIDERS: AiProvider[] = ['deepseek', 'gemini'];

export interface LlmResult {
  text: string;
  provider: string;
  model: string;
  tokens: number | null;
}

export interface LlmRequest {
  system: string;
  user: string;
  /** Ask the provider for strict JSON (best-effort — parsing is still defensive). */
  json?: boolean;
  maxTokens?: number;
}

/** Injectable http hook so tests never touch the network. */
export type HttpFn = (url: string, init: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }>;
const defaultHttp: HttpFn = (url, init) => (globalThis as any).fetch(url, init);

/**
 * THE LLM ADAPTER — the single place the CRM talks to a hosted LLM.
 *
 * The DeepSeek / Gemini API keys live in Settings > Channels (channel='ai', one encrypted
 * row per provider). This adapter RESOLVES a configured provider (never a hardcoded key),
 * calls it with a bounded timeout + one retry, and returns text. When NO ai key is stored
 * it throws NotConfiguredException — a 503 the UI surfaces as a clean "add a DeepSeek/Gemini
 * key in Settings" state, never a 500, and never an Error-Log row.
 *
 * DeepSeek speaks the OpenAI chat-completions dialect; Gemini speaks generateContent. Both
 * are normalised to { text } here so the AiService is provider-agnostic.
 */
@Injectable()
export class LlmAdapterService {
  private readonly timeoutMs = 20_000;

  /** Overridable so tests never touch the network (set it in a spec). */
  http: HttpFn = defaultHttp;

  constructor(private readonly channels: ChannelConfigService) {}

  /** Per-provider configured flags for the "AI not configured" UI, without decrypting. */
  async providerStatus(): Promise<Array<{ provider: AiProvider; label: string; configured: boolean }>> {
    const rows = await this.channels.status().catch(() => []);
    const byProvider = new Map(rows.filter((r) => r.channel === 'ai').map((r) => [r.provider, r.configured]));
    return AI_PROVIDERS.map((p) => ({
      provider: p,
      label: p === 'deepseek' ? 'DeepSeek' : 'Google Gemini',
      configured: !!byProvider.get(p),
    }));
  }

  async anyConfigured(): Promise<boolean> {
    return (await this.providerStatus()).some((p) => p.configured);
  }

  /** Resolve a usable, key-bearing ai provider — the preferred one, else deepseek, else gemini. */
  private async pick(preferred?: string | null): Promise<ResolvedConfig | null> {
    const order = preferred && AI_PROVIDERS.includes(preferred as AiProvider)
      ? [preferred, ...AI_PROVIDERS.filter((p) => p !== preferred)]
      : AI_PROVIDERS;
    for (const p of order) {
      const cfg = await this.channels.resolve('ai', null, p);
      if (cfg && cfg.secrets?.api_key) return cfg;
    }
    return null;
  }

  /**
   * Run a completion. Throws NotConfiguredException when no key is stored (degrade cleanly).
   * `preferred` optionally forces DeepSeek or Gemini when both are configured.
   */
  async complete(req: LlmRequest, preferred?: string | null): Promise<LlmResult> {
    const cfg = await this.pick(preferred);
    if (!cfg) {
      throw new NotConfiguredException(
        'AI is not configured — add a DeepSeek or Gemini key in Administration > Settings > Channels > AI.',
      );
    }
    const provider = cfg.provider as AiProvider;
    const apiKey = cfg.secrets.api_key;
    const model = String(cfg.config?.model || (provider === 'deepseek' ? 'deepseek-chat' : 'gemini-2.0-flash'));
    const baseUrl = String(cfg.config?.base_url || 'https://api.deepseek.com');

    // one retry on a transient failure
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return provider === 'deepseek'
          ? await this.callDeepSeek(baseUrl, apiKey, model, req)
          : await this.callGemini(apiKey, model, req);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('LLM call failed');
  }

  private async withTimeout<T>(fn: (signal: any) => Promise<T>): Promise<T> {
    const ctrl = new (globalThis as any).AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await fn(ctrl.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private async callDeepSeek(baseUrl: string, apiKey: string, model: string, req: LlmRequest): Promise<LlmResult> {
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body = {
      model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      temperature: 0.2,
      max_tokens: req.maxTokens ?? 900,
      ...(req.json ? { response_format: { type: 'json_object' } } : {}),
    };
    const res = await this.withTimeout((signal) => this.http(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    }));
    if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    const tokens = data?.usage?.total_tokens ?? null;
    return { text: String(text), provider: 'deepseek', model, tokens };
  }

  private async callGemini(apiKey: string, model: string, req: LlmRequest): Promise<LlmResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: req.maxTokens ?? 900,
        ...(req.json ? { responseMimeType: 'application/json' } : {}),
      },
    };
    const res = await this.withTimeout((signal) => this.http(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }));
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    const data = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('');
    const tokens = data?.usageMetadata?.totalTokenCount ?? null;
    return { text: String(text), provider: 'gemini', model, tokens };
  }
}
