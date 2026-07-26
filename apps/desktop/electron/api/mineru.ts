import { ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const MINERU_API_BASE = 'https://mineru.net/api/v4';
const MINERU_TOKEN = process.env.MINERU_API_TOKEN || '';

interface MineruTask {
  projectId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  pdfPath: string;
  resultUrl?: string;
}

// 简单的内存存储（生产环境应该用 SQLite）
const tasks = new Map<string, MineruTask>();
const projects = new Map<string, any>();

export function registerMineruHandlers() {
  // 创建项目
  ipcMain.handle('createProject', async (_, name: string) => {
    const projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const project = {
      id: projectId,
      name,
      title: name,
      createdAt: new Date().toISOString(),
      currentStage: 'recognition',
    };
    projects.set(projectId, project);
    return project;
  });

  // 获取项目列表
  ipcMain.handle('getProjects', async () => {
    return Array.from(projects.values());
  });

  // 获取单个项目
  ipcMain.handle('getProject', async (_, projectId: string) => {
    return projects.get(projectId);
  });

  // 保存上传的 PDF
  ipcMain.handle('savePdf', async (_, projectId: string, fileName: string, fileData: ArrayBuffer) => {
    const userDataPath = app.getPath('userData');
    const projectDir = path.join(userDataPath, 'projects', projectId);
    const inputDir = path.join(projectDir, 'input');
    
    if (!fs.existsSync(inputDir)) {
      fs.mkdirSync(inputDir, { recursive: true });
    }
    
    const pdfPath = path.join(inputDir, fileName);
    fs.writeFileSync(pdfPath, Buffer.from(fileData));
    
    return { pdfPath };
  });

  // 启动 MinerU 识别
  ipcMain.handle('startRecognition', async (_, projectId: string, pdfPath: string) => {
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
        throw new Error(`Failed to create batch: ${batchResponse.status}`);
      }

      const batchData = await batchResponse.json();
      const uploadUrl = batchData.data?.file_urls?.[0];
      const batchId = batchData.data?.batch_id;

      if (!uploadUrl || !batchId) {
        throw new Error('Invalid batch response');
      }

      // 2. 上传文件
      const fileBuffer = fs.readFileSync(pdfPath);
      const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        body: fileBuffer,
      });

      if (!uploadResponse.ok) {
        throw new Error(`Failed to upload file: ${uploadResponse.status}`);
      }

      // 3. 创建任务记录
      const task: MineruTask = {
        projectId,
        status: 'queued',
        pdfPath,
      };
      tasks.set(projectId, task);

      // 4. 启动轮询（异步）
      pollMineruResult(projectId, batchId);

      return { status: 'queued', batchId };
    } catch (error) {
      console.error('Start recognition error:', error);
      throw error;
    }
  });

  // 查询识别状态
  ipcMain.handle('getRecognitionStatus', async (_, projectId: string) => {
    return tasks.get(projectId);
  });

  // 保存元数据
  ipcMain.handle('saveMetadata', async (_, projectId: string, metadata: any) => {
    const project = projects.get(projectId);
    if (project) {
      project.metadata = metadata;
      project.currentStage = 'proofreading';
      projects.set(projectId, project);
    }
    return project;
  });

  // 获取元数据
  ipcMain.handle('getMetadata', async (_, projectId: string) => {
    const project = projects.get(projectId);
    return project?.metadata || null;
  });
}

// 轮询 MinerU 结果
async function pollMineruResult(projectId: string, batchId: string) {
  const maxAttempts = 360; // 最多轮询 12 分钟
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
        console.error('Poll error:', response.status);
        continue;
      }

      const data = await response.json();
      const extractResult = data.data?.extract_result?.[0];
      
      if (extractResult) {
        const state = extractResult.state?.toLowerCase();
        
        if (state === 'success' || state === 'completed') {
          task.status = 'completed';
          task.resultUrl = extractResult.full_zip_url;
          tasks.set(projectId, task);
          
          // 下载结果
          await downloadResult(projectId, extractResult.full_zip_url);
          return;
        } else if (state === 'failed' || state === 'error') {
          task.status = 'failed';
          tasks.set(projectId, task);
          return;
        }
      }

      task.status = 'processing';
      tasks.set(projectId, task);
    } catch (error) {
      console.error('Poll error:', error);
    }

    // 等待 2 秒
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // 超时
  task.status = 'failed';
  tasks.set(projectId, task);
}

// 下载识别结果
async function downloadResult(projectId: string, url: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to download result');
    
    const buffer = await response.arrayBuffer();
    const userDataPath = app.getPath('userData');
    const resultPath = path.join(userDataPath, 'projects', projectId, 'result.zip');
    
    fs.writeFileSync(resultPath, Buffer.from(buffer));
    console.log('Result downloaded to:', resultPath);
  } catch (error) {
    console.error('Download result error:', error);
  }
}
