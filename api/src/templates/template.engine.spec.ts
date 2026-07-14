import { SAMPLE_VARS, VARIABLE_CATALOG, lookup, render, renderTemplate, variablesOf } from './template.engine';

/**
 * The template engine is PURE, so it can be pinned exhaustively. The rule that matters
 * most is the one about MISSING variables: a lead with no course must never receive the
 * literal text "{{course}}", and must never crash the send.
 */
describe('template engine — variable resolution', () => {
  const vars = {
    lead: { name: 'Priya Sharma', phone: '+919810000001', email: null as string | null, city: 'Delhi' },
    course: 'IELTS', counsellor: 'Asha Rao', branch: 'Vikaspuri', org: 'Tech Lingua LLP',
  };

  it('resolves a flat variable', () => {
    expect(render('Hello {{course}}', vars).text).toBe('Hello IELTS');
  });

  it('resolves a DOTTED path against the lead', () => {
    expect(render('Hi {{lead.name}} on {{lead.phone}}', vars).text).toBe('Hi Priya Sharma on +919810000001');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(render('Hi {{  lead.name  }}', vars).text).toBe('Hi Priya Sharma');
  });

  it('resolves EVERY variable in the catalogue against the sample lead (the catalogue cannot lie)', () => {
    for (const v of VARIABLE_CATALOG) {
      const r = render(`{{${v.key}}}`, SAMPLE_VARS);
      expect(r.missing).toEqual([]);          // a catalogue entry the resolver cannot answer is a bug
      expect(r.text).not.toBe('');
    }
  });

  it('an UNKNOWN variable renders EMPTY and is reported — never the raw {{token}}', () => {
    const r = render('Fee: {{course_fee}} for {{course}}', vars);
    expect(r.text).toBe('Fee:  for IELTS');
    expect(r.text).not.toContain('{{');
    expect(r.missing).toEqual(['course_fee']);
  });

  it('a NULL/blank value counts as missing, not as the string "null"', () => {
    const r = render('Email: {{lead.email}}', vars);
    expect(r.text).toBe('Email: ');
    expect(r.missing).toEqual(['lead.email']);
  });

  it('a deep path through a missing object does not throw', () => {
    expect(() => render('{{a.b.c.d}}', vars)).not.toThrow();
    expect(render('{{a.b.c.d}}', vars).missing).toEqual(['a.b.c.d']);
  });

  it('lookup() is total — it never throws on a nonsense path', () => {
    expect(lookup(vars, 'lead.name.nope.deeper')).toBeUndefined();
    expect(lookup({}, 'x')).toBeUndefined();
  });

  it('reports every variable used, resolved or not', () => {
    expect(render('{{course}} {{nope}}', vars).used.sort()).toEqual(['course', 'nope']);
  });

  it('a body with no variables is returned verbatim', () => {
    expect(render('Plain text.', vars)).toEqual({ text: 'Plain text.', missing: [], used: [] });
  });

  it('variablesOf() extracts across subject + body + params (the Variables column)', () => {
    expect(variablesOf('Hi {{lead.name}}', 'Your {{course}}', '{{branch}}').sort())
      .toEqual(['branch', 'course', 'lead.name']);
    expect(variablesOf(null, undefined, '')).toEqual([]);
  });
});

describe('renderTemplate — the whole template in one pass', () => {
  it('EMAIL renders subject AND body, and unions their missing variables', () => {
    const r = renderTemplate(
      { channel: 'email', subject: 'Your {{course}} at {{branch}}', body: '<p>Hi {{lead.name}}</p>' },
      { lead: { name: 'Priya' }, course: 'IELTS' },
    );
    expect(r.subject).toBe('Your IELTS at ');
    expect(r.body).toBe('<p>Hi Priya</p>');
    // the subject's missing variable is caught too — the bug you find only after sending
    expect(r.missing).toEqual(['branch']);
  });

  it('a non-email template has NO subject, even if one is stored', () => {
    const r = renderTemplate({ channel: 'sms', subject: 'ignored', body: 'Hi {{lead.name}}' }, { lead: { name: 'P' } });
    expect(r.subject).toBeNull();
    expect(r.body).toBe('Hi P');
  });

  it('WHATSAPP renders the positional params (Meta body {{1}},{{2}}) from expressions', () => {
    const r = renderTemplate(
      {
        channel: 'whatsapp', body: 'preview', wa_template_name: 'lead_welcome', wa_language: 'en',
        wa_params: ['{{lead.name}}', '{{course}}'],
      },
      { lead: { name: 'Priya Sharma' }, course: 'IELTS' },
    );
    expect(r.wa_template_name).toBe('lead_welcome');
    expect(r.wa_params).toEqual(['Priya Sharma', 'IELTS']);
  });

  it('SMS carries the India DLT fields through untouched', () => {
    const r = renderTemplate(
      { channel: 'sms', body: 'Hi {{lead.name}}', sms_sender_id: 'TCHLNG', sms_dlt_template_id: '1207161234567890' },
      { lead: { name: 'P' } },
    );
    expect(r.sms_sender_id).toBe('TCHLNG');
    expect(r.sms_dlt_template_id).toBe('1207161234567890');
  });

  it('a missing WhatsApp param is reported, so a blank never reaches Meta unnoticed', () => {
    const r = renderTemplate(
      { channel: 'whatsapp', body: '', wa_template_name: 't', wa_params: ['{{lead.name}}', '{{course}}'] },
      { lead: { name: 'P' } },
    );
    expect(r.wa_params).toEqual(['P', '']);
    expect(r.missing).toEqual(['course']);
  });
});
