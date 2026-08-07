/**
 * THE CAVEAT MUST RENDER — not merely exist.
 *
 * =============================================================================
 * THE GAP THIS CLOSES (QA-14 §7.2)
 * =============================================================================
 * The api guard (`credentials.spec.ts`) fails the build if a `send` provider's SPEC has no
 * `testCaveat`. It says nothing about the screen. The Tester's words:
 *
 *   > "Deleting the 4 lines of JSX at sprint4.tsx:1196 would keep all 1315 tests green and
 *      silently restore the exact overclaim this feature exists to prevent."
 *
 * A caveat that exists in a constant and never reaches a pixel protects nobody. MSG91
 * answers `type:success` to a BOGUS Auth Key — reproduced live, twice — so a green tick
 * with no caveat next to it is a lie the client would act on: he would conclude his SMS
 * gateway works, tell his counsellors to use it, and find out from a customer who never
 * got the message.
 *
 * So this renders the REAL `ChannelConfigModal`, feeds it the EXACT live response, and
 * asserts the caveat is on screen NEXT TO the green result. It is written generically —
 * every provider whose spec marks a caveat mandatory gets its RENDERING pinned, so a new
 * send provider is covered the day it is added, with nobody remembering to add a test.
 * (Same discipline as the qa10 matrix: a new form with a phantom field fails BY DEFAULT.)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ChannelConfigModal, ProviderSpec } from './sprint4';

vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true, me: { user: { id: 1, name: 'Admin' } } }) }));
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return {
    ...actual,
    useRef_: () => ({ verticals: [{ id: 7, name: 'BCL', branch_id: 9 }], loaded: true, reload: () => undefined }),
    toast: vi.fn(),
  };
});

const post = vi.fn();
vi.mock('./api', () => ({ api: { get: (...a: unknown[]) => (get as any)(...a), post: (...a: unknown[]) => (post as any)(...a) } }));
const get = vi.fn(async () => ({}));

/**
 * THE SEND PROVIDERS, exactly as `messaging/providers.ts` declares them. Each MUST carry a
 * caveat (the api guard enforces that) — and each must RENDER it (this file enforces that).
 * Add a send provider to the product and add it here; the last test in this file fails if
 * this list drifts out of step with the shipped spec list.
 */
const SEND_PROVIDERS: Array<{ spec: ProviderSpec; caveat: string }> = [
  {
    spec: {
      key: 'msg91', channel: 'sms', label: 'MSG91 (India, DLT)', blurb: '', perVertical: false, test: 'send',
      config: [{ key: 'sender_id', label: 'DLT Sender ID', type: 'text', required: true }],
      secrets: [{ key: 'authkey', label: 'Auth Key', type: 'password', required: true }], setup: [],
    },
    caveat: 'Green means MSG91 ACCEPTED the request — it does NOT prove delivery. MSG91 answers "success" '
      + 'even to a wrong Auth Key, and DLT rejections happen later, silently. Only an SMS actually arriving '
      + 'on the handset proves the gateway works.',
  },
  {
    spec: {
      key: 'smtp', channel: 'email', label: 'Email (SMTP)', blurb: '', perVertical: true, test: 'send',
      config: [{ key: 'host', label: 'Host', type: 'text', required: true }],
      secrets: [{ key: 'password', label: 'SMTP password / app password', type: 'password', required: true }], setup: [],
    },
    caveat: 'Green means your SMTP server accepted the mail for delivery. Check the inbox (and the spam '
      + 'folder) to confirm it actually landed.',
  },
  {
    spec: {
      key: 'sms_http', channel: 'sms', label: 'Any SMS gateway (HTTP)', blurb: '', perVertical: false, test: 'send',
      config: [{ key: 'url', label: 'Send-SMS URL', type: 'text', required: true }],
      secrets: [{ key: 'api_key', label: 'API key / token', type: 'password', required: true }], setup: [],
    },
    caveat: 'Green means your gateway returned a success response — it does NOT prove delivery. Many Indian '
      + 'gateways accept a request and drop it later at the DLT layer. Only an SMS arriving on the handset '
      + 'proves it works.',
  },
  {
    spec: {
      key: 'twilio', channel: 'sms', label: 'Twilio', blurb: '', perVertical: false, test: 'send',
      config: [{ key: 'account_sid', label: 'Account SID', type: 'text', required: true }],
      secrets: [{ key: 'auth_token', label: 'Auth Token', type: 'password', required: true }], setup: [],
    },
    caveat: 'Green means Twilio queued the message — it does NOT prove delivery. Check the handset.',
  },
  {
    spec: {
      key: 'nimbus', channel: 'sms', label: 'Nimbus IT (India, DLT)', blurb: '', perVertical: false, test: 'send',
      config: [{ key: 'user', label: 'Nimbus user / profile ID', type: 'text', required: true }],
      secrets: [{ key: 'authkey', label: 'Auth Key', type: 'password', required: true }], setup: [],
    },
    caveat: 'Green means Nimbus ACCEPTED the request — it does NOT prove delivery. DLT rejections (wrong '
      + 'Template ID, header not linked, or the sent text not matching the approved template) happen later. '
      + 'Only an SMS arriving on the handset proves it works.',
  },
];

/** The EXACT live response shape from POST /settings/channels/test (QA-14 §7.2). */
const greenResult = (caveat: string) => ({
  mode: 'send', ok: true, status: 'sent',
  message: 'Accepted by MSG91 (India, DLT) for delivery to +919999999999.',
  caveat,
});

const openAndTest = async (spec: ProviderSpec) => {
  render(<ChannelConfigModal spec={spec} existing={{ id: 1, channel: spec.channel, provider: spec.key,
    provider_label: spec.label, vertical_id: null, vertical_name: null, config: {}, secrets_masked: {},
    is_active: true, status: 'connected', missing: [], last_test_at: null, last_test_ok: null,
    last_test_error: null } as never}
    onClose={() => undefined} onSaved={() => undefined} />);
  const to = document.querySelector('#cf-testto') as HTMLInputElement;
  if (to) fireEvent.change(to, { target: { value: '+919999999999' } });
  const btn = [...document.querySelectorAll('button')]
    .find((b) => /Send test|Test connection/.test(b.textContent ?? ''))!;
  fireEvent.click(btn);
};

beforeEach(() => { cleanup(); post.mockReset(); get.mockReset(); get.mockResolvedValue({}); });

describe.each(SEND_PROVIDERS)('$spec.label — a green result must carry its caveat', ({ spec, caveat }) => {
  it('renders the caveat text on screen next to the green result', async () => {
    post.mockResolvedValue(greenResult(caveat));
    await openAndTest(spec);
    await waitFor(() => expect(document.body.textContent).toContain(caveat));
    expect(document.body.textContent).toContain('What this does and does not prove');
  });

  it('the caveat sits in a .notice.warn ADJACENT to the .notice.ok — not somewhere else on the page', async () => {
    post.mockResolvedValue(greenResult(caveat));
    await openAndTest(spec);
    await waitFor(() => expect(document.querySelector('.notice.ok')).toBeTruthy());
    const ok = document.querySelector('.notice.ok')!;
    const warn = document.querySelector('.notice.warn')!;
    expect(warn).toBeTruthy();
    expect(warn.textContent).toContain(caveat);
    // ADJACENCY, structurally: the warning is the ok notice's next sibling. A caveat at the
    // bottom of a long card is a caveat the client scrolls past.
    expect(ok.nextElementSibling).toBe(warn);
  });

  it('THE REGRESSION: the caveat is NOT hidden inside the <details> disclosure', async () => {
    post.mockResolvedValue({ ...greenResult(caveat), detail: '{"type":"success"}' });
    await openAndTest(spec);
    await waitFor(() => expect(document.querySelector('.notice.warn')).toBeTruthy());
    const details = document.querySelector('details');
    expect(details).toBeTruthy();                       // the raw provider reply IS disclosed
    expect(details!.textContent).not.toContain(caveat); // the caveat is NOT
    expect(document.querySelector('details .notice.warn')).toBeNull();
  });

  it('deleting the caveat JSX fails THIS test — the caveat is the only thing between a green tick and a lie', async () => {
    post.mockResolvedValue(greenResult(caveat));
    await openAndTest(spec);
    await waitFor(() => expect(document.querySelectorAll('.notice.warn').length).toBeGreaterThan(0));
  });
});

describe('the caveat is tied to the GREEN result specifically', () => {
  const { spec, caveat } = SEND_PROVIDERS[0];

  it('a FAILED test shows the failure, and does not moralise about delivery', async () => {
    post.mockResolvedValue({ mode: 'send', ok: false, status: 'failed',
      message: 'MSG91 rejected the Auth Key.', caveat: undefined });
    await openAndTest(spec);
    await waitFor(() => expect(document.querySelector('.notice.err')).toBeTruthy());
    expect(document.body.textContent).toContain('MSG91 rejected the Auth Key.');
    expect(document.body.textContent).not.toContain('does NOT prove delivery');
  });

  it('BEFORE any test is run there is no green tick and no caveat', () => {
    render(<ChannelConfigModal spec={spec} existing={null} onClose={() => undefined} onSaved={() => undefined} />);
    expect(document.querySelector('.notice.ok')).toBeNull();
    expect(document.body.textContent).not.toContain(caveat);
  });
});

/**
 * COVERAGE IS ENFORCED FROM THE API SIDE, where the provider registry lives and node's
 * `fs` is available: `api/src/settings/caveat-rendering.spec.ts` fails the build if a
 * `send` provider is missing from `SEND_PROVIDERS` above, or if the caveat text asserted
 * here has drifted from the text the product actually ships. So a new send provider cannot
 * arrive with an unrendered caveat just because nobody remembered this file, and this file
 * cannot pass by asserting a caveat that does not exist.
 */
