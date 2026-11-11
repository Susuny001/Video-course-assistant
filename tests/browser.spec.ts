import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fixtureDir: string;
let audioPath: string;
let markdownPath: string;
const pageErrors = new WeakMap<Page, string[]>();

test.beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'course-e2e-input-'));
  audioPath = join(fixtureDir, '课堂录音.wav');
  markdownPath = join(fixtureDir, '课堂原稿.md');
  await writeFile(markdownPath, '# 课堂原稿\n\n## 课程通知\n期末考试开卷，可以带一本教材。\n本次作业是习题3-1到3-7，下节课讲标准件。\n\n## 剖视图\n剖视图是假想把机件剖开，表达内部孔槽结构。\n断面图只画切断面，不包括切面后面的结构。\n');
  execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ac', '1', '-ar', '16000', audioPath]);
});
test.afterAll(async () => { await rm(fixtureDir, { recursive: true, force: true }); });
test.beforeEach(async ({ page, request }) => {
  // This API belongs to the isolated test server, never the user's running application.
  await request.put('/api/settings', { data: { baseUrl: '', model: '', apiKey: '' } });
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.course-heading h1')).toBeVisible();
});
test.afterEach(async ({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

async function importCourse(page: Page, title: string, paths: string[]) {
  await page.getByRole('button', { name: '导入一堂新课', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入课程资料' });
  await dialog.getByRole('button', { name: '创建新课程', exact: true }).click();
  await dialog.getByLabel('课程名称').fill(title);
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: '点击选择，或把文件拖到这里', exact: false }).click();
  await (await chooser).setFiles(paths);
  await dialog.getByRole('button', { name: '导入，开始学习', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.course-heading h1')).toHaveText(title);
}

test('imports a transcript, extracts editable keywords, scopes local cited Q&A and downloads subtitles', async ({ page }) => {
  await page.getByRole('button', { name: '我的重点', exact: true }).click();
  await expect(page.getByLabel('我想重点关注')).toHaveValue(/作业.*大作业.*期末.*开卷.*下节课.*提醒/);
  await page.getByRole('button', { name: '课程大纲', exact: true }).click();
  await importCourse(page, '浏览器验证 · 计算机绘图', [markdownPath]);
  await expect(page.locator('.chapter-title')).toHaveCount(2);
  await page.locator('.source-documents button').click();
  await expect(page.getByRole('dialog', {name:'原始资料',exact:true})).toContainText('断面图只画切断面');
  await page.getByRole('button',{name:'关闭原始资料',exact:true}).click();
  await expect(page.locator('.course-heading')).toContainText('时间为文字估算');
  await page.getByRole('button', { name: '我的重点', exact: true }).click();
  await page.getByLabel('我想重点关注').fill('开卷');
  const extraction = page.waitForResponse(response => response.url().includes('/highlights?keywords=') && response.request().method() === 'GET');
  await page.getByRole('button', { name: '提取我的重点', exact: true }).click();
  await extraction;
  await expect(page.locator('.highlight-card')).toHaveCount(1);
  await expect(page.locator('.highlight-card')).toContainText('可以带一本教材');
  await page.getByRole('button', { name: '用这段问 AI', exact: true }).click();
  await expect(page.locator('.context-range')).toContainText('选段');
  await page.getByRole('textbox', { name: '向课堂助手提问' }).fill('开卷考试能带什么？');
  const answerPromise = page.waitForResponse(response => response.url().endsWith('/chat') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  const answer = await (await answerPromise).json();
  expect(answer.mode).toBe('local');
  expect(answer.sources).toHaveLength(1);
  expect(answer.sources[0].excerpt).toContain('可以带一本教材');
  await expect(page.locator('.message.assistant')).toContainText('本地检索');
  await expect(page.locator('.source-chips button')).toHaveCount(1);
  await page.locator('.source-chips button').click();
  await page.getByRole('button', { name: '导出笔记', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: /字幕文件/ }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  const srt = await readFile(path!, 'utf8');
  expect(srt).toMatch(/00:00:00,000 --> \d{2}:\d{2}:\d{2},\d{3}/);
  expect(srt).toContain('期末考试开卷，可以带一本教材。');
});

test('plays an imported real audio file, seeks, changes speed and keeps exact SRT timing', async ({ page }) => {
  const subtitlePath = join(fixtureDir, '课堂字幕.srt');
  await writeFile(subtitlePath, '1\n00:00:00,000 --> 00:00:03,000\n第一段讲解剖视图。\n\n2\n00:00:03,000 --> 00:00:08,000\n第二段布置作业。\n');
  await importCourse(page, '浏览器验证 · 音频与字幕', [audioPath, subtitlePath]);
  await expect(page.locator('.course-heading')).toContainText('含真实时间戳');
  await expect(page.locator('.cue-row')).toHaveCount(2);
  const audio = page.locator('audio');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThan(0);
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.duration)).toBeCloseTo(8, 0);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0.1);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.locator('.cue-text').nth(1).click();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThanOrEqual(3);
  await page.getByRole('combobox', { name: '播放倍速' }).selectOption('1.5');
  expect(await audio.evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(1.5);
  await page.getByRole('checkbox', { name: '选择字幕 00:00', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择字幕 00:03', exact: true }).check();
  await expect(page.locator('.selection-bar')).toContainText('00:00 — 00:08');
  await page.getByLabel('选段开始时间', {exact:true}).fill('00:01');
  await page.getByLabel('选段结束时间', {exact:true}).fill('00:06');
  await page.getByRole('button', { name: '定位选段', exact: true }).click();
  await expect(page.locator('.selection-bar')).toContainText('00:01 — 00:06');
  await page.getByRole('button', { name: '循环选段', exact: true }).click();
  await expect(page.getByRole('button', { name: '循环选段', exact: true })).toHaveClass(/selected/);
});

test('saves provider preferences while keeping the API key out of GET responses and browser storage', async ({ page, request }) => {
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '模型与偏好设置' });
  await dialog.getByRole('button', { name: 'OpenAI', exact: true }).click();
  const marker = 'e2e-key-not-a-real-credential';
  await dialog.locator('input[type="password"]').fill(marker);
  await dialog.getByLabel('翻译目标语言').fill('英语');
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(dialog).toBeHidden();
  const response = await request.get('/api/settings');
  const settings = await response.json();
  expect(settings.hasApiKey).toBe(true);
  expect(settings.apiKey).toBeUndefined();
  expect(await response.text()).not.toContain(marker);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(marker);
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  await expect(page.locator('input[type="password"]')).toHaveValue('');
  await request.put('/api/settings', { data: { baseUrl: '', model: '', apiKey: '' } });
});

test('mobile workspace keeps content within the viewport and can navigate library, focus and import', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '打开资料库', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开资料库', exact: true }).click();
  await expect(page.getByRole('button', { name: '导入一堂新课', exact: true })).toBeVisible();
  await page.locator('.sidebar-scrim').click({ position: { x: 330, y: 90 } });
  await page.getByRole('button', { name: '我的重点', exact: true }).click();
  await expect(page.getByLabel('我想重点关注')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: '补充资料', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '导入课程资料' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath('course-mobile-import.png'), fullPage: false });
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({ path: test.info().outputPath('course-mobile.png'), fullPage: true });
});
