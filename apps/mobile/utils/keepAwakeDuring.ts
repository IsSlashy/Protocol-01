import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

export async function withKeepAwake<T>(tag: string, work: () => Promise<T>): Promise<T> {
  try {
    await activateKeepAwakeAsync(tag);
    return await work();
  } finally {
    try { deactivateKeepAwake(tag); } catch {}
  }
}
