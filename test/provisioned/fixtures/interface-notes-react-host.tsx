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
