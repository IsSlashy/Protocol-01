/**
 * Mock: expo-background-fetch
 */
export const BackgroundFetchResult = {
  NewData: 1,
  NoData: 2,
  Failed: 3,
};

export async function registerTaskAsync(_taskName: string, _options?: any): Promise<void> {}
export async function unregisterTaskAsync(_taskName: string): Promise<void> {}
export async function getStatusAsync(): Promise<number> { return 3; } // Available
