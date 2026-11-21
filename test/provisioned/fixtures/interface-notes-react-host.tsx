import { createRoot } from 'react-dom/client';

function StudioPanel({ title }: { title: string }) {
  return <section><h2 id="panel-title">{title}</h2></section>;
}

createRoot(document.getElementById('root')!).render(<main><StudioPanel title="Model" /></main>);
