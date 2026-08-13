// Client controller for the History page (history.astro).
//
// Reads the locally-stored list of calling-points pages visited in the last two
// weeks and renders it newest-first. Each row is a link back to that service's
// calling points (short press) plus a Delete button that opens a confirmation
// dialog. The header's Clear-history button clears everything, also behind a
// confirmation.
//
// Accessibility (ADR-0002): a real <ol> of rows, every action reachable by
// keyboard and announced to a polite live region, state never conveyed by
// colour alone, and a proper modal dialog (role/aria-modal, focus trap,
// Escape, focus restored to the trigger).

import { clearHistory, loadHistory, saveHistory, withoutEntry, type HistoryEntry } from '../lib/history';
import { esc } from '../lib/html';
import { fmtTime } from '../lib/format';
import { onStationCrsReady, stationLabel } from '../lib/station-codes';

const EMPTY_MSG =
  'No services in your history yet. Open a service from a station board to see its calling points here.';

/** Lucide "trash-2". */
const TRASH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

interface Elements {
  list: HTMLOListElement;
  countEl: HTMLElement;
  announceEl: HTMLElement;
  clearBtn: HTMLButtonElement;
  dialog: HTMLElement;
  dialogTitle: HTMLElement;
  dialogBody: HTMLElement;
  dialogCancel: HTMLButtonElement;
  dialogConfirm: HTMLButtonElement;
}

/** "3 Aug, 14:20" — visitedAt is a real epoch, so local rendering fits. */
function fmtWhen(epochMs: number): string {
  const d = new Date(epochMs);
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "3 Aug" — the service's running date, sliced verbatim from the naive
 *  UK-local ISO (the same no-timezone-shift rule as fmtTime). */
function fmtServiceDate(iso: string): string {
  const m = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${Number(m[3])} ${MONTHS_SHORT[Number(m[2]) - 1]}`;
}

/** "10:00 London King's Cross to Edinburgh, 3 Aug" — the row's identity, used
 *  for the Delete button's accessible name and the confirmation dialog. The
 *  date is included because the same time+route recurs daily — without it the
 *  list could hold indistinguishable entries. Raw names (no CRS codes) keep it
 *  concise for speech. */
function describe(e: HistoryEntry): string {
  const date = fmtServiceDate(e.originTime);
  return `${fmtTime(e.originTime)} ${e.origin} to ${e.destination}${date ? `, ${date}` : ''}`;
}

export function initHistory(root: HTMLElement): void {
  const listEl = root.querySelector<HTMLOListElement>('#history-list');
  const countEl = document.getElementById('history-count');
  const announceEl = document.getElementById('history-announce');
  const clearBtn = document.getElementById('history-clear') as HTMLButtonElement | null;
  const dialog = document.getElementById('history-dialog');
  const dialogTitle = document.getElementById('history-dialog-title');
  const dialogBody = document.getElementById('history-dialog-body');
  const dialogCancel = document.getElementById('history-dialog-cancel') as HTMLButtonElement | null;
  const dialogConfirm = document.getElementById('history-dialog-confirm') as HTMLButtonElement | null;
  if (
    !listEl ||
    !countEl ||
    !announceEl ||
    !clearBtn ||
    !dialog ||
    !dialogTitle ||
    !dialogBody ||
    !dialogCancel ||
    !dialogConfirm
  ) {
    return;
  }
  // Pack into a typed object: closures below keep the non-null field types
  // (TS doesn't carry the guard's narrowing into nested functions).
  const els: Elements = {
    list: listEl,
    countEl,
    announceEl,
    clearBtn,
    dialog,
    dialogTitle,
    dialogBody,
    dialogCancel,
    dialogConfirm,
  };

  let entries: HistoryEntry[] = loadHistory();

  function rowHtml(e: HistoryEntry): string {
    const time = fmtTime(e.originTime);
    const desc = describe(e);
    return `
      <li class="hist-item" data-id="${esc(e.id)}">
        <a class="hist-link" href="${esc(e.url)}">
          <span class="hist-top">
            <span class="hist-time">${esc(time)}<span class="hist-date">${esc(fmtServiceDate(e.originTime))}</span></span>
            <span class="hist-route">${esc(stationLabel(e.origin))} <span class="hist-arrow" aria-hidden="true">&rarr;</span> ${esc(stationLabel(e.destination))}</span>
          </span>
          <span class="hist-meta">${esc(e.operator)} &middot; Last visited ${esc(fmtWhen(e.visitedAt))}</span>
        </a>
        <button type="button" class="hist-delete" data-id="${esc(e.id)}" aria-label="Delete ${esc(desc)} from history">
          ${TRASH_SVG}
        </button>
      </li>`;
  }

  function render(): void {
    els.list.innerHTML =
      entries.length === 0
        ? `<li class="board-msg">${EMPTY_MSG}</li>`
        : entries.map(rowHtml).join('');
    const n = entries.length;
    els.countEl.textContent = n === 0 ? '' : `${n} ${n === 1 ? 'service' : 'services'}`;
    els.clearBtn.disabled = n === 0;
  }

  function announce(msg: string): void {
    els.announceEl.textContent = '';
    if (msg) requestAnimationFrame(() => (els.announceEl.textContent = msg));
  }

  /** Move focus to the row now at `index` (or the previous one), so keyboard
   *  users keep their place after a delete. Falls back to the list. */
  function focusRow(index: number): void {
    const links = els.list.querySelectorAll<HTMLAnchorElement>('.hist-link');
    const target = links[index] ?? links[index - 1];
    if (target) target.focus();
    else els.list.focus();
  }

  function deleteEntry(id: string): void {
    const i = entries.findIndex((e) => e.id === id);
    if (i === -1) return;
    const removed = entries[i]!;
    entries = withoutEntry(entries, id);
    saveHistory(entries);
    render();
    announce(`Removed ${describe(removed)}.`);
    focusRow(i);
  }

  // ---- Confirmation dialog (shared by per-line delete and Clear history) ----

  let dialogTrigger: HTMLElement | null = null;
  let dialogOnConfirm: (() => void) | null = null;
  let dialogFocusables: HTMLButtonElement[] = [];

  function openDialog(opts: {
    title: string;
    body: string;
    confirmLabel: string;
    onConfirm: () => void;
  }): void {
    els.dialogTitle.textContent = opts.title;
    els.dialogBody.textContent = opts.body;
    els.dialogConfirm.textContent = opts.confirmLabel;
    dialogOnConfirm = opts.onConfirm;
    dialogTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    els.dialog.hidden = false;
    document.body.style.overflow = 'hidden';
    dialogFocusables = [els.dialogCancel, els.dialogConfirm];
    document.addEventListener('keydown', onDialogKey);
    els.dialog.addEventListener('click', onBackdropClick);
    els.dialogConfirm.addEventListener('click', onConfirmClick);
    els.dialogCancel.addEventListener('click', onCancelClick);
    // Focus the non-destructive option first (safe default for a confirmation).
    els.dialogCancel.focus();
  }

  function closeDialog(): void {
    els.dialog.hidden = true;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onDialogKey);
    els.dialog.removeEventListener('click', onBackdropClick);
    els.dialogConfirm.removeEventListener('click', onConfirmClick);
    els.dialogCancel.removeEventListener('click', onCancelClick);
    dialogOnConfirm = null;
    dialogFocusables = [];
    const trigger = dialogTrigger;
    dialogTrigger = null;
    trigger?.focus();
  }

  function onConfirmClick(): void {
    const fn = dialogOnConfirm;
    closeDialog();
    fn?.();
  }
  function onCancelClick(): void {
    closeDialog();
  }
  function onBackdropClick(e: MouseEvent): void {
    // Click on the overlay (not the panel) cancels — same as Escape.
    if (e.target === els.dialog) closeDialog();
  }
  function onDialogKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDialog();
      return;
    }
    if (e.key !== 'Tab' || dialogFocusables.length === 0) return;
    const idx = dialogFocusables.indexOf(document.activeElement as HTMLButtonElement);
    if (e.shiftKey) {
      if (idx <= 0) {
        e.preventDefault();
        dialogFocusables[dialogFocusables.length - 1]!.focus();
      }
    } else {
      if (idx === dialogFocusables.length - 1 || idx === -1) {
        e.preventDefault();
        dialogFocusables[0]!.focus();
      }
    }
  }

  function openDeleteDialog(id: string): void {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    openDialog({
      title: 'Delete from history?',
      body: `Remove \u201C${describe(e)}\u201D from your history?`,
      confirmLabel: 'Delete',
      onConfirm: () => deleteEntry(id),
    });
  }

  function openClearDialog(): void {
    const n = entries.length;
    if (n === 0) return;
    openDialog({
      title: 'Clear all history?',
      body: `Remove all ${n} ${n === 1 ? 'entry' : 'entries'} from your history? This can\u2019t be undone.`,
      confirmLabel: 'Clear',
      onConfirm: () => {
        clearHistory();
        entries = [];
        render();
        announce('History cleared.');
        els.list.focus();
      },
    });
  }

  // ---- Row interactions ----

  // Delete buttons (delegated): the single path to the delete dialog, for
  // mouse, keyboard, touch and screen-reader users alike.
  els.list.addEventListener('click', (e) => {
    const btn = (e.target as Element | null)?.closest('.hist-delete') as HTMLButtonElement | null;
    if (!btn) return;
    e.preventDefault();
    openDeleteDialog(btn.dataset.id ?? '');
  });

  els.clearBtn.addEventListener('click', openClearDialog);

  // ---- Boot ----

  render();
  // Station codes (for the "Name (CRS)" labels) arrive async; re-render once
  // they're known, mirroring the service-detail page.
  onStationCrsReady(render);
}
