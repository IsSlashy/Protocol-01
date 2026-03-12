/**
 * Version Check — checks GitHub releases for app updates.
 *
 * On each app foreground (max once per 24h), fetches the latest GitHub
 * release tag and compares it against the running app version.
 * If a newer version exists, prompts the user via p01Alert with a
 * download link to the APK asset.
 *
 * Fully self-contained — no app store dependency.
 */

import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { p01Alert } from '@/stores/alertStore';

const GITHUB_REPO = 'IsSlashy/Protocol-01';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const LAST_CHECK_KEY = 'p01_update_last_check';
const SKIPPED_VERSION_KEY = 'p01_update_skipped';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Get the current app version from expo config */
function getCurrentVersion(): string {
  return Constants.expoConfig?.version ?? '0.0.0';
}

/** Parse semver string "0.8.3" → [0, 8, 3] */
function parseSemver(version: string): [number, number, number] {
  const clean = version.replace(/^v/, '');
  const parts = clean.split('.').map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Returns true if `remote` is newer than `local` */
function isNewer(remote: string, local: string): boolean {
  const [rMaj, rMin, rPat] = parseSemver(remote);
  const [lMaj, lMin, lPat] = parseSemver(local);
  if (rMaj !== lMaj) return rMaj > lMaj;
  if (rMin !== lMin) return rMin > lMin;
  return rPat > lPat;
}

interface ReleaseInfo {
  tagName: string;
  version: string;
  body: string;
  apkUrl: string | null;
  htmlUrl: string;
}

/** Fetch latest release from GitHub API */
async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(GITHUB_API, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    if (!res.ok) return null;

    const data = await res.json();
    const apkAsset = data.assets?.find(
      (a: any) => a.name?.endsWith('.apk'),
    );

    return {
      tagName: data.tag_name ?? '',
      version: (data.tag_name ?? '').replace(/^v/, ''),
      body: data.body ?? '',
      apkUrl: apkAsset?.browser_download_url ?? null,
      htmlUrl: data.html_url ?? `https://github.com/${GITHUB_REPO}/releases/latest`,
    };
  } catch {
    return null;
  }
}

/**
 * Check for updates. Call on app foreground.
 *
 * - Skips if checked within the last 24h
 * - Skips if user dismissed this specific version
 * - Shows p01Alert with "Update" / "Later" / "Skip" buttons
 *
 * @param force  bypass the 24h cooldown (e.g. from settings "Check for updates")
 */
export async function checkForUpdate(force = false): Promise<void> {
  try {
    // Throttle: max once per 24h unless forced
    if (!force) {
      const lastCheck = await AsyncStorage.getItem(LAST_CHECK_KEY);
      if (lastCheck && Date.now() - Number(lastCheck) < CHECK_INTERVAL_MS) {
        return;
      }
    }

    await AsyncStorage.setItem(LAST_CHECK_KEY, String(Date.now()));

    const release = await fetchLatestRelease();
    if (!release) return;

    const current = getCurrentVersion();
    if (!isNewer(release.version, current)) return;

    // Skip if user already dismissed this version
    if (!force) {
      const skipped = await AsyncStorage.getItem(SKIPPED_VERSION_KEY);
      if (skipped === release.version) return;
    }

    // Show update prompt
    const downloadUrl = release.apkUrl || release.htmlUrl;

    p01Alert(
      'Update Available',
      `Version ${release.version} is available (current: ${current}).`,
      [
        {
          text: 'Update',
          style: 'default',
          onPress: () => Linking.openURL(downloadUrl),
        },
        {
          text: 'Later',
          style: 'cancel',
        },
        {
          text: 'Skip',
          style: 'destructive',
          onPress: async () => {
            await AsyncStorage.setItem(SKIPPED_VERSION_KEY, release.version);
          },
        },
      ],
    );
  } catch {
    // Silent fail — update check is non-critical
  }
}
