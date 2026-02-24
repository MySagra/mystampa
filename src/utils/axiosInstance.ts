import axios from 'axios';

// 1. Creazione dell'istanza base
const axiosInstance = axios.create({
    timeout: 10000, // 10 secondi di timeout
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
});

// Helper per mettere in pausa l'esecuzione (delay)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 2. INTERCEPTOR DELLE RICHIESTE (Log utile per il debug)
axiosInstance.interceptors.request.use((config) => {
    console.log(`[Axios] Eseguo ${config.method?.toUpperCase()} a ${config.url}`);
    return config;
}, (error) => {
    return Promise.reject(error);
});

// 3. INTERCEPTOR DELLE RISPOSTE (Qui c'è la magia del FALLBACK / RETRY)
axiosInstance.interceptors.response.use(
    (response) => {
        // Se la chiamata va a buon fine, restituisci i dati normalmente
        return response;
    },
    async (error) => {
        const config = error.config;

        // Impostiamo il numero massimo di tentativi (es. 6 tentativi = 30 secondi totali di attesa)
        const MAX_RETRIES = 6;

        // Se manca la configurazione o abbiamo superato i tentativi, diamo l'errore finale
        if (!config || (config._retryCount && config._retryCount >= MAX_RETRIES)) {
            console.error(`[Axios Error] Fallimento definitivo dopo ${MAX_RETRIES} tentativi.`);
            return Promise.reject(error);
        }

        // Inizializza il contatore dei tentativi se non esiste
        config._retryCount = config._retryCount || 0;
        config._retryCount += 1;

        // Se l'errore è 401 (Credenziali errate) NON ha senso riprovare, fermiamoci subito.
        if (error.response && error.response.status === 401) {
            console.error(`[Axios Error] Errore 401: Credenziali respinte dal server. Interrompo i retry.`);
            return Promise.reject(error);
        }

        // Log del fallback
        console.warn(`[Axios Fallback] API non pronta o irraggiungibile. Tentativo ${config._retryCount} di ${MAX_RETRIES} in corso tra 30 secondi...`);

        // Aspetta 30 secondi (30000 millisecondi) prima di riprovare
        await sleep(30000);

        // Riprova la chiamata esatta che era fallita!
        return axiosInstance(config);
    }
);

export default axiosInstance;