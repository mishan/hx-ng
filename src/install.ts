/**
 * Installing this client as an app, where the browser lets a page ask.
 *
 * Chromium decides when a page is installable and says so with
 * `beforeinstallprompt`. The event carries the one call that shows its
 * install dialog, and it usually fires at load, well before the connect
 * form is drawn, so it is caught as early as `main.ts` runs and kept
 * until somebody clicks. Cancelling it keeps Android's own install bar
 * off the connect form; the button this feeds says the same thing in
 * the client's own voice.
 *
 * Nothing here for iOS or Firefox: neither has the event, and the
 * browser's own menu is the only way in. An installed window never gets
 * the event either, so the button is simply never offered there.
 *
 * No DOM: the target is passed in, so a test can be the browser.
 */

/** Chromium's, and in no TypeScript library yet. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let pending: BeforeInstallPromptEvent | null = null;
const watchers = new Set<(available: boolean) => void>();

function tell(): void {
  for (const w of watchers) w(pending !== null);
}

/** Start listening. Called once, before anything asynchronous, so an
 *  event fired while the config and icons load is not missed. */
export function listenForInstall(target: EventTarget = window): void {
  target.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    pending = e as BeforeInstallPromptEvent;
    tell();
  });
  target.addEventListener('appinstalled', () => {
    pending = null;
    tell();
  });
}

/** Can the browser be asked to install this client right now? */
export function canInstall(): boolean {
  return pending !== null;
}

/** Call `fn` now and whenever that changes; returns the unsubscribe. */
export function watchInstall(fn: (available: boolean) => void): () => void {
  watchers.add(fn);
  fn(pending !== null);
  return () => watchers.delete(fn);
}

/**
 * Show the browser's install dialog. An event's `prompt()` works once,
 * so it is spent here whatever the answer; Chromium fires a fresh one
 * later if the page is still installable after a dismissal. True if the
 * user said yes.
 */
export async function install(): Promise<boolean> {
  const e = pending;
  if (!e) return false;
  pending = null;
  tell();
  await e.prompt();
  return (await e.userChoice).outcome === 'accepted';
}
