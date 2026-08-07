import { readFileSync } from 'fs';
import { join } from 'path';
import { MSG_PROVIDERS } from '../messaging/providers';

/**
 * THE CAVEAT'S *RENDERING* IS PINNED — enforced from the side that owns the registry.
 *
 * =============================================================================
 * THE GAP (QA-14 §7.2)
 * =============================================================================
 * `credentials.spec.ts` already fails the build if a `send` provider has no `testCaveat`.
 * That only ever proved the caveat exists in a CONSTANT. The Tester's finding:
 *
 *   > "Deleting the 4 lines of JSX at sprint4.tsx:1196 would keep all 1315 tests green and
 *      silently restore the exact overclaim this feature exists to prevent."
 *
 * `web/src/caveat.test.tsx` now renders the real modal and proves the caveat reaches the
 * screen next to the green result (verified: deleting that JSX fails 16 of its tests).
 * But a rendering test only protects the providers it happens to list — so THIS guard
 * makes the coverage itself mandatory:
 *
 *   1. every `send` provider must appear in the web suite's SEND_PROVIDERS list;
 *   2. the caveat text asserted there must be the text this registry actually ships.
 *
 * (1) without (2) would let the web suite pass by rendering a caveat the product does not
 * have. (2) without (1) would let a new provider ship unrendered. Both, or neither works.
 *
 * The rule, generalised: **any provider whose spec marks a caveat mandatory has that
 * caveat's RENDERING pinned — not just its existence in code.**
 */

const WEB_SPEC = join(__dirname, '..', '..', '..', 'web', 'src', 'caveat.test.tsx');
const web = readFileSync(WEB_SPEC, 'utf8');
/**
 * TypeScript concatenates `'a' + 'b'` literals; flatten so we can search for the finished
 * sentence. `\s` spans newlines, so this handles the `+` sitting at the end of a line OR at
 * the start of the next — the api and web files happen to use opposite styles.
 */
const flatten = (s: string) => s.replace(/'\s*\+\s*'/g, '');

const SEND_PROVIDERS = Object.values(MSG_PROVIDERS).filter((p) => p.test === 'send');

describe('every provider with a MANDATORY caveat has its RENDERING pinned', () => {
  it('there is at least one send provider — otherwise this guard is vacuous', () => {
    expect(SEND_PROVIDERS.length).toBeGreaterThan(0);
    expect(SEND_PROVIDERS.map((p) => p.key).sort()).toEqual(['msg91', 'nimbus', 'sms_http', 'smtp', 'twilio']);
  });

  it('the web caveat-rendering suite exists at all', () => {
    expect(web).toMatch(/ChannelConfigModal/);
    expect(web).toMatch(/notice\.warn/);
  });

  it.each(SEND_PROVIDERS.map((p) => [p.key, p] as const))(
    '%s — is covered by the web rendering suite', (key, spec) => {
      // If this fails: `${key}` shows a green "Send test" result with a caveat that NO test
      // proves is on screen. Add it to SEND_PROVIDERS in web/src/caveat.test.tsx.
      expect(web).toMatch(new RegExp(`key:\\s*'${key}'`));
      expect(spec.testCaveat).toBeTruthy();
    },
  );

  it.each(SEND_PROVIDERS.map((p) => [p.key, p] as const))(
    '%s — the web suite asserts the caveat text THIS registry ships, not a paraphrase',
    (_key, spec) => {
      const shipped = flatten(spec.testCaveat ?? '');
      // A rendering test that renders a caveat the product does not ship proves nothing.
      expect(flatten(web)).toContain(shipped);
    },
  );
});

describe('the caveats still say the thing that matters', () => {
  it('every send caveat says plainly that green is NOT proof of delivery', () => {
    for (const p of SEND_PROVIDERS) {
      expect(p.testCaveat).toMatch(/does NOT prove delivery|does not prove|Check the inbox|Check the handset/i);
    }
  });

  it('MSG91 names the bogus-key behaviour the Tester reproduced live, twice', () => {
    const c = flatten(MSG_PROVIDERS.msg91.testCaveat ?? '');
    expect(c).toMatch(/does NOT prove delivery/);
    expect(c).toMatch(/wrong Auth Key/);
    expect(c).toMatch(/handset/);
  });
});
