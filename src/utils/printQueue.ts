
import { sendToPrinter, getPrinterStatus } from "./printer";
import { resolveEffectiveIp, resolveIpFromMac } from "./arp";
import { patchPrinterIp } from "./api";

interface PrintJob {
    id: string; // unique job id
    printerId: string;
    ip: string;
    port: number;
    mac: string | null;
    data: (string | Buffer)[] | string | Buffer;
    timestamp: number;
    attempts: number;
}

class PrintQueueManager {
    private queue: PrintJob[] = [];
    private isProcessing = false;
    private checkInterval: NodeJS.Timeout | null = null;
    private readonly INTERVAL_MS = 60000; // Check every 60 seconds
    private readonly MAX_QUEUE_SIZE = 1000;

    constructor() {
        this.start();
    }

    public add(printerId: string, ip: string, port: number, data: (string | Buffer)[] | string | Buffer, mac?: string | null) {
        if (this.queue.length >= this.MAX_QUEUE_SIZE) {
            console.warn(`[PrintQueue] Queue full (${this.MAX_QUEUE_SIZE} jobs). Dropping job for printer ${printerId}.`);
            return;
        }
        const job: PrintJob = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2),
            printerId,
            ip,
            port,
            mac: mac ?? null,
            data,
            timestamp: Date.now(),
            attempts: 0,
        };
        this.queue.push(job);
        const addr = mac ? `MAC:${mac}` : `${ip}:${port}`;
        console.log(`[PrintQueue] Job added for printer ${printerId} (${addr}). Queue size: ${this.queue.length}`);

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

        try {
            // Group by printer ID to check status once per printer
            const jobsByPrinter = new Map<string, PrintJob[]>();
            for (const job of this.queue) {
                const existing = jobsByPrinter.get(job.printerId) || [];
                existing.push(job);
                jobsByPrinter.set(job.printerId, existing);
            }

            for (const [printerId, jobs] of jobsByPrinter) {
                // Take the first job to get ip/port/mac
                const { ip, port, mac } = jobs[0];
                // Prefer IP; only resolve from MAC if no IP is stored
                let effectiveIp = resolveEffectiveIp(ip, mac) ?? ip;

                let status = 'UNKNOWN';
                try {
                    status = await getPrinterStatus(effectiveIp, port);
                } catch (err) {
                    console.warn(`[PrintQueue] getPrinterStatus failed for ${printerId} at ${effectiveIp}:${port}:`, err);
                    // Connection to IP failed — try MAC fallback if available
                    if (ip && mac) {
                        const macIp = resolveIpFromMac(mac);
                        if (macIp && macIp !== effectiveIp) {
                            console.log(`[PrintQueue] IP ${effectiveIp} unreachable, retrying with MAC-resolved IP ${macIp}`);
                            try {
                                status = await getPrinterStatus(macIp, port);
                                effectiveIp = macIp;
                                // IP changed — update DB asynchronously
                                patchPrinterIp(printerId, macIp);
                            } catch {
                                console.log(`[PrintQueue] Printer ${printerId} unreachable via IP and MAC. Keep jobs in queue.`);
                                remainingJobs.push(...jobs);
                                continue;
                            }
                        } else {
                            remainingJobs.push(...jobs);
                            continue;
                        }
                    } else {
                        remainingJobs.push(...jobs);
                        continue;
                    }
                }

                console.log(`[PrintQueue] Printer ${printerId} status: ${status}`);

                if (status === "OK" || status === "CARTA_QUASI_FINITA") {
                    // Printer is ready, try to print all jobs for this printer
                    for (const job of jobs) {
                        try {
                            await sendToPrinter(effectiveIp, job.port, job.data);
                            console.log(`[PrintQueue] Job ${job.id} printed successfully.`);
                        } catch (err) {
                            console.error(`[PrintQueue] Failed to print job ${job.id} despite OK status:`, err);
                            remainingJobs.push(job);
                        }
                    }
                } else {
                    // Status not OK (e.g. CARTA_FINITA), keep all jobs
                    console.log(`[PrintQueue] Printer ${printerId} not ready. Keep jobs in queue.`);
                    remainingJobs.push(...jobs);
                }
            }

            this.queue = remainingJobs;
        } catch (err) {
            console.error('[PrintQueue] Unexpected error during queue processing:', err);
        } finally {
            // Always release the lock so subsequent intervals can run
            this.isProcessing = false;
        }
    }
}

// Singleton instance
export const printQueue = new PrintQueueManager();
