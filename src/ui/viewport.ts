/**
 * Making the shell fit a phone.
 *
 * `100dvh` is the right height right up until the on-screen keyboard
 * appears. `dvh` accounts for the browser's own retracting chrome and
 * nothing else, so on iOS the layout viewport keeps its full height, the
 * keyboard is drawn over the bottom of it, and the composer — the one
 * element the keyboard exists to serve — ends up underneath it. Safari
 * then scrolls the layout viewport to compensate, which pushes the title
 * bar off the top instead.
 *
 * `visualViewport` is the only thing that reports the box actually
 * visible. Pin the shell to it and both halves go away: the composer
 * stays above the keyboard, and there is nothing to scroll because the
 * document is exactly as tall as what can be seen.
 *
 * Desktop browsers never shrink it, so this is inert there, and a
 * browser without `visualViewport` falls back to the `100dvh` in the
 * stylesheet.
 */
export function pinToVisualViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;

  const apply = (): void => {
    document.documentElement.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
    // Safari scrolls the layout viewport out from under itself when the
    // keyboard opens. With the shell already sized to the visible box
    // there is nothing down there to look at, so put it back.
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  };

  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 200));
  apply();
}
