import { Injectable } from '@nestjs/common';
import { ChannelConfigService, ResolvedConfig } from '../messaging/channel-config.service';
import { NotConfiguredException } from '../common/not-configured.exception';

/**
 * SPEECH-TO-TEXT — call recordings to text (client 12 Nov 2026, AI Insights / Communication
 * Intelligence). ONE provider is active (channel 'stt' in Settings › Channels), chosen by the
 * client: OpenAI Whisper, Deepgram or Sarvam (built for Indian languages). No key → the
 * NotConfiguredException path: nothing is sent anywhere and the screens say so.
 *
 * `http` is overridable so specs never touch the network.
 */
export type SttProvider = 'openai_whisper' | 'deepgram' | 'sarvam';
export interface SttResult { text: string; provider: SttProvider; model: string; language: string | null }
type HttpFn = (url: string, init: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }>;

@Injectable()
export class SttAdapterService {
  http: HttpFn = (url, init) => (globalThis as any).fetch(url, init);
  private readonly timeoutMs = 180_000;

  constructor(private readonly channels: ChannelConfigService) {}

  async active(): Promise<ResolvedConfig | null> {
    const cfg = await this.channels.resolve('stt' as any, null).catch(() => null);
    return cfg && cfg.secrets?.api_key ? cfg : null;
  }

  /** language: 'auto' | an ISO code such as 'hi' / 'en' / 'hi-IN'. */
  async transcribe(audio: Buffer, mime: string, fileName: string, language = 'auto'): Promise<SttResult> {
    const cfg = await this.active();
    if (!cfg) throw new NotConfiguredException('Speech-to-text is not configured — choose a provider and add its key in Administration › Settings › Channels › Speech-to-text.');
    const p = cfg.provider as SttProvider;
    const key = String(cfg.secrets.api_key);
    const ctrl = new (globalThis as any).AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      if (p === 'openai_whisper') {
        const model = String(cfg.config?.model || 'whisper-1');
        const fd = new FormData();
        fd.append('file', new Blob([audio], { type: mime || 'audio/mpeg' }), fileName || 'call.mp3');
        fd.append('model', model);
        if (language && language !== 'auto') fd.append('language', language.slice(0, 2));
        fd.append('response_format', 'json');
        const r = await this.http('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd, signal: ctrl.signal });
        if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
        const j = await r.json();
        return { text: String(j?.text ?? '').trim(), provider: p, model, language: language === 'auto' ? null : language };
      }
      if (p === 'deepgram') {
        const model = String(cfg.config?.model || 'nova-2');
        const q = new URLSearchParams({ model, smart_format: 'true', punctuate: 'true', diarize: 'true' });
        if (language && language !== 'auto') q.set('language', language.slice(0, 2)); else q.set('detect_language', 'true');
        const r = await this.http(`https://api.deepgram.com/v1/listen?${q.toString()}`, {
          method: 'POST', headers: { Authorization: `Token ${key}`, 'Content-Type': mime || 'audio/mpeg' }, body: audio, signal: ctrl.signal });
        if (!r.ok) throw new Error(`Deepgram HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
        const j = await r.json();
        const ch = j?.results?.channels?.[0];
        // speaker-labelled lines when diarization came back, else the plain transcript
        const words: any[] = ch?.alternatives?.[0]?.words ?? [];
        let text = String(ch?.alternatives?.[0]?.transcript ?? '').trim();
        if (words.length && words.some((w) => w.speaker != null)) {
          const lines: string[] = []; let cur = -1; let buf: string[] = [];
          for (const w of words) {
            if (w.speaker !== cur) { if (buf.length) lines.push(`Speaker ${cur + 1}: ${buf.join(' ')}`); cur = w.speaker; buf = []; }
            buf.push(w.punctuated_word ?? w.word);
          }
          if (buf.length) lines.push(`Speaker ${cur + 1}: ${buf.join(' ')}`);
          text = lines.join('\n');
        }
        return { text, provider: p, model, language: ch?.detected_language ?? (language === 'auto' ? null : language) };
      }
      if (p === 'sarvam') {
        const model = String(cfg.config?.model || 'saarika:v2');
        const fd = new FormData();
        fd.append('file', new Blob([audio], { type: mime || 'audio/wav' }), fileName || 'call.wav');
        fd.append('model', model);
        fd.append('language_code', language && language !== 'auto' ? (language.includes('-') ? language : `${language}-IN`) : 'unknown');
        const r = await this.http('https://api.sarvam.ai/speech-to-text', { method: 'POST', headers: { 'api-subscription-key': key }, body: fd, signal: ctrl.signal });
        if (!r.ok) throw new Error(`Sarvam HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
        const j = await r.json();
        return { text: String(j?.transcript ?? '').trim(), provider: p, model, language: j?.language_code ?? null };
      }
      throw new Error(`Unknown speech-to-text provider "${cfg.provider}"`);
    } finally {
      clearTimeout(timer);
    }
  }
}
