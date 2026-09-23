import { install, watchInstall } from '../install';
import { h } from './dom';

/** An Install button, drawn only while the browser will take the
 *  request. */
export function installButton(): HTMLButtonElement {
  const btn = h(
    'button',
    { class: 'ghost', type: 'button', hidden: true, title: 'Install this client as an app, in a window of its own' },
    'Install',
  );
  watchInstall((available) => (btn.hidden = !available));
  btn.onclick = () => void install();
  return btn;
}
