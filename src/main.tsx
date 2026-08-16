import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { useStudio } from './ui/store';
import './ui/styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

// Dev-only handle so the store can be driven from the console (and from automated
// browser checks). Stripped from production builds by the `import.meta.env.DEV` guard.
if (import.meta.env.DEV) {
  (globalThis as unknown as { __studio: typeof useStudio }).__studio = useStudio;
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
