import { contextBridge, ipcRenderer } from 'electron';

// 暴露给渲染进程的 API
contextBridge.exposeInMainWorld('jojoPress', {
  appName: 'jojo-press',
  
  // 文件选择
  selectPdf: () => ipcRenderer.invoke('selectPdf'),
  
  // 项目管理
  createProject: (name: string) => ipcRenderer.invoke('createProject', name),
  getProjects: () => ipcRenderer.invoke('getProjects'),
  getProject: (projectId: string) => ipcRenderer.invoke('getProject', projectId),
  
  // PDF 处理
  savePdf: (projectId: string, fileName: string, fileData: ArrayBuffer) => 
    ipcRenderer.invoke('savePdf', projectId, fileName, fileData),
  startRecognition: (projectId: string, pdfPath: string) => 
    ipcRenderer.invoke('startRecognition', projectId, pdfPath),
  getRecognitionStatus: (projectId: string) => 
    ipcRenderer.invoke('getRecognitionStatus', projectId),
  
  // 元数据
  saveMetadata: (projectId: string, metadata: any) => 
    ipcRenderer.invoke('saveMetadata', projectId, metadata),
  getMetadata: (projectId: string) => ipcRenderer.invoke('getMetadata', projectId),
  
  // 文件路径
  getProjectPath: (projectId: string) => ipcRenderer.invoke('getProjectPath', projectId),
  openPdf: (pdfPath: string) => ipcRenderer.invoke('openPdf', pdfPath),
});

export type JojoPressAPI = typeof window.jojoPress;
