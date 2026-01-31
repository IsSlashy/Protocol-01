// POLYFILLS FIRST - BEFORE ANY OTHER IMPORTS
import { Buffer } from 'buffer';
import process from 'process';

// Set up polyfills
(globalThis as any).Buffer = Buffer;
(window as any).Buffer = Buffer;
(globalThis as any).process = process;
(window as any).process = process;

// Now import everything else
import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { P01PrivyProvider } from '../shared/providers/PrivyProvider';
import './styles/globals.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  console.error('[P01] Root element not found!');
  document.body.innerHTML = '<div style="color: red; padding: 20px;">Error: Root not found</div>';
} else {
  try {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <ErrorBoundary>
          <P01PrivyProvider>
            <HashRouter>
              <App />
            </HashRouter>
          </P01PrivyProvider>
        </ErrorBoundary>
      </React.StrictMode>
    );
  } catch (e) {
    console.error('[P01] Mount error:', e);
  }
}
