import ReactMarkdown from 'react-markdown';
import './Stage3.css';

export default function Stage3({ finalResponse }) {
  if (!finalResponse) {
    return null;
  }
  const model = String(finalResponse.model ?? '');

  return (
    <div className="stage stage3">
      <h3 className="stage-title">Этап 3: Финальный ответ Совета</h3>
      <div className="final-response">
        <div className="chairman-label">
          Председатель: {model.split('/')[1] || model}
        </div>
        <div className="final-text markdown-content">
          <ReactMarkdown>{String(finalResponse.response ?? '')}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
