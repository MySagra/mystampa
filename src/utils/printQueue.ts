
import { sendToPrinter, getPrinterStatus } from "./printer";

interface PrintJob {
    id: string; // unique job id
    printerId: string;
    ip: string;
    port: number;
    data: (string | Buffer)[] | string | Buffer;
    timestamp: number;
    attempts: number;
}

class PrintQueueManager {
    private queue: PrintJob[] = [];
    private isProcessing = false;
    private checkInterval: NodeJS.Timeout | null = null;
    private readonly INTERVAL_MS = 60000; // Check every 60 seconds

    constructor() {
        this.start();
    }

    public add(printerId: string, ip: string, port: number, data: (string | Buffer)[] | string | Buffer) {
        const job: PrintJob = {
            id: Math.random().toString(36).substring(7),
            printerId,
            ip,
            port,
            data,
            timestamp: Date.now(),
            attempts: 0,
        };
        this.queue.push(job);
        console.log(`[PrintQueue] Job added for printer ${printerId} (${ip}:${port}). Queue size: ${this.queue.length}`);

        // Optional: Trigger processing immediately if not running/waiting
        // But requirement says "if negative, create a queue", implying we wait for condition to change.
        // However, fast retry could be good. For now, we rely on the interval.
    }

    public start() {
        if (this.checkInterval) return;
        console.log("[PrintQueue] Starting queue manager...");
        this.checkInterval = setInterval(() => this.processQueue(), this.INTERVAL_MS);
    }

    public stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    private async processQueue() {
        if (this.isProcessing) return;
        if (this.queue.length === 0) return;

        this.isProcessing = true;
        console.log(`[PrintQueue] Processing queue. Jobs pending: ${this.queue.length}`);

        const remainingJobs: PrintJob[] = [];

        // Group jobs by printer to avoid spamming status checks?
        // For simplicity, iterate linearly. If we have multiple jobs for same printer, 
        // we check status for each? Or better: check status once per printer.

        // Let's grouping by printer ID first
        const jobsByPrinter = new Map<string, PrintJob[]>();
        for (const job of this.queue) {
            const existing = jobsByPrinter.get(job.printerId) || [];
            existing.push(job);
            jobsByPrinter.set(job.printerId, existing);
        }

        for (const [printerId, jobs] of jobsByPrinter) {
            // Take the first job to get ip/port (assuming they don't change for the same printerId in this context)
            const { ip, port } = jobs[0];

            try {
                const status = await getPrinterStatus(ip, port);
                console.log(`[PrintQueue] Printer ${printerId} status: ${status}`);

                if (status === "OK" || status === "CARTA_QUASI_FINITA") {
                    // Printer is ready, try to print all jobs for this printer
                    for (const job of jobs) {
                        try {
                            await sendToPrinter(job.ip, job.port, job.data);
                            console.log(`[PrintQueue] Job ${job.id} printed successfully.`);
                        } catch (err) {
                            console.error(`[PrintQueue] Failed to print job ${job.id} despite OK status:`, err);
                            // If print fails (e.g. connection drop during print), keep in queue?
                            // The prompt says "before print check status, if negative create queue".
                            // Here we checked status, it was OK, but send failed. 
                            // We should probably keep it.
                            remainingJobs.push(job);
                        }
                    }
                } else {
                    // Status not OK (e.g. CARTA_FINITA), keep all jobs
                    console.log(`[PrintQueue] Printer ${printerId} not ready. Keep jobs in queue.`);
                    remainingJobs.push(...jobs);
                }
            } catch (err) {
                console.error(`[PrintQueue] Error checking status for printer ${printerId}:`, err);
                // Could not check status, assume offline/bad. Keep jobs.
                remainingJobs.push(...jobs);
            }
        }

        this.queue = remainingJobs;
        this.isProcessing = false;
    }
}

// Singleton instance
export const printQueue = new PrintQueueManager();
