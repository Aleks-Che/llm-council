import { useState, useEffect } from 'react';
import { api } from '../api';
import './SettingsModal.css';

export default function SettingsModal({ onClose }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [availableModels, setAvailableModels] = useState([]);
  const [checkedModels, setCheckedModels] = useState(() => new Set());
  const [chairmanModel, setChairmanModel] = useState('');
  const [search, setSearch] = useState(null);
  const [searchKey, setSearchKey] = useState({ configured: false, personal: false });
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  // Состояние теста по каждой модели: 'testing' | 'ok' | 'fail' (+ длительность)
  const [testStates, setTestStates] = useState({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getSettings();
        if (cancelled) return;
        setAvailableModels(data.available_models || []);
        // Чекбокс включён, если модель входит в эффективный состав совета
        // (переопределение из settings.json, иначе дефолт конфига).
        setCheckedModels(new Set(data.council_models || []));
        setChairmanModel(data.chairman_model || '');
        setSearch(data.search);
        setSearchKey(data.search_key || { configured: false, personal: false });
      } catch {
        if (!cancelled) setLoadError('Не удалось загрузить настройки');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const toggleModel = (id) => {
    setCheckedModels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleTestModel = async (e, id) => {
    // Кнопка внутри <label> - не даём клику переключить чекбокс
    e.preventDefault();
    e.stopPropagation();
    if (testStates[id]?.status === 'testing') return;

    setTestStates((prev) => ({ ...prev, [id]: { status: 'testing' } }));
    try {
      const result = await api.testModel(id);
      setTestStates((prev) => ({
        ...prev,
        [id]: {
          status: result.ok ? 'ok' : 'fail',
          duration: result.duration_s,
        },
      }));
    } catch {
      setTestStates((prev) => ({ ...prev, [id]: { status: 'fail' } }));
    }
  };

  const handleSave = async () => {
    const council = availableModels.filter((m) => checkedModels.has(m));
    // На случай, если выбранные модели не из списка прокси (прокси был недоступен)
    for (const m of checkedModels) {
      if (!council.includes(m)) council.push(m);
    }
    if (council.length === 0) {
      setSaveError('Выберите хотя бы одну модель для совета');
      return;
    }
    if (!chairmanModel) {
      setSaveError('Выберите модель Председателя');
      return;
    }
    if (!search?.model) {
      setSaveError('Выберите модель для поиска');
      return;
    }
    for (const [key, min, max] of [['max_rounds', 1, 3], ['max_queries', 1, 6], ['max_pages', 1, 12], ['timeout_seconds', 30, 300]]) {
      if (!Number.isInteger(search[key]) || search[key] < min || search[key] > max) {
        setSaveError('Проверьте лимиты поиска: 1–3 прохода, 1–6 запросов, 1–12 страниц, 30–300 секунд.');
        return;
      }
    }
    setSaving(true);
    setSaveError(null);
    try {
      await api.saveSettings({
        council_models: council,
        chairman_model: chairmanModel,
        search,
        ...(apiKey.trim() ? { tavily_api_key: apiKey.trim() } : {}),
        remove_tavily_key: removeKey,
      });
      onClose();
    } catch (e) {
      setSaveError(e.message || 'Не удалось сохранить настройки');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Настройки совета"
      >
        <div className="settings-header">
          <h2>Настройки совета</h2>
          <button className="settings-close" onClick={onClose} title="Закрыть">
            ×
          </button>
        </div>

        {loading ? (
          <div className="settings-loading">Загрузка…</div>
        ) : loadError ? (
          <div className="settings-error">{loadError}</div>
        ) : (
          <>
            <div className="settings-section">
              <div className="settings-section-title">
                Модели совета ({checkedModels.size} из {availableModels.length})
              </div>
              <div className="settings-model-list">
                {availableModels.map((id) => {
                  const test = testStates[id];
                  const status = test?.status;
                  return (
                    <label key={id} className="settings-model-item">
                      <input
                        type="checkbox"
                        checked={checkedModels.has(id)}
                        onChange={() => toggleModel(id)}
                      />
                      <span className="settings-model-name">{id}</span>
                      <button
                        type="button"
                        className={`settings-model-test-btn${
                          status ? ` tested ${status}` : ''
                        }`}
                        title={
                          status === 'ok'
                            ? `Ответ за ${test.duration} с`
                            : status === 'fail'
                              ? 'Модель не ответила или вернула пустой ответ'
                              : 'Отправить тестовый запрос'
                        }
                        disabled={status === 'testing'}
                        onClick={(e) => handleTestModel(e, id)}
                      >
                        {status === 'testing'
                          ? '…'
                          : status === 'ok'
                            ? 'Успех!'
                            : status === 'fail'
                              ? 'Ошибка'
                              : 'Тест'}
                      </button>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">Председатель</div>
              <select
                className="settings-chairman-select"
                value={chairmanModel}
                onChange={(e) => setChairmanModel(e.target.value)}
              >
                {availableModels.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>

            {search && (
              <div className="settings-section settings-search">
                <div className="settings-section-title">Поиск в интернете</div>
                <label className="settings-field" htmlFor="search-model">Модель исследования</label>
                <select id="search-model" className="settings-chairman-select" value={search.model}
                  onChange={(e) => setSearch({ ...search, model: e.target.value })}>
                  {availableModels.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
                <p className="settings-search-hint">Планирует поиск, читает источники и проверяет, достаточно ли информации для совета.</p>

                <label className="settings-field" htmlFor="tavily-key">Ключ Tavily API</label>
                <input id="tavily-key" type="password" autoComplete="new-password"
                  className="settings-chairman-select" value={apiKey}
                  placeholder={searchKey.configured && !removeKey ? 'Ключ настроен. Введите новый для замены' : 'tvly-…'}
                  onChange={(e) => { setApiKey(e.target.value); setRemoveKey(false); }} />
                <p className="settings-search-hint">
                  {searchKey.configured && !removeKey ? (searchKey.personal ? 'Личный ключ сохранён на сервере.' : 'Используется ключ сервера.') : 'Для поиска нужен ключ Tavily.'}
                  {' '}<a href="https://app.tavily.com" target="_blank" rel="noreferrer">Получить ключ</a>
                </p>
                {searchKey.personal && (
                  <label className="settings-remove-key"><input type="checkbox" checked={removeKey}
                    onChange={(e) => { setRemoveKey(e.target.checked); setApiKey(''); }} /> Удалить личный ключ при сохранении</label>
                )}

                <div className="settings-search-limits">
                  {[
                    ['max_rounds', 'Проходов', 1, 3],
                    ['max_queries', 'Запросов всего', 1, 6],
                    ['max_pages', 'Страниц всего', 1, 12],
                    ['timeout_seconds', 'Время, секунд', 30, 300],
                  ].map(([key, label, min, max]) => (
                    <label key={key} className="settings-field">{label}
                      <input type="number" min={min} max={max} value={search[key]}
                        onChange={(e) => setSearch({ ...search, [key]: e.target.value === '' ? '' : Number(e.target.value) })} />
                    </label>
                  ))}
                </div>
              </div>
            )}

            {saveError && <div className="settings-error">{saveError}</div>}

            <div className="settings-note">
              Настройки применяются к новым сообщениям.
            </div>

            <div className="settings-actions">
              <button
                className="settings-save-btn"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Сохранение…' : 'Сохранить'}
              </button>
              <button className="settings-cancel-btn" onClick={onClose}>
                Отмена
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
