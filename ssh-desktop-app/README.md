# SSH Client — Desktop Application

Десктопная версия SSH-клиента на основе веб-макета, собранная на Electron.

## Структура проекта

```
ssh-desktop-app/
├── main.js          # Главный процесс Electron
├── preload.js       # Preload скрипт для безопасного доступа к API
├── index.html       # Веб-интерфейс (ваш макет)
├── package.json     # Конфигурация npm и electron-builder
└── README.md        # Этот файл
```

## Установка зависимостей

```bash
npm install
```

## Запуск приложения

```bash
npm start
```

## Сборка исполняемых файлов

### Сборка для текущей ОС
```bash
npm run build
```

### Сборка для Windows
```bash
npm run build:win
```

### Сборка для macOS
```bash
npm run build:mac
```

### Сборка для Linux
```bash
npm run build:linux
```

Собранные файлы появятся в папке `dist/`.

## Функции

- ✅ Полностью перенесён веб-интерфейс
- ✅ Нативные кнопки управления окном (свернуть, развернуть, закрыть)
- ✅ Поддержка тёмной темы (Edge/Night)
- ✅ Готово к расширению функционалом SSH

## Технологии

- **Electron** — фреймворк для десктопных приложений
- **electron-builder** — сборка установщиков для Windows, macOS, Linux

## Лицензия

ISC
