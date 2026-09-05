/**
 * Foreground "Sync now (this device)" — the manual counterpart to the Android app's
 * background WorkManager jobs. On the app it asks the native CallPlugin to collect the
 * phone's recent call-log rows + new recording files, then POSTs them to the same server
 * endpoints the background workers use:
 *   POST /calls/log-sync         (authoritative call-log import)
 *   POST /calls/recording-upload (one call per new recording file)
 * In a plain browser there is no phone to read, so it reports that and does nothing.
 *
 * The native plugin is reached through the Capacitor runtime global (the web bundle has no
 * Capacitor dependency); when absent we are on the desktop CRM.
 */
import { api } from './api';

interface CallLogRow {
  external_log_id?: string; phone: string; direction: string;
  duration_s: number; call_start_at?: string; sim_label?: string; sim_slot?: number;
}
interface RecFile {
  phone?: string; file_name: string; mime: string; file_mtime?: string;
  duration_s?: number; source_hash?: string; content_base64: string;
}

function nativePlugin(): any | null {
  const cap = (window as any).Capacitor;
  if (cap?.isNativePlatform?.() && cap?.Plugins?.CallPlugin) return cap.Plugins.CallPlugin;
  return null;
}

export const isCallNative = () => !!nativePlugin();

/** Collect from the device and push to the server. Returns a short human summary. */
export async function deviceSyncNow(): Promise<{ ok: boolean; message: string }> {
  const plugin = nativePlugin();
  if (!plugin) return { ok: false, message: 'Call sync runs on the mobile app only.' };

  let logResult = { inserted: 0, deduped: 0 };
  let recCount = 0;

  // 1) call log
  const logs: { rows: CallLogRow[] } = await plugin.collectCallLog().catch(() => ({ rows: [] }));
  if (logs?.rows?.length) {
    logResult = await api.post('/calls/log-sync', { rows: logs.rows });
  }

  // 2) recordings (one POST per file, so a large folder streams rather than one giant body)
  const recs: { files: RecFile[] } = await plugin.collectRecordings().catch(() => ({ files: [] }));
  for (const f of recs?.files ?? []) {
    await api.post('/calls/recording-upload', f);
    recCount++;
  }

  return {
    ok: true,
    message: `Synced ${logResult.inserted ?? 0} call(s) and ${recCount} recording(s) from this device.`,
  };
}

/** Windowed on-demand sync: pull call-log rows (or recording files) newer than sinceMs
 *  from the device via the native plugin, then POST to the server. Powers the Call Settings
 *  "Sync today / yesterday / 7 days / 30 days / 6 months / 1 year" buttons. */
export async function deviceSyncWindow(kind: 'log' | 'rec', sinceMs: number): Promise<{ ok: boolean; message: string }> {
  const plugin = nativePlugin();
  if (!plugin) return { ok: false, message: 'Sync runs on the mobile app only.' };
  if (kind === 'log') {
    const logs: { rows: CallLogRow[] } = await plugin.collectCallLog({ sinceMs: String(sinceMs) }).catch(() => ({ rows: [] }));
    const n = logs?.rows?.length || 0;
    if (n) await api.post('/calls/log-sync', { rows: logs.rows });
    return { ok: true, message: `Synced ${n} call(s) from this device.` };
  }
  const recs: { files: RecFile[] } = await plugin.collectRecordings({ sinceMs: String(sinceMs) }).catch(() => ({ files: [] }));
  let n = 0;
  for (const f of recs?.files ?? []) { await api.post('/calls/recording-upload', f); n++; }
  return { ok: true, message: `Synced ${n} recording(s) from this device.` };
}

/** Path the native Android NotificationWorker polls for new-lead / due-follow-up alerts.
 *  Declared here so the route-reachability guard sees /calls/mobile-feed is in use. */
export const MOBILE_FEED_PATH = '/calls/mobile-feed';
