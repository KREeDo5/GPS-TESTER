# GPS-TESTER

Локальный стенд для отладки отправки GPS из мобильного приложения.

Три приложения:

| Порт | Приложение | Назначение |
|---|---|---|
| 3000 | Sender | Управление геолокацией эмуляторов, построение маршрута, скорость и стоянки на участках |
| 4000 | Receiver | Приём координат, история обновлений, карта, проигрывание трека, экспорт |
| 8899 | iOS logs | Live-просмотр `courier_tracking.log` из iOS Simulator |

Карта — официальный Яндекс Карты JavaScript API 2.1 (тёмное оформление через CSS-фильтр слоя тайлов). Маршрут можно строить по дорогам (OSRM) или по прямой.

## Запуск

```bash
cd GPS-TESTER
npm install
cp .env.example .env
# укажите YANDEX_MAPS_API_KEY в .env
npm start
```

Открыть:

- Sender: http://localhost:3000
- Receiver: http://localhost:4000
- iOS logs: http://localhost:8899

Порты и токен можно изменить:

```bash
SENDER_PORT=3100 RECEIVER_PORT=4100 IOS_LOGS_PORT=8999 npm start
RECEIVER_TOKEN=dev-token npm start
```

По умолчанию оба сервиса слушают только `127.0.0.1`. Чтобы принимать координаты с телефона по сети, задайте `RECEIVER_HOST=0.0.0.0` и `RECEIVER_TOKEN`: без токена сервис не запустится. После этого откройте UI один раз как `http://localhost:4000/?token=<RECEIVER_TOKEN>` — сервер поставит HttpOnly-сессию и уберёт токен из адресной строки.

Ключ Яндекс Карт задаётся в `.env` (`YANDEX_MAPS_API_KEY`). Переменные окружения, заданные при запуске, имеют приоритет над `.env`.

## Управление эмуляторами

Sender автоматически находит запущенные устройства:

- Android Emulator — через `adb` (`emulator-*`);
- iOS Simulator — через `xcrun simctl`.

Проверка вручную:

```bash
adb devices -l
xcrun simctl list devices booted
```

Установка координаты:

```bash
adb -s emulator-5554 emu geo fix 37.6173 55.7558
xcrun simctl location F0D21651-1127-4910-B78F-40B9F875C828 set 55.7558,37.6173
```

Sender делает это автоматически на каждом тике симуляции.

## Маршрут и симуляция

1. Выберите устройства.
2. Кликните по карте — добавить точку. Точки можно перетаскивать.
3. Для каждой точки задайте скорость до следующей и стоянку.
4. «Построить маршрут» — по дорогам (OSRM) или по прямой.
5. «Старт» — координаты эмуляторов обновляются с выбранным интервалом.

## Приём данных

Мобильное приложение отправляет точку:

```http
POST /api/orders/{order_id}/courier-position
Authorization: Bearer <token>
Content-Type: application/json
X-Gps-Device: android-medium

{"lat": 55.7558, "lon": 37.6173, "recorded_at": "2026-11-26T11:00:00Z"}
```

Альтернативные пути: `POST /api/courier-position`, `POST /api/ingest`.

Ответ:

```json
{"data": {"id": "...", "order_id": "900001", "accepted_at": "..."}, "meta": {"success": true}}
```

История хранится в `data/positions.jsonl` (файл в `.gitignore`). Записи старше `POSITIONS_RETENTION_DAYS` удаляются при старте.

### Полезные запросы

```bash
# Если RECEIVER_TOKEN задан, добавьте заголовок:
#   -H "Authorization: Bearer $RECEIVER_TOKEN"

curl http://localhost:4000/api/health
curl http://localhost:4000/api/orders
curl "http://localhost:4000/api/positions?order_id=900001&limit=100"
curl -X DELETE "http://localhost:4000/api/positions?confirm=yes"
```

Экспорт: `/api/export.geojson`, `/api/export.csv`.

## Подключение мобильного приложения

Для Android-эмулятора хост машины — `10.0.2.2`, для iOS Simulator — `127.0.0.1`.

```bash
flutter run \
  --dart-define=COURIER_POSITION_BASE_URL=http://10.0.2.2:4000/api \
  --dart-define=COURIER_DEVICE_LABEL=android-medium \
  --dart-define=COURIER_TRACKING_INTERVAL_SECONDS=5
```

iOS:

```bash
flutter run \
  --dart-define=COURIER_POSITION_BASE_URL=http://127.0.0.1:4000/api \
  --dart-define=COURIER_DEVICE_LABEL=ios-17-pro \
  --dart-define=COURIER_TRACKING_INTERVAL_SECONDS=5 \
  --dart-define=COURIER_IOS_DISTANCE_FILTER_METERS=5
```

`COURIER_POSITION_BASE_URL` направляет только отправку координат в тестовый приёмник. Остальные запросы приложения идут на обычный API.

## Логи iOS-трекинга

`apps/ios-logs` показывает в браузере файл `Documents/courier_tracking.log` из
iOS Simulator. Приложение пишет этот файл только в debug-сборке (`kDebugMode`)
и только на iOS.

1. Запустите GPS-TESTER: `npm start` (сервер логов поднимется на порту 8899).
2. Запустите debug-сборку мобильного приложения на iOS Simulator.
3. Возьмите заказ в работу, чтобы фоновый сервис начал писать точки.
4. Откройте http://localhost:8899 и выберите симулятор.

Сервер сам находит data-контейнер через
`xcrun simctl get_app_container <udid> <bundle> data`. Путь пересчитывается
после переустановки приложения. Если файла ещё нет, страница показывает
ожидание.

Настройки:

```bash
IOS_LOGS_PORT=8899
IOS_APP_BUNDLE_ID=com.whitetigersoft.ru.fabric.bo
IOS_LOG_FILENAME=courier_tracking.log
```

Сервер слушает только loopback: он читает локальные файлы симулятора и не
предназначен для доступа по сети. Отдельный запуск — `npm run ios-logs`.

## Карта и ключ Яндекса

Используется официальный Яндекс Карты JavaScript API 2.1:

```
https://api-maps.yandex.ru/2.1/?apikey=<ключ>&lang=ru_RU
```

Ключ хранится в `.env` в переменной `YANDEX_MAPS_API_KEY` и подставляется серверами в HTML при отдаче страницы. Файл `.env` не коммитится, шаблон — `.env.example`. Ключ можно взять из мобильного проекта: `yandexMapApiKey` в `lib/main_dev.dart`. Ключ проверен в браузере: API 2.1 загружает карту. JavaScript API 3.0 этот ключ не принимает (`Invalid API key`), поэтому используется версия 2.1.

Тёмная схема сделана CSS-фильтром на слое тайлов (`.map [class*='ground-pane']`), а не отдельным тёмным стилем карты. Сторонние картографические библиотеки не используются.

## Безопасность

- Все три сервиса по умолчанию слушают только `127.0.0.1`. Сетевой интерфейс sender/receiver — только вместе с токеном (`RECEIVER_TOKEN` / `SENDER_TOKEN`), иначе процесс завершится с ошибкой. iOS logs всегда работает только на loopback.
- Все `/api/*` (включая чтение, SSE, экспорт и удаление) требуют `Authorization: Bearer <token>` либо HttpOnly-сессию UI. CORS-заголовки не отдаются, поэтому сторонние сайты не могут читать или менять данные.
- Фрагмент токена (`token_tail`) больше не сохраняется. Старые записи с ним, а также с `ip`/`user_agent`/`raw`, очищаются при старте, если `STORE_DEBUG_META` не включён.
- IP, User-Agent и тело запроса сохраняются только при `STORE_DEBUG_META=1`.
- История старше `POSITIONS_RETENTION_DAYS` (по умолчанию 30 дней) удаляется при старте. `0` — хранить бессрочно.
- Sender отправляет preview только на хосты из `PREVIEW_ALLOWED_HOSTS` (по умолчанию localhost и `10.0.2.2`), чтобы не отдать токен на чужой сервер.
- Токен приёмника в sender UI хранится только в памяти вкладки, не в `localStorage`.
- Держите `.env` с правами `600`: `chmod 600 .env`.

## Структура

```
apps/sender/          управление эмуляторами и маршрутом (порт 3000)
apps/receiver/        приём и визуализация (порт 4000)
apps/ios-logs/        live-логи iOS-трекинга (порт 8899)
lib/devices.js        adb / simctl
lib/geo.js            геометрия
lib/auth.js           токен-авторизация и сессии UI
scripts/start-all.js  запуск всех приложений
data/                 история позиций (не коммитится)
```
