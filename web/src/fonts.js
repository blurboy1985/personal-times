// Self-hosted type (no third-party font requests; CSP stays 'self').
import '@fontsource/unifrakturmaguntia/400.css';
import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/newsreader/opsz-italic.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';

export async function fontsReady() {
  try {
    await Promise.all([
      document.fonts.load('400 32px "UnifrakturMaguntia"'),
      document.fonts.load('700 32px "Newsreader Variable"'),
      document.fonts.load('italic 400 16px "Newsreader Variable"'),
      document.fonts.load('400 14px "IBM Plex Mono"'),
    ]);
    await document.fonts.ready;
  } catch {
    /* fall back to system serifs */
  }
}
