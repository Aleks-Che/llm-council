import { test, expect } from '@playwright/test';

const cid = '10000000-0000-4000-8000-000000000001';
const rid = '20000000-0000-4000-8000-000000000002';
const searchSettings = { model: 'test/research', max_rounds: 2, max_queries: 6, max_pages: 10, timeout_seconds: 180, context_chars: 24000 };

async function setup(page) {
  let conv = { id: cid, title: 'Новый диалог', created_at: '2026-09-05T00:00:00Z', messages: [] };
  let settings = { available_models: ['test/council', 'test/research'], council_models: ['test/council'], chairman_model: 'test/council', search: searchSettings, search_key: { configured: false, personal: false } };
  const submitted = [], saved = [];
  let sourceLoads = 0;
  await page.addInitScript(() => localStorage.setItem('llmcouncil_token', 'synthetic-ui-test-token'));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (json, status = 200) => route.fulfill({ status, json });
    if (path === '/api/auth/me') return respond({ id: 'ui-test', username: 'Тест', role: 'user' });
    if (path === '/api/conversations') return respond([{ ...conv, message_count: conv.messages.length, is_running: conv.messages.at(-1)?.status === 'running' }]);
    if (path === '/api/settings') {
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        saved.push(body);
        settings = { ...settings, ...body, search_key: { configured: Boolean(body.tavily_api_key), personal: Boolean(body.tavily_api_key) } };
      }
      return respond(settings);
    }
    if (path.endsWith('/message')) {
      const body = request.postDataJSON();
      submitted.push(body);
      if (body.search_enabled && !settings.search_key.configured) return respond({ detail: 'Для поиска добавьте ключ Tavily в настройках совета.' }, 400);
      conv.messages = [{ role: 'user', content: body.content, search_enabled: body.search_enabled }, { role: 'assistant', status: 'running', current_stage: body.search_enabled ? 'research' : 'stage1' }];
      return respond({ status: 'started', conversation_id: cid });
    }
    if (path.includes('/sources/')) { sourceLoads++; return respond({ content: 'Сохранённый исходный текст страницы для проверки.', truncated: false }); }
    if (path.endsWith('/cancel')) { conv.messages.at(-1).status = 'cancelled'; conv.messages.at(-1).current_stage = null; return respond({ status: 'ok' }); }
    if (path === `/api/conversations/${cid}`) return respond(conv);
    return respond({ detail: 'Unexpected request in UI test' }, 404);
  });
  await page.goto('/');
  await page.getByText('Новый диалог', { exact: true }).click();
  return {
    submitted, saved,
    sourceLoads: () => sourceLoads,
    update: (message) => { conv.messages[1] = { ...conv.messages[1], ...message }; },
  };
}

test('search toggle, recoverable configuration error, settings and persisted research progress', async ({ page }) => {
  const fixture = await setup(page);
  const input = page.getByRole('textbox', { name: 'Ваш вопрос' });
  const search = page.getByRole('button', { name: 'Поиск', exact: true });
  const inputBox = await input.boundingBox(), buttonBox = await search.boundingBox();
  expect(buttonBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height);
  expect(Math.abs(buttonBox.x - inputBox.x)).toBeLessThan(2);
  await expect(search).toHaveAttribute('aria-pressed', 'false');
  await input.fill('Как работает поиск источников?');
  await search.click();
  await expect(search).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: 'test-results/search-composer.png' });
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('добавьте ключ Tavily');
  await expect(input).toHaveValue('Как работает поиск источников?');

  await page.getByTitle('Настройки совета', { exact: true }).click();
  await page.getByLabel('Ключ Tavily API').fill('synthetic-tavily-key');
  await page.getByLabel('Модель исследования').selectOption('test/research');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(fixture.saved[0].search.model).toBe('test/research');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.getByText('Подготавливаем поиск…', { exact: true })).toBeVisible();
  expect(fixture.submitted.at(-1).search_enabled).toBe(true);

  const research = { id: rid, status: 'running', phase: 'searching', revision: 1, limits: searchSettings,
    round: 1, queries: [{ query: 'источники поиска', round: 1, status: 'complete', result_count: 1 }], sources: [],
    questions: ['Как работает поиск?'], findings: [], gaps: [], warnings: [], usage: {}, elapsed_seconds: 2 };
  fixture.update({ research });
  await expect(page.getByText('Ищем материалы', { exact: true })).toBeVisible();
  fixture.update({ research: { ...research, phase: 'reading', revision: 2 } });
  await expect(page.getByText('Читаем страницы', { exact: true })).toBeVisible();
  const source = { id: 'S1', status: 'read', title: 'Документация поиска', url: 'https://example.org/docs',
    excerpts: [{ id: 'S1E1', text: 'Точная выдержка из документации.' }], retrieved_at: '2026-09-05T00:00:00Z' };
  fixture.update({ status: 'complete', current_stage: null,
    research: { ...research, revision: 3, phase: 'done', status: 'complete', stop_reason: 'sufficient', sources: [source],
      findings: [{ text: 'Поиск использует источники.', evidence_ids: ['S1E1'] }] },
    stage3: { model: 'test/council', response: 'Ответ со ссылкой [S1E1](https://example.org/docs).' } });
  await expect(page.getByText('Найденные факты', { exact: true })).toBeVisible();
  expect(fixture.sourceLoads()).toBe(0);
  await page.getByText('Документация поиска', { exact: true }).click();
  await expect(page.getByText('Точная выдержка из документации.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Показать сохранённый текст' }).click();
  await expect(page.getByText('Сохранённый исходный текст страницы для проверки.', { exact: true })).toBeVisible();
  expect(fixture.sourceLoads()).toBe(1);
  await page.reload();
  await page.getByText('Новый диалог', { exact: true }).click();
  await expect(page.getByText('Найденные факты', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/search-results.png' });
});

test('search off keeps the existing flow and a running request can be stopped', async ({ page }) => {
  const fixture = await setup(page);
  await page.getByRole('textbox', { name: 'Ваш вопрос' }).fill('Обычный вопрос');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.getByText('Этап 1: Сбор индивидуальных ответов...').first()).toBeVisible();
  expect(fixture.submitted.at(-1).search_enabled).toBe(false);
  await expect(page.getByText('Поиск и источники', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Остановить', exact: true }).click();
  await expect(page.getByText('Запуск остановлен. Собранные материалы сохранены.', { exact: true })).toBeVisible();
});
