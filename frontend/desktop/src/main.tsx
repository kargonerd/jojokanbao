import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './shell/App';
import '@jojo/web/desktop.css';
import './shell/styles.css';

document.documentElement.dataset.desktopPlatform = window.jojoDesktop?.platform ?? 'web';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
