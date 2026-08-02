import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './shell/App';
import './press/styles.css';
import './shell/styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
