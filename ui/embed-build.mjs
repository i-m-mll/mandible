import fs from 'node:fs/promises';
import path from 'node:path';

const UI_SRC = path.join(import.meta.dirname, 'src');

/**
 * The interface-notes embed and its bridge (docs/specs/interface-annotations-and-attachments.md).
 * The embed is one self-contained module another app's dev page loads from this
 * origin, so it takes no chunks and carries its styles as text for its shadow root.
 * It is built for development because Agentation reads React component names and
 * source files only when `process.env.NODE_ENV` is "development".
 */
const embedStylesPlugin = {
  name: 'mandible-embed-styles',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^mandible-embed-styles$/ }, () => ({ path: 'mandible-embed-styles', namespace: 'mandible-embed-styles' }));
    buildApi.onLoad({ filter: /.*/, namespace: 'mandible-embed-styles' }, async () => {
      const read = (file) => fs.readFile(path.join(UI_SRC, file), 'utf8');
      // Tokens are declared on the document root and on [data-theme='light']; in the embed they belong to its shadow host.
      const tokens = (await read('styles/tokens.css'))
        .replace(/^:root\s*\{/m, ':host {')
        .replace(/^\[data-theme='light'\]\s*\{/m, ":host([data-theme='light']) {");
      const css = [tokens, '.app-anchored-menu { z-index: var(--z-anchored-menu); }', await read('annotation/InterfaceNotesMenu.css')].join('\n');
      return { contents: `export default ${JSON.stringify(css)};`, loader: 'js', watchFiles: ['styles/tokens.css', 'annotation/InterfaceNotesMenu.css'].map((file) => path.join(UI_SRC, file)) };
    });
  },
};

export function embedBuildOptions({ outdir, isWatch = false, alias }) {
  return {
  entryPoints: {
      'interface-notes-embed': path.join(UI_SRC, 'annotation/embed.tsx'),
      'interface-notes-bridge': path.join(UI_SRC, 'annotation/bridge.ts'),
    },
  bundle: true,
  outdir,
  format: 'esm',
  splitting: false,
  sourcemap: isWatch,
  target: 'es2020',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  alias,
  define: { 'process.env.NODE_ENV': '"development"' },
  loader: { '.css': 'empty' },
  minify: !isWatch,
  logLevel: 'info',
  plugins: [embedStylesPlugin],
  };
}

