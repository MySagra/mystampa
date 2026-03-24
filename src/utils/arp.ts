import * as fs from 'fs';

/**
 * Resolve a MAC address to its current IP by reading the system ARP table.
 *
 * NOTE: This function works exclusively on Linux (including Docker containers)
 * by reading /proc/net/arp. On Windows or macOS the file does not exist and
 * the function always returns null, meaning MAC-based IP fallback will be
 * disabled on non-Linux hosts. Deploy the service inside a Docker container
 * or on a Linux host for full MAC resolution support.
 *
 * Returns null if the MAC is not found or the file is unavailable.
 */
export function resolveIpFromMac(mac: string): string | null {
  const normalizedMac = mac.toLowerCase().trim();
  if (!normalizedMac) return null;
  try {
    const content = fs.readFileSync('/proc/net/arp', 'utf-8');
    // Format: IP address  HW type  Flags  HW address         Mask  Device
    const lines = content.split('\n').slice(1); // skip header
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        const ip = parts[0];
        const hwAddr = parts[3].toLowerCase();
        if (hwAddr === normalizedMac) {
          return ip;
        }
      }
    }
  } catch {
    // /proc/net/arp not available (e.g., Windows dev environment)
  }
  return null;
}

/**
 * Resolve the effective IP for a printer TCP connection.
 *
 * - Prefers `ip` if available.
 * - If no IP is given, tries to resolve `mac` via the ARP table.
 * - Returns null when neither address can be resolved.
 *
 * Note: when both ip and mac are present, the caller should use ip first
 * and fall back to resolveIpFromMac(mac) only if the TCP connection fails.
 */
export function resolveEffectiveIp(
  ip: string | null | undefined,
  mac: string | null | undefined
): string | null {
  const cleanIp = ip ? String(ip).trim() : '';
  if (cleanIp) return cleanIp;

  const cleanMac = mac ? String(mac).trim() : '';
  if (cleanMac) return resolveIpFromMac(cleanMac);

  return null;
}
