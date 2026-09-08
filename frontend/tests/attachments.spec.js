import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';

async function setup(page, messages = []) {
  const conversation = { id: 'attachment-test', title: 'Файлы в чате', created_at: '2026-09-08T00:00:00Z', messages };
  const other = { id: 'other-test', title: 'Другой диалог', created_at: '2026-09-07T00:00:00Z', messages: [] };
  const sent = [];
  await page.addInitScript(() => localStorage.setItem('llmcouncil_token', 'synthetic-ui-test-token'));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (json) => route.fulfill({ json });
    if (path === '/api/auth/me') return respond({ id: 'ui-test', username: 'Тест', role: 'user' });
    if (path === '/api/settings') return respond({ available_models: ['test/a'], chat_model: 'test/a',
      council_models: ['test/a'], chairman_model: 'test/a', custom_models: [] });
    if (path === '/api/conversations') return respond([conversation, other].map((item) => ({
      ...item, message_count: item.messages.length, is_running: false,
    })));
    if (path === '/api/conversations/attachment-test/message') {
      const body = request.postDataJSON();
      sent.push(body);
      // The backend persists content only, without the optimistic UI's metadata.
      conversation.messages.push({ role: 'user', content: body.content }, { role: 'assistant', mode: 'chat',
        model: 'test/a', status: 'complete', content: 'Ответ модели.\n\n'.repeat(100), completed_stages: ['chat'] });
      return respond({ status: 'started' });
    }
    if (path === '/api/conversations/attachment-test') return respond(conversation);
    if (path === '/api/conversations/other-test') return respond(other);
    return route.fulfill({ status: 404, json: { detail: 'Unexpected request' } });
  });
  await page.goto('/');
  await page.getByText('Файлы в чате', { exact: true }).click();
  return { sent };
}

test('sent files stay collapsed after reload and open alongside the chat with independent scrolling', async ({ page }) => {
  const { sent } = await setup(page);
  const markdown = '# Отчёт проекта\n\n| Задача | Статус |\n| --- | --- |\n| Просмотрщик | Готов |\n\n'
    + '~~~~text\nВложенный блок кода\n~~~~\n\n'
    + 'Подробности документа.\n\n'.repeat(100);
  const plain = '  Первая строка\r\n\t<config>**Без разметки**</config>\r\n\r\n';
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'report.md', mimeType: 'text/markdown', buffer: Buffer.from(markdown) },
    { name: 'config.txt', mimeType: 'text/plain', buffer: Buffer.from(plain) },
  ]);
  const preview = page.getByRole('complementary', { name: /Просмотр файла/ });
  await expect(preview).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Ваш вопрос' }).fill('Проверь вложенные файлы');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  const message = page.locator('.user-message');
  const report = message.getByRole('button', { name: 'Открыть файл report.md', exact: true });
  await expect(report).toBeVisible();
  await expect(message).toContainText('Проверь вложенные файлы');
  await expect(message).not.toContainText('Отчёт проекта');
  await expect(preview).toHaveCount(0);
  expect(sent[0].content).toContain(markdown);
  expect(sent[0].content).toContain(plain);

  await page.reload();
  await page.getByText('Файлы в чате', { exact: true }).click();
  await expect(report).toHaveAttribute('aria-expanded', 'false');
  await expect(preview).toHaveCount(0);
  await report.click();
  await expect(preview.getByRole('heading', { name: 'Отчёт проекта' })).toBeVisible();
  await expect(preview.getByRole('table')).toBeVisible();
  await expect(preview.locator('pre')).toHaveText('Вложенный блок кода\n');
  await expect(report).toHaveAttribute('aria-expanded', 'true');
  const chatBox = await page.locator('.chat-interface').boundingBox();
  const previewBox = await preview.boundingBox();
  expect(previewBox.x).toBeCloseTo(chatBox.x + chatBox.width, 0);
  expect(previewBox.height).toBe(chatBox.height);
  await expect(preview).toHaveCSS('border-left-width', '1px');
  await page.screenshot({ path: 'test-results/attachment-preview.png' });

  const messages = page.locator('.messages-container');
  const body = preview.getByRole('region', { name: 'Содержимое файла' });
  // Stabilize the chat after its existing smooth initial scroll.
  await messages.evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }));
  await body.hover();
  await page.mouse.wheel(0, 650);
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => messages.evaluate((element) => element.scrollTop)).toBe(0);
  await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.mouse.wheel(0, 650);
  await expect.poll(() => messages.evaluate((element) => element.scrollTop)).toBe(0);
  const previewScroll = await body.evaluate((element) => element.scrollTop);
  await messages.hover();
  await page.mouse.wheel(0, 450);
  await expect.poll(() => messages.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await body.evaluate((element) => element.scrollTop)).toBe(previewScroll);

  const config = message.getByRole('button', { name: 'Открыть файл config.txt', exact: true });
  await config.click();
  await expect(preview.locator('.attachment-preview-text')).toHaveText(plain);
  expect(await preview.locator('.attachment-preview-text').textContent()).toBe(plain);
  expect(await body.evaluate((element) => element.scrollTop)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(config).toBeFocused();
  expect((await page.locator('.chat-interface').boundingBox()).width).toBeGreaterThan(chatBox.width);
  await report.click();
  await preview.getByRole('button', { name: 'Закрыть просмотр файла' }).click();
  await expect(preview).toHaveCount(0);
  await expect(report).toBeFocused();
});

test('legacy attachments, duplicate names, empty files and ordinary message code remain readable', async ({ page }) => {
  await setup(page, [
    { role: 'user', content: 'Старый запрос\n\n---\n\n**Прикреплённые файлы:**\n\n'
      + '**📎 report.md** (20 B):\n\n~~~~text\n# Первый отчёт\n~~~~\n\n'
      + '**📎 report.md** (20 B):\n\n~~~~text\n# Второй отчёт\n~~~~\n\n'
      + '**📎 empty.txt** (0 B):\n\n~~~~text\n\n~~~~\n\n'
      + '**📎 pasted-2.txt** (20 B):\n\n~~~~text\n## Вставленный текст\n~~~~' },
    { role: 'user', content: 'Пример кода:\n\n```markdown\n# Обычный код\n```\n\n---\n\n**Прикреплённые файлы:**\n\nНезавершённый пример' },
  ]);
  const preview = page.getByRole('complementary', { name: /Просмотр файла/ });
  const reports = page.getByRole('button', { name: 'Открыть файл report.md', exact: true });
  await expect(reports).toHaveCount(2);
  await expect(page.locator('.user-message')).not.toContainText(['Первый отчёт', 'Второй отчёт']);
  await reports.nth(0).click();
  await expect(preview.getByRole('heading', { name: 'Первый отчёт' })).toBeVisible();
  await reports.nth(1).click();
  await expect(preview.getByRole('heading', { name: 'Второй отчёт' })).toBeVisible();
  await page.getByRole('button', { name: 'Открыть файл empty.txt', exact: true }).click();
  await expect(preview).toContainText('Файл пуст');
  await page.getByRole('button', { name: 'Открыть файл pasted-2.txt', exact: true }).click();
  await expect(preview.getByRole('heading', { name: 'Вставленный текст' })).toBeVisible();
  await expect(page.locator('.user-message').last().locator('pre')).toHaveText('# Обычный код\n');
  await expect(page.locator('.user-message').last()).toContainText('Незавершённый пример');
  await page.getByText('Другой диалог', { exact: true }).click();
  await expect(preview).toHaveCount(0);
  await page.getByText('Файлы в чате', { exact: true }).click();
  await expect(preview).toHaveCount(0);
});

test('draft and pasted files preview on click, close on removal and fit a narrow screen', async ({ page }) => {
  await setup(page);
  await page.locator('input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Черновик файла') });
  const preview = page.getByRole('complementary', { name: /Просмотр файла/ });
  await page.getByRole('button', { name: 'Открыть файл notes.txt', exact: true }).click();
  await expect(preview).toContainText('Черновик файла');
  await page.getByRole('button', { name: 'Убрать файл notes.txt', exact: true }).click();
  await expect(preview).toHaveCount(0);
  const text = '# Длинная вставка\n\n' + 'Текст документа.\n\n'.repeat(150);
  await page.getByRole('textbox', { name: 'Ваш вопрос' }).evaluate((element, content) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', content);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
  await expect(preview).toHaveCount(0);
  await page.getByRole('button', { name: 'Открыть файл pasted.txt', exact: true }).click();
  await expect(preview.getByRole('heading', { name: 'Длинная вставка' })).toBeVisible();
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(preview).toHaveCount(0);
  const file = page.locator('.user-message').getByRole('button', { name: 'Открыть файл pasted.txt', exact: true });
  await file.click();
  await page.setViewportSize({ width: 600, height: 800 });
  const box = await preview.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(600);
  expect(box.height).toBe(800);
  await expect(preview.getByRole('button', { name: 'Закрыть просмотр файла' })).toBeInViewport();
  await preview.getByRole('button', { name: 'Закрыть просмотр файла' }).click();
  await expect(preview).toHaveCount(0);
});

test('preview divider resizes with the pointer and keyboard, preserves width and respects the available space', async ({ page }) => {
  await setup(page, [{ role: 'user', content: '---\n\n**Прикреплённые файлы:**\n\n'
    + '**📎 first.txt** (6 B):\n\n~~~~text\nПервый\n~~~~\n\n'
    + '**📎 second.txt** (6 B):\n\n~~~~text\nВторой\n~~~~' }]);
  const first = page.getByRole('button', { name: 'Открыть файл first.txt', exact: true });
  const second = page.getByRole('button', { name: 'Открыть файл second.txt', exact: true });
  const preview = page.getByRole('complementary', { name: /Просмотр файла/ });
  const divider = page.getByRole('separator', { name: 'Ширина просмотрщика файла' });
  const previewWidth = async () => (await preview.boundingBox()).width;
  await first.click();
  const initial = await previewWidth();
  const handle = await divider.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  // Keep dragging after the pointer leaves the original divider hit area.
  await page.mouse.move(handle.x - 114, handle.y + handle.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(previewWidth).toBeCloseTo(initial + 120, 0);
  const resized = await previewWidth();
  await expect(preview).not.toHaveClass(/attachment-preview-resizing/);
  await second.click();
  await expect.poll(previewWidth).toBe(resized);
  await page.keyboard.press('Escape');
  await first.click();
  await expect.poll(previewWidth).toBe(resized);
  await page.reload();
  await page.getByText('Файлы в чате', { exact: true }).click();
  await first.click();
  await expect.poll(previewWidth).toBe(resized);

  await divider.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(previewWidth).toBe(resized - 24);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(previewWidth).toBe(resized);
  await page.keyboard.press('End');
  await expect.poll(async () => (await page.locator('.chat-interface').boundingBox()).width).toBe(360);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await page.locator('.chat-interface').boundingBox()).width).toBe(360);
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect.poll(async () => (await page.locator('.chat-interface').boundingBox()).width).toBe(360);
  await expect(preview.getByRole('button', { name: 'Закрыть просмотр файла' })).toBeInViewport();
  await page.keyboard.press('Home');
  await expect.poll(previewWidth).toBe(320);
  await page.keyboard.press('ArrowRight');
  await expect.poll(previewWidth).toBe(320);

  await page.setViewportSize({ width: 1280, height: 900 });
  await divider.dblclick();
  await expect.poll(previewWidth).toBeCloseTo(initial, 0);
  await second.click();
  await expect.poll(previewWidth).toBeCloseTo(initial, 0);
});
