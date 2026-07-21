const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jojoPress', {
  appName: 'jojo-press',
  apiBaseUrl: process.env.JOJO_PRESS_API_BASE_URL,
  selectPdf: () => ipcRenderer.invoke('jojo-press:select-pdf')
});
