import axiosInstance from './axiosInstance';

export interface StationData {
  id: string;
  name: string;
  categoryIds: Set<string>;
}

let cache: StationData[] = [];
// categoryId → stationId for fast lookup
let categoryToStation: Map<string, string> = new Map();

export function getStationsCache(): StationData[] {
  return cache;
}

export function getCategoryToStationMap(): Map<string, string> {
  return categoryToStation;
}

export async function fetchAndCacheStations(apiUrl: string, apiKey: string): Promise<void> {
  try {
    const resp = await axiosInstance.get(`${apiUrl}/v1/stations?include=categories.foods`, {
      headers: { Accept: 'application/json', 'X-API-KEY': apiKey },
    });
    const newMap = new Map<string, string>();
    cache = (resp.data as any[]).map((s: any) => {
      const categoryIds = new Set<string>(
        (s.categories ?? []).map((c: any) => c.id as string)
      );
      for (const catId of categoryIds) {
        newMap.set(catId, s.id);
      }
      return { id: s.id, name: s.name, categoryIds };
    });
    categoryToStation = newMap;
    console.log(`[Stations] Cached ${cache.length} stations, ${newMap.size} categories mapped`);
  } catch (err: any) {
    console.error('[Stations] Failed to fetch stations:', err.message);
  }
}
