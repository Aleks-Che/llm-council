import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CopyButton from './CopyButton';
import './Stage2.css';

function deAnonymizeText(text, labelToModel) {
  if (!labelToModel) return text;

  let result = text;
  // Replace each "Response X" with the actual model name
  Object.entries(labelToModel).forEach(([label, model]) => {
    const modelShortName = model.split('/')[1] || model;
    result = result.replace(new RegExp(label, 'g'), `**${modelShortName}**`);
  });
  return result;
}

export default function Stage2({ rankings, labelToModel, aggregateRankings }) {
  const [activeTab, setActiveTab] = useState(0);

  if (!rankings || rankings.length === 0) {
    return null;
  }

  const tab = Math.min(activeTab, rankings.length - 1);
  const rankingText = deAnonymizeText(rankings[tab].ranking, labelToModel);

  return (
    <div className="stage stage2">
      <h3 className="stage-title">Этап 2: Взаимные оценки</h3>

      <h4>Исходные оценки</h4>
      <p className="stage-description">
        Каждая модель оценила все ответы (анонимизированные как Response A, B, C и т.д.) и выставила ранжирование.
        Ниже имена моделей выделены <strong>жирным</strong> для удобства чтения, но в исходной оценке использовались анонимные метки.
      </p>

      <div className="tabs">
        {rankings.map((rank, index) => (
          <button
            key={index}
            className={`tab ${tab === index ? 'active' : ''}`}
            onClick={() => setActiveTab(index)}
          >
            {rank.model.split('/')[1] || rank.model}
          </button>
        ))}
      </div>

      <div className="tab-content">
        <div className="tab-content-header">
          <div className="ranking-model">
            {rankings[tab].model}
          </div>
          <CopyButton text={rankingText} />
        </div>
        <div className="ranking-content markdown-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {rankingText}
          </ReactMarkdown>
        </div>

        {rankings[tab].parsed_ranking &&
         rankings[tab].parsed_ranking.length > 0 && (
          <div className="parsed-ranking">
            <strong>Извлечённый рейтинг:</strong>
            <ol>
              {rankings[tab].parsed_ranking.map((label, i) => (
                <li key={i}>
                  {labelToModel && labelToModel[label]
                    ? labelToModel[label].split('/')[1] || labelToModel[label]
                    : label}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      {aggregateRankings && aggregateRankings.length > 0 && (
        <div className="aggregate-rankings">
          <h4>Сводный рейтинг (общее признание)</h4>
          <p className="stage-description">
            Объединённые результаты всех взаимных оценок (чем ниже значение, тем лучше):
          </p>
          <div className="aggregate-list">
            {aggregateRankings.map((agg, index) => (
              <div key={index} className="aggregate-item">
                <span className="rank-position">#{index + 1}</span>
                <span className="rank-model">
                  {agg.model.split('/')[1] || agg.model}
                </span>
                <span className="rank-score">
                  Среднее: {agg.average_rank.toFixed(2)}
                </span>
                <span className="rank-count">
                  ({agg.rankings_count} оцен.)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
