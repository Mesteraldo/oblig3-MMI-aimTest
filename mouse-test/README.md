# Mus vs. Trackpad – hastighet og presisjon

En liten nettapp som måler hvor raskt og presist en testperson treffer targets med trackpad og med ekstern mus. Ingenting lagres automatisk.

**På nett:** https://aimtest.esper.no. Innsendte gjennomganger havner først i en kø (`venter/`). De lagres «ordentlig» (`godkjent/`) først når du godkjenner dem på **/admin**.

## Innsending og godkjenning

| Mappe (i `RESULTS_DIR`) | Betydning |
|---|---|
| `venter/` | Sendt inn av en testperson, ikke godkjent ennå |
| `godkjent/` | Godkjent av admin. Dette er datasettet. |
| `avvist/` | Avvist av admin (slettes ikke, kan angres) |

- **/admin** er beskyttet med passordet i miljøvariabelen `ADMIN_PASSWORD` (nettleserens innloggingsboks; brukernavn spiller ingen rolle). Uten variabelen er admin slått av.
- Admin viser hver innsending med deltakerinfo og alle 6 testene, og varsler om mistenkelig lave/høye tider. Knapper: **Godkjenn**, **Avvis**, og angre i begge retninger.
- **Last ned godkjente (JSON)** gir alle godkjente gjennomganger i én fil, klar til analyse.
- Serveren godtar bare nøyaktig appens format (6 tester × 20 tider, gyldig alder/kjønn/preferanse), maks 64 kB, maks 10 innsendinger per IP per 10 min og maks 2000 i køen.

## Drift (hjemmeserveren)

Dokploy-app `aimtest` i prosjekt `jesper`, bygges fra `Dockerfile`. Data ligger i volumet `jesper-aimtest-data` montert på `/data`. Se `AGENTS.md` i prosjektroten.

## Kom i gang

Fra prosjektroten (`oblig3-MMI-aimTest/`):

```sh
npm start
```

Åpne adressen serveren skriver ut, vanligvis **http://127.0.0.1:3000**. For å prøve admin lokalt: `ADMIN_PASSWORD=test npm start` og åpne `/admin`. Er port 3000 opptatt av et annet program, bruker serveren automatisk neste ledige port (3001, 3002 …) og skriver den ut. Du kan også velge port selv: `PORT=4000 npm start`. Når en gjennomgang sendes inn, skrives JSON-filen til **`resultater/venter/`** i prosjektroten. Stopp serveren med Ctrl+C.

Appen virker også uten serveren, enten ved å åpne `mouse-test/index.html` direkte eller med `npx serve mouse-test`. Da kan ikke nettleseren skrive til mappen selv. «Send inn» laster i stedet ned filen til Nedlastinger, og appen ber deg flytte den til `resultater/`.

Bruk et vindu på minst 1024×700.

## Gjennomgang

1. Startskjema der testpersonen fyller inn **alder**, **kjønn** og **preferanse** (trackpad / mus / ingen).
2. **6 tester** i fast rekkefølge: Trackpad forsøk 1, 2, 3, deretter Ekstern mus forsøk 1, 2, 3. Hver test har 20 targets som vises ett om gangen.
3. Etter hver test vises resultatet for den testen. Det lagres ikke ennå.
4. Når alle 6 er ferdige, vises en oppsummering med **«Send inn gjennomgangen»** og **«Ikke send inn»**. Enten sendes alle 6 testene inn i én fil, eller ingenting. Feiler innsendingen (nett, server), kan testpersonen prøve igjen.

<kbd>Esc</kbd> eller endret vindusstørrelse avbryter testen som pågår, og testpersonen tar **samme forsøk** på nytt. «Avbryt gjennomgang» på instruksjonsskjermen må klikkes to ganger og forkaster hele gjennomgangen.

## JSON-format

Én fil per gjennomgang: `gjennomgang_YYYY-MM-DD_HH-MM-SS.json` (lokal tid hos testpersonen) i `venter/`, `godkjent/` eller `avvist/`. Finnes navnet fra før, får den nye filen `-2`, `-3` … på slutten. Ingenting overskrives.

```json
{
  "schemaVersion": 3,
  "completedAt": "2026-11-02T13:31:21.273Z",
  "participant": { "age": 24, "gender": "kvinne", "preference": "trackpad" },
  "tests": [
    {
      "testType": "trackpad",
      "attempt": 1,
      "totalTimeMs": 15234.5,
      "averageTimeMs": 761.7,
      "longestTimeMs": 1420.1,
      "shortestTimeMs": 512.3,
      "totalMisses": 3,
      "timesBetweenClicksMs": [842.3, 610.0, 1420.1, "… 20 verdier totalt"]
    }
  ]
}
```

| Felt | Betydning |
|---|---|
| `schemaVersion` | Formatversjon (3) |
| `completedAt` | Når siste test ble fullført (ISO 8601, UTC) |
| `participant.age` | Alder (heltall 5–120) |
| `participant.gender` | `"kvinne"`, `"mann"`, `"annet"` eller `"vil_ikke_oppgi"` |
| `participant.preference` | Hva testpersonen foretrekker til vanlig: `"trackpad"`, `"mus"` eller `"ingen"` |
| `tests[]` | De 6 testene i rekkefølgen de ble tatt |
| `tests[].testType` | `"trackpad"` eller `"external_mouse"` |
| `tests[].attempt` | 1, 2 eller 3: første, andre eller tredje forsøk på dette mediet |
| `tests[].totalTimeMs` | Total tid for de 20 targetene (= summen av `timesBetweenClicksMs`) |
| `tests[].averageTimeMs` | Gjennomsnitt: `totalTimeMs / 20` |
| `tests[].longestTimeMs` | Lengste tid mellom to klikk |
| `tests[].shortestTimeMs` | Korteste tid mellom to klikk |
| `tests[].totalMisses` | Antall bom (klikk i arenaen utenfor target) i testen |
| `tests[].timesBetweenClicksMs` | Tiden for hvert av de 20 targetene, i rekkefølge. Neste target vises i det forrige treffes, så dette er tiden mellom to treff-klikk. For det første targetet er det tiden fra det dukket opp etter nedtellingen. Bom underveis teller med i tiden. |

Alle tider er i millisekunder, målt med `performance.now()` og avrundet til én desimal.

`resultater/` står i `.gitignore`, fordi filene inneholder deltakerdata som ikke skal havne i git.

## Test

```sh
npm i -D playwright && npx playwright install chromium   # én gang
npm test                                                  # exit code 0 = alt PASS
```

Testen dekker også API-et, validering, ratebegrensning og admin-godkjenning (med passord og i nettleseren). Den bruker sin egen mappe, `tests/output/resultater/`, så ekte data i `resultater/` ikke blandes med testdata. Skjermdumper havner i `tests/screenshots/`.
