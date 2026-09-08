import { useEffect, useRef, useState } from 'react';
import { modelName } from '../modelNames';
import './ModelSelector.css';

export default function ModelSelector({ councilEnabled, settings, disabled, error, onChange, onReload }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const council = settings?.council_models || [];
  const labels = Object.fromEntries((settings?.custom_models || []).map((m) => [m.id, `${m.model} · ${new URL(m.url).host}`]));
  const available = [...new Set([...(settings?.available_models || []), ...council,
    settings?.chairman_model, settings?.chat_model].filter(Boolean))];
  const locked = disabled || !settings;
  const options = available.map((id) => <option key={id} value={id}>{modelName(id, labels)}</option>);

  return (
    <div className="chat-model-bar">
      <div className="chat-model-controls">
        {councilEnabled ? (
          <>
            <div className="council-model-picker" ref={root} onBlur={(event) => {
              if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
            }}>
              <span className="model-picker-label" id="council-model-label">Модели совета</span>
              <button type="button" ref={trigger} className="model-picker-trigger"
                aria-expanded={open} aria-controls="council-model-options" disabled={locked}
                onClick={() => setOpen((value) => !value)}>
                Участники: {council.length} <span aria-hidden="true">⌄</span>
              </button>
              {open && (
                <div className="council-model-options" id="council-model-options" role="group" aria-labelledby="council-model-label">
                  {available.map((id) => (
                    <label key={id} className="council-model-option">
                      <input type="checkbox" checked={council.includes(id)}
                        disabled={locked || (council.length === 1 && council.includes(id))}
                        onChange={() => onChange({ council_models: council.includes(id)
                          ? council.filter((model) => model !== id) : [...council, id] })} />
                      <span>{modelName(id, labels)}</span>
                    </label>
                  ))}
                  <p className="model-picker-hint">Выберите хотя бы одну модель.</p>
                </div>
              )}
            </div>
            <label className="single-model-picker">
              <span className="model-picker-label">Председатель совета</span>
              <select aria-label="Председатель совета" value={settings?.chairman_model || ''}
                disabled={locked} onChange={(event) => onChange({ chairman_model: event.target.value })}>
                {!settings && <option value="">Загрузка моделей…</option>}
                {options}
              </select>
            </label>
          </>
        ) : (
          <label className="single-model-picker">
            <span className="model-picker-label">Модель чата</span>
            <select aria-label="Модель чата" value={settings?.chat_model || settings?.chairman_model || ''}
              disabled={locked} onChange={(event) => onChange({ chat_model: event.target.value })}>
              {!settings && <option value="">Загрузка моделей…</option>}
              {options}
            </select>
          </label>
        )}
        {settings && <span className="model-selection-note">{disabled ? '' : 'Выбор сохраняется по умолчанию'}</span>}
      </div>
      {error && <div className="model-selection-error" role="alert">{error}{' '}
        <button type="button" onClick={onReload}>Загрузить модели заново</button>
      </div>}
    </div>
  );
}
