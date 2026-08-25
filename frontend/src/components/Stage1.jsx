import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import './Stage1.css';

export default function Stage1({ responses }) {
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
            {String(resp?.model ?? '').split('/')[1] || String(resp?.model ?? '?')}
          </button>
        ))}
      </div>

      <div className="tab-content">
        <div className="model-name">{String(responses[tab]?.model ?? '')}</div>
        <div className="response-text markdown-content">
          <ReactMarkdown>{String(responses[tab]?.response ?? '')}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
