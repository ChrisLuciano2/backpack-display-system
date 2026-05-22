import React, {useCallback, useState} from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import SeekBar from '../components/SeekBar';
import {useBluetooth} from '../context/BluetoothContext';

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

type DisplayMode = 'contain' | 'cover' | 'stretch';

const DISPLAY_MODES: {mode: DisplayMode; label: string; hint: string}[] = [
  {mode: 'contain', label: 'Fit',     hint: 'Black bars, full content'},
  {mode: 'cover',   label: 'Fill',    hint: 'Crops edges to fill screen'},
  {mode: 'stretch', label: 'Stretch', hint: 'Stretches to fill screen'},
];

export default function NowPlayingScreen() {
  const {connected, piStatus, sendCommand} = useBluetooth();
  const {status, file, pos, duration, volume} = piStatus;
  const isPlaying = status === 'playing';
  const hasMedia = status === 'playing' || status === 'paused';
  const progress = duration > 0 ? pos / duration : 0;
  const [displayMode, setDisplayMode] = useState<DisplayMode>('contain');

  const onPlayPause = useCallback(() => {
    sendCommand(isPlaying ? {action: 'pause'} : {action: 'resume'});
  }, [isPlaying, sendCommand]);

  const onStop = useCallback(() => {
    sendCommand({action: 'stop'});
  }, [sendCommand]);

  const onPrev = useCallback(() => {
    sendCommand({action: 'prev'});
  }, [sendCommand]);

  const onNext = useCallback(() => {
    sendCommand({action: 'next'});
  }, [sendCommand]);

  const onSeek = useCallback(
    (value: number) => {
      sendCommand({action: 'seek', seconds: Math.floor(value * duration)});
    },
    [duration, sendCommand],
  );

  const onVolume = useCallback(
    (value: number) => {
      // SeekBar gives 0..1; volume command expects 0..100
      sendCommand({action: 'volume', level: Math.round(value * 100)});
    },
    [sendCommand],
  );

  const onRotate = useCallback(
    (angle: number) => {
      sendCommand({action: 'rotate', angle});
    },
    [sendCommand],
  );

  const onDisplayMode = useCallback(
    (mode: DisplayMode) => {
      setDisplayMode(mode);
      sendCommand({action: 'displaymode', mode});
    },
    [sendCommand],
  );

  return (
    <View style={styles.container}>
      {/* Status bar */}
      <View style={styles.statusRow}>
        <View
          style={[
            styles.statusDot,
            {backgroundColor: connected ? '#4CAF50' : '#F44336'},
          ]}
        />
        <Text style={styles.statusText}>
          {connected ? 'Connected' : 'Not Connected'}
        </Text>
      </View>

      {/* Artwork placeholder */}
      <View style={styles.artwork}>
        <Text style={styles.artworkIcon}>{hasMedia ? '🎬' : '📺'}</Text>
      </View>

      {/* File name */}
      <Text style={styles.fileName} numberOfLines={2}>
        {file ?? 'Nothing playing'}
      </Text>
      <Text style={styles.statusLabel}>
        {status === 'playing'
          ? 'Playing'
          : status === 'paused'
          ? 'Paused'
          : status === 'stopped'
          ? 'Stopped'
          : 'Idle'}
      </Text>

      {/* Progress */}
      <View style={styles.progressRow}>
        <Text style={styles.timeText}>{formatTime(pos)}</Text>
        <View style={styles.seekBarWrap}>
          <SeekBar
            value={progress}
            onSlidingComplete={onSeek}
            minimumTrackTintColor="#2196F3"
            maximumTrackTintColor="#444"
            thumbTintColor="#2196F3"
            disabled={!hasMedia || !connected}
          />
        </View>
        <Text style={styles.timeText}>{formatTime(duration)}</Text>
      </View>

      {/* Transport controls */}
      <View style={styles.controls}>
        <TouchableOpacity
          style={styles.controlBtn}
          onPress={onPrev}
          disabled={!connected}>
          <Text style={[styles.controlIcon, !connected && styles.disabled]}>
            ⏮
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.controlBtn, styles.playBtn]}
          onPress={onPlayPause}
          disabled={!connected}>
          <Text style={styles.playIcon}>{isPlaying ? '⏸' : '▶'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.controlBtn}
          onPress={onStop}
          disabled={!connected}>
          <Text style={[styles.controlIcon, !connected && styles.disabled]}>
            ⏹
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.controlBtn}
          onPress={onNext}
          disabled={!connected}>
          <Text style={[styles.controlIcon, !connected && styles.disabled]}>
            ⏭
          </Text>
        </TouchableOpacity>
      </View>

      {/* Volume */}
      <View style={styles.volumeRow}>
        <Text style={styles.volumeLabel}>🔈</Text>
        <View style={styles.seekBarWrap}>
          <SeekBar
            value={volume / 100}
            onSlidingComplete={onVolume}
            minimumTrackTintColor="#2196F3"
            maximumTrackTintColor="#444"
            thumbTintColor="#2196F3"
            disabled={!connected}
          />
        </View>
        <Text style={styles.volumeLabel}>🔊</Text>
      </View>

      {/* Rotation */}
      <View style={styles.rotateRow}>
        <Text style={styles.rotateLabel}>🔄</Text>
        {[0, 90, 180, 270].map(angle => (
          <TouchableOpacity
            key={angle}
            style={[styles.rotateBtn, !connected && styles.disabledBtn]}
            onPress={() => onRotate(angle)}
            disabled={!connected}>
            <Text style={styles.rotateBtnText}>{angle}°</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Display fit mode */}
      <View style={styles.displayModeRow}>
        <Text style={styles.displayModeLabel}>🖥</Text>
        {DISPLAY_MODES.map(({mode, label}) => (
          <TouchableOpacity
            key={mode}
            style={[
              styles.displayModeBtn,
              displayMode === mode && styles.displayModeBtnActive,
              !connected && styles.disabledBtn,
            ]}
            onPress={() => onDisplayMode(mode)}
            disabled={!connected}>
            <Text
              style={[
                styles.displayModeBtnText,
                displayMode === mode && styles.displayModeBtnTextActive,
              ]}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {!connected && (
        <Text style={styles.hint}>Go to Settings to connect to the Pi</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 16,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    marginBottom: 16,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 6,
  },
  statusText: {
    color: '#9E9E9E',
    fontSize: 13,
  },
  artwork: {
    width: 200,
    height: 200,
    borderRadius: 12,
    backgroundColor: '#1E1E1E',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  artworkIcon: {
    fontSize: 80,
  },
  fileName: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 4,
  },
  statusLabel: {
    color: '#9E9E9E',
    fontSize: 14,
    marginBottom: 24,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    marginBottom: 24,
  },
  seekBarWrap: {
    flex: 1,
  },
  timeText: {
    color: '#9E9E9E',
    fontSize: 12,
    width: 36,
    textAlign: 'center',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    marginBottom: 32,
  },
  controlBtn: {
    padding: 12,
  },
  playBtn: {
    backgroundColor: '#2196F3',
    borderRadius: 40,
    width: 72,
    height: 72,
    justifyContent: 'center',
    alignItems: 'center',
  },
  controlIcon: {
    fontSize: 28,
    color: '#FFFFFF',
  },
  playIcon: {
    fontSize: 28,
    color: '#FFFFFF',
  },
  disabled: {
    opacity: 0.3,
  },
  volumeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
  },
  volumeLabel: {
    fontSize: 20,
    width: 28,
    textAlign: 'center',
  },
  rotateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 20,
    marginBottom: 8,
  },
  rotateLabel: {
    fontSize: 18,
    marginRight: 4,
  },
  rotateBtn: {
    backgroundColor: '#1E1E1E',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  disabledBtn: {
    opacity: 0.3,
  },
  rotateBtnText: {
    color: '#2196F3',
    fontSize: 14,
    fontWeight: '600',
  },
  displayModeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    marginBottom: 8,
  },
  displayModeLabel: {
    fontSize: 18,
    marginRight: 4,
  },
  displayModeBtn: {
    backgroundColor: '#1E1E1E',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  displayModeBtnActive: {
    backgroundColor: '#1A2A3A',
    borderColor: '#2196F3',
  },
  displayModeBtnText: {
    color: '#9E9E9E',
    fontSize: 13,
    fontWeight: '500',
  },
  displayModeBtnTextActive: {
    color: '#2196F3',
    fontWeight: '700',
  },
  hint: {
    color: '#616161',
    fontSize: 13,
    marginTop: 24,
    textAlign: 'center',
  },
});
