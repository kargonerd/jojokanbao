
import { PressActionLink, PressButton, PressPage, PressPanel, PressStageStrip } from '../components/PressUi';
import type { MockRecognitionState } from '../types/project';
import type { RecognitionTask } from '../lib/api';
import { pressPath } from '../paths';

type RecognitionData = MockRecognitionState | RecognitionTask;

interface RecognitionWaitingPageProps {
  recognition: RecognitionData;
  onContinue?: () => Promise<void> | void;
  mode?: 'real' | 'mock';
}

function isMockRecognition(recognition: RecognitionData): recognition is MockRecognitionState {
  return 'statusText' in recognition;
}

function getStatusText(recognition: RecognitionData) {
  if (isMockRecognition(recognition)) {
    return recognition.statusText;
  }

  if (recognition.status === 'completed') {
    return '识别已完成，正在进入添加书籍信息。';
  }

  if (recognition.status === 'failed') {
    return '识别失败，请检查服务配置后重试。';
  }

  if (recognition.status === 'processing') {
    return 'MinerU 正在处理当前项目。';
  }

  return '识别任务已创建，正在排队处理中。';
}

export function RecognitionWaitingPage({ recognition, onContinue, mode = 'real' }: RecognitionWaitingPageProps) {
  if (isMockRecognition(recognition) || mode === 'mock') {
    const mockRecognition = isMockRecognition(recognition) ? recognition : null;
    const realRecognition = isMockRecognition(recognition) ? null : recognition;
    const progressPercent = mockRecognition ? Math.round((mockRecognition.processedPages / mockRecognition.totalPages) * 100) : 0;

    return (
      <PressPage title="识别进行中" description={mockRecognition?.statusText ?? 'MinerU 正在处理当前项目。'}>
        <PressStageStrip active="recognition" />

        <section className="page-layout page-layout--single">
          <PressPanel spacious>
            <div className="info-grid">
              <div>
                <p className="eyebrow">当前项目</p>
                <h2>{mockRecognition?.title ?? realRecognition?.project_id ?? '识别任务'}</h2>
                <p>{mockRecognition?.fileName ?? realRecognition?.pdf_path ?? ''}</p>
              </div>
              <div>
                <p className="eyebrow">识别引擎</p>
                <p>{mockRecognition?.engine ?? realRecognition?.engine ?? 'MinerU'}</p>
                <p>{mockRecognition?.currentPhase ?? getStatusText(recognition)}</p>
              </div>
            </div>

            {mockRecognition ? (
              <div className="progress-meter" aria-label={`已处理 ${mockRecognition.processedPages} / ${mockRecognition.totalPages} 页`}>
                <div className="progress-meter__bar">
                  <div className="progress-meter__fill" style={{ width: `${progressPercent}%` }} />
                </div>
                <div className="progress-meter__meta">
                  <span>已处理 {mockRecognition.processedPages} / {mockRecognition.totalPages} 页</span>
                  <strong>{mockRecognition.estimateLabel}</strong>
                </div>
              </div>
            ) : null}

            <div className="inline-actions">
              <PressActionLink to={pressPath(mockRecognition?.nextHref ?? `/projects/${realRecognition?.project_id ?? ''}/metadata`)}>
                查看识别结果
              </PressActionLink>
            </div>
          </PressPanel>
        </section>
      </PressPage>
    );
  }

  return (
    <PressPage title="识别进行中" description={getStatusText(recognition)}>
      <PressStageStrip active="recognition" />

      <section className="page-layout page-layout--single">
        <PressPanel spacious>
          <div className="info-grid">
            <div>
              <p className="eyebrow">当前项目</p>
              <h2>{recognition.project_id}</h2>
              <p>{recognition.pdf_path}</p>
            </div>
            <div>
              <p className="eyebrow">识别引擎</p>
              <p>{recognition.engine}</p>
              <p>状态：{recognition.status}</p>
            </div>
          </div>

          <div className="inline-actions">
            {recognition.status === 'completed' ? (
              <PressButton type="button" onClick={() => void onContinue?.()}>
                查看识别结果
              </PressButton>
            ) : null}
          </div>
        </PressPanel>
      </section>
    </PressPage>
  );
}
