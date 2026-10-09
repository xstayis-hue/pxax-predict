/* Прописывает адрес задеплоенного воркера в index.html → CONFIG.API_BASE.
   Запуск: node worker/link.mjs https://pxaxbet-payments.<subdomain>.workers.dev
   Скрипт правит только строку с API_BASE и печатает, что было и что стало. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const base = process.argv[2];
if (!base || !/^https:\/\/[a-z0-9.-]+\/?$/i.test(base)) {
  console.error('нужен адрес воркера, например: node worker/link.mjs https://pxaxbet-payments.abc.workers.dev');
  process.exit(1);
}
const url = base.replace(/\/+$/, '');
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const html = readFileSync(file, 'utf8');

const re = /(API_BASE:\s*)'[^']*'/;
if (!re.test(html)) {
  console.error('в index.html не найдено поле API_BASE — ничего не меняю');
  process.exit(1);
}
const before = html.match(re)[0];
const after = `$1'${url}'`;
writeFileSync(file, html.replace(re, after));
console.log('было:  ' + before);
console.log('стало: ' + after.replace('$1', "API_BASE: "));
console.log('Не забудь закоммитить index.html — только после пуша GitHub Pages раздаст новую версию.');
