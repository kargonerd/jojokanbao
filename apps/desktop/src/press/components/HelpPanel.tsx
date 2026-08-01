import { useState } from 'react';

export function HelpPanel() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="help-panel">
      <button 
        className="help-panel__toggle"
        onClick={() => setIsOpen(!isOpen)}
        title="帮助"
      >
        {isOpen ? '✕' : '?'}
      </button>
      
      {isOpen && (
        <div className="help-panel__content">
          <h3 className="help-panel__title">使用帮助</h3>
          
          <div className="help-section">
            <h4 className="help-section__title">📖 制作流程</h4>
            <ol className="help-list">
              <li>点击"选择 PDF 文件"上传扫描版 PDF</li>
              <li>系统自动识别 PDF 内容</li>
              <li>确认书名、作者等元数据</li>
              <li>校对识别出的文字</li>
              <li>导出为 Markdown 或 EPUB</li>
            </ol>
          </div>
          
          <div className="help-section">
            <h4 className="help-section__title">⚙️ 配置 MinerU 识别服务</h4>
            <p className="help-text">
              如果遇到"识别服务未配置"错误，需要配置 MinerU API：
            </p>
            <div className="code-block">
              <p>1. 设置环境变量：</p>
              <code>
                MINERU_API_BASE=https://your-mineru-api.com<br/>
                MINERU_API_TOKEN=your-api-token
              </code>
            </div>
            <p className="help-text">
              2. 重启后端引擎服务
            </p>
          </div>
          
          <div className="help-section">
            <h4 className="help-section__title">💡 提示</h4>
            <ul className="help-list">
              <li>支持 600 页以内的 PDF 文件</li>
              <li>扫描版 PDF 需要 OCR 识别</li>
              <li>识别时间取决于 PDF 页数</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
