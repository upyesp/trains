import { describe, expect, it, vi } from 'vitest';
import { sendContactEmail } from './resend';
import type { ContactInput } from './router';

const ENV = {
  apiKey: 're_test_key',
  from: 'VIP Trains <contact@viptrains.org>',
  to: 'owner@example.com',
};

const REQUEST: ContactInput = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  message: 'The board at WAT looks stuck.',
};

function stubFetch(status: number): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response('', { status }));
}

describe('sendContactEmail', () => {
  it('POSTs the submission to Resend with auth and a text body', async () => {
    const fetchFn = stubFetch(200);
    const outcome = await sendContactEmail(ENV, REQUEST, fetchFn as typeof fetch);

    expect(outcome).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test_key');
    const body = JSON.parse(init.body as string);
    expect(body.from).toBe(ENV.from);
    expect(body.to).toEqual([ENV.to]);
    expect(body.reply_to).toBe('ada@example.com');
    expect(body.subject).toBe('Contact form: Ada Lovelace');
    expect(body.text).toContain('The board at WAT looks stuck.');
  });

  it('returns ok:false when Resend responds with an error', async () => {
    const fetchFn = stubFetch(401);
    expect(await sendContactEmail(ENV, REQUEST, fetchFn as typeof fetch)).toEqual({ ok: false });
  });

  it('returns ok:false when the network throws', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    });
    expect(await sendContactEmail(ENV, REQUEST, fetchFn as typeof fetch)).toEqual({ ok: false });
  });

  it('returns ok:false when configuration is missing (never sends)', async () => {
    const fetchFn = stubFetch(200);
    expect(await sendContactEmail({ ...ENV, apiKey: '' }, REQUEST, fetchFn as typeof fetch)).toEqual({
      ok: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
