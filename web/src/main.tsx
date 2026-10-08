import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { listenForInstallPrompt } from './lib/install-prompt';
import './design-tokens/tokens.css';
import './styles/base.css';

// L'invitation à installer la PWA arrive dès le chargement : elle est gardée pour « Mon compte ».
listenForInstallPrompt();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
