// Resend email adapter — the thin platform seam for contact-form delivery
// (the Worker has no outbound email API, so we forward submissions to
// Resend's REST API; ADR-0003 keeps platform code out of the core). Fetch is
// injected so tests can stub it; the API key lives as a Worker secret
// (RESEND_API_KEY), never in the client or repo.

import type { ContactInput } from './router';

export interface ResendEnv {
  apiKey: string;
  /** Verified sender, e.g. "VIP Trains <contact@viptrains.org>". */
  from: string;
  /** Destination inbox for form submissions. */
  to: string;
}

export type SendEmailOutcome = { ok: true } | { ok: false };

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * Send a contact submission as a plain-text email via Resend.
 *
 * The form data is delivered as text/plain (never HTML) so there is no
 * markup-injection surface. The submitter's address becomes the reply-to, so
 * the site owner can answer directly. Returns ok:false on any failure —
 * including missing configuration — and never throws.
 */
export async function sendContactEmail(
  env: ResendEnv,
  request: ContactInput,
  fetchFn: typeof fetch = fetch,
): Promise<SendEmailOutcome> {
  if (!env.apiKey || !env.from || !env.to) return { ok: false };
  try {
    const res = await fetchFn(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.from,
        to: [env.to],
        reply_to: request.email,
        subject: `Contact form: ${request.name}`,
        text: `Name: ${request.name}\nEmail: ${request.email}\n\n${request.message}`,
      }),
    });
    return res.ok ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}
