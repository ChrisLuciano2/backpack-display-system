import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useBluetooth} from '../context/BluetoothContext';
import {GameControl, SystemInfo} from '../types/protocol';

// Why a system cannot be played, in plain words.
const NOT_READY_TEXT: Record<string, string> = {
  no_core: 'Emulator not installed',
  needs_bios: 'Needs a BIOS file',
  empty: 'No games yet',
};

export default function GamesScreen() {
  const {
    connected,
    piStatus,
    systems,
    library,
    notice,
    clearNotice,
    error,
    sendCommand,
  } = useBluetooth();
  const {mode, phase, game} = piStatus;
  const [system, setSystem] = useState<string | null>(null);

  // Ask for the list of systems whenever the game menu is showing.
  useEffect(() => {
    if (connected && mode === 'game' && phase === 'menu') {
      sendCommand({action: 'systems'});
    }
  }, [connected, mode, phase, sendCommand]);

  // Start from the system list again after a game or a mode change.
  useEffect(() => {
    if (mode !== 'game' || phase === 'playing') {
      setSystem(null);
    }
  }, [mode, phase]);

  const toGameMode = useCallback(() => {
    sendCommand({action: 'mode', target: 'game'});
  }, [sendCommand]);

  const toVideoMode = useCallback(() => {
    const running = phase === 'playing' || phase === 'launching';
    if (!running) {
      sendCommand({action: 'mode', target: 'video', force: true});
      return;
    }
    Alert.alert(
      'Leave the game?',
      'A game is running. Going back to Video Mode will end it.',
      [
        {text: 'Keep playing', style: 'cancel'},
        {
          text: 'Leave',
          style: 'destructive',
          onPress: () =>
            sendCommand({action: 'mode', target: 'video', force: true}),
        },
      ],
    );
  }, [phase, sendCommand]);

  const control = useCallback(
    (op: GameControl) => sendCommand({action: 'gamectl', op}),
    [sendCommand],
  );

  const pickSystem = useCallback(
    (s: SystemInfo) => {
      setSystem(s.id);
      sendCommand({action: 'library', system: s.id, page: 0, size: 100});
    },
    [sendCommand],
  );

  const launch = useCallback(
    (gameId: string) => sendCommand({action: 'launchgame', gameId}),
    [sendCommand],
  );

  if (!connected) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.bigIcon}>📡</Text>
        <Text style={styles.emptyText}>Not connected to Pi</Text>
      </View>
    );
  }

  const modeLabel =
    mode === 'game'
      ? 'Game Mode'
      : mode === 'switching'
      ? 'Switching…'
      : mode === 'error'
      ? 'Video Mode is restarting…'
      : 'Video Mode';

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Games</Text>
        <View style={[styles.pill, mode === 'game' && styles.pillGame]}>
          <Text style={styles.pillText}>{modeLabel}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}
        {notice ? (
          <TouchableOpacity style={styles.noticeBanner} onPress={clearNotice}>
            <Text style={styles.noticeText}>{notice} (tap to dismiss)</Text>
          </TouchableOpacity>
        ) : null}

        {/* ── Video Mode: one big button ─────────────────────────────── */}
        {mode === 'video' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Ready for games</Text>
            <Text style={styles.cardText}>
              Game Mode stops the video player and starts the game console.
              Video comes back where it left off.
            </Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={toGameMode}>
              <Text style={styles.primaryBtnText}>🎮  Switch to Game Mode</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Switching or recovering ────────────────────────────────── */}
        {(mode === 'switching' || mode === 'error') && (
          <View style={[styles.card, styles.centeredCard]}>
            <ActivityIndicator color="#2196F3" size="large" />
            <Text style={styles.cardText}>
              {mode === 'error'
                ? 'Video Mode did not start. Trying again…'
                : 'Switching. This takes a few seconds.'}
            </Text>
          </View>
        )}

        {/* ── Game Mode ──────────────────────────────────────────────── */}
        {mode === 'game' && phase === 'launching' && (
          <View style={[styles.card, styles.centeredCard]}>
            <ActivityIndicator color="#2196F3" size="large" />
            <Text style={styles.cardTitle}>
              Starting {game?.name ?? 'the game'}…
            </Text>
            <Text style={styles.cardText}>
              The screen stays black for about 5 seconds.
            </Text>
          </View>
        )}

        {mode === 'game' && phase === 'playing' && (
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>Now playing</Text>
            <Text style={styles.gameName}>{game?.name ?? 'A game'}</Text>
            <View style={styles.row}>
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => control('pause')}>
                <Text style={styles.secondaryBtnText}>⏸  Pause</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => control('resume')}>
                <Text style={styles.secondaryBtnText}>▶  Resume</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.row}>
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => control('reset')}>
                <Text style={styles.secondaryBtnText}>↺  Restart</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => control('quit')}>
                <Text style={styles.secondaryBtnText}>⏹  Back to menu</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.hint}>
              Players can also press the controller's Home button for the pause
              menu.
            </Text>
          </View>
        )}

        {mode === 'game' && phase === 'menu' && (
          <View>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Pick a game</Text>
              <Text style={styles.cardText}>
                Players can choose on the screen with a controller (Playlists),
                or you can start one from here.
              </Text>
            </View>

            {system === null ? (
              <View style={styles.list}>
                {systems.length === 0 ? (
                  <Text style={styles.dimText}>Loading systems…</Text>
                ) : (
                  systems.map(s => {
                    const ok = s.ready === 'ready';
                    return (
                      <TouchableOpacity
                        key={s.id}
                        disabled={!ok}
                        style={[styles.listRow, !ok && styles.listRowOff]}
                        onPress={() => pickSystem(s)}>
                        <Text style={styles.listName}>{s.name}</Text>
                        <Text style={styles.listMeta}>
                          {ok
                            ? `${s.games} game${s.games === 1 ? '' : 's'}`
                            : NOT_READY_TEXT[s.ready] ?? s.ready}
                        </Text>
                      </TouchableOpacity>
                    );
                  })
                )}
              </View>
            ) : (
              <View style={styles.list}>
                <TouchableOpacity
                  style={styles.backRow}
                  onPress={() => setSystem(null)}>
                  <Text style={styles.backText}>‹  All systems</Text>
                </TouchableOpacity>
                {library && library.system === system ? (
                  library.items.map(g => (
                    <TouchableOpacity
                      key={g.id}
                      style={styles.listRow}
                      onPress={() => launch(g.id)}>
                      <Text style={styles.listName}>{g.name}</Text>
                      <Text style={styles.listMeta}>▶</Text>
                    </TouchableOpacity>
                  ))
                ) : (
                  <Text style={styles.dimText}>Loading games…</Text>
                )}
              </View>
            )}
          </View>
        )}

        {mode === 'game' && (
          <TouchableOpacity style={styles.leaveBtn} onPress={toVideoMode}>
            <Text style={styles.leaveBtnText}>🎬  Back to Video Mode</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#121212'},
  centered: {alignItems: 'center', justifyContent: 'center'},
  bigIcon: {fontSize: 40, marginBottom: 8},
  emptyText: {color: '#9E9E9E', fontSize: 15},
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  title: {color: '#FFFFFF', fontSize: 18, fontWeight: '600'},
  pill: {
    backgroundColor: '#1E1E1E',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  pillGame: {backgroundColor: '#1A2A3A', borderColor: '#2196F3'},
  pillText: {color: '#FFFFFF', fontSize: 12, fontWeight: '600'},
  scroll: {padding: 16, paddingBottom: 32, gap: 12},
  errorBanner: {
    backgroundColor: '#3a1a1a',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#F44336',
  },
  errorText: {color: '#FF8A80', fontSize: 13},
  noticeBanner: {
    backgroundColor: '#3a321a',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#FFB74D',
  },
  noticeText: {color: '#FFD180', fontSize: 13},
  card: {
    backgroundColor: '#1E1E1E',
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  centeredCard: {alignItems: 'center'},
  cardTitle: {color: '#FFFFFF', fontSize: 16, fontWeight: '600'},
  cardText: {color: '#BDBDBD', fontSize: 14, lineHeight: 20},
  sectionLabel: {
    color: '#9E9E9E',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  gameName: {color: '#2196F3', fontSize: 20, fontWeight: '700'},
  hint: {color: '#757575', fontSize: 12, lineHeight: 17},
  row: {flexDirection: 'row', gap: 10},
  primaryBtn: {
    backgroundColor: '#2196F3',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  primaryBtnText: {color: '#FFFFFF', fontSize: 16, fontWeight: '700'},
  secondaryBtn: {
    flex: 1,
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryBtnText: {color: '#FFFFFF', fontSize: 14, fontWeight: '600'},
  leaveBtn: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#3a3a3a',
    marginTop: 8,
  },
  leaveBtnText: {color: '#E0E0E0', fontSize: 15, fontWeight: '600'},
  list: {
    backgroundColor: '#1E1E1E',
    borderRadius: 14,
    overflow: 'hidden',
    marginTop: 12,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  listRowOff: {opacity: 0.45},
  listName: {color: '#FFFFFF', fontSize: 15, flex: 1},
  listMeta: {color: '#9E9E9E', fontSize: 13},
  backRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  backText: {color: '#2196F3', fontSize: 14, fontWeight: '600'},
  dimText: {color: '#757575', fontSize: 14, padding: 16},
});
