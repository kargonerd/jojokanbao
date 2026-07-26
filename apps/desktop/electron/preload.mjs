const { contextBridge, ipcRenderer } = require('electron');

// 暴露给渲染进程的 API
contextBridge.exposeInMainWorld('jojoPress', {
  appName: 'jojo-press',
  
  // 文件选择
  selectPdf: () => ipcRenderer.invoke('selectPdf'),
  
  // 项目管理
  createProject: (name) => ipcRenderer.invoke('createProject', name),
  getProjects: () => ipcRenderer.invoke('getProjects'),
  getProject: (projectId) => ipcRenderer.invoke('getProject', projectId),
  
  // PDF 处理
  savePdf: (projectId, fileName, fileData) => 
    ipcRenderer.invoke('savePdf', projectId, fileName, fileData),
  startRecognition: (projectId, pdfPath) => 
    ipcRenderer.invoke('startRecognition', projectId, pdfPath),
  getRecognitionStatus: (projectId) => 
    ipcRenderer.invoke('getRecognitionStatus', projectId),
  
  // 元数据
  saveMetadata: (projectId, metadata) => 
    ipcRenderer.invoke('saveMetadata', projectId, metadata),
  getMetadata: (projectId) => ipcRenderer.invoke('getMetadata', projectId),
  
  // 文件路径
  getProjectPath: (projectId) => ipcRenderer.invoke('getProjectPath', projectId),
  openPdf: (pdfPath) => ipcRenderer.invoke('openPdf', pdfPath),
  readPdfFile: (pdfPath) => ipcRenderer.invoke('readPdfFile', pdfPath),
  
  // 校对工作区
  getProofreadWorkspace: (projectId) => ipcRenderer.invoke('getProofreadWorkspace', projectId),
});
