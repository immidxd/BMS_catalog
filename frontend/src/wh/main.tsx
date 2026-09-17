import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { initTelegram } from '../telegram';
import '../styles/tokens.css';
import './wh.css';

initTelegram();

// Оболонка застосунку — з Service Worker: відкривається й без мережі (де вебвʼю
// це дозволяє). Дані складу SW не кешує — їх без мережі дає offline.ts.
if ('serviceWorker' in navigator && location.pathname.startsWith('/wh') && location.hostname !== 'localhost') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/wh-sw.js', { scope: '/wh' }).catch(() => { /* не критично */ });
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
