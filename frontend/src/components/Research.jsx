import { useState } from 'react';
import { api } from '../api';
import './Research.css';

const phases = {
  planning: 'Составляем план поиска', searching: 'Ищем материалы',
  selecting: 'Выбираем источники', reading: 'Читаем страницы',
  assessing: 'Проверяем полноту информации', done: 'Поиск завершён',
};
const statuses = {
  read: 'Прочитан', failed: 'Не удалось прочитать', not_selected: 'Найден, не прочитан',
  reading: 'Читаем…', duplicate: 'Повтор материала',
};
const reasons = {
  sufficient: 'Все пункты плана подтверждены по оценке исследователя.',
  timeout: 'Достигнут лимит времени.', round_limit: 'Достигнут лимит проходов.',
  query_limit: 'Достигнут лимит запросов.', page_limit: 'Достигнут лимит страниц.',
  no_new_queries: 'Новых поисковых запросов нет.', no_results: 'Новых источников не найдено.',
  assessment_failed: 'Проверка полноты не завершена.', provider_error: 'Поисковый сервис недоступен.',
  cancelled: 'Поиск остановлен.', interrupted: 'Поиск прерван перезапуском сервера.',
};

function Source({ source, conversationId, researchId }) {
  const [document, setDocument] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showDocument, setShowDocument] = useState(false);
  const loadDocument = async () => {
    if (document) { setShowDocument(!showDocument); return; }
    setLoading(true);
    setError('');
    try {
      setDocument(await api.getResearchSource(conversationId, researchId, source.id));
      setShowDocument(true);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  return (
    <details className="research-source">
      <summary>
        <span className="research-source-id">{source.id}</span>
        <span className="research-source-title">{source.title}</span>
        <span className={`research-source-status ${source.status}`}>{statuses[source.status] || source.status}</span>
      </summary>
      <div className="research-source-body">
        <a href={source.url} target="_blank" rel="noreferrer">{source.url}</a>
        {source.published_at && <div className="research-meta">Опубликовано: {source.published_at}</div>}
        {source.retrieved_at && <div className="research-meta">Получено: {new Date(source.retrieved_at).toLocaleString()}</div>}
        {source.status !== 'read' && source.snippet && <p className="research-snippet">Фрагмент поисковой выдачи: {source.snippet}</p>}
        {source.error && <p className="research-notice">{source.error}</p>}
        {source.duplicate_of && <p>Повторяет материал {source.duplicate_of}.</p>}
        {source.excerpts?.map((excerpt) => <blockquote key={excerpt.id}><strong>{excerpt.id}</strong><div>{excerpt.text}</div></blockquote>)}
        {source.status === 'read' && <button type="button" className="research-text-button" disabled={loading} onClick={loadDocument}>
          {loading ? 'Загрузка…' : showDocument ? 'Скрыть текст страницы' : 'Показать сохранённый текст'}
        </button>}
        {error && <p role="alert" className="research-notice">{error}</p>}
        {showDocument && document && <>
          {document.truncated && <p className="research-notice">Сохранённый текст сокращён до 120 000 символов.</p>}
          <pre className="research-document">{document.content}</pre>
        </>}
      </div>
    </details>
  );
}

export default function Research({ research, conversationId, running }) {
  if (!research) return <div className="stage-loading"><div className="spinner" />Подготавливаем поиск…</div>;
  const read = research.sources.filter((s) => s.status === 'read');
  const registry = Object.fromEntries(read.flatMap((s) => (s.excerpts || []).map((e) => [e.id, s.url])));
  return (
    <section className="stage research-stage">
      <div className="research-heading">
        <h3 className="stage-title">Поиск и источники</h3>
        {running && <span className="stage-chip-spinner" />}
      </div>
      <p className="research-progress" aria-live="polite">
        {running ? phases[research.phase] || 'Поиск выполняется' : research.status === 'failed' ? 'Поиск не дал прочитанных источников' : research.status === 'partial' ? 'Материалы собраны частично' : reasons[research.stop_reason] || 'Поиск завершён'}
      </p>
      <div className="research-meta">
        Проход {research.round} из {research.limits.max_rounds} · Запросов: {research.queries.length} · Прочитано: {read.length}
        {research.elapsed_seconds != null && ` · ${research.elapsed_seconds} с`}
        {research.usage?.credits > 0 && ` · ${research.usage.credits} кр. Tavily`}
      </div>
      {!running && research.status !== 'complete' && <p className="research-notice">
        {reasons[research.stop_reason]} {read.length ? 'Совет использует доступные выдержки с учётом пробелов.' : 'Совет отвечает без подтверждения веб-источниками.'}
      </p>}
      {research.questions.length > 0 && <details className="research-plan"><summary>План исследования</summary><ol>{research.questions.map((q, i) => <li key={i}>{q}</li>)}</ol></details>}
      {research.queries.length > 0 && <details className="research-plan"><summary>Поисковые запросы ({research.queries.length})</summary>
        <ol>{research.queries.map((q, i) => <li key={i}><span>{q.query}</span><small>Проход {q.round} · {q.status === 'running' ? 'Выполняется…' : q.status === 'failed' ? q.error : `Найдено: ${q.result_count}`}</small></li>)}</ol>
      </details>}
      {research.findings.length > 0 && <div className="research-findings"><h4>Найденные факты</h4><ul>
        {research.findings.map((finding, i) => <li key={i}>{finding.text}{' '}{finding.evidence_ids.filter((id) => registry[id]).map((id) => <a className="research-citation" href={registry[id]} key={id} target="_blank" rel="noreferrer">[{id}]</a>)}</li>)}
      </ul></div>}
      {research.gaps.length > 0 && <div className="research-gaps"><h4>Что осталось выяснить</h4><ul>{research.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></div>}
      {research.warnings.map((warning, i) => <p className="research-notice" key={i}>{warning}</p>)}
      <div className="research-sources">{research.sources.map((source) => <Source key={source.id} source={source} conversationId={conversationId} researchId={research.id} />)}</div>
    </section>
  );
}
