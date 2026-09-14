# Политика конфиденциальности SSH Client

_Последнее обновление: 14 сентября 2026 г._

SSH Client — десктопное приложение для Windows, которое работает на компьютере пользователя. У приложения нет своих серверов, аккаунтов и аналитики: разработчик не получает и не хранит данные пользователей.

## Какие данные обрабатываются

- **Сейф** (`secrets.vault`): сохранённые SSH-сессии, ключи, пробросы портов, журнал и настройки. Шифруется на компьютере пользователя (scrypt + AES-256-GCM) мастер-паролем, который никуда не передаётся.
- **Known hosts**: отпечатки ключей серверов, к которым вы подключались. Хранятся локально.

## Google Диск (синхронизация — по желанию)

Если вы нажмёте «Войти через Google», приложение запросит доступ:

- `https://www.googleapis.com/auth/drive.file` — только к файлам, которые создало само приложение. Остальные файлы вашего Google Диска приложению недоступны;
- `openid`, `email` — чтобы показать, в какой аккаунт выполнен вход.

Приложение создаёт на вашем «Моём диске» папку **SSH Client** и хранит в ней **только зашифрованный** файл сейфа, чтобы синхронизировать его между вашими компьютерами. Содержимое сейфа Google и разработчику недоступно без вашего мастер-пароля.

Токен доступа Google хранится только на вашем компьютере, зашифрованный средствами Windows (DPAPI). Данные, полученные через Google API, используются исключительно для синхронизации вашего сейфа, не передаются третьим лицам, не используются для рекламы и для обучения моделей ИИ. Использование соответствует [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), включая требования Limited Use.

## Как отозвать доступ и удалить данные

- В приложении: «Настройки → Синхронизация → Выйти», при желании — с удалением копии сейфа с Google Диска.
- В аккаунте Google: <https://myaccount.google.com/permissions> → SSH Client → «Удалить доступ».
- Папку **SSH Client** можно удалить с Google Диска в любой момент.

## Другие сетевые запросы

- **Обновления**: приложение проверяет новые версии на GitHub Releases этого репозитория.
- **SSH**: подключения идут напрямую к серверам, которые вы добавили.
- **Claude Code**: если вы пользуетесь чатом, запросы обрабатывает установленный у вас Claude Code по правилам Anthropic.

## Контакты

Вопросы о конфиденциальности: [ewkereboss@gmail.com](mailto:ewkereboss@gmail.com) или [issues этого репозитория](https://github.com/sovereignbrains/ssh/issues).

---

## Privacy Policy (English summary)

SSH Client is a Windows desktop app with no servers, accounts or analytics. Your vault is encrypted locally with your master password. If you choose to sign in with Google, the app uses the `drive.file` scope (plus `openid email`) solely to store and sync **your own encrypted vault file** in a visible "SSH Client" folder on your Google Drive. Google user data is not shared with third parties, not used for advertising or AI training, and its use complies with the Google API Services User Data Policy, including the Limited Use requirements. Revoke access any time in the app (Settings → Sync → Sign out) or at https://myaccount.google.com/permissions. Contact: ewkereboss@gmail.com.
