# Glofox Task Filter

Skrypt Tampermonkey dla `https://app.glofox.com/dashboard/#/tasks`, ktory:

- dodaje przycisk `Wyswietl w modalu`,
- pobiera wszystkie zadania jednym API call (`limit=10000`),
- wyswietla klasyczna tabele z paginacja,
- udostepnia filtry i sortowanie,
- zapamietuje ustawienia UI (filtry/sort/page size) w `localStorage`.

## Wymagania

- Chrome / Edge / Firefox
- Tampermonkey
- aktywna sesja Glofox (token pobierany dynamicznie z sesji)

## Instalacja

1. Otworz Tampermonkey.
2. Wybierz `Create a new script`.
3. Wklej zawartosc:
   - `Glofox Tasks - Modal Filter (Stable)-1.0.user.js`
4. Zapisz (`Ctrl+S`) i upewnij sie, ze skrypt jest wlaczony.

## Uzycie

1. Przejdz do `https://app.glofox.com/dashboard/#/tasks`.
2. Kliknij `Wyswietl w modalu`.
3. Modal pobierze dane i pozwoli filtrowac/sortowac/paginowac.
4. Uzyj `Odswiez dane`, aby pobrac swiezy snapshot.

## Zakres v1

- Read-only explorer (bez mutacji taskow i bez akcji per-row).
- Filtry:
  - nazwa zadania,
  - klient,
  - utworzone przez,
  - przypisano do,
  - status (multi),
  - typ (multi),
  - zakres dat terminu.
- Sortowanie po kolumnach:
  - nazwa,
  - klient,
  - typ,
  - status,
  - termin,
  - utworzone przez.
- Paginacja:
  - domyslnie `100`/strone,
  - opcje `25/50/100/200`.

## Uwagi

- Jesli pojawi sie blad autoryzacji, odswiez sesje Glofox i otworz ponownie widok tasks.
- Skrypt jest odporny na nawigacje SPA (hashchange/mutation/url watcher).
- Skrypt zawiera wewnetrzne mechanizmy diagnostyczne i `SAFE_MODE` jako fallback anty-whiteout.
