/**
 * @fileoverview Консольная утилита для измерения скорости скачивания по заданному URL.
 * Стек: Node.js (ES Modules), без сторонних зависимостей.
 */

import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Конфигурация по умолчанию */
const CONFIG = {
  /** Надежный тестовый URL с нагрузкой 10 МБ (Cloudflare Anycast CDN) */
  DEFAULT_URL: 'https://speed.cloudflare.com/__down?bytes=10000000',
  /** Количество последовательных запросов */
  TOTAL_REQUESTS: 10,
  /** Таймаут на каждый запрос в миллисекундах */
  TIMEOUT_MS: 15_000,
  /** Байт в одном двоичном мегабайте (MiB) */
  BYTES_PER_MIB: 1024 * 1024,
  /** Бит в одном десятичном мегабите (Mbit) */
  BITS_PER_MBIT: 1_000_000,
};

/**
 * Валидирует и нормализует переданную строку в объект URL.
 *
 * @param {string} rawUrl - Строка с URL для проверки.
 * @returns {URL} Валидный объект URL.
 * @throws {Error} Если строка не является валидным HTTP(S) URL.
 */
export function validateUrl(rawUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl.trim());
  } catch {
    throw new Error(`Некорректный формат URL: "${rawUrl}". Убедитесь, что указали протокол (например, https://).`);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`Неподдерживаемый протокол "${parsedUrl.protocol}". Поддерживаются только http: и https:.`);
  }

  return parsedUrl;
}

/**
 * Определяет целевой URL: из аргументов командной строки или через интерактивный ввод.
 *
 * @param {string | undefined} cliArg - Аргумент командной строки (при наличии).
 * @returns {Promise<URL>} Целевой валидированный URL.
 */
export async function resolveTargetUrl(cliArg) {
  if (cliArg && cliArg.trim().length > 0) {
    return validateUrl(cliArg);
  }

  console.log('Целевой URL не передан в аргументах командной строки.');
  console.log(`URL по умолчанию: ${CONFIG.DEFAULT_URL}\n`);

  const rl = createInterface({ input, output });

  try {
    const answer = await rl.question('Введите URL для теста (или нажмите Enter для значения по умолчанию):\n> ');
    const selectedUrl = answer.trim() || CONFIG.DEFAULT_URL;
    return validateUrl(selectedUrl);
  } finally {
    rl.close();
  }
}

/**
 * Формирует URL для выполнения запроса, добавляя уникальный параметр для предотвращения кэширования.
 *
 * @param {URL} baseUrl - Исходный URL.
 * @param {number} attemptIndex - Порядковый номер попытки.
 * @returns {string} Итоговый URL со строкой запроса против кэширования.
 */
export function prepareRequestUrl(baseUrl, attemptIndex) {
  const requestUrl = new URL(baseUrl.href);
  requestUrl.searchParams.set('_speedtest_cb', `${Date.now()}_${attemptIndex}`);
  return requestUrl.href;
}

/**
 * @typedef {Object} DownloadResult
 * @property {number} bytes - Фактический размер скачанных данных в байтах.
 * @property {number} durationMs - Точное время скачивания в миллисекундах.
 */

/**
 * Выполняет один одиночный HTTP-запрос на скачивание с замером времени и размера.
 *
 * @param {URL} targetUrl - Базовый URL для запроса.
 * @param {number} attemptIndex - Номер текущей попытки (1-based).
 * @param {number} timeoutMs - Лимит времени ожидания в мс.
 * @returns {Promise<DownloadResult>} Результат одного замера.
 */
export async function performDownload(targetUrl, attemptIndex, timeoutMs = CONFIG.TIMEOUT_MS) {
  const requestUrl = prepareRequestUrl(targetUrl, attemptIndex);
  const signal = AbortSignal.timeout(timeoutMs);

  const startTime = performance.now();

  let response;
  try {
    response = await fetch(requestUrl, {
      signal,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (error) {
    if (error.name === 'TimeoutError') {
      throw new Error(`Превышено максимальное время ожидания ответа (${timeoutMs / 1000} с) для запроса #${attemptIndex}.`);
    }
    throw new Error(`Сетевая ошибка при запросе #${attemptIndex}: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(`Сервер вернул ошибку HTTP ${response.status} (${response.statusText || 'Unknown'}) на шаге [${attemptIndex}].`);
  }

  // Полное считывание тела ответа для точного измерения времени и размера полезной нагрузки
  const buffer = await response.arrayBuffer();
  const endTime = performance.now();

  const durationMs = endTime - startTime;
  const bytes = buffer.byteLength;

  if (bytes === 0) {
    throw new Error(`Запрос #${attemptIndex} вернул пустое тело ответа (0 байт). Невозможно рассчитать скорость.`);
  }

  return { bytes, durationMs };
}

/**
 * @typedef {Object} SpeedMetrics
 * @property {number} totalBytes - Общий объем скачанных данных в байтах.
 * @property {number} totalMB - Общий объем в двоичных мегабайтах (1 МБ = 1024 * 1024 байт).
 * @property {number} totalDurationSec - Суммарное чистое время скачивания всех запросов в секундах.
 * @property {number} avgDurationMs - Среднее время одного запроса в миллисекундах.
 * @property {number} speedMbps - Итоговая средняя скорость в мегабитах в секунду (Мбит/с, 1 Мбит = 10^6 бит).
 * @property {number} speedMBs - Итоговая средняя скорость в мегабайтах в секунду (МБ/с, 1 МБ = 1024 * 1024 байт).
 * @property {number} minSpeedMbps - Минимальная скорость среди одиночных запросов.
 * @property {number} maxSpeedMbps - Максимальная скорость среди одиночных запросов.
 */

/**
 * Рассчитывает итоговые метрики на основе серии замеров.
 *
 * @param {DownloadResult[]} results - Массив результатов всех успешных замеров.
 * @returns {SpeedMetrics} Рассчитанные агрегированные метрики.
 */
export function calculateMetrics(results) {
  const totalBytes = results.reduce((acc, curr) => acc + curr.bytes, 0);
  const totalDurationMs = results.reduce((acc, curr) => acc + curr.durationMs, 0);
  const totalDurationSec = totalDurationMs / 1000;
  const avgDurationMs = totalDurationMs / results.length;

  const totalMB = totalBytes / CONFIG.BYTES_PER_MIB;
  const speedMBs = totalDurationSec > 0 ? totalMB / totalDurationSec : 0;

  const totalBits = totalBytes * 8;
  const speedMbps = totalDurationSec > 0 ? (totalBits / CONFIG.BITS_PER_MBIT) / totalDurationSec : 0;

  const singleSpeedsMbps = results.map((r) => {
    const sec = r.durationMs / 1000;
    return sec > 0 ? (r.bytes * 8 / CONFIG.BITS_PER_MBIT) / sec : 0;
  });

  const minSpeedMbps = Math.min(...singleSpeedsMbps);
  const maxSpeedMbps = Math.max(...singleSpeedsMbps);

  return {
    totalBytes,
    totalMB,
    totalDurationSec,
    avgDurationMs,
    speedMbps,
    speedMBs,
    minSpeedMbps,
    maxSpeedMbps,
  };
}

/**
 * Выводит прогресс одиночного запроса в консоль.
 *
 * @param {number} attempt - Текущий номер запроса.
 * @param {number} total - Общее количество запросов.
 * @param {number} bytes - Объем в байтах.
 * @param {number} durationMs - Время выполнения в миллисекундах.
 */
export function displayProgress(attempt, total, bytes, durationMs) {
  const mb = (bytes / CONFIG.BYTES_PER_MIB).toFixed(2);
  const durationSec = durationMs / 1000;
  const mbps = durationSec > 0 ? ((bytes * 8 / CONFIG.BITS_PER_MBIT) / durationSec).toFixed(2) : '0.00';
  const paddedIndex = `[${attempt}/${total}]`.padEnd(8, ' ');
  const paddedSize = `${mb} MB`.padStart(9, ' ');
  const paddedTime = `${durationMs.toFixed(0)} ms`.padStart(9, ' ');
  const paddedSpeed = `${mbps} Mbps`.padStart(12, ' ');

  console.log(`${paddedIndex} ${paddedSize}   ${paddedTime}   (${paddedSpeed})`);
}

/**
 * Выводит итоговую сводку результатов тестирования в консоль.
 *
 * @param {SpeedMetrics} metrics - Итоговые показатели.
 * @param {URL} targetUrl - Протестированный URL.
 */
export function displaySummary(metrics, targetUrl) {
  const line = '─'.repeat(60);

  console.log(`\n${line}`);
  console.log('               ИТОГОВЫЕ РЕЗУЛЬТАТЫ ЗАМЕРА');
  console.log(line);
  console.log(` Целевой URL:              ${targetUrl.origin}${targetUrl.pathname}`);
  console.log(` Успешных запросов:        ${CONFIG.TOTAL_REQUESTS} из ${CONFIG.TOTAL_REQUESTS}`);
  console.log(` Скачано данных:           ${metrics.totalMB.toFixed(2)} МБ (${metrics.totalBytes.toLocaleString('ru-RU')} байт)`);
  console.log(` Чистое время скачивания:  ${metrics.totalDurationSec.toFixed(2)} сек`);
  console.log(` Среднее время запроса:    ${metrics.avgDurationMs.toFixed(1)} мс`);
  console.log(line);
  console.log(` Итоговая средняя скорость:`);
  console.log(`  ▶  ${metrics.speedMbps.toFixed(2)} Мбит/с (Mbps)`);
  console.log(`  ▶  ${metrics.speedMBs.toFixed(2)} МБ/с (MB/s)`);
  console.log(line);
  console.log(` Диапазон скорости:        ${metrics.minSpeedMbps.toFixed(2)} — ${metrics.maxSpeedMbps.toFixed(2)} Мбит/с`);
  console.log(`${line}\n`);
}

/**
 * Точка входа в программу.
 */
export async function main() {
  try {
    const rawArg = process.argv[2];
    const targetUrl = await resolveTargetUrl(rawArg);

    console.log(`\nЗапуск тестирования скорости:`);
    console.log(`  URL: ${targetUrl.href}`);
    console.log(`  Серия: ${CONFIG.TOTAL_REQUESTS} последовательных запросов`);
    console.log(`  Таймаут одного запроса: ${CONFIG.TIMEOUT_MS / 1000} сек\n`);

    /** @type {DownloadResult[]} */
    const results = [];

    for (let i = 1; i <= CONFIG.TOTAL_REQUESTS; i++) {
      const result = await performDownload(targetUrl, i, CONFIG.TIMEOUT_MS);
      results.push(result);
      displayProgress(i, CONFIG.TOTAL_REQUESTS, result.bytes, result.durationMs);
    }

    const metrics = calculateMetrics(results);
    displaySummary(metrics, targetUrl);
  } catch (error) {
    console.error(`\n[ОШИБКА]: ${error.message}`);
    process.exit(1);
  }
}

// Запуск только при прямом вызове через CLI
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main();
}
