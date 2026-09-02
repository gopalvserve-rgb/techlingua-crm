/**
 * Web-side bridge to the native CallPlugin. On the Android app it drives the native plugin;
 * in a plain browser it degrades gracefully (dial => tel: link, sync => no-op) so the same
 * SPA code runs everywhere. Import this from the CRM's Call Settings + lead Call button.
 */
import { registerPlugin, Capacitor } from '@capacitor/core';

export interface CallPluginNative {
  configure(o: { apiBase: string; token: string }): Promise<void>;
  dial(o: { number: string }): Promise<void>;
  setRecordingFolder(o: { treeUri: string }): Promise<void>;
  startWorkers(o: { logSyncMinutes: number; recSyncMinutes: number }): Promise<void>;
  syncNow(): Promise<void>;
  stopWorkers(): Promise<void>;
}

const Native = registerPlugin<CallPluginNative>('CallPlugin');
const isNative = () => Capacitor.isNativePlatform();

export const CallBridge = {
  isNative,
  /** Push api base + JWT to the native workers (call once after login on the app). */
  async configure(apiBase: string, token: string) {
    if (isNative()) await Native.configure({ apiBase, token });
  },
  /** Tap-to-dial: native dialer on the app, tel: link in the browser. */
  async dial(number: string) {
    if (isNative()) return Native.dial({ number });
    window.location.href = `tel:${number.replace(/[^0-9+]/g, '')}`;
  },
  async setRecordingFolder(treeUri: string) { if (isNative()) await Native.setRecordingFolder({ treeUri }); },
  async startWorkers(logSyncMinutes = 60, recSyncMinutes = 15) {
    if (isNative()) await Native.startWorkers({ logSyncMinutes, recSyncMinutes });
  },
  async syncNow() { if (isNative()) await Native.syncNow(); },
  async stopWorkers() { if (isNative()) await Native.stopWorkers(); },
};
