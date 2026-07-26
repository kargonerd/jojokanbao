import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rendererUrl = process.env.JOJO_PRESS_RENDERER_URL;

// MinerU API 配置
const MINERU_API_BASE = 'https://mineru.net/api/v4';
const MINERU_TOKEN = process.env.MINERU_API_TOKEN || '';

// 简单的内存存储
const tasks = new Map<string, any>();
const projects = new Map<string, any>();

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    titleBarStyle: 'hiddenInset', // macOS 风格标题栏
    webPreferences: {
      preload: path.join(currentDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  // 设置应用菜单
  setupApplicationMenu(window);

  if (rendererUrl) {
    void window.loadURL(rendererUrl);
    // DevTools 可以通过菜单 "视图" -> "开发者工具" 手动打开
    // window.webContents.openDevTools({ mode: 'bottom' });
    return;
  }

  void window.loadFile(path.join(currentDir, '../index.html'));
};

// 设置应用菜单
function setupApplicationMenu(mainWindow: BrowserWindow) {
  const { Menu } = require('electron');
  
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开 PDF',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            mainWindow.webContents.send('menu-open-pdf');
          }
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => {
            app.quit();
          }
        }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: 'jojo-press',
              detail: 'PDF 书籍制作工具'
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template as any);
  Menu.setApplicationMenu(menu);
}

// 注册 IPC 处理程序
function registerIpcHandlers() {
  // 选择 PDF 文件
  ipcMain.handle('selectPdf', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'PDF 文件', extensions: ['pdf'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    
    return result.filePaths[0];
  });

  // 创建项目
  ipcMain.handle('createProject', async (_, name: string) => {
    const projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const projectPath = path.join(app.getPath('userData'), 'projects', projectId);
    
    // 创建项目目录结构
    fs.mkdirSync(path.join(projectPath, 'input'), { recursive: true });
    fs.mkdirSync(path.join(projectPath, 'output'), { recursive: true });
    fs.mkdirSync(path.join(projectPath, 'state'), { recursive: true });
    
    const project = {
      id: projectId,
      name,
      title: name,
      createdAt: new Date().toISOString(),
      currentStage: 'recognition',
      path: projectPath,
    };
    
    projects.set(projectId, project);
    
    // 保存项目信息到文件
    fs.writeFileSync(
      path.join(projectPath, 'project.json'),
      JSON.stringify(project, null, 2)
    );
    
    return project;
  });

  // 获取项目列表
  ipcMain.handle('getProjects', async () => {
    // 从文件系统加载项目
    const projectsDir = path.join(app.getPath('userData'), 'projects');
    if (!fs.existsSync(projectsDir)) {
      return [];
    }
    
    const projectList: any[] = [];
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const projectFile = path.join(projectsDir, entry.name, 'project.json');
        if (fs.existsSync(projectFile)) {
          try {
            const project = JSON.parse(fs.readFileSync(projectFile, 'utf-8'));
            projectList.push(project);
          } catch (e) {
            console.error('Failed to load project:', entry.name);
          }
        }
      }
    }
    
    return projectList.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  });

  // 获取单个项目
  ipcMain.handle('getProject', async (_, projectId: string) => {
    // 先查内存
    if (projects.has(projectId)) {
      return projects.get(projectId);
    }
    
    // 从文件加载
    const projectFile = path.join(
      app.getPath('userData'), 
      'projects', 
      projectId, 
      'project.json'
    );
    
    if (fs.existsSync(projectFile)) {
      const project = JSON.parse(fs.readFileSync(projectFile, 'utf-8'));
      projects.set(projectId, project);
      return project;
    }
    
    return null;
  });

  // 保存 PDF 文件
  ipcMain.handle('savePdf', async (_, projectId: string, fileName: string, fileData: ArrayBuffer) => {
    const inputDir = path.join(app.getPath('userData'), 'projects', projectId, 'input');
    fs.mkdirSync(inputDir, { recursive: true });
    
    const pdfPath = path.join(inputDir, fileName);
    fs.writeFileSync(pdfPath, Buffer.from(fileData));
    
    return { pdfPath };
  });

  // 启动 MinerU 识别
  ipcMain.handle('startRecognition', async (_, projectId: string, pdfPath: string) => {
    if (!MINERU_TOKEN) {
      throw new Error('MinerU API Token 未配置');
    }
    
    try {
      // 1. 获取上传 URL
      const batchResponse = await fetch(`${MINERU_API_BASE}/file-urls/batch`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${MINERU_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          files: [{
            name: path.basename(pdfPath),
            data_id: projectId,
          }],
        }),
      });

      if (!batchResponse.ok) {
        throw new Error(`创建批次失败: ${batchResponse.status}`);
      }

      const batchData = await batchResponse.json();
      const uploadUrl = batchData.data?.file_urls?.[0];
      const batchId = batchData.data?.batch_id;

      if (!uploadUrl || !batchId) {
        throw new Error('无效的批次响应');
      }

      // 2. 上传文件
      const fileBuffer = fs.readFileSync(pdfPath);
      const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        body: fileBuffer,
      });

      if (!uploadResponse.ok) {
        throw new Error(`上传文件失败: ${uploadResponse.status}`);
      }

      // 3. 创建任务记录
      const task = {
        projectId,
        status: 'queued',
        pdfPath,
        batchId,
        createdAt: new Date().toISOString(),
      };
      tasks.set(projectId, task);

      // 4. 启动轮询（异步，不阻塞）
      pollMineruResult(projectId, batchId);

      return { status: 'queued', batchId };
    } catch (error) {
      console.error('启动识别失败:', error);
      throw error;
    }
  });

  // 获取识别状态
  ipcMain.handle('getRecognitionStatus', async (_, projectId: string) => {
    return tasks.get(projectId) || null;
  });

  // 保存元数据
  ipcMain.handle('saveMetadata', async (_, projectId: string, metadata: any) => {
    const project = projects.get(projectId);
    if (project) {
      project.metadata = metadata;
      project.currentStage = 'proofreading';
      projects.set(projectId, project);
      
      // 保存到文件
      const projectFile = path.join(
        app.getPath('userData'), 
        'projects', 
        projectId, 
        'project.json'
      );
      fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));
    }
    return project;
  });

  // 获取元数据
  ipcMain.handle('getMetadata', async (_, projectId: string) => {
    const project = projects.get(projectId);
    return project?.metadata || null;
  });

  // 获取项目路径
  ipcMain.handle('getProjectPath', async (_, projectId: string) => {
    return path.join(app.getPath('userData'), 'projects', projectId);
  });

  // 打开 PDF
  ipcMain.handle('openPdf', async (_, pdfPath: string) => {
    await shell.openPath(pdfPath);
  });
}

// 轮询 MinerU 结果
async function pollMineruResult(projectId: string, batchId: string) {
  const maxAttempts = 360;
  const task = tasks.get(projectId);
  if (!task) return;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${MINERU_API_BASE}/extract-results/batch/${batchId}`, {
        headers: {
          'Authorization': `Bearer ${MINERU_TOKEN}`,
        },
      });

      if (!response.ok) {
        console.error('轮询错误:', response.status);
        continue;
      }

      const data = await response.json();
      const extractResult = data.data?.extract_result?.[0];
      
      if (extractResult) {
        const state = extractResult.state?.toLowerCase();
        
        if (state === 'success' || state === 'completed') {
          task.status = 'completed';
          task.resultUrl = extractResult.full_zip_url;
          task.completedAt = new Date().toISOString();
          tasks.set(projectId, task);
          
          // 下载结果
          await downloadResult(projectId, extractResult.full_zip_url);
          return;
        } else if (state === 'failed' || state === 'error') {
          task.status = 'failed';
          task.error = extractResult.error || '识别失败';
          tasks.set(projectId, task);
          return;
        }
      }

      task.status = 'processing';
      tasks.set(projectId, task);
    } catch (error) {
      console.error('轮询错误:', error);
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // 超时
  task.status = 'failed';
  task.error = '识别超时';
  tasks.set(projectId, task);
}

// 下载识别结果
async function downloadResult(projectId: string, url: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('下载结果失败');
    
    const buffer = await response.arrayBuffer();
    const resultPath = path.join(
      app.getPath('userData'), 
      'projects', 
      projectId, 
      'output',
      'mineru-result.zip'
    );
    
    fs.writeFileSync(resultPath, Buffer.from(buffer));
    console.log('结果已下载:', resultPath);
  } catch (error) {
    console.error('下载结果失败:', error);
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
