/**
 * Date formatting utilities for Protocol 01
 */

type TimeUnit = {
  unit: Intl.RelativeTimeFormatUnit;
  seconds: number;
};

const TIME_UNITS: TimeUnit[] = [
  { unit: 'year', seconds: 31536000 },
  { unit: 'month', seconds: 2592000 },
  { unit: 'week', seconds: 604800 },
  { unit: 'day', seconds: 86400 },
  { unit: 'hour', seconds: 3600 },
  { unit: 'minute', seconds: 60 },
  { unit: 'second', seconds: 1 },
];

/**
 * Format date as relative time (e.g., "2 hours ago", "in 3 days")
 */
export function formatRelativeTime(
  date: Date | number | string,
  locale: string = 'en-US'
): string {
  const timestamp = normalizeToTimestamp(date);
  if (timestamp === null) {
    return 'Invalid date';
  }

  const now = Date.now();
  const diffInSeconds = Math.floor((timestamp - now) / 1000);
  const absDiff = Math.abs(diffInSeconds);

  // Less than a minute
  if (absDiff < 60) {
    return 'just now';
  }

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  for (const { unit, seconds } of TIME_UNITS) {
    if (absDiff >= seconds) {
      const value = Math.floor(diffInSeconds / seconds);
      return rtf.format(value, unit);
    }
  }

  return 'just now';
}

/**
 * Format date for display (e.g., "Jan 15, 2024")
 */
export function formatDate(
  date: Date | number | string,
  locale: string = 'en-US',
  options?: Intl.DateTimeFormatOptions
): string {
  const timestamp = normalizeToTimestamp(date);
  if (timestamp === null) {
    return 'Invalid date';
  }

  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  };

  return new Date(timestamp).toLocaleDateString(locale, options || defaultOptions);
}

/**
 * Format date and time (e.g., "Jan 15, 2024, 3:30 PM")
 */
export function formatDateTime(
  date: Date | number | string,
  locale: string = 'en-US'
): string {
  const timestamp = normalizeToTimestamp(date);
  if (timestamp === null) {
    return 'Invalid date';
  }

  return new Date(timestamp).toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Format time only (e.g., "3:30 PM")
 */
export function formatTime(
  date: Date | number | string,
  locale: string = 'en-US',
  use24Hour: boolean = false
): string {
  const timestamp = normalizeToTimestamp(date);
  if (timestamp === null) {
    return 'Invalid date';
  }

  return new Date(timestamp).toLocaleTimeString(locale, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: !use24Hour,
  });
}

/**
 * Format as ISO date string (YYYY-MM-DD)
 */
export function formatISODate(date: Date | number | string): string {
  const timestamp = normalizeToTimestamp(date);
  if (timestamp === null) {
    return '';
  }

  return new Date(timestamp).toISOString().split('T')[0];
}

/**
 * Format transaction timestamp
 */
export function formatTransactionTime(
  date: Date | number | string,
  locale: string = 'en-US'
): string {
  const timestamp = normalizeToTimestamp(date);
  if (timestamp === null) {
    return 'Invalid date';
  }

  const now = Date.now();
  const diffInHours = Math.abs(now - timestamp) / (1000 * 60 * 60);

  // If within 24 hours, show relative time
  if (diffInHours < 24) {
    return formatRelativeTime(timestamp, locale);
  }

  // If within current year, show month and day
  const dateObj = new Date(timestamp);
  const currentYear = new Date().getFullYear();

  if (dateObj.getFullYear() === currentYear) {
    return dateObj.toLocaleDateString(locale, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  // Otherwise show full date
  return formatDateTime(timestamp, locale);
}

/**
 * Get time ago in short format (e.g., "2h", "3d", "1w")
 */
export function formatTimeAgoShort(date: Date | number | string): string {
  const timestamp = normalizeToTimestamp(date);
  if (timestamp === null) {
    return '';
  }

  const now = Date.now();
  const diffInSeconds = Math.floor((now - timestamp) / 1000);

  if (diffInSeconds < 60) return `${diffInSeconds}s`;
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h`;
  if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)}d`;
  if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 604800)}w`;
  if (diffInSeconds < 31536000) return `${Math.floor(diffInSeconds / 2592000)}mo`;
  return `${Math.floor(diffInSeconds / 31536000)}y`;
}

/**
 * Check if date is today
 */
export function isToday(date: Date | number | string): boolean {
  const timestamp = normalizeToTimestamp(date);
  if (timestamp === null) {
    return false;
  }

  const today = new Date();
  const dateObj = new Date(timestamp);

  return (
    dateObj.getDate() === today.getDate() &&
    dateObj.getMonth() === today.getMonth() &&
    dateObj.getFullYear() === today.getFullYear()
  );
}

/**
 * Check if date is yesterday
 */
export function isYesterday(date: Date | number | string): boolean {
  const timestamp = normalizeToTimestamp(date);
  if (timestamp === null) {
    return false;
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateObj = new Date(timestamp);

  return (
    dateObj.getDate() === yesterday.getDate() &&
    dateObj.getMonth() === yesterday.getMonth() &&
    dateObj.getFullYear() === yesterday.getFullYear()
  );
}

/**
 * Normalize various date inputs to timestamp
 */
function normalizeToTimestamp(date: Date | number | string): number | null {
  if (date instanceof Date) {
    return date.getTime();
  }

  if (typeof date === 'number') {
    // Handle Unix timestamps (seconds) vs milliseconds
    if (date < 1e12) {
      return date * 1000;
    }
    return date;
  }

  if (typeof date === 'string') {
    const parsed = Date.parse(date);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }

  return null;
}

/**
 * Format duration in milliseconds to human readable string
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0s';
  }

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
