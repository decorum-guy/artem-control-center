# Списки понравившейся музыки

**Яндекс Музыка — да. YouTube Music — да, через авторизованную сессию Music.** В текущей панели отображение этих списков пока отсутствует.

## Яндекс Музыка

`users_likes_tracks()` читает «Мне нравится» авторизованного аккаунта и возвращает краткие записи. Названия и исполнителей можно получать по ID треков. Предыдущая живая проба проекта уже подтвердила чтение списка: после голосового лайка появился один новый элемент. Адаптер панели для списка пока отсутствует. [Код клиента Яндекс Музыки](https://github.com/MarshalX/yandex-music-api/blob/main/yandex_music/_client/likes.py) · [Проверка на Станции](plans/STATION_AND_BLE_PILOT.md#голосовой-лайк-и-youtube-music)

## YouTube Music

`ytmusicapi 1.12.4` умеет читать «Понравившуюся музыку» через `get_liked_songs()`. Библиотека поддерживает авторизацию через отдельную браузерную сессию Music. В нашем пилоте отдельные записи были видны в авторизованном интерфейсе Music. Автоматическое чтение текущим Desktop OAuth на Samsung вернуло HTTP 400, а серверная проверка ищет один ID в пределах 100 элементов. Вариант с браузерной авторизацией надо подтвердить отдельным чтением на Samsung через Happ `127.0.0.1:10809`. [Метод чтения списка](https://ytmusicapi.readthedocs.io/en/1.12.4/reference/library.html#ytmusicapi.YTMusic.get_liked_songs) · [Поддерживаемая авторизация](https://ytmusicapi.readthedocs.io/en/1.12.4/setup/browser.html) · [Результаты пилота](YOUTUBE_CURRENT_TRACK.md#api-и-прокси)

Если нужен обычный список лайков **YouTube**, официальный Data API предоставляет ID плейлиста из `channels.list(part=contentDetails,mine=true)` и постраничное чтение через `playlistItems.list`. Это список понравившихся видео канала, у него другой состав и контракт, чем у «Понравившейся музыки». [Свойство канала `relatedPlaylists.likes`](https://developers.google.com/youtube/data/reference/rest/v3/channels#contentDetails.relatedPlaylists.likes) · [Чтение плейлиста](https://developers.google.com/youtube/data/reference/rest/v3/playlistItems/list)
