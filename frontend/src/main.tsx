import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { initTelegram } from './telegram';
import './styles/tokens.css';
import './styles/app.css';

initTelegram();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
