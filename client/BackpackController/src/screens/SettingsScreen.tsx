import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {BluetoothDevice} from 'react-native-bluetooth-classic';
import {useBluetooth} from '../context/BluetoothContext';

const APP_VERSION = '1.0.0';
const PI_DEVICE_NAME = 'raspberrypi';

export default function SettingsScreen() {
  const {
    connected,
    connecting,
    connectedDevice,
    pairedDevices,
    error,
    piIp,
    setPiIp,
    requestPermissions,
    loadPairedDevices,
    connect,
    disconnect,
  } = useBluetooth();

  const [ipDraft, setIpDraft] = useState(piIp);
  // Keep the draft in sync when auto-detect updates piIp over Bluetooth
  useEffect(() => {
    setIpDraft(piIp);
  }, [piIp]);

  const [loading, setLoading] = useState(false);

  const onScan = useCallback(async () => {
    setLoading(true);
    const granted = await requestPermissions();
    if (!granted) {
      Alert.alert(
        'Permission Required',
        'Bluetooth permissions are required to connect to the Pi.',
      );
      setLoading(false);
      return;
    }
    await loadPairedDevices();
    setLoading(false);
  }, [loadPairedDevices, requestPermissions]);

  useEffect(() => {
    onScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onConnect = useCallback(
    (device: BluetoothDevice) => {
      Alert.alert(
        'Connect',
        `Connect to ${device.name ?? device.address}?`,
        [
          {text: 'Cancel', style: 'cancel'},
          {text: 'Connect', onPress: () => connect(device)},
        ],
      );
    },
    [connect],
  );

  const onDisconnect = useCallback(() => {
    Alert.alert('Disconnect', 'Disconnect from the Pi?', [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Disconnect', style: 'destructive', onPress: disconnect},
    ]);
  }, [disconnect]);

  const renderDevice = useCallback(
    ({item}: {item: BluetoothDevice}) => {
      const isConnected = connectedDevice?.address === item.address;
      const isPi =
        item.name?.toLowerCase().includes('raspberry') ||
        item.name?.toLowerCase().includes(PI_DEVICE_NAME);

      return (
        <TouchableOpacity
          style={[styles.deviceRow, isConnected && styles.deviceRowActive]}
          onPress={() => (isConnected ? onDisconnect() : onConnect(item))}
          disabled={connecting}>
          <View style={styles.deviceInfo}>
            <Text style={styles.deviceName}>
              {isPi ? '🍓 ' : '📱 '}
              {item.name ?? 'Unknown Device'}
            </Text>
            <Text style={styles.deviceAddress}>{item.address}</Text>
          </View>
          {connecting && connectedDevice?.address === item.address ? (
            <ActivityIndicator color="#2196F3" size="small" />
          ) : (
            <View
              style={[
                styles.connBadge,
                {backgroundColor: isConnected ? '#4CAF50' : '#333'},
              ]}>
              <Text style={styles.connBadgeText}>
                {isConnected ? 'Connected' : 'Tap to connect'}
              </Text>
            </View>
          )}
        </TouchableOpacity>
      );
    },
    [connect, connectedDevice?.address, connecting, onConnect, onDisconnect],
  );

  return (
    <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      {/* Connection status card */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View
            style={[
              styles.statusDot,
              {backgroundColor: connected ? '#4CAF50' : '#F44336'},
            ]}
          />
          <Text style={styles.cardTitle}>
            {connected
              ? `Connected to ${connectedDevice?.name ?? 'Pi'}`
              : 'Not Connected'}
          </Text>
        </View>
        {connected && (
          <TouchableOpacity
            style={styles.disconnectBtn}
            onPress={onDisconnect}>
            <Text style={styles.disconnectText}>Disconnect</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Paired devices */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Paired Devices</Text>
        <TouchableOpacity
          style={styles.scanBtn}
          onPress={onScan}
          disabled={loading || connecting}>
          {loading ? (
            <ActivityIndicator color="#2196F3" size="small" />
          ) : (
            <Text style={styles.scanText}>↻ Scan</Text>
          )}
        </TouchableOpacity>
      </View>

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>⚠ {error}</Text>
        </View>
      )}

      {pairedDevices.length === 0 && !loading ? (
        <View style={styles.emptyDevices}>
          <Text style={styles.emptyText}>No paired devices found</Text>
          <Text style={styles.emptyHint}>
            Pair the Pi with your phone in Android Bluetooth settings first,
            then tap Scan.
          </Text>
        </View>
      ) : (
        <View style={styles.deviceList}>
          {pairedDevices.map((item, index) => (
            <React.Fragment key={item.address}>
              {renderDevice({item})}
              {index < pairedDevices.length - 1 && (
                <View style={styles.separator} />
              )}
            </React.Fragment>
          ))}
        </View>
      )}

      {/* Pi IP address for WiFi uploads */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Wi-Fi Upload Settings</Text>
      </View>
      <View style={styles.ipCard}>
        <Text style={styles.ipLabel}>Pi IP Address</Text>
        <Text style={styles.ipHint}>
          {connected
            ? 'Auto-detected via Bluetooth — or override manually below'
            : 'Connect via Bluetooth to auto-detect, or enter manually'}
        </Text>
        <View style={styles.ipRow}>
          <TextInput
            style={styles.ipInput}
            value={ipDraft}
            onChangeText={setIpDraft}
            placeholder="e.g. 192.168.1.42"
            placeholderTextColor="#616161"
            keyboardType="decimal-pad"
            autoCorrect={false}
            autoCapitalize="none"
          />
          <TouchableOpacity
            style={styles.ipSaveBtn}
            onPress={() => {
              setPiIp(ipDraft.trim());
              Alert.alert('Saved', `Pi IP set to ${ipDraft.trim() || '(cleared)'}`);
            }}>
            <Text style={styles.ipSaveBtnText}>Save</Text>
          </TouchableOpacity>
        </View>
        {piIp ? (
          <Text style={styles.ipSaved}>✓ Saved: {piIp}:3001</Text>
        ) : null}
      </View>

      {/* Info section */}
      <View style={styles.infoSection}>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Protocol</Text>
          <Text style={styles.infoValue}>Bluetooth Classic SPP</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Version</Text>
          <Text style={styles.infoValue}>{APP_VERSION}</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
  },
  card: {
    backgroundColor: '#1E1E1E',
    margin: 16,
    borderRadius: 12,
    padding: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  cardTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  disconnectBtn: {
    marginTop: 12,
    backgroundColor: '#2a2a2a',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  disconnectText: {
    color: '#F44336',
    fontWeight: '600',
    fontSize: 14,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  sectionTitle: {
    color: '#9E9E9E',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  scanBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#1E1E1E',
    borderRadius: 8,
    minWidth: 70,
    alignItems: 'center',
  },
  scanText: {
    color: '#2196F3',
    fontSize: 13,
    fontWeight: '500',
  },
  errorBanner: {
    backgroundColor: '#2a1010',
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#F44336',
  },
  errorText: {
    color: '#F44336',
    fontSize: 13,
  },
  deviceList: {
    backgroundColor: '#1E1E1E',
    marginHorizontal: 16,
    borderRadius: 12,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
  },
  deviceRowActive: {
    backgroundColor: '#1A2A3A',
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '500',
  },
  deviceAddress: {
    color: '#616161',
    fontSize: 12,
    marginTop: 2,
  },
  connBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },
  connBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
  },
  separator: {
    height: 1,
    backgroundColor: '#2a2a2a',
    marginLeft: 14,
  },
  emptyDevices: {
    margin: 16,
    padding: 20,
    backgroundColor: '#1E1E1E',
    borderRadius: 12,
    alignItems: 'center',
    gap: 8,
  },
  emptyText: {
    color: '#9E9E9E',
    fontSize: 15,
  },
  emptyHint: {
    color: '#616161',
    fontSize: 13,
    textAlign: 'center',
  },
  infoSection: {
    margin: 16,
    marginTop: 8,
    marginBottom: 32,
    backgroundColor: '#1E1E1E',
    borderRadius: 12,
    overflow: 'hidden',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  infoLabel: {
    color: '#9E9E9E',
    fontSize: 14,
  },
  infoValue: {
    color: '#FFFFFF',
    fontSize: 14,
  },
  ipCard: {
    backgroundColor: '#1E1E1E',
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  ipLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  ipHint: {
    color: '#616161',
    fontSize: 12,
  },
  ipCode: {
    color: '#9E9E9E',
    fontFamily: 'monospace',
  },
  ipRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  ipInput: {
    flex: 1,
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#FFFFFF',
    fontSize: 15,
  },
  ipSaveBtn: {
    backgroundColor: '#2196F3',
    borderRadius: 8,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  ipSaveBtnText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 14,
  },
  ipSaved: {
    color: '#4CAF50',
    fontSize: 12,
    marginTop: 2,
  },
});
