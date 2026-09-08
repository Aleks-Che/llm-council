import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';

const cid = '10000000-0000-4000-8000-000000000004';

async function setup(page) {
  const conversations = [{ id: cid, title: 'Проверка чата', created_at: '2026-09-08T00:00:00Z', messages: [] }];
  let settings = { available_models: ['test/a', 'test/b', 'test/chair'], chat_model: 'test/a',
    council_models: ['test/a', 'test/b'], chairman_model: 'test/chair', custom_models: [],
    search: { model: 'test/a', max_rounds: 2, max_queries: 6, max_pages: 10, timeout_seconds: 180, context_chars: 24000 },
    search_key: { configured: true, personal: true } };
  const sent = [], saved = [], retries = [], edits = [];
  let saveError = false;
  let editError = false;
  let saveGate = null, releaseSave;
  await page.addInitScript(() => localStorage.setItem('llmcouncil_token', 'synthetic-ui-test-token'));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (json, status = 200) => route.fulfill({ json, status });
    if (path === '/api/auth/me') return respond({ id: 'ui-test', username: 'Тест', role: 'user' });
    if (path === '/api/settings') {
      if (request.method() === 'PATCH') {
        if (saveGate) await saveGate;
        if (saveError) return respond({ detail: 'Не удалось сохранить модель' }, 503);
        saved.push(request.postDataJSON());
        settings = { ...settings, ...request.postDataJSON() };
      }
      return respond(settings);
    }
    if (path === '/api/conversations') {
      if (request.method() === 'POST') {
        const next = { id: `${cid}-${conversations.length}`, title: 'Новый диалог', created_at: '2026-09-08T01:00:00Z', messages: [] };
        conversations.unshift(next);
        return respond(next);
      }
      return respond(conversations.map((conv) => ({ ...conv, message_count: conv.messages.length,
        is_running: conv.messages.at(-1)?.status === 'running' })));
    }
    const conv = conversations.find((item) => path.startsWith(`/api/conversations/${item.id}`));
    const editMatch = /\/messages\/(\d+)$/.exec(path);
    if (path.endsWith('/message') || editMatch) {
      const body = request.postDataJSON();
      if (editMatch) {
        if (editError) return respond({ detail: 'Не удалось сохранить запрос' }, 503);
        const index = Number(editMatch[1]);
        edits.push({ index, ...body });
        conv.messages.splice(index);
      } else sent.push(body);
      conv.messages.push({ role: 'user', content: body.content, search_enabled: body.search_enabled },
        { role: 'assistant', mode: body.council_enabled ? 'council' : 'chat', model: body.chat_model,
          status: 'running', current_stage: body.search_enabled ? 'research' : body.council_enabled ? 'stage1' : 'chat' });
      return respond({ status: 'started' });
    }
    if (path.endsWith('/retry')) {
      const body = request.postDataJSON();
      retries.push(body);
      Object.assign(conv.messages.at(-1), { model: body.chat_model, status: 'running', current_stage: 'chat', error: null });
      return respond({ status: 'started' });
    }
    if (path.endsWith('/cancel')) {
      Object.assign(conv.messages.at(-1), { status: 'cancelled', current_stage: null });
      return respond({ status: 'ok' });
    }
    if (conv) return respond(conv);
    return respond({ detail: 'Unexpected request' }, 404);
  });
  await page.goto('/');
  await page.getByText('Проверка чата', { exact: true }).click();
  return { sent, saved, retries, edits, failSave: (value) => { saveError = value; },
    failEdit: (value) => { editError = value; },
    holdSave: () => { saveGate = new Promise((resolve) => { releaseSave = resolve; }); },
    releaseSave: () => { releaseSave(); saveGate = null; },
    complete: (fields = {}) => {
      Object.assign(conversations[0].messages.at(-1), { status: 'complete', current_stage: null, content: 'Ответ выбранной модели',
        completed_stages: ['chat'], ...fields });
    } };
}

test('ordinary chat is the default, persists its model, continues and restores history', async ({ page }) => {
  const fixture = await setup(page);
  const model = page.getByRole('combobox', { name: 'Модель чата', exact: true });
  const input = page.getByRole('textbox', { name: 'Ваш вопрос' });
  await expect(model).toHaveValue('test/a');
  await expect(page.getByRole('button', { name: 'Совет', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const modelBox = await model.boundingBox(), inputBox = await input.boundingBox();
  expect(modelBox.y).toBeLessThan(inputBox.y);
  await model.selectOption('test/b');
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue('test/b');
  expect(fixture.saved).toEqual([{ chat_model: 'test/b' }]);
  await input.fill('Меня зовут Алексей');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.getByText('Модель готовит ответ…', { exact: true })).toBeVisible();
  expect(fixture.sent[0]).toMatchObject({ council_enabled: false, search_enabled: false, chat_model: 'test/b' });
  await expect(model).toBeDisabled();
  fixture.complete();
  await expect(page.getByText('Ответ выбранной модели', { exact: true })).toBeVisible();
  await expect(page.getByText('Этап 1: Ответы', { exact: true })).toHaveCount(0);
  await expect(input).toBeEnabled();
  await input.fill('Как меня зовут?');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect.poll(() => fixture.sent.length).toBe(2);
  fixture.complete({ content: 'Вас зовут Алексей.' });
  await expect(page.getByText('Вас зовут Алексей.', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByText('Проверка чата', { exact: true }).click();
  await expect(model).toHaveValue('test/b');
  await expect(page.getByText('Меня зовут Алексей', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/chat-dialog.png' });
  await page.getByRole('button', { name: '+ Новый диалог', exact: true }).click();
  await expect(model).toHaveValue('test/b');
});

test('council dropdown saves participants and a separate chairman, with independent toggles', async ({ page }) => {
  const fixture = await setup(page);
  const council = page.getByRole('button', { name: 'Совет', exact: true });
  const search = page.getByRole('button', { name: 'Поиск', exact: true });
  const councilBox = await council.boundingBox(), searchBox = await search.boundingBox();
  expect(councilBox.x).toBeGreaterThan(searchBox.x + searchBox.width);
  expect(councilBox.x - searchBox.x - searchBox.width).toBeLessThanOrEqual(12);
  expect(councilBox.y).toBe(searchBox.y);
  await council.click();
  await expect(page.getByRole('combobox', { name: 'Модель чата', exact: true })).toHaveCount(0);
  const members = page.getByRole('button', { name: 'Участники: 2' });
  await members.click();
  await page.getByRole('checkbox', { name: 'test/b', exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Участники: 1' })).toBeEnabled();
  await expect(page.getByRole('checkbox', { name: 'test/a', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'test/chair', exact: true }).check();
  await expect(members).toBeEnabled();
  await page.keyboard.press('Escape');
  const chairman = page.getByRole('combobox', { name: 'Председатель совета', exact: true });
  await chairman.selectOption('test/b');
  await expect(chairman).toBeEnabled();
  expect(fixture.saved.at(-1)).toEqual({ chairman_model: 'test/b' });
  await search.click();
  await expect(council).toHaveAttribute('aria-pressed', 'true');
  await expect(search).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('textbox', { name: 'Ваш вопрос' }).fill('Вопрос совету');
  await members.click();
  await page.screenshot({ path: 'test-results/council-model-picker.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect.poll(() => fixture.sent.length).toBe(1);
  expect(fixture.sent[0]).toMatchObject({ council_enabled: true, search_enabled: true,
    council_models: ['test/a', 'test/chair'], chairman_model: 'test/b' });
  fixture.complete({ content: null, completed_stages: ['stage1', 'stage2', 'stage3'],
    stage3: { model: 'test/b', response: 'Итог совета' } });
  await expect(page.getByText('Итог совета', { exact: true })).toBeVisible();
  await council.click();
  await expect(search).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('textbox', { name: 'Ваш вопрос' }).fill('Уточнение с поиском');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect.poll(() => fixture.sent.length).toBe(2);
  expect(fixture.sent[1]).toMatchObject({ council_enabled: false, search_enabled: true, chat_model: 'test/a' });
  fixture.complete();
  await expect(page.getByText('Ответ выбранной модели', { exact: true })).toBeVisible();
});

test('failed model save preserves selection and composer text', async ({ page }) => {
  const fixture = await setup(page);
  const model = page.getByRole('combobox', { name: 'Модель чата', exact: true });
  const input = page.getByRole('textbox', { name: 'Ваш вопрос' });
  await input.fill('Не потерять черновик');
  fixture.failSave(true);
  await model.selectOption('test/b');
  await expect(page.getByRole('alert')).toContainText('Не удалось сохранить модель');
  await expect(model).toHaveValue('test/a');
  await expect(input).toHaveValue('Не потерять черновик');
  fixture.failSave(false);
  await model.selectOption('test/b');
  await expect(model).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(model).toHaveValue('test/b');
});

test('retry after a provider error waits for model selection and sends the newly selected model', async ({ page }) => {
  const fixture = await setup(page);
  const model = page.getByRole('combobox', { name: 'Модель чата', exact: true });
  await page.getByRole('textbox', { name: 'Ваш вопрос' }).fill('Исходный вопрос');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect.poll(() => fixture.sent.length).toBe(1);
  fixture.complete({ status: 'error', content: null, error: 'HTTP 503: ошибка провайдера',
    failed_stage: 'chat', completed_stages: [] });
  const retry = page.getByRole('button', { name: 'Повторить', exact: true });
  await expect(retry).toBeEnabled();
  fixture.holdSave();
  await model.selectOption('test/b');
  await expect(retry).toBeDisabled();
  expect(fixture.retries).toHaveLength(0);
  fixture.releaseSave();
  await retry.click();
  await expect.poll(() => fixture.retries).toEqual([{ chat_model: 'test/b' }]);
  await expect(model).toBeDisabled();
  fixture.complete({ content: 'Ответ новой модели' });
  await expect(page.getByText('Ответ новой модели', { exact: true })).toBeVisible();
  await expect(page.getByText('Исходный вопрос', { exact: true })).toHaveCount(1);
  await expect(page.locator('.assistant-message .message-label')).toHaveText('test/b');
  expect(fixture.sent).toHaveLength(1);
});

test('stop, edit and resend preserves attachments; Shift+Enter inserts a newline and Enter submits', async ({ page }) => {
  const fixture = await setup(page);
  const input = page.getByRole('textbox', { name: 'Ваш вопрос' });
  await input.fill('Ошибочный запрос');
  await input.press('Shift+Enter');
  await input.pressSequentially('Вторая строка');
  await expect(input).toHaveValue('Ошибочный запрос\nВторая строка');
  expect(fixture.sent).toHaveLength(0);
  await page.locator('input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Содержимое вложения') });
  await input.press('Enter');
  await expect.poll(() => fixture.sent.length).toBe(1);
  const original = fixture.sent[0].content;
  const message = page.locator('.user-message');
  const edit = message.getByRole('button', { name: 'Редактировать запрос' });
  await expect(edit).toBeDisabled();
  await page.getByRole('button', { name: 'Остановить', exact: true }).click();
  await expect(edit).toBeEnabled();
  await input.focus();
  await input.hover();
  await expect(edit).toHaveCSS('opacity', '0');
  await message.hover();
  await expect(edit).toHaveCSS('opacity', '1');
  await edit.click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Ошибочный запрос\nВторая строка');
  await expect(page.locator('.attachments-bar')).toContainText('notes.txt');
  await expect(page.getByRole('button', { name: 'Повторить', exact: true })).toBeDisabled();
  await input.fill('Исправленный запрос');
  await input.press('Shift+Enter');
  await input.pressSequentially('Уточнение');
  await expect(input).toHaveValue('Исправленный запрос\nУточнение');
  expect(fixture.edits).toHaveLength(0);
  await page.screenshot({ path: 'test-results/edit-prompt.png' });
  await input.press('Enter');
  await expect.poll(() => fixture.edits.length).toBe(1);
  expect(fixture.edits[0]).toMatchObject({ index: 0, original_content: original, expected_message_count: 2 });
  expect(fixture.edits[0].content).toContain('Исправленный запрос\nУточнение');
  expect(fixture.edits[0].content).toContain('Содержимое вложения');
  fixture.complete({ content: 'Ответ на исправленный запрос' });
  await expect(page.getByText('Ответ на исправленный запрос', { exact: true })).toBeVisible();
  await expect(message).toHaveCount(1);
  await expect(message).not.toContainText('Ошибочный запрос');
  await page.reload();
  await page.getByText('Проверка чата', { exact: true }).click();
  await expect(message).toContainText('Исправленный запрос');
  await message.getByRole('button', { name: 'Открыть файл notes.txt', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Просмотр файла notes.txt' })).toContainText('Содержимое вложения');
});

test('cancelling edits restores the draft and failed edits preserve text and history for another attempt', async ({ page }) => {
  const fixture = await setup(page);
  const input = page.getByRole('textbox', { name: 'Ваш вопрос' });
  for (const question of ['Первый вопрос', 'Второй вопрос']) {
    await input.fill(question);
    await input.press('Enter');
    await expect(input).toBeDisabled();
    fixture.complete({ content: `Ответ: ${question}` });
    await expect(input).toBeEnabled();
  }
  await input.fill('Сохранённый черновик');
  await page.locator('input[type="file"]').setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Черновик файла') });
  const messages = page.locator('.user-message');
  await messages.first().hover();
  const edit = messages.first().getByRole('button', { name: 'Редактировать запрос' });
  await edit.click();
  await expect(page.locator('.composer-edit-banner')).toContainText('все сообщения после него будут заменены');
  await input.fill('Не сохранять');
  await page.getByRole('button', { name: 'Отменить редактирование' }).click();
  await expect(input).toHaveValue('Сохранённый черновик');
  await expect(page.locator('.attachments-bar')).toContainText('draft.txt');
  await expect(messages).toHaveCount(2);
  expect(fixture.edits).toHaveLength(0);

  await messages.first().hover();
  await edit.click();
  await input.fill('Новый первый вопрос');
  fixture.failEdit(true);
  await page.getByRole('button', { name: 'Сохранить и отправить' }).click();
  await expect(page.getByRole('alert')).toContainText('Не удалось сохранить запрос');
  await expect(messages).toHaveCount(2);
  await expect(messages.first()).toContainText('Первый вопрос');
  await expect(input).toHaveValue('Новый первый вопрос');
  fixture.failEdit(false);
  await page.getByRole('button', { name: 'Сохранить и отправить' }).click();
  await expect.poll(() => fixture.edits.length).toBe(1);
  fixture.complete({ content: 'Новый ответ' });
  await expect(page.getByText('Новый ответ', { exact: true })).toBeVisible();
  await expect(messages).toHaveCount(1);
  await expect(messages).toContainText('Новый первый вопрос');
  await expect(page.getByText('Второй вопрос', { exact: true })).toHaveCount(0);
  await expect(input).toHaveValue('Сохранённый черновик');
  await expect(page.locator('.attachments-bar')).toContainText('draft.txt');
});
