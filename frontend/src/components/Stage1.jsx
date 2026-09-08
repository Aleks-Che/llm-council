import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CopyButton from './CopyButton';
import './Stage1.css';
import { modelName } from '../modelNames';

export default function Stage1({ responses, modelLabels }) {
  const [activeTab, setActiveTab] = useState(0);

  if (!Array.isArray(responses) || responses.length === 0) {
    return null;
  }
  const tab = Math.min(activeTab, responses.length - 1);

  return (
    <div className="stage stage1">
      <h3 className="stage-title">Этап 1: Индивидуальные ответы</h3>

      <div className="tabs">
        {responses.map((resp, index) => (
          <button
            key={index}
            className={`tab ${tab === index ? 'active' : ''}`}
            onClick={() => setActiveTab(index)}
          >
            {modelName(resp?.model, modelLabels, true)}
          </button>
        ))}
      </div>

      <div className="tab-content">
        <div className="tab-content-header">
          <div className="model-name">{modelName(responses[tab]?.model, modelLabels)}</div>
          <CopyButton text={String(responses[tab]?.response ?? '')} />
        </div>
        <div className="response-text markdown-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{String(responses[tab]?.response ?? '')}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
