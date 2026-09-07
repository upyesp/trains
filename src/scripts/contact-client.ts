// Client controller for the contact form (contact.astro).
//
// Validates the fields (mirroring the Worker's rules), posts them to the
// Worker as urlencoded form data (a CORS "simple request" — no preflight),
// and announces the outcome in a polite status region. Errors are attached
// to their fields (aria-describedby + aria-invalid) and focus moves to the
// first invalid field so a screen reader reads label, value, and error
// together.

const NAME_MAX = 100;
const EMAIL_MAX = 254;
const MESSAGE_MAX = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FieldName = 'name' | 'email' | 'message';

interface FieldEls {
  input: HTMLInputElement | HTMLTextAreaElement;
  error: HTMLElement;
}

function fieldError(input: HTMLInputElement | HTMLTextAreaElement, name: FieldName): string {
  const value = input.value.trim();
  if (value.length === 0) return `Please enter your ${name}.`;
  if (name === 'name' && value.length > NAME_MAX) return 'Please shorten your name.';
  if (name === 'email') {
    if (value.length > EMAIL_MAX) return 'Please shorten your email address.';
    if (!EMAIL_RE.test(value)) return 'Please enter a valid email address.';
  }
  if (name === 'message' && value.length > MESSAGE_MAX) {
    return `Please shorten your message (max ${MESSAGE_MAX} characters).`;
  }
  return '';
}

export function initContactForm(form: HTMLFormElement): void {
  const fields = new Map<FieldName, FieldEls>();
  for (const name of ['name', 'email', 'message'] as const) {
    const input = form.elements.namedItem(name);
    const error = document.getElementById(`cf-${name}-error`);
    if (
      error &&
      (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)
    ) {
      fields.set(name, { input, error });
    }
  }

  const status = document.getElementById('cf-status');
  const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]');

  function announce(text: string, isError = false): void {
    if (!(status instanceof HTMLElement)) return;
    status.textContent = text;
    status.classList.toggle('error', isError);
  }

  function setError(name: FieldName, text: string): boolean {
    const f = fields.get(name);
    if (!f) return false;
    f.error.textContent = text;
    f.error.hidden = text.length === 0;
    f.input.setAttribute('aria-invalid', text ? 'true' : 'false');
    return text.length > 0;
  }

  /** Validate all fields; return the first invalid one (or null). */
  function validate(): FieldName | null {
    let first: FieldName | null = null;
    for (const name of ['name', 'email', 'message'] as const) {
      const f = fields.get(name);
      if (!f) continue;
      const msg = fieldError(f.input, name);
      if (setError(name, msg) && first === null) first = name;
    }
    return first;
  }

  async function send(): Promise<void> {
    if (submitBtn) submitBtn.disabled = true;
    announce('');
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: (() => {
          const params = new URLSearchParams();
          for (const [key, value] of new FormData(form).entries()) {
            // The form has no file inputs; guard the union for TS.
            params.append(key, typeof value === 'string' ? value : '');
          }
          return params;
        })(),
      });
      if (res.ok) {
        form.reset();
        for (const name of ['name', 'email', 'message'] as const) setError(name, '');
        announce('Message sent — thanks for getting in touch.');
      } else if (res.status === 429) {
        announce('Too many messages — please wait a few minutes and try again.', true);
      } else {
        announce("Couldn't send the message right now — please try again shortly.", true);
      }
    } catch {
      announce("Couldn't reach the message service — please try again shortly.", true);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    announce('');
    const first = validate();
    if (first) {
      fields.get(first)?.input.focus();
      return;
    }
    void send();
  });

  // No-JS fallback lands here with ?sent=1 (the Worker 303-redirects native
  // form posts). Show the same success message; clean the URL so a refresh
  // doesn't re-announce it.
  if (new URLSearchParams(window.location.search).has('sent')) {
    announce('Message sent — thanks for getting in touch.');
    const clean = window.location.pathname + window.location.hash;
    window.history.replaceState(null, '', clean);
  }
}
