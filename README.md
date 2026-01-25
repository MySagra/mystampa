# Mycassa – Servizio di stampa avanzato

Questa applicazione Node.js/TypeScript implementa un servizio REST che si
autentica presso un'API esterna, recupera l'elenco delle stampanti di rete e
gestisce la stampa degli ordini su stampanti diverse (cucina e cassa) in
funzione del `printerId` associato a ogni prodotto e al registratore di
cassa. Non vengono più utilizzate le categorie per determinare la
destinazione della stampa: per ciascun articolo viene effettuata una
chiamata al servizio dei cibi per conoscere il `printerId` corretto.
Le API esposte dal servizio sono documentate con Swagger e possono essere esplorate
tramite un'interfaccia web.

## Funzionalità

1. **Autenticazione all'avvio** – All'avvio il server esegue una richiesta
   `POST /auth/login` verso il servizio esterno utilizzando il nome utente e la
   password definiti nelle variabili d'ambiente. Il token JWT restituito viene
   salvato in memoria e reso disponibile alle richieste successive.

2. **Recupero stampanti** – Dopo il login il server interroga
   `GET /v1/printers` per ottenere l'elenco delle stampanti di rete
   configurate. Questo elenco viene memorizzato in memoria e stampato a
   console all'avvio. È utilizzato per risolvere gli indirizzi IP e le porte
   delle stampanti a partire dai rispettivi `printerId`.

3. **Modelli TypeScript e classi per il database** – Il progetto è scritto
   interamente in TypeScript. Oltre alle interfacce dei payload (ad esempio
   `IncomingOrder` e `OrderItemIn`), il file `src/models.ts` definisce
   classi che rispecchiano la struttura delle tabelle del database:
   `FoodEntity` per la tabella `foods`, `PrinterEntity` per la tabella
   `printers`, `CashRegisterEntity` per la tabella `cash_registers` e
   `CategoryEntity` per la tabella `categories`. Ogni classe espone un
   metodo statico `fromJson` che converte automaticamente gli oggetti
   restituiti dalle API in istanze tipizzate, facilitando la gestione dei dati.

4. **Endpoint di stampa** – L'API `POST /print` accetta un oggetto
   `IncomingOrder` contenente l'identificatore dell'ordine, il codice
   esposto al cliente (`displayCode`), il tavolo, il nome del cliente,
   i timestamp di creazione e conferma e un array di `orderItems`.
   Ogni elemento di `orderItems` specifica l'`id` della riga, la
   quantità, il `foodId` del prodotto ordinato, eventuali note e un
   `surcharge` (supplemento di prezzo). I dettagli del cibo non sono
   inclusi nel payload: per ogni `foodId` il server chiama
   `GET /v1/foods/{id}` per recuperare il nome, il prezzo e il `printerId`.

   Gli articoli vengono raggruppati per `printerId`: per ciascuna
   stampante di cucina viene generato uno **scontrino di cucina** che
   mette in evidenza **tavolo**, **cliente**, **codice ordine** e **ora**
   insieme a un **progressivo** che si incrementa a ogni stampa su
   quella stampante. Seguono le righe con quantità e nome del cibo;
   eventuali note appaiono sulla riga successiva indentata. I prezzi non
   vengono visualizzati negli scontrini di cucina.

   Se l'ordine contiene un `cashRegisterId`, il server richiama
   `GET /v1/cash-registers/{id}?include=printer` per ottenere la
   stampante associata al registratore di cassa. Viene quindi
   generato uno **scontrino fiscale** che elenca **codice ordine**,
   **tavolo**, **cliente** e **ora**, seguito da una riga per ciascun
   articolo con quantità, nome e **prezzo totale** (prezzo
   unitario moltiplicato per quantità). Se l'articolo ha un
   supplemento o una nota, una seconda riga mostra la nota e
   l'importo del supplemento. In coda vengono stampati lo sconto (solo
   se diverso da zero) e il **totale complessivo** calcolato
   sommando i prezzi degli articoli e i relativi supplementi e
   sottraendo lo sconto.

   In entrambi i casi il testo viene inviato via TCP alla stampante
   (indirizzo IP e porta). Se la stampante non è configurata o non
   raggiungibile, lo scontrino viene stampato sul terminale per
   facilitare il debugging. Ogni scontrino è preceduto e seguito da
   diverse righe vuote per garantire che la carta avanzi a sufficienza
   nelle stampanti termiche.

5. **Documentazione Swagger** – La documentazione interattiva si trova su
   `/api-docs`. È basata su uno schema OpenAPI definito nel file
   `swagger.json` e descrive l'unico endpoint disponibile (`/print`) con
   esempi di richiesta e risposta.

## Prerequisiti

- Node.js (versione >= 14) installato sul sistema.
- npm per installare le dipendenze.

## Configurazione

1. Copia il file `.env.example` e rinominalo in `.env`:

   ```bash
   cp .env.example .env
   ```

2. Apri `.env` e modifica i valori secondo il tuo ambiente:
   - `EXTERNAL_BASE_URL` – URL di base del servizio esterno a cui effettuare il
     login e da cui recuperare i cibi, i registratori e le stampanti (es.
     `http://localhost:4300`).
   - `ADMIN_USERNAME` e `ADMIN_PASSWORD` – Credenziali per l'autenticazione.
   - `PORT` – Porta su cui questo servizio deve ascoltare in locale. La
     porta predefinita è **1234**.

> **Nota:** il file `.env` non deve essere committato su sistemi di versioning. È
> incluso solo come esempio.

## Installazione e avvio in modalità sviluppo

1. Installa le dipendenze (sono specificate in `package.json`). Il comando
   seguente installa `express`, `axios`, `cors`, `dotenv`,
   `swagger-ui-express` e le tipizzazioni per TypeScript. Un articolo mostra
   come si possa abilitare CORS in Express importando il pacchetto `cors` e
   chiamando `app.use(cors())`【911934809301482†L88-L109】. In questo progetto
   utilizziamo gli stessi pacchetti (più `dotenv` per la gestione delle
   variabili d'ambiente) per connetterci a servizi esterni, gestire le
   richieste da browser e servire l'interfaccia Swagger.

   ```bash
   npm install
   ```

2. Avvia il server. Poiché il progetto è scritto in TypeScript, puoi
   utilizzare due modalità:

   - **Modalità sviluppo**: esegue l'applicazione con `ts-node`, compilando i
     file all'avolto.

       ```bash
       npm run dev
       ```

   - **Modalità produzione**: compila i file TypeScript in JavaScript nella
     cartella `dist` e avvia il codice compilato.

       ```bash
       npm run build
       npm start
       ```

   Per impostazione predefinita il server ascolta sulla porta definita
   nella variabile `PORT` (1234 se non modificata). Di conseguenza
   l'applicazione sarà disponibile su `http://localhost:1234` se non viene
   specificato diversamente.

3. Visita `http://localhost:<PORT>/api-docs` in un browser per consultare la
   documentazione Swagger. Un articolo spiega come servire la documentazione
   Swagger montando `swaggerUi.serve` e `swaggerUi.setup` su `/api-docs`【901356715103199†L146-L152】.

## Test dell'endpoint di stampa

Una volta avviato il server e completata la fase di inizializzazione (login e
caricamento delle stampanti), è possibile testare l'endpoint di stampa
utilizzando `curl` o un altro client HTTP. Di seguito è riportato un
esempio di payload compatibile con l'ultima versione del servizio:

```bash
curl -X POST \
  http://localhost:<PORT>/print \
  -H 'Content-Type: application/json' \
  -d '{
    "id": 6,
    "displayCode": "5BL",
    "table": "5",
    "customer": "Mario Rossi",
    "createdAt": "2025-11-28T10:55:15.983Z",
    "confirmedAt": "2025-11-28T11:01:08.225Z",
    "ticketNumber": 2,
    "status": "CONFIRMED",
    "paymentMethod": "CARD",
    "subTotal": "31",
    "discount": "0",
    "total": "31",
    "userId": "cmif13wap0003t4fk0ij4682h",
    "cashRegisterId": "cmif3kark0004t4u8x26vvudu",
    "orderItems": [
      {
        "id": "cmir51j40007t4h4g786kl9j",
        "quantity": 1,
        "orderId": 6,
        "foodId": "cmif13wat0006t4fk9s277yo4",
        "notes": null,
        "surcharge": 0
      },
      {
        "id": "cmir51j40006t4h4yylqbdz3",
        "quantity": 1,
        "orderId": 6,
        "foodId": "cmif13wat0006t4fk9s277yo4",
        "notes": "No formaggio",
        "surcharge": 2
      }
    ]
  }'
```

Nel nuovo flusso il servizio non utilizza più le categorie per determinare
la stampante. Viene effettuata una chiamata `/v1/foods/{id}` per ogni
prodotto per ottenere il `printerId` del cibo, mentre la chiamata
`/v1/cash-registers/{id}?include=printer` restituisce la stampante del
registratore di cassa. Se non viene trovata una stampante per uno dei due ruoli,
lo scontrino viene semplicemente mostrato nel terminale per diagnosi.

## Gestione delle variabili d'ambiente

La libreria [dotenv](https://www.npmjs.com/package/dotenv) permette di caricare
le variabili definite in un file `.env` nell'oggetto `process.env`. Come
illustrato da W3Schools, per utilizzarla è necessario installare il pacchetto
(`npm install dotenv`), creare un file `.env` con le variabili desiderate (es.
`PORT`, `DB_HOST`, `DB_USER`) e richiamare `require('dotenv').config()` all'inizio
del programma【842935397317975†L953-L985】. In questo progetto `dotenv` viene utilizzato in
`src/index.js` per leggere le variabili `EXTERNAL_BASE_URL`, `ADMIN_USERNAME`,
`ADMIN_PASSWORD` e `PORT`.

## Note finali

 - Questo progetto non esegue alcun controllo persistente sui dati. Le
  stampanti recuperate e il token di autenticazione vengono mantenuti
  in memoria fino al riavvio dell'applicazione.
 - Se l'API esterna non dovesse rispondere o restituire un errore durante
  l'inizializzazione, l'elenco delle stampanti sarà vuoto e la
  risoluzione dei `printerId` restituirà `null`; in questo caso gli
  scontrini verranno stampati sul terminale anziché inviati ad una stampante.
- Per una gestione più robusta dei casi di errore e per l'integrazione con
  stampanti reali, sarebbe opportuno estendere il codice con logica di retry e
  servizi di coda.