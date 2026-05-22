import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import {DeviceEventEmitter, PermissionsAndroid, Platform} from 'react-native';
import RNBluetoothClassic, {
  BluetoothDevice,
} from 'react-native-bluetooth-classic';
import {PiCommand, PiStatus} from '../types/protocol';

interface BluetoothContextValue {
  connected: boolean;
  connecting: boolean;
  connectedDevice: BluetoothDevice | null;
  pairedDevices: BluetoothDevice[];
  piStatus: PiStatus;
  fileList: string[];
  error: string | null;
  piIp: string;
  setPiIp: (ip: string) => void;
  requestPermissions: () => Promise<boolean>;
  loadPairedDevices: () => Promise<void>;
  connect: (device: BluetoothDevice) => Promise<void>;
  disconnect: () => Promise<void>;
  sendCommand: (cmd: PiCommand) => Promise<void>;
  requestFileList: () => Promise<void>;
}

const DEFAULT_STATUS: PiStatus = {
  status: 'idle',
  file: null,
  pos: 0,
  duration: 0,
  volume: 75,
};

const BluetoothContext = createContext<BluetoothContextValue | null>(null);

export function BluetoothProvider({children}: {children: React.ReactNode}) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectedDevice, setConnectedDevice] =
    useState<BluetoothDevice | null>(null);
  const [pairedDevices, setPairedDevices] = useState<BluetoothDevice[]>([]);
  const [piStatus, setPiStatus] = useState<PiStatus>(DEFAULT_STATUS);
  const [fileList, setFileList] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [piIp, setPiIp] = useState<string>('');

  const deviceRef = useRef<BluetoothDevice | null>(null);
  const dataSub = useRef<any>(null);
  const disconnectSub = useRef<any>(null);
  const buffer = useRef('');

  const cleanup = useCallback(() => {
    try { dataSub.current?.remove(); } catch {}
    try { disconnectSub.current?.remove(); } catch {}
    dataSub.current = null;
    disconnectSub.current = null;
    deviceRef.current = null;
    buffer.current = '';
  }, []);

  const handleData = useCallback((raw: any) => {
    // raw may be a string or an event object depending on the library version
    const text: string =
      typeof raw === 'string'
        ? raw
        : raw?.data ?? raw?.message ?? JSON.stringify(raw);

    buffer.current += text;
    const lines = buffer.current.split('\n');
    buffer.current = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const msg = JSON.parse(trimmed);
        if (Array.isArray(msg.files)) {
          setFileList(msg.files);
        }
        if (msg.status) {
          setPiStatus({
            status: msg.status,
            file: msg.file ?? null,
            pos: msg.pos ?? 0,
            duration: msg.duration ?? 0,
            volume: msg.volume ?? 75,
          });
        }
      } catch {
        // ignore malformed JSON
      }
    }
  }, []);

  const requestPermissions = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== 'android') {
      return true;
    }
    if (Platform.Version >= 31) {
      const results = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      ]);
      return (
        results['android.permission.BLUETOOTH_CONNECT'] === 'granted' &&
        results['android.permission.BLUETOOTH_SCAN'] === 'granted'
      );
    }
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    );
    return result === 'granted';
  }, []);

  const loadPairedDevices = useCallback(async () => {
    try {
      const devices = await RNBluetoothClassic.getBondedDevices();
      setPairedDevices(devices);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load paired devices');
    }
  }, []);

  const connect = useCallback(
    async (device: BluetoothDevice) => {
      try {
        setConnecting(true);
        setError(null);
        cleanup();

        // Android BT Classic frequently fails on the first attempt with
        // "read failed, socket might closed" — retry once automatically.
        let dev: BluetoothDevice;
        try {
          dev = await RNBluetoothClassic.connectToDevice(device.address);
        } catch {
          await new Promise(r => setTimeout(r, 600));
          dev = await RNBluetoothClassic.connectToDevice(device.address);
        }
        deviceRef.current = dev;
        setConnectedDevice(dev);
        setConnected(true);

        const handleDisconnect = () => {
          cleanup();
          setConnected(false);
          setConnectedDevice(null);
          setPiStatus(DEFAULT_STATUS);
          setFileList([]);
        };

        // ── Data subscription ───────────────────────────────────────────────
        // The library's NativeEventEmitter is wired to a stub NativeModule,
        // so events never arrive through it. Use DeviceEventEmitter directly
        // (the global RN event bus that native modules actually emit into),
        // and activate native event sending via the real native module.
        const readEventType = `DEVICE_READ@${dev.address}`;
        try {
          (RNBluetoothClassic as any)._nativeModule?.addListener?.(readEventType);
        } catch {}
        dataSub.current = DeviceEventEmitter.addListener(
          readEventType,
          (event: any) => {
            // Java's read() strips the delimiter before firing the event.
            // Re-add '\n' so handleData's newline-split logic sees a complete message.
            handleData((event?.data ?? '') + '\n');
          },
        );

        // ── Disconnect subscription ─────────────────────────────────────────
        const disconnectEventType = 'DEVICE_DISCONNECTED';
        try {
          (RNBluetoothClassic as any)._nativeModule?.addListener?.(disconnectEventType);
        } catch {}
        disconnectSub.current = DeviceEventEmitter.addListener(
          disconnectEventType,
          (event: any) => {
            if (event?.device?.address === dev.address) {
              handleDisconnect();
            }
          },
        );

        // Request file list immediately after connecting
        try {
          await dev.write(JSON.stringify({action: 'list'}) + '\n');
        } catch {
          // write may fail silently on first connect; Browse tab can retry
        }
      } catch (e: any) {
        setError(e?.message ?? 'Connection failed');
        cleanup();
        setConnected(false);
        setConnectedDevice(null);
      } finally {
        setConnecting(false);
      }
    },
    [cleanup, handleData],
  );

  const disconnect = useCallback(async () => {
    try {
      await deviceRef.current?.disconnect();
    } catch {}
    cleanup();
    setConnected(false);
    setConnectedDevice(null);
    setPiStatus(DEFAULT_STATUS);
    setFileList([]);
  }, [cleanup]);

  const sendCommand = useCallback(async (cmd: PiCommand) => {
    if (!deviceRef.current) {
      return;
    }
    try {
      await deviceRef.current.write(JSON.stringify(cmd) + '\n');
    } catch (e: any) {
      setError(e?.message ?? 'Send failed');
    }
  }, []);

  const requestFileList = useCallback(async () => {
    await sendCommand({action: 'list'});
  }, [sendCommand]);

  return (
    <BluetoothContext.Provider
      value={{
        connected,
        connecting,
        connectedDevice,
        pairedDevices,
        piStatus,
        fileList,
        error,
        piIp,
        setPiIp,
        requestPermissions,
        loadPairedDevices,
        connect,
        disconnect,
        sendCommand,
        requestFileList,
      }}>
      {children}
    </BluetoothContext.Provider>
  );
}

export function useBluetooth(): BluetoothContextValue {
  const ctx = useContext(BluetoothContext);
  if (!ctx) {
    throw new Error('useBluetooth must be used inside BluetoothProvider');
  }
  return ctx;
}
