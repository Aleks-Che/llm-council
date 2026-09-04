import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CopyButton from './CopyButton';
import './Stage3.css';

export default function Stage3({ finalResponse }) {
  if (!finalResponse) {
    return null;
  }
  const model = String(finalResponse.model ?? '');
  const responseText = String(finalResponse.response ?? '');

  return (
    <div className="stage stage3">
      <div className="stage-header">
        <h3 className="stage-title">Этап 3: Финальный ответ Совета</h3>
        <CopyButton text={responseText} />
      </div>
      <div className="final-response">
        <div className="chairman-label">
          Председатель: {model.split('/')[1] || model}
        </div>
        <div className="final-text markdown-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{responseText}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
