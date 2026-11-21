import { useSyncExternalStore } from 'react';

/**
 * Recording the screen with the reporter's voice, for feedback (22 Nov 2026).
 *
 * The browser asks which screen, window or tab to share, and for the microphone; nothing is
 * recorded before the person says yes. The screen, the voice and (when shared) the tab's own
 * sound are mixed into one video by the browser's MediaRecorder: WebM in Chrome, Edge and
 * Firefox, MP4 in Safari. Nothing leaves the browser until the note is sent.
 *
 * The state lives HERE, outside React: someone recording a problem clicks through pages to
 * show it, every page change re-renders the widget, and the recording has to survive that.
 */

/** Ten minutes — five cut people off mid-sentence. */
export const MAX_SECONDS = 10 * 60;
/** Screen content is mostly still; this keeps ten minutes near 40 MB. */
const VIDEO_BPS = 500_000;
const AUDIO_BPS = 48_000;
/** The server takes 50 MB for a recording. */
export const MAX_BYTES = 50 * 1024 * 1024;

export type RecorderState =
  | { status: 'idle' }
  | { status: 'asking' }
  | { status: 'recording'; startedAt: number; voice: boolean; startPath: string }
  | { status: 'done'; blob: Blob; url: string; seconds: number; voice: boolean; startPath: string }
  | { status: 'error'; reason: 'unsupported' | 'empty' | 'failed' };

let state: RecorderState = { status: 'idle' };
const listeners = new Set<() => void>();
const set = (next: RecorderState) => { state = next; listeners.forEach((l) => l()); };

/** The note's words, kept beside the recording so changing page loses neither. */
export const draft = { message: '', kind: 'ISSUE' as string };

let recorder: MediaRecorder | null = null;
let streams: MediaStream[] = [];
let audio: AudioContext | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function canRecord(): boolean {
  return typeof window !== 'undefined'
    && !!navigator.mediaDevices?.getDisplayMedia
    && typeof MediaRecorder !== 'undefined';
}

function pickType(): string {
  const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a', 'video/mp4'];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

function release() {
  if (timer) clearTimeout(timer);
  timer = null;
  for (const s of streams) s.getTracks().forEach((t) => t.stop());
  streams = [];
  void audio?.close().catch(() => {});
  audio = null;
  recorder = null;
}

/** Starts, and says how it ended up: 'recording', or 'idle' when they chose not to share. */
export async function startRecording(opts: { voice: boolean; path: string }): Promise<RecorderState['status']> {
  await begin(opts);
  return state.status;
}

async function begin(opts: { voice: boolean; path: string }) {
  if (!canRecord()) { set({ status: 'error', reason: 'unsupported' }); return; }
  if (state.status === 'recording' || state.status === 'asking') return;
  discardRecording();
  set({ status: 'asking' });
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 24 } },
      // the tab's own sound when the browser offers it; the voice comes from the microphone
      audio: true,
      // Chrome: offer THIS tab first, which is what nearly everyone means
      ...({ preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'include' } as object),
    } as DisplayMediaStreamOptions);
    streams.push(display);

    let mic: MediaStream | null = null;
    if (opts.voice) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        streams.push(mic);
      } catch {
        mic = null; // no microphone, or refused: the screen alone is still worth having
      }
    }

    // one sound track: the voice and the tab, mixed
    const sources = [display, mic].filter((s): s is MediaStream => !!s && s.getAudioTracks().length > 0);
    const tracks: MediaStreamTrack[] = [...display.getVideoTracks()];
    if (sources.length) {
      audio = new AudioContext();
      const out = audio.createMediaStreamDestination();
      for (const s of sources) audio.createMediaStreamSource(s).connect(out);
      tracks.push(...out.stream.getAudioTracks());
    }

    const type = pickType();
    const rec = new MediaRecorder(new MediaStream(tracks), {
      ...(type ? { mimeType: type } : {}),
      videoBitsPerSecond: VIDEO_BPS,
      audioBitsPerSecond: AUDIO_BPS,
    });
    const chunks: Blob[] = [];
    const startedAt = Date.now();
    let bytes = 0;
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      chunks.push(e.data);
      bytes += e.data.size;
      // a busy screen can run over the rate: stop before the server's limit
      if (bytes > MAX_BYTES * 0.94 && rec.state === 'recording') stopRecording();
    };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: (rec.mimeType || type || 'video/webm').split(';')[0] });
      const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      release();
      if (!blob.size) { set({ status: 'error', reason: 'empty' }); return; }
      set({ status: 'done', blob, url: URL.createObjectURL(blob), seconds, voice: !!mic, startPath: opts.path });
    };
    // "Stop sharing" in the browser's own bar ends the recording too
    display.getVideoTracks()[0]?.addEventListener('ended', () => stopRecording());
    recorder = rec;
    rec.start(1000);
    timer = setTimeout(() => stopRecording(), MAX_SECONDS * 1000);
    set({ status: 'recording', startedAt, voice: !!mic, startPath: opts.path });
  } catch (e) {
    release();
    const name = (e as DOMException)?.name;
    set(name === 'NotAllowedError' || name === 'AbortError'
      ? { status: 'idle' } // they chose not to share: not an error
      : { status: 'error', reason: 'failed' });
  }
}

export function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

export function discardRecording() {
  if (state.status === 'recording') {
    // stop without keeping it
    if (recorder) { recorder.onstop = null; recorder.stop(); }
    release();
  }
  if (state.status === 'done') URL.revokeObjectURL(state.url);
  set({ status: 'idle' });
}

export function useRecorder(): RecorderState {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => state,
    () => state,
  );
}

export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
