import './styles.css';
import { loadConfig } from './config';
import { App } from './ui/app';
import { loadIcons } from './ui/icons';
import { pinToVisualViewport } from './ui/viewport';

async function boot(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('no #root');
  pinToVisualViewport();
  // The sprite sheet is two files and both are needed before anything is
  // drawn, so wait for them rather than painting a roster of empty
  // squares that fills in a moment later. The deployment's config comes
  // along for the same round trip; neither is large and both are needed
  // before the connect form can be drawn.
  const [config] = await Promise.all([
    loadConfig(),
    loadIcons().catch((e: Error) => {
      root.textContent = `Could not load the icon sheet (${e.message}). Run "npm run icons".`;
      throw e;
    }),
  ]);
  document.title = config.title;
  new App(root, config).mount();
}

void boot();
