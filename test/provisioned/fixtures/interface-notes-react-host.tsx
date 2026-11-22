import { createRoot } from 'react-dom/client';

function StudioPanel({ title }: { title: string }) {
  return <section><h2 id="panel-title">{title}</h2></section>;
}

// The page fills the viewport, so the Send menu opens over page content.
createRoot(document.getElementById('root')!).render(
  <main style={{ minHeight: '100vh', display: 'grid', alignContent: 'start' }}>
    <StudioPanel title="Model" />
    <p style={{ minHeight: '90vh' }}>Training curves</p>
  </main>,
);

// Outside React, as on a production build: what the host stamps is all the note can learn of the element's origin.
const stamped = document.createElement('div');
stamped.setAttribute('data-source', 'studio/ErrorBox.tsx:42');
stamped.setAttribute('data-note-ref', 'error-7');
stamped.innerHTML = '<p><span id="error-text">Run failed</span></p>';
document.body.appendChild(stamped);
