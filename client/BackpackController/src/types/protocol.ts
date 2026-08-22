export type PlaybackStatus = 'playing' | 'paused' | 'stopped' | 'idle' | 'error';

export type ScreenState = 'on' | 'off';

export interface PiStatus {
  status: PlaybackStatus;
  file: string | null;
  pos: number;
  duration: number;
  volume: number;
  screen: ScreenState;
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
  | { action: 'rotate'; angle: 0 | 90 | 180 | 270 }
  | { action: 'displaymode'; mode: 'contain' | 'cover' | 'stretch'; ratio: '16:9' | '9:16' }
  | { action: 'enqueue'; file: string }
  | { action: 'clearqueue' }
  | { action: 'screen'; state: 'sleep' | 'wake' };
