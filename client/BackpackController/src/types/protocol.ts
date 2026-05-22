export type PlaybackStatus = 'playing' | 'paused' | 'stopped' | 'idle' | 'error';

export interface PiStatus {
  status: PlaybackStatus;
  file: string | null;
  pos: number;
  duration: number;
  volume: number;
}

export type PiCommand =
  | { action: 'play'; file: string }
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'stop' }
  | { action: 'next' }
  | { action: 'prev' }
  | { action: 'volume'; level: number }
  | { action: 'seek'; seconds: number }
  | { action: 'list' }
  | { action: 'rotate'; angle: 0 | 90 | 180 | 270 };
