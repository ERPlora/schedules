// schedules#28 — a business refusal paints as a SENTENCE of the hub's language, never the
// runtime's plumbing.
//
// Before: the handler failed with `Err("overlapping: intervals 09:00–14:00 and 13:00–18:00
// overlap")`, the runtime wrapped it ("error de handler WASM: wasm call to
// `set_business_hours` failed: …") and the form pasted `e.message` — English text with the
// tripas of the transport in the user's face. Now the command rejects with a stable
// `schedules.*` code (hub#139) and the form paints the catalog translation of that code.
import { beforeEach, describe, expect, it } from 'vitest';
import es from '../../../locales/es.json';
import en from '../../../locales/en.json';

let rejectWith: { code?: string; message: string } | null = null;

beforeEach(() => {
  rejectWith = null;
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryAll: async () => [],
    queryPage: async () => ({ rows: [], total: 0 }),
    command: async () => {
      if (rejectWith) {
        // The SDK throws `ErploraError(code, message)` for a 409 `{error:{code,message}}`.
        throw Object.assign(new Error(rejectWith.message), { code: rejectWith.code });
      }
      return {};
    },
    on: () => () => {},
    locale: 'es',
    t: (_catalog: unknown, key: string) => key,
  };
});

type Wc = HTMLElement & {
  shadowRoot: ShadowRoot;
  updateComplete: Promise<unknown>;
  formError: string;
  bhClosed: boolean;
  sdDate: string;
  sdName: string;
  sdClosed: boolean;
  ovStart: string;
  ovEnd: string;
  ovReason: string;
  ovClosed: boolean;
};

async function mount(tab: 'hours' | 'special_days'): Promise<Wc> {
  window.history.replaceState({}, '', `/m/schedules/${tab}`);
  await import('./erp-schedules-hours');
  const el = document.createElement('erp-schedules-hours') as Wc;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

const submit = (el: Wc, slot: string) => {
  el.shadowRoot.querySelector(`form[slot="${slot}"]`)!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  return new Promise((r) => setTimeout(r, 0));
};

const painted = (el: Wc): string =>
  [...el.shadowRoot.querySelectorAll('ok-inline-feedback')].map((n) => n.textContent?.trim() ?? '').join('|');

describe('a rejection arrives as a schedules.* code and leaves as a translated sentence', () => {
  it('overlapping hours on the weekly editor paint the es catalog sentence, not the plumbing', async () => {
    const el = await mount('hours');
    rejectWith = { code: 'schedules.overlapping', message: 'overlapping: intervals 09:00–14:00 and 13:00–18:00 overlap' };
    await submit(el, 'create');
    const text = painted(el);
    expect(text).toBe((es.errors as Record<string, string>)['schedules.overlapping']);
    expect(text, 'no plumbing may reach the user').not.toContain('wasm');
    expect(text, 'no plumbing may reach the user').not.toContain('handler');
    expect(text).not.toContain('overlapping: intervals');
  });

  it('a duplicate special day paints the es sentence of already_exists', async () => {
    const el = await mount('special_days');
    el.sdDate = '2026-08-25';
    el.sdName = 'Fiesta local';
    el.sdClosed = true;
    rejectWith = { code: 'schedules.already_exists', message: 'A special day already exists on 2026-08-25' };
    await submit(el, 'create');
    expect(painted(el)).toBe((es.errors as Record<string, string>)['schedules.already_exists']);
  });

  it('the same is true in English when the hub runs in en', async () => {
    (globalThis as Record<string, unknown>).erplora = {
      ...((globalThis as Record<string, { erplora: object }>).erplora as object),
      locale: 'en',
    };
    const el = await mount('special_days');
    el.ovStart = '2026-09-01';
    el.ovEnd = '2026-08-30';
    el.ovReason = 'Inverted';
    el.ovClosed = true;
    rejectWith = { code: 'schedules.invalid_range', message: 'end_date (2026-08-30) must not be before start_date (2026-09-01)' };
    const overrideForm = [...el.shadowRoot.querySelectorAll('form[slot="create"]')].pop() as HTMLFormElement;
    overrideForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(painted(el)).toBe((en.errors as Record<string, string>)['schedules.invalid_range']);
  });

  it('an unknown error (no code) keeps the generic fallback, still without inventing a translation', async () => {
    const el = await mount('hours');
    rejectWith = { message: 'network is down' };
    await submit(el, 'create');
    expect(painted(el)).toContain('network is down');
  });
});
