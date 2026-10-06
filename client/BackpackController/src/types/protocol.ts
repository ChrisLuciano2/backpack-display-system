export type PlaybackStatus = 'playing' | 'paused' | 'stopped' | 'idle' | 'error';

export type ScreenState = 'on' | 'off';

// Which program the Pi is running. The Pi owns this; the phone only shows it.
export type PiMode = 'video' | 'game' | 'switching' | 'error';
export type GamePhase = 'menu' | 'launching' | 'playing' | null;

export interface GameRef {
  id: string | null;
  name: string | null;
  system: string | null;
}

export interface PiStatus {
  status: PlaybackStatus;
  file: string | null;
  pos: number;
  duration: number;
  volume: number;
  screen: ScreenState;
  queue: string[];
  // Game Mode fields. An older server never sends them, so the app falls back to video.
  mode: PiMode;
  phase: GamePhase;
  game: GameRef | null;
}

export type SystemReadiness = 'ready' | 'no_core' | 'needs_bios' | 'empty';

export interface SystemInfo {
  id: string;
  name: string;
  media: string;
  verified: boolean;
  ready: SystemReadiness;
  games: number;
}

export interface GameItem {
  id: string;
  name: string;
  system: string;
  sizeMB: number;
}

export interface LibraryPage {
  system: string;
  ready: SystemReadiness;
  total: number;
  page: number;
  size: number;
  items: GameItem[];
}

export type GameControl = 'pause' | 'resume' | 'reset' | 'loadstate' | 'savestate' | 'quit' | 'swap';

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
  | { action: 'screen'; state: 'sleep' | 'wake' }
  | { action: 'queueremove'; index: number }
  | { action: 'queuereorder'; fromIndex: number; toIndex: number }
  | { action: 'queuejump'; index: number }
  // Game Mode (protocol v2)
  | { action: 'hello'; v: 2 }
  | { action: 'mode'; target: 'video' | 'game'; force?: boolean }
  | { action: 'systems' }
  | { action: 'library'; system: string; page?: number; size?: number }
  | { action: 'launchgame'; gameId: string }
  | { action: 'gamectl'; op: GameControl }
  | { action: 'ping' };
