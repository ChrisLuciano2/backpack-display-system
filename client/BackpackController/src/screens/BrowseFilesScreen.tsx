import React, {useCallback, useEffect} from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useBluetooth} from '../context/BluetoothContext';

// Emoji icon for a file based on its extension
function fileIcon(name: string, isActive: boolean): string {
  if (isActive) {return '▶';}
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['gif'].includes(ext))                          {return '🎞';}
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext))  {return '🖼️';}
  return '🎬';
}

interface SectionProps {
  title: string;
  emoji: string;
  files: string[];
  connected: boolean;
  activeFile: string | null;
  activeStatus: string;
  onPlay: (file: string) => void;
}

function Section({title, emoji, files, connected, activeFile, activeStatus, onPlay}: SectionProps) {
  if (files.length === 0) {return null;}
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionEmoji}>{emoji}</Text>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionCount}>{files.length}</Text>
      </View>
      <View style={styles.sectionList}>
        {files.map((item, index) => {
          const isActive =
            activeFile === item &&
            (activeStatus === 'playing' || activeStatus === 'paused');
          return (
            <React.Fragment key={item}>
              <TouchableOpacity
                style={[styles.fileRow, isActive && styles.fileRowActive]}
                onPress={() => onPlay(item)}
                disabled={!connected}>
                <Text style={styles.fileIconText}>
                  {fileIcon(item, isActive)}
                </Text>
                <Text
                  style={[styles.fileName, isActive && styles.fileNameActive]}
                  numberOfLines={1}>
                  {item}
                </Text>
                {isActive && (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>
                      {activeStatus === 'playing' ? 'Playing' : 'Paused'}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
              {index < files.length - 1 && <View style={styles.separator} />}
            </React.Fragment>
          );
        })}
      </View>
    </View>
  );
}

export default function BrowseFilesScreen() {
  const {
    connected,
    fileList,
    movieList,
    mediaList,
    piStatus,
    sendCommand,
    requestFileList,
  } = useBluetooth();

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

  const totalCount = fileList.length;
  const hasGroups = movieList.length > 0 || mediaList.length > 0;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Browse</Text>
        <TouchableOpacity
          style={[styles.refreshBtn, !connected && styles.disabledBtn]}
          onPress={requestFileList}
          disabled={!connected}>
          <Text style={styles.refreshText}>↻ Refresh</Text>
        </TouchableOpacity>
      </View>

      {/* Body */}
      {!connected ? (
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>📡</Text>
          <Text style={styles.emptyText}>Not connected to Pi</Text>
          <Text style={styles.emptyHint}>
            Go to Settings to connect via Bluetooth
          </Text>
        </View>
      ) : totalCount === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator color="#2196F3" size="large" />
          <Text style={styles.emptyText}>Loading files…</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          {hasGroups ? (
            <>
              <Section
                title="Movies"
                emoji="🎬"
                files={movieList}
                connected={connected}
                activeFile={piStatus.file}
                activeStatus={piStatus.status}
                onPlay={onPlay}
              />
              <Section
                title="Media"
                emoji="🖼️"
                files={mediaList}
                connected={connected}
                activeFile={piStatus.file}
                activeStatus={piStatus.status}
                onPlay={onPlay}
              />
            </>
          ) : (
            // Fallback: server hasn't sent grouped data yet — show flat list
            <View style={styles.section}>
              <View style={styles.sectionList}>
                {fileList.map((item, index) => (
                  <React.Fragment key={item}>
                    <TouchableOpacity
                      style={styles.fileRow}
                      onPress={() => onPlay(item)}
                      disabled={!connected}>
                      <Text style={styles.fileIconText}>🎬</Text>
                      <Text style={styles.fileName} numberOfLines={1}>
                        {item}
                      </Text>
                    </TouchableOpacity>
                    {index < fileList.length - 1 && (
                      <View style={styles.separator} />
                    )}
                  </React.Fragment>
                ))}
              </View>
            </View>
          )}

          <Text style={styles.countText}>
            {totalCount} file{totalCount !== 1 ? 's' : ''} on Pi
          </Text>
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
  scroll: {
    paddingBottom: 24,
  },
  section: {
    marginTop: 16,
    marginHorizontal: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  sectionEmoji: {
    fontSize: 16,
  },
  sectionTitle: {
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
  sectionList: {
    backgroundColor: '#1E1E1E',
    borderRadius: 12,
    overflow: 'hidden',
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 12,
  },
  fileRowActive: {
    backgroundColor: '#1A2A3A',
  },
  fileIconText: {
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
    backgroundColor: '#2a2a2a',
    marginLeft: 54,
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
    color: '#444',
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: 16,
  },
});
