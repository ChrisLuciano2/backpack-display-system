import React, {useCallback} from 'react';
import {ScrollView, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {useBluetooth} from '../context/BluetoothContext';

export default function QueueScreen() {
  const {connected, piStatus, sendCommand} = useBluetooth();
  const {file, status, queue} = piStatus;
  const hasNowPlaying = status === 'playing' || status === 'paused';

  const onJump = useCallback(
    (index: number) => sendCommand({action: 'queuejump', index}),
    [sendCommand],
  );

  const onRemove = useCallback(
    (index: number) => sendCommand({action: 'queueremove', index}),
    [sendCommand],
  );

  const onMoveUp = useCallback(
    (index: number) => {
      if (index === 0) {return;}
      sendCommand({action: 'queuereorder', fromIndex: index, toIndex: index - 1});
    },
    [sendCommand],
  );

  const onMoveDown = useCallback(
    (index: number) => {
      if (index === queue.length - 1) {return;}
      sendCommand({action: 'queuereorder', fromIndex: index, toIndex: index + 1});
    },
    [sendCommand, queue.length],
  );

  const onClear = useCallback(() => {
    sendCommand({action: 'clearqueue'});
  }, [sendCommand]);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Queue</Text>
        {connected && queue.length > 0 && (
          <TouchableOpacity style={styles.clearBtn} onPress={onClear}>
            <Text style={styles.clearBtnText}>🗑 Clear</Text>
          </TouchableOpacity>
        )}
      </View>

      {!connected ? (
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>📡</Text>
          <Text style={styles.emptyText}>Not connected to Pi</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          {/* Now playing */}
          <View style={styles.sectionLabelRow}>
            <Text style={styles.sectionLabel}>NOW PLAYING</Text>
          </View>
          {hasNowPlaying && file ? (
            <View style={styles.nowPlayingRow}>
              <Text style={styles.nowPlayingIcon}>
                {status === 'playing' ? '▶' : '⏸'}
              </Text>
              <Text style={styles.nowPlayingText} numberOfLines={1}>
                {file}
              </Text>
            </View>
          ) : (
            <View style={styles.nowPlayingRow}>
              <Text style={styles.nowPlayingEmpty}>Nothing playing</Text>
            </View>
          )}

          {/* Up next */}
          <View style={styles.sectionLabelRow}>
            <Text style={styles.sectionLabel}>UP NEXT</Text>
            <Text style={styles.sectionCount}>{queue.length}</Text>
          </View>

          {queue.length === 0 ? (
            <View style={styles.centered}>
              <Text style={styles.emptyIcon}>🎞️</Text>
              <Text style={styles.emptyText}>Queue is empty</Text>
              <Text style={styles.emptyHint}>
                Add files from Browse to queue them up
              </Text>
            </View>
          ) : (
            <View style={styles.queueList}>
              {queue.map((item, index) => (
                <React.Fragment key={`${item}-${index}`}>
                  <View style={styles.queueRow}>
                    <Text style={styles.queuePosition}>{index + 1}</Text>

                    <TouchableOpacity
                      style={styles.queueRowMain}
                      onPress={() => onJump(index)}>
                      <Text style={styles.queueFileName} numberOfLines={1}>
                        {item}
                      </Text>
                    </TouchableOpacity>

                    <View style={styles.reorderBtns}>
                      <TouchableOpacity
                        style={[styles.reorderBtn, index === 0 && styles.disabledBtn]}
                        onPress={() => onMoveUp(index)}
                        disabled={index === 0}>
                        <Text style={styles.reorderBtnText}>▲</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.reorderBtn,
                          index === queue.length - 1 && styles.disabledBtn,
                        ]}
                        onPress={() => onMoveDown(index)}
                        disabled={index === queue.length - 1}>
                        <Text style={styles.reorderBtnText}>▼</Text>
                      </TouchableOpacity>
                    </View>

                    <TouchableOpacity
                      style={styles.removeBtn}
                      onPress={() => onRemove(index)}>
                      <Text style={styles.removeBtnText}>✕</Text>
                    </TouchableOpacity>
                  </View>
                  {index < queue.length - 1 && <View style={styles.separator} />}
                </React.Fragment>
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  clearBtn: {
    backgroundColor: '#1E1E1E',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#3a1a1a',
  },
  clearBtnText: {
    color: '#F44336',
    fontSize: 13,
    fontWeight: '500',
  },
  scroll: {
    paddingBottom: 24,
  },
  sectionLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginTop: 16,
    marginBottom: 8,
  },
  sectionLabel: {
    color: '#9E9E9E',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    flex: 1,
  },
  sectionCount: {
    color: '#444',
    fontSize: 12,
  },
  nowPlayingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A2A3A',
    borderRadius: 12,
    marginHorizontal: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 12,
  },
  nowPlayingIcon: {
    fontSize: 16,
    color: '#2196F3',
    width: 20,
    textAlign: 'center',
  },
  nowPlayingText: {
    flex: 1,
    color: '#2196F3',
    fontSize: 15,
    fontWeight: '600',
  },
  nowPlayingEmpty: {
    color: '#616161',
    fontSize: 14,
  },
  queueList: {
    backgroundColor: '#1E1E1E',
    borderRadius: 12,
    marginHorizontal: 16,
    overflow: 'hidden',
  },
  queueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingLeft: 4,
  },
  queuePosition: {
    width: 24,
    textAlign: 'center',
    color: '#444',
    fontSize: 13,
  },
  queueRowMain: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  queueFileName: {
    color: '#FFFFFF',
    fontSize: 14,
  },
  reorderBtns: {
    flexDirection: 'column',
  },
  reorderBtn: {
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  reorderBtnText: {
    color: '#2196F3',
    fontSize: 11,
  },
  disabledBtn: {
    opacity: 0.2,
  },
  removeBtn: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeBtnText: {
    color: '#F44336',
    fontSize: 15,
  },
  separator: {
    height: 1,
    backgroundColor: '#2a2a2a',
    marginLeft: 34,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 32,
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: 4,
  },
  emptyText: {
    color: '#9E9E9E',
    fontSize: 15,
  },
  emptyHint: {
    color: '#616161',
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
});
