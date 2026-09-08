import { test, expect } from '@playwright/test';

const cid = '10000000-0000-4000-8000-000000000003';
const searchSettings = { model: 'test/a', max_rounds: 2, max_queries: 6, max_pages: 10, timeout_seconds: 180, context_chars: 24000 };

async function setup(page, status = 'error') {
  const conv = { id: cid, title: 'Проверка повтора', created_at: '2026-09-06T00:00:00Z', messages: [
    { role: 'user', content: 'Исходный вопрос с вложением' },
    { role: 'assistant', status, current_stage: null, failed_stage: 'stage3', error: 'Председатель не ответил.',
      stage1: [{ model: 'test/a', response: 'Сохранённый ответ модели' }],
      stage2: [{ model: 'test/a', ranking: 'Сохранённая оценка. FINAL RANKING:\n1. Response A', parsed_ranking: ['Response A'] }],
      metadata: { label_to_model: { 'Response A': 'test/a' }, aggregate_rankings: [] },
      completed_stages: ['stage1', 'stage2'], stage3: null },
  ] };
  let settings = { available_models: ['test/a'], council_models: ['test/a'], chairman_model: 'test/a',
    custom_models: [], search: searchSettings, search_key: { configured: false, personal: false } };
  const saved = [], tested = [], retries = [];
  let retryError = false;
  await page.addInitScript(() => localStorage.setItem('llmcouncil_token', 'synthetic-ui-test-token'));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (json, code = 200) => route.fulfill({ status: code, json });
    if (path === '/api/auth/me') return respond({ id: 'ui-test', username: 'Тест', role: 'user' });
    if (path === '/api/conversations') return respond([{ ...conv, message_count: 2, is_running: conv.messages[1].status === 'running' }]);
    if (path === `/api/conversations/${cid}`) return respond(conv);
    if (path.endsWith('/retry')) {
      retries.push(request.method());
      if (retryError) return respond({ detail: 'Временная ошибка сервера' }, 503);
      Object.assign(conv.messages[1], { status: 'running', current_stage: 'stage3', error: null });
      return respond({ status: 'started' });
    }
    if (path === '/api/settings/test-model') { tested.push(request.postDataJSON()); return respond({ ok: true, duration_s: 0.1 }); }
    if (path === '/api/settings') {
      if (request.method() === 'POST') {
        const data = request.postDataJSON();
        saved.push(data);
        settings = { ...settings, ...data,
          available_models: [...new Set(['test/a', ...data.custom_models.map((m) => m.id)])],
          custom_models: data.custom_models.map(({ api_key, ...model }) => ({ ...model, key_configured: Boolean(api_key) || model.key_configured })),
        };
      }
      return respond(settings);
    }
    return respond({ detail: 'Unexpected request' }, 404);
  });
  await page.goto('/');
  await page.getByText('Проверка повтора', { exact: true }).click();
  return { saved, tested, retries, failRetry: (fail) => { retryError = fail; },
    complete: () => Object.assign(conv.messages[1], { status: 'complete', current_stage: null,
      completed_stages: ['stage1', 'stage2', 'stage3'], stage3: { model: 'test/a', response: 'Продолженный финальный ответ' } }),
  };
}

test('retry preserves saved stages, handles endpoint failure and resumes polling', async ({ page }) => {
  const fixture = await setup(page);
  const retry = page.getByRole('button', { name: 'Повторить', exact: true });
  await expect(retry).toBeVisible();
  fixture.failRetry(true);
  await retry.click();
  await expect(page.getByText('Временная ошибка сервера', { exact: true })).toBeVisible();
  await expect(retry).toBeEnabled();
  await expect(page.getByText('Сохранённый ответ модели', { exact: true })).toBeAttached();
  fixture.failRetry(false);
  await retry.click();
  await expect(page.getByText('Этап 3: Финальный синтез...').first()).toBeVisible();
  await expect(page.getByText('Сохранённый ответ модели', { exact: true })).toBeAttached();
  expect(fixture.retries).toEqual(['POST', 'POST']);
  fixture.complete();
  await expect(page.getByText('Продолженный финальный ответ', { exact: true })).toBeVisible();
  await expect(retry).toHaveCount(0);
  await expect(page.getByText('Исходный вопрос с вложением', { exact: true })).toHaveCount(1);
});

for (const status of ['interrupted', 'cancelled']) {
  test(`retry is available after ${status} and page reload`, async ({ page }) => {
    const fixture = await setup(page, status);
    await page.reload();
    await page.getByText('Проверка повтора', { exact: true }).click();
    await page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Остановить', exact: true })).toBeVisible();
    expect(fixture.retries).toHaveLength(1);
  });
}

test('custom model form, reasoning toggle, draft test, save and edit round trip', async ({ page }) => {
  const fixture = await setup(page);
  await page.getByTitle('Настройки совета', { exact: true }).click();
  const add = page.getByRole('button', { name: '+ Добавить модель', exact: true });
  const models = page.getByText('Модели совета (1 из 1)', { exact: true });
  const addBox = await add.boundingBox(), modelsBox = await models.boundingBox();
  expect(addBox.y).toBeLessThan(modelsBox.y);
  await add.click();
  await expect(page.getByLabel('Режим рассуждений', { exact: true })).toHaveCount(0);
  await page.getByLabel('OpenAI compatible URL', { exact: true }).fill('https://models.example.org/v1/chat/completions/');
  await page.getByLabel('API key', { exact: true }).fill('synthetic-model-key');
  await expect(page.getByLabel('API key', { exact: true })).toHaveAttribute('type', 'password');
  await page.getByLabel('Модель', { exact: true }).fill('vendor/reasoner');
  await page.getByLabel('Reasoning effort', { exact: true }).check();
  await page.getByLabel('Режим рассуждений', { exact: true }).selectOption('high');
  await page.screenshot({ path: 'test-results/custom-model-form.png' });
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  const row = page.locator('.settings-model-item').filter({ hasText: 'vendor/reasoner' });
  await expect(row.getByRole('checkbox')).toBeChecked();
  await row.hover();
  await row.getByRole('button', { name: 'Тест', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Успех!', exact: true })).toBeVisible();
  expect(fixture.tested[0].custom_models[0].reasoning_effort).toBe('high');
  expect(fixture.saved).toHaveLength(0);
  const customId = fixture.tested[0].model;
  await page.getByLabel('Председатель', { exact: true }).selectOption(customId);
  await page.getByLabel('Модель исследования', { exact: true }).selectOption(customId);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(fixture.saved[0].custom_models[0]).toMatchObject({ url: 'https://models.example.org/v1',
    model: 'vendor/reasoner', api_key: 'synthetic-model-key', reasoning_effort: 'high' });
  expect(fixture.saved[0].chairman_model).toBe(customId);
  expect(fixture.saved[0].search.model).toBe(customId);

  await page.getByTitle('Настройки совета', { exact: true }).click();
  await row.getByRole('button', { name: 'Изменить', exact: true }).click();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Режим рассуждений', { exact: true })).toHaveValue('high');
  await page.getByLabel('Reasoning effort', { exact: true }).uncheck();
  await expect(page.getByLabel('Режим рассуждений', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(fixture.saved[1].custom_models[0].reasoning_effort).toBeNull();
  expect(fixture.saved[1].custom_models[0].api_key).toBeNull();
});

test('model test shows the provider error and clears it after a successful retry', async ({ page }) => {
  await setup(page);
  const error = 'HTTP 401 — https://models.example.org/v1/chat/completions: Invalid API-key provided';
  let ok = false;
  await page.route('**/api/settings/test-model', (route) => route.fulfill({
    json: { ok, duration_s: 0.1, ...(ok ? {} : { error }) },
  }));
  await page.getByTitle('Настройки совета', { exact: true }).click();
  const row = page.locator('.settings-model-item').filter({ hasText: 'test/a' });
  await row.hover();
  await row.getByRole('button', { name: 'Тест', exact: true }).click();
  await expect(row.getByRole('alert')).toHaveText(error);
  await expect(row.getByRole('button', { name: 'Ошибка', exact: true })).toHaveAttribute('title', error);
  ok = true;
  await row.getByRole('button', { name: 'Ошибка', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Успех!', exact: true })).toBeVisible();
  await expect(row.getByRole('alert')).toHaveCount(0);
});
