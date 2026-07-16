import { QuotationService, QUOTE_TRANSITIONS } from './quotation.service';

const svc = () => new QuotationService({} as never, { buildScopeWhere: () => '1=1' } as never, {} as never);

describe('normalising what the UI sends', () => {
  const s = svc();

  it('turns rupees into exact paise and computes the line', () => {
    const [l] = s.normaliseItems([{ description: 'IELTS', qty: 1, unit_price: '45,000.50', discount_type: 'percent', discount_value: '10', tax_pct: '18' }]);
    expect(l.unit_price_minor).toBe(4_500_050);
    expect(l.computed.discount_minor).toBe(450_005);
    expect(l.computed.total_minor).toBe(4_050_045 + 729_008);
  });

  it("'amount' discounts arrive in RUPEES and are stored in PAISE; 'percent' is a percent either way", () => {
    const [a] = s.normaliseItems([{ description: 'x', unit_price: '1000', discount_type: 'amount', discount_value: '100' }]);
    expect(a.discount_value).toBe(10_000);          // ₹100 -> 10000 paise
    expect(a.computed.discount_minor).toBe(10_000);
    const [p] = s.normaliseItems([{ description: 'x', unit_price: '1000', discount_type: 'percent', discount_value: '10' }]);
    expect(p.discount_value).toBe(10);              // 10 means 10%, not ₹10
    expect(p.computed.discount_minor).toBe(10_000);
  });

  it('REFUSES a quotation with no lines', () => {
    expect(() => s.normaliseItems([])).toThrow(/at least one line item/);
    expect(() => s.normaliseItems(undefined)).toThrow(/at least one line item/);
  });

  it('refuses a line with no description — a PDF row that says nothing is not an offer', () => {
    expect(() => s.normaliseItems([{ unit_price: '100' }])).toThrow(/Line 1: a description is required/);
  });

  it('names the LINE that is wrong, not just "invalid input"', () => {
    expect(() => s.normaliseItems([
      { description: 'ok', unit_price: '100' },
      { description: 'bad', unit_price: 'abc' },
    ])).toThrow(/Line 2/);
  });

  it('refuses junk money rather than quoting ₹0', () => {
    expect(() => s.normaliseItems([{ description: 'x', unit_price: 'free!' }])).toThrow(/not an amount/);
  });

  it('refuses a percentage discount over 100% and a negative one', () => {
    expect(() => s.normaliseItems([{ description: 'x', unit_price: '100', discount_type: 'percent', discount_value: '120' }])).toThrow(/cannot exceed 100/);
    expect(() => s.normaliseItems([{ description: 'x', unit_price: '100', discount_type: 'percent', discount_value: '-5' }])).toThrow(/cannot be negative/);
  });

  it('refuses tax outside 0–100 and a non-positive quantity', () => {
    expect(() => s.normaliseItems([{ description: 'x', unit_price: '100', tax_pct: '150' }])).toThrow(/between 0 and 100/);
    expect(() => s.normaliseItems([{ description: 'x', unit_price: '100', qty: 0 }])).toThrow(/whole number of 1 or more/);
    expect(() => s.normaliseItems([{ description: 'x', unit_price: '100', qty: 1.5 }])).toThrow(/whole number of 1 or more/);
  });

  it('caps the line count — a 5,000-line quotation is a mistake, not a proposal', () => {
    const many = Array.from({ length: 51 }, () => ({ description: 'x', unit_price: '1' }));
    expect(() => s.normaliseItems(many)).toThrow(/50 line items/);
  });

  it('numbers the lines in order and clips an over-long description', () => {
    const items = s.normaliseItems([
      { description: 'a'.repeat(400), unit_price: '1' },
      { description: 'b', unit_price: '2' },
    ]);
    expect(items[0].description).toHaveLength(240);
    expect(items.map((i) => i.description[0])).toEqual(['a', 'b']);
  });
});

describe('the status machine — a quotation is a document, not a free-for-all', () => {
  it('only a draft can be sent; only a sent quote can be decided', () => {
    expect(QUOTE_TRANSITIONS.draft).toEqual(['sent']);
    expect(QUOTE_TRANSITIONS.sent.sort()).toEqual(['accepted', 'expired', 'rejected']);
  });

  it('accepted / rejected / expired are TERMINAL — the way back is a revision', () => {
    expect(QUOTE_TRANSITIONS.accepted).toEqual([]);
    expect(QUOTE_TRANSITIONS.rejected).toEqual([]);
    expect(QUOTE_TRANSITIONS.expired).toEqual([]);
  });

  it('refuses an illegal transition and says what IS legal', async () => {
    const s = svc();
    (s as any).get = async () => ({ id: 1, quote_no: 'QT-1', status: 'draft', lead_id: 5 });
    await expect(s.decide(1, 'accepted', {}, { id: 3 }, {} as never))
      .rejects.toThrow(/A draft quotation cannot be marked accepted.*can only become: sent/s);
  });

  it('refuses to re-decide a decided quote and points at revision', async () => {
    const s = svc();
    (s as any).get = async () => ({ id: 1, quote_no: 'QT-1', status: 'accepted', lead_id: 5 });
    await expect(s.decide(1, 'rejected', {}, { id: 3 }, {} as never))
      .rejects.toThrow(/already decided — create a revision/);
  });
});

describe('a SENT quotation is evidence', () => {
  it('cannot be edited in place — it must be revised', async () => {
    const s = svc();
    (s as any).get = async () => ({ id: 1, quote_no: 'QT-2026/0001', status: 'sent', items: [] });
    await expect(s.update(1, { items: [{ description: 'x', unit_price: '1' }] }, { id: 3 }, {} as never))
      .rejects.toThrow(/record of what the customer was offered — create a revision/);
  });

  it('an ACCEPTED quotation is not re-sent', async () => {
    const s = svc();
    (s as any).get = async () => ({ id: 1, quote_no: 'QT-1', status: 'accepted' });
    await expect(s.send(1, { channel: 'email' }, { id: 3 }, {} as never)).rejects.toThrow(/already been accepted/);
  });

  it('a DRAFT can still be edited', async () => {
    const s = svc();
    (s as any).get = async () => ({ id: 1, quote_no: 'QT-1', status: 'draft', items: [], notes: null, terms: null, valid_until: null });
    (s as any).db = { tx: async (fn: any) => fn({ query: async () => ({ rows: [] }) }) };
    await expect(s.update(1, { items: [{ description: 'x', unit_price: '1' }] }, { id: 3 }, {} as never))
      .resolves.toEqual({ id: 1, ok: true });
  });
});

describe('SEND degrades cleanly when the channel is not configured', () => {
  const quote = {
    id: 1, quote_no: 'QT-2026/0001', status: 'draft', lead_id: 31,
    valid_until: null, vertical_name: 'BCL',
  };

  it('an unconfigured channel does NOT mark the quotation sent, and returns the provider\'s own words', async () => {
    const s = svc();
    (s as any).get = async () => quote;
    (s as any).templates = { build: async () => ({ channel: 'email', to: 'a@b.com', body: 'x' }) };
    (s as any).messaging = {
      sendNow: async () => ({ id: 7, status: 'failed', reason: 'Email is not configured for this vertical — add SMTP in Settings › Channels.' }),
    };
    const tx = jest.fn();
    (s as any).db = { tx };

    const r = await s.send(1, { channel: 'email' }, { id: 3 }, {} as never);
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/not configured/);
    // THE POINT: the client is never told "sent" when nothing was sent, and the
    // quotation stays a draft so he can send it again once SMTP exists.
    expect(tx).not.toHaveBeenCalled();
  });

  it('a real send DOES mark it sent', async () => {
    const s = svc();
    (s as any).get = async () => quote;
    (s as any).templates = { build: async () => ({ channel: 'email', to: 'a@b.com', body: 'x' }) };
    (s as any).messaging = { sendNow: async () => ({ id: 7, status: 'sent' }) };
    (s as any).db = { tx: async (fn: any) => fn({ query: async () => ({ rows: [] }) }) };

    const r = await s.send(1, { channel: 'email' }, { id: 3 }, {} as never);
    expect(r.sent).toBe(true);
  });

  it('refuses a channel that is not a sending channel', async () => {
    const s = svc();
    (s as any).get = async () => quote;
    (s as any).templates = {}; (s as any).messaging = {};
    await expect(s.send(1, { channel: 'pigeon' }, { id: 3 }, {} as never)).rejects.toThrow(/email, WhatsApp or SMS/);
  });
});

describe('CONVERT — the Phase-3 seam, honestly labelled', () => {
  const s = svc();
  const accepted = {
    id: 1, quote_no: 'QT-2026/0001', status: 'accepted', lead_id: 31, lead_name: 'Priya',
    branch_id: 9, vertical_id: 1, owner_id: 3,
    subtotal_minor: 4_500_000, discount_minor: 450_000, tax_minor: 729_000, total_minor: 4_779_000,
    items: [{ course_id: 21, course_name: 'IELTS' }],
  };

  it('only an ACCEPTED quotation converts', async () => {
    (s as any).get = async () => ({ ...accepted, status: 'sent' });
    await expect(s.convertPreview(1, {} as never)).rejects.toThrow(/Only an accepted quotation converts/);
  });

  it('produces an ENROLMENT prefill — and says plainly that the GST invoice is Phase 3', async () => {
    (s as any).get = async () => accepted;
    const p = await s.convertPreview(1, {} as never);
    expect(p.invoice.available).toBe(false);
    expect(p.invoice.phase).toBe(3);
    expect(p.invoice.note).toMatch(/GST tax invoice/);
    expect(p.course_id).toBe(21);
  });

  it('carries fee and discount but NOT tax — an enrolment that guessed its GST would be a lie', async () => {
    (s as any).get = async () => accepted;
    const p = await s.convertPreview(1, {} as never);
    expect(p.fee_minor).toBe(4_500_000);           // the GROSS, not the tax-inclusive total
    expect(p.discount_minor).toBe(450_000);
    expect(p.net_fee_minor).toBe(4_050_000);
    expect(JSON.stringify(p)).not.toContain('729000');
  });
});
