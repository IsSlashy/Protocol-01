/**
 * Version Check — checks GitHub releases for app updates.
 *
 * Fetches the latest release from Protocol-01-releases repo,
 * compares against the running app version, and if newer:
 * - Downloads the APK in-app via expo-file-system
 * - Triggers native Android install via intent
 *
 * Fully self-contained — no app store dependency.
 */

import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { p01Alert } from '@/stores/alertStore';

const GITHUB_REPO = 'IsSlashy/Protocol-01-releases';
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

/** Download APK and trigger native Android install */
async function downloadAndInstall(apkUrl: string, version: string): Promise<void> {
  try {
    p01Alert('Downloading Update', `Downloading v${version}...`);

    // Download APK bytes
    const response = await fetch(apkUrl, {
      headers: { Accept: 'application/octet-stream' },
    });
    if (!response.ok) {
      p01Alert('Update Failed', 'Download failed. Please try again.');
      return;
    }

    const arrayBuffer = await response.arrayBuffer();

    // Write to cache file
    const apkFile = new File(Paths.cache, `protocol01-v${version}.apk`);
    apkFile.write(new Uint8Array(arrayBuffer));

    // Trigger native Android package installer
    await IntentLauncher.startActivityAsync(
      'android.intent.action.INSTALL_PACKAGE' as any,
      {
        data: apkFile.uri,
        flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
        type: 'application/vnd.android.package-archive',
      },
    );
  } catch (error: any) {
    console.error('[Update] Install failed:', error);
    p01Alert('Update Failed', `Could not install update: ${error?.message ?? 'Unknown error'}`);
  }
}

/**
 * Check for updates.
 *
 * - Skips if checked within the last 24h (unless forced)
 * - Skips if user dismissed this specific version
 * - Downloads + installs APK natively in-app
 * - Shows "up to date" confirmation when forced
 *
 * @param force  bypass the 24h cooldown (e.g. from settings "Check for updates")
 */
export async function checkForUpdate(force = false): Promise<void> {
  try {
    if (Platform.OS !== 'android') return;

    // Throttle: max once per 24h unless forced
    if (!force) {
      const lastCheck = await AsyncStorage.getItem(LAST_CHECK_KEY);
      if (lastCheck && Date.now() - Number(lastCheck) < CHECK_INTERVAL_MS) {
        return;
      }
    }

    await AsyncStorage.setItem(LAST_CHECK_KEY, String(Date.now()));

    const release = await fetchLatestRelease();
    if (!release) {
      if (force) p01Alert('Update Check', 'Could not reach update server. Check your connection.');
      return;
    }

    const current = getCurrentVersion();

    if (!isNewer(release.version, current)) {
      if (force) {
        p01Alert('Up to Date', `Protocol 01 v${current} is the latest version.`);
      }
      return;
    }

    // Skip if user already dismissed this version (auto-check only)
    if (!force) {
      const skipped = await AsyncStorage.getItem(SKIPPED_VERSION_KEY);
      if (skipped === release.version) return;
    }

    // Build changelog preview (first 3 lines)
    const changelog = release.body
      .split('\n')
      .filter((l: string) => l.trim().length > 0)
      .slice(0, 3)
      .join('\n');

    const message = `Version ${release.version} is available (current: v${current}).${changelog ? '\n\n' + changelog : ''}`;

    if (release.apkUrl) {
      p01Alert(
        'Update Available',
        message,
        [
          {
            text: 'Update Now',
            style: 'default',
            onPress: () => downloadAndInstall(release.apkUrl!, release.version),
          },
          {
            text: 'Later',
            style: 'cancel',
          },
          {
            text: 'Skip Version',
            style: 'destructive',
            onPress: async () => {
              await AsyncStorage.setItem(SKIPPED_VERSION_KEY, release.version);
            },
          },
        ],
      );
    } else {
      // Fallback: no APK attached, open GitHub releases page
      p01Alert(
        'Update Available',
        message,
        [
          {
            text: 'View Release',
            style: 'default',
            onPress: () => {
              const Linking = require('expo-linking');
              Linking.openURL(release.htmlUrl);
            },
          },
          { text: 'Later', style: 'cancel' },
        ],
      );
    }
  } catch {
    if (force) p01Alert('Update Check', 'Something went wrong. Please try again.');
  }
}
