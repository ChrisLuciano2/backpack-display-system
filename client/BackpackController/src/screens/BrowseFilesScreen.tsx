import React, {useCallback, useEffect} from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useBluetooth} from '../context/BluetoothContext';

export default function BrowseFilesScreen() {
  const {connected, fileList, piStatus, sendCommand, requestFileList} =
    useBluetooth();

  useEffect(() => {
    if (connected && fileList.length === 0) {
      requestFileList();
    }
  }, [connected, fileList.length, requestFileList]);

  const onPlay = useCallback(
    (file: string) => {
      sendCommand({action: 'play', file});
    },
    [sendCommand],
  );

  const renderItem = useCallback(
    ({item}: {item: string}) => {
      const isPlaying =
        piStatus.file === item &&
        (piStatus.status === 'playing' || piStatus.status === 'paused');

      return (
        <TouchableOpacity
          style={[styles.fileRow, isPlaying && styles.fileRowActive]}
          onPress={() => onPlay(item)}
          disabled={!connected}>
          <Text style={styles.fileIcon}>{isPlaying ? '▶' : '🎬'}</Text>
          <Text
            style={[styles.fileName, isPlaying && styles.fileNameActive]}
            numberOfLines={1}>
            {item}
          </Text>
          {isPlaying && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {piStatus.status === 'playing' ? 'Playing' : 'Paused'}
              </Text>
            </View>
          )}
        </TouchableOpacity>
      );
    },
    [connected, onPlay, piStatus.file, piStatus.status],
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Media Files</Text>
        <TouchableOpacity
          style={[styles.refreshBtn, !connected && styles.disabledBtn]}
          onPress={requestFileList}
          disabled={!connected}>
          <Text style={styles.refreshText}>↻ Refresh</Text>
        </TouchableOpacity>
      </View>

      {!connected ? (
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>📡</Text>
          <Text style={styles.emptyText}>Not connected to Pi</Text>
          <Text style={styles.emptyHint}>
            Go to Settings to connect via Bluetooth
          </Text>
        </View>
      ) : fileList.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator color="#2196F3" size="large" />
          <Text style={styles.emptyText}>Loading files...</Text>
        </View>
      ) : (
        <FlatList
          data={fileList}
          keyExtractor={item => item}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}

      {connected && fileList.length > 0 && (
        <Text style={styles.countText}>
          {fileList.length} file{fileList.length !== 1 ? 's' : ''} on Pi
        </Text>
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
  refreshBtn: {
    backgroundColor: '#1E1E1E',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  disabledBtn: {
    opacity: 0.3,
  },
  refreshText: {
    color: '#2196F3',
    fontSize: 14,
    fontWeight: '500',
  },
  list: {
    paddingVertical: 8,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  fileRowActive: {
    backgroundColor: '#1A2A3A',
  },
  fileIcon: {
    fontSize: 20,
    width: 28,
    textAlign: 'center',
  },
  fileName: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 15,
  },
  fileNameActive: {
    color: '#2196F3',
    fontWeight: '600',
  },
  badge: {
    backgroundColor: '#2196F3',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
  },
  separator: {
    height: 1,
    backgroundColor: '#1E1E1E',
    marginLeft: 56,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 8,
  },
  emptyText: {
    color: '#9E9E9E',
    fontSize: 16,
  },
  emptyHint: {
    color: '#616161',
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  countText: {
    color: '#616161',
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: 8,
  },
});
