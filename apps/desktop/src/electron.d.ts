export {};

declare global {
  interface JojoPressBridge {
    appName: string;
    apiBaseUrl?: string;

    // 文件选择
    selectPdf?: () => Promise<string | null>;

    // 项目管理
    createProject?: (name: string) => Promise<{
      id: string;
      name: string;
      title: string;
      createdAt: string;
      currentStage: string;
      path: string;
    }>;
    getProjects?: () => Promise<Array<{
      id: string;
      name: string;
      title: string;
      createdAt: string;
      currentStage: string;
      path: string;
    }>>;
    getProject?: (projectId: string) => Promise<{
      id: string;
      name: string;
      title: string;
      createdAt: string;
      currentStage: string;
      path: string;
      metadata?: unknown;
    } | null>;

    // PDF 处理
    savePdf?: (projectId: string, fileName: string, fileData: ArrayBuffer) => Promise<{ pdfPath: string }>;
    startRecognition?: (projectId: string, pdfPath: string) => Promise<{ status: string; batchId: string }>;
    getRecognitionStatus?: (projectId: string) => Promise<{
      projectId: string;
      status: 'queued' | 'processing' | 'completed' | 'failed';
      pdfPath: string;
      batchId: string;
      createdAt: string;
      completedAt?: string;
      resultUrl?: string;
      error?: string;
    } | null>;

    // 元数据
    saveMetadata?: (projectId: string, metadata: unknown) => Promise<unknown>;
    getMetadata?: (projectId: string) => Promise<unknown | null>;

    // 文件操作
    getProjectPath?: (projectId: string) => Promise<string>;
    openPdf?: (pdfPath: string) => Promise<void>;
  }

  interface Window {
    jojoPress?: JojoPressBridge;
  }
}
