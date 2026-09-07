// Hamburger menu + theme switcher (disclosure pattern).
//
// The colour theme itself is applied by an INLINE <head> script before first
// paint (see BaseLayout.astro) so there's no flash-of-wrong-theme and so the
// default is dark even with JS disabled. This module just wires up the menu
// toggle and the Light/Dark segmented control to that same data-theme attribute
// + localStorage, and keeps the native <meta name="theme-color"> in step.

type Theme = 'light' | 'dark';

const THEME_COLOR: Record<Theme, string> = {
  dark: '#0f141b',
  light: '#f6f7f9',
};

function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light'
    ? 'light'
    : 'dark';
}

function applyTheme(theme: Theme, buttons: HTMLButtonElement[]): void {
  const el = document.documentElement;
  el.setAttribute('data-theme', theme);
  el.style.colorScheme = theme;
  try {
    localStorage.setItem('theme', theme);
  } catch {
    /* private mode / storage disabled - theme still applies for this session */
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[theme]);
  for (const b of buttons) {
    b.setAttribute('aria-pressed', b.dataset.themeSet === theme ? 'true' : 'false');
  }
}

/** Initialise the menu on a root element (the document body). No-op if absent. */
export function initMenu(root: ParentNode): void {
  const btn = root.querySelector<HTMLButtonElement>('#menu-btn');
  const panel = root.querySelector<HTMLElement>('#menu-panel');
  if (!btn || !panel) return;

  const themeButtons = Array.from(
    panel.querySelectorAll<HTMLButtonElement>('[data-theme-set]'),
  );
  // Mark the menu link for the CURRENT page (aria-current="page") so
  // screen-reader users know where they are — the site-nav equivalent of a
  // bolded tab. Works for "/" (home) and trailing-slash variants alike.
  const here = window.location.pathname.replace(/\/+$/, '') || '/';
  for (const link of Array.from(panel.querySelectorAll<HTMLAnchorElement>('.menu-link'))) {
    let target = '/';
    try {
      target = new URL(link.href).pathname.replace(/\/+$/, '') || '/';
    } catch {
      /* leave "/" — malformed href can't be current */
    }
    if (target === here) link.setAttribute('aria-current', 'page');
  }
  // normalise: sync the control + storage with whatever the head script set
  applyTheme(currentTheme(), themeButtons);

  let open = false;
  const setOpen = (next: boolean, returnFocus: boolean) => {
    open = next;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    panel.hidden = !open;
    if (open) {
      const active =
        themeButtons.find((b) => b.getAttribute('aria-pressed') === 'true') ??
        themeButtons[0];
      document.addEventListener('keydown', onKey);
      // defer so the opening click doesn't count as an "outside" click
      requestAnimationFrame(() => document.addEventListener('click', onDocClick));
      active?.focus();
    } else {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onDocClick);
      if (returnFocus) btn.focus();
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false, true);
    }
  };
  const onDocClick = (e: MouseEvent) => {
    const target = e.target as Node | null;
    if (target && !panel.contains(target) && !btn.contains(target)) {
      setOpen(false, false);
    }
  };

  btn.addEventListener('click', () => setOpen(!open, true));
  for (const b of themeButtons) {
    b.addEventListener('click', () =>
      applyTheme(b.dataset.themeSet === 'light' ? 'light' : 'dark', themeButtons),
    );
  }
}
