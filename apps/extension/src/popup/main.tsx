// POLYFILLS FIRST - BEFORE ANY OTHER IMPORTS
import { Buffer } from 'buffer';
import process from 'process';

// Set up polyfills
(globalThis as any).Buffer = Buffer;
(window as any).Buffer = Buffer;
(globalThis as any).process = process;
(window as any).process = process;

console.log('[P01] Polyfills loaded');

// Now import everything else
import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/globals.css';

console.log('[P01] Mounting React...');
const rootElement = document.getElementById('root');

if (!rootElement) {
  console.error('[P01] Root element not found!');
  document.body.innerHTML = '<div style="color: red; padding: 20px;">Error: Root not found</div>';
} else {
  try {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <ErrorBoundary>
          <HashRouter>
            <App />
          </HashRouter>
        </ErrorBoundary>
      </React.StrictMode>
    );
    console.log('[P01] React mounted');
  } catch (e) {
    console.error('[P01] Mount error:', e);
  }
}
