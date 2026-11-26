# GPS-TESTER

Локальный стенд для отладки отправки GPS из мобильного приложения.

Два приложения:

| Порт | Приложение | Назначение |
|---|---|---|
| 3000 | Sender | Управление геолокацией эмуляторов, построение маршрута, скорость и стоянки на участках |
| 4000 | Receiver | Приём координат, история обновлений, карта, проигрывание трека, экспорт |

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

Порты и токен можно изменить:

```bash
SENDER_PORT=3100 RECEIVER_PORT=4100 npm start
RECEIVER_TOKEN=dev-token npm start
```

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

История хранится в `data/positions.jsonl` (файл в `.gitignore`).

### Полезные запросы

```bash
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

## Карта и ключ Яндекса

Используется официальный Яндекс Карты JavaScript API 2.1:

```
https://api-maps.yandex.ru/2.1/?apikey=<ключ>&lang=ru_RU
```

Ключ хранится в `.env` в переменной `YANDEX_MAPS_API_KEY` и подставляется серверами в HTML при отдаче страницы. Файл `.env` не коммитится, шаблон — `.env.example`. Ключ можно взять из мобильного проекта: `yandexMapApiKey` в `lib/main_dev.dart`. Ключ проверен в браузере: API 2.1 загружает карту. JavaScript API 3.0 этот ключ не принимает (`Invalid API key`), поэтому используется версия 2.1.

Тёмная схема сделана CSS-фильтром на слое тайлов (`.map [class*='ground-pane']`), а не отдельным тёмным стилем карты. Сторонние картографические библиотеки не используются.

## Структура

```
apps/sender/          управление эмуляторами и маршрутом (порт 3000)
apps/receiver/        приём и визуализация (порт 4000)
lib/devices.js        adb / simctl
lib/geo.js            геометрия
scripts/start-all.js  запуск обоих приложений
data/                 история позиций (не коммитится)
```
