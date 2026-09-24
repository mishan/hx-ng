/** Whether a reader is on screen, and whether being on screen now is
 * worth a fetch.
 *
 * Two things say so and neither knows about the other: the shell, when
 * it swaps a reader into the chat pane's place, and the layout, through
 * mullion's `onShow`. Both say `true` for the same bring-forward, and a
 * reader that fetched on each would fetch twice.
 *
 * And `onShow` says `false` for every pane when the browser tab is put
 * away, and `true` again when it comes back. That is worth knowing — a
 * reader nobody can see has not seen what arrives in it — but coming
 * back to the tab is not the reader brought forward: nothing new was
 * asked for, and fetching again would throw away the page a reader had
 * scrolled or paged to.
 */
export class Sight {
  /** On screen, as last told. */
  on = false;
  /** Put out of sight by the browser tab rather than by the shell or
   *  the layout. */
  private away = false;

  /** Take the news, and say whether it is a bring-forward: `false` for
   *  a repeat, for going, and for a browser tab coming back. */
  set(on: boolean, hidden = document.hidden): boolean {
    if (on === this.on) return false;
    this.on = on;
    if (!on) {
      this.away = hidden;
      return false;
    }
    const back = this.away;
    this.away = false;
    return !back;
  }
}
