/** In-app replacements for the browser's native confirm() / prompt() / alert() boxes.
 *
 *  Client (Oct 2026, design audit): the grey "connect.techlingua.net says" browser boxes looked
 *  foreign next to the app's own modals, and they freeze the page for automated testing. These
 *  render the SAME `.add-modal` look as {@link ConfirmModal} and resolve a Promise, so a call
 *  site only changes `confirm(x)` → `await askConfirm(x)` and `prompt(x)` → `await askText(x)`.
 *
 *  Under the unit-test runner they defer to window.confirm / window.prompt, so the existing
 *  tests that stub those keep working unchanged. */
import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Ic } from './icons';

const IN_TEST = (import.meta as any).env?.MODE === 'test';

function mount<T>(render: (done: (v: T) => void) => ReactNode): Promise<T> {
  return new Promise<T>((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: T) => { root.unmount(); host.remove(); resolve(v); };
    root.render(<>{render(done)}</>);
  });
}

function Box({ title, icon, children, footer, onClose }: {
  title: string; icon: string; children: ReactNode; footer: ReactNode; onClose: () => void;
}) {
  return (
    <div className="add-scrim" style={{ zIndex: 400 }} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="add-modal" style={{ width: 440 }} role="dialog" aria-modal="true">
        <div className="ah">
          <h3><Ic k={icon} />{title}</h3>
          <button className="ax" aria-label="Close" onClick={onClose}><Ic k="x" /></button>
        </div>
        <div className="abody" style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{children}</div>
        <div className="af">{footer}</div>
      </div>
    </div>
  );
}

export interface AskOpts { title?: string; okLabel?: string; danger?: boolean }

/** Yes / No question. Resolves true on OK, false on Cancel / ✕ / Esc. */
export function askConfirm(message: string, opts: AskOpts = {}): Promise<boolean> {
  if (IN_TEST) return Promise.resolve(window.confirm(message));
  const danger = opts.danger ?? /delete|remove|cancel|revoke|disconnect|reject|reverse/i.test(message);
  return mount<boolean>((done) => (
    <Box title={opts.title ?? 'Please confirm'} icon="shield" onClose={() => done(false)}
      footer={<>
        <button className="btn" onClick={() => done(false)}>Cancel</button>
        <button className="btn primary" autoFocus onClick={() => done(true)}
          style={danger ? { background: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}>
          <Ic k="check" />{opts.okLabel ?? 'OK'}
        </button>
      </>}>
      {message}
    </Box>
  ));
}

function TextAsk({ message, initial, opts, done }: { message: string; initial: string; opts: AskOpts; done: (v: string | null) => void }) {
  const [val, setVal] = useState(initial);
  return (
    <Box title={opts.title ?? 'Please enter'} icon="note" onClose={() => done(null)}
      footer={<>
        <button className="btn" onClick={() => done(null)}>Cancel</button>
        <button className="btn primary" onClick={() => done(val)}><Ic k="check" />{opts.okLabel ?? 'OK'}</button>
      </>}>
      <div className="fld">
        <label>{message}</label>
        <input className="ainp" autoFocus value={val} onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') done(val); }} />
      </div>
    </Box>
  );
}

/** One-line text question. Resolves the text on OK (may be ''), null on Cancel / ✕ / Esc. */
export function askText(message: string, initial = '', opts: AskOpts = {}): Promise<string | null> {
  if (IN_TEST) return Promise.resolve(window.prompt(message, initial));
  return mount<string | null>((done) => <TextAsk message={message} initial={initial} opts={opts} done={done} />);
}

/** Information box with a single OK. */
export function askNotice(message: string, opts: AskOpts = {}): Promise<void> {
  if (IN_TEST) { window.alert?.(message); return Promise.resolve(); }
  return mount<void>((done) => (
    <Box title={opts.title ?? 'Notice'} icon="bell" onClose={() => done()}
      footer={<button className="btn primary" autoFocus onClick={() => done()}><Ic k="check" />OK</button>}>
      {message}
    </Box>
  ));
}
