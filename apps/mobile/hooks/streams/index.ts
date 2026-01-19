/**
 * Streams hooks exports
 * @module hooks/streams
 */

export { useStreams } from './useStreams';
export type {
  Stream,
  StreamStatus,
  StreamDirection,
  StreamStats,
} from './useStreams';

export { useStream } from './useStream';
export type { StreamActions } from './useStream';

export { useCreateStream, STREAM_DURATIONS } from './useCreateStream';
export type {
  CreateStreamParams,
  StreamPreview,
  CreateStreamStep,
} from './useCreateStream';

export { useStreamProgress, formatStreamTime } from './useStreamProgress';
export type {
  StreamProgress,
  StreamMilestone,
} from './useStreamProgress';
