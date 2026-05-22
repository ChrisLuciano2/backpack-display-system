import React, {useCallback, useRef, useState} from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {isCancel, pick} from '@react-native-documents/picker';
import type {DocumentPickerAsset} from '@react-native-documents/picker';
import {useBluetooth} from '../context/BluetoothContext';

const UPLOAD_PORT = 3001;

// File types the Pi can play / display
const PICK_TYPES = [
  'video/*',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) {return `${bytes} B`;}
  if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`;}
  if (bytes < 1024 * 1024 * 1024) {return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;}
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function UploadScreen() {
  const {piIp} = useBluetooth();

  const [pickedFile, setPickedFile] = useState<DocumentPickerAsset | null>(
    null,
  );
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const [result, setResult] = useState<{ok: boolean; message: string} | null>(
    null,
  );
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<boolean | null>(null); // null = untested

  const xhrRef = useRef<XMLHttpRequest | null>(null);

  // ── Pick a file ──────────────────────────────────────────────────────────

  const pickFile = useCallback(async () => {
    try {
      const results = await pick({
        type: PICK_TYPES,
        copyTo: 'cachesDirectory', // ensures a file:// URI we can stream
        allowMultiSelection: false,
      });
      if (results.length > 0) {
        setPickedFile(results[0]);
        setResult(null);
        setProgress(0);
      }
    } catch (e) {
      if (!isCancel(e)) {
        Alert.alert('Picker Error', String(e));
      }
    }
  }, []);

  // ── Ping the Pi upload server ────────────────────────────────────────────

  const pingPi = useCallback(async () => {
    if (!piIp) {
      Alert.alert('No IP set', 'Enter the Pi IP address in Settings first.');
      return;
    }
    setPinging(true);
    setPingResult(null);
    try {
      const resp = await fetch(`http://${piIp}:${UPLOAD_PORT}/ping`, {
        signal: AbortSignal.timeout(4000),
      });
      const ok = resp.status === 200;
      setPingResult(ok);
    } catch {
      setPingResult(false);
    } finally {
      setPinging(false);
    }
  }, [piIp]);

  // ── Upload ────────────────────────────────────────────────────────────────

  const upload = useCallback(() => {
    if (!pickedFile) {return;}
    if (!piIp) {
      Alert.alert('No IP set', 'Enter the Pi IP address in Settings first.');
      return;
    }

    // Use the cached copy URI if available (guaranteed file:// on Android)
    const fileUri = pickedFile.fileCopyUri ?? pickedFile.uri;
    const fileName = pickedFile.name ?? 'upload';

    setUploading(true);
    setProgress(0);
    setResult(null);

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;

    xhr.upload.onprogress = (e: ProgressEvent) => {
      if (e.lengthComputable) {
        setProgress(e.loaded / e.total);
      }
    };

    xhr.onload = () => {
      setUploading(false);
      xhrRef.current = null;
      if (xhr.status === 200) {
        setResult({ok: true, message: `"${fileName}" uploaded successfully!`});
        setPickedFile(null);
        setProgress(0);
      } else {
        let errMsg = `Server returned ${xhr.status}`;
        try {
          const body = JSON.parse(xhr.responseText);
          if (body.error) {errMsg = body.error;}
        } catch {}
        setResult({ok: false, message: errMsg});
      }
    };

    xhr.onerror = () => {
      setUploading(false);
      xhrRef.current = null;
      setResult({
        ok: false,
        message: 'Upload failed — check that the Pi is on the same WiFi.',
      });
    };

    xhr.ontimeout = () => {
      setUploading(false);
      xhrRef.current = null;
      setResult({ok: false, message: 'Upload timed out.'});
    };

    xhr.open('POST', `http://${piIp}:${UPLOAD_PORT}/upload`);
    // No explicit Content-Type — let XHR set it with the correct boundary

    const formData = new FormData();
    formData.append('file', {
      uri: fileUri,
      type: pickedFile.type ?? 'application/octet-stream',
      name: fileName,
    } as unknown as Blob);

    xhr.send(formData);
  }, [pickedFile, piIp]);

  const cancelUpload = useCallback(() => {
    xhrRef.current?.abort();
    xhrRef.current = null;
    setUploading(false);
    setProgress(0);
    setResult({ok: false, message: 'Upload cancelled.'});
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  const hasIp = piIp.length > 0;
  const canUpload = !uploading && pickedFile !== null && hasIp;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled">

      {/* Pi connection status */}
      <View style={styles.card}>
        <View style={styles.cardRow}>
          <Text style={styles.cardTitle}>Pi Upload Server</Text>
          <View
            style={[
              styles.statusDot,
              {
                backgroundColor:
                  pingResult === true
                    ? '#4CAF50'
                    : pingResult === false
                    ? '#F44336'
                    : '#616161',
              },
            ]}
          />
        </View>
        <Text style={styles.cardSub}>
          {hasIp ? `${piIp}:${UPLOAD_PORT}` : 'No IP set — go to Settings'}
        </Text>
        <TouchableOpacity
          style={[styles.pingBtn, !hasIp && styles.btnDisabled]}
          onPress={pingPi}
          disabled={!hasIp || pinging}>
          <Text style={styles.pingBtnText}>
            {pinging ? 'Pinging…' : pingResult === true ? '✓ Reachable' : 'Ping Pi'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* File picker */}
      <TouchableOpacity style={styles.pickBtn} onPress={pickFile} disabled={uploading}>
        <Text style={styles.pickBtnIcon}>📁</Text>
        <Text style={styles.pickBtnText}>
          {pickedFile ? 'Change File' : 'Pick File to Upload'}
        </Text>
      </TouchableOpacity>

      {/* Selected file card */}
      {pickedFile && (
        <View style={styles.fileCard}>
          <Text style={styles.fileIcon}>
            {(pickedFile.type ?? '').startsWith('video') ? '🎬' : '🖼️'}
          </Text>
          <View style={styles.fileInfo}>
            <Text style={styles.fileName} numberOfLines={2}>
              {pickedFile.name}
            </Text>
            <Text style={styles.fileMeta}>
              {pickedFile.type ?? 'unknown type'}
              {pickedFile.size != null
                ? `  •  ${formatBytes(pickedFile.size)}`
                : ''}
            </Text>
          </View>
        </View>
      )}

      {/* Progress bar */}
      {uploading && (
        <View style={styles.progressSection}>
          <View style={styles.progressBg}>
            <View
              style={[styles.progressFill, {width: `${Math.round(progress * 100)}%`}]}
            />
          </View>
          <Text style={styles.progressText}>
            {Math.round(progress * 100)}% uploaded
          </Text>
          <TouchableOpacity style={styles.cancelBtn} onPress={cancelUpload}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Upload button */}
      {!uploading && (
        <TouchableOpacity
          style={[styles.uploadBtn, !canUpload && styles.btnDisabled]}
          onPress={upload}
          disabled={!canUpload}>
          <Text style={styles.uploadBtnText}>
            {pickedFile ? '⬆  Upload to Pi' : 'Pick a file first'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Result message */}
      {result && (
        <View
          style={[
            styles.resultBanner,
            result.ok ? styles.resultSuccess : styles.resultError,
          ]}>
          <Text style={styles.resultText}>
            {result.ok ? '✓ ' : '✗ '}
            {result.message}
          </Text>
          {result.ok && (
            <Text style={styles.resultHint}>
              Go to Browse tab and tap ↻ Refresh to see the new file.
            </Text>
          )}
        </View>
      )}

      {/* Instructions */}
      <View style={styles.instructions}>
        <Text style={styles.instructionsTitle}>How it works</Text>
        <Text style={styles.instructionsText}>
          1. Make sure your phone and Pi are on the same WiFi network.{'\n'}
          2. Enter the Pi's IP in Settings, then tap Ping to confirm.{'\n'}
          3. Pick a video, GIF, or image from your phone.{'\n'}
          4. Tap Upload — the file is saved to the Pi's media folder.{'\n'}
          5. Switch to Browse and refresh to see it.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
  },
  content: {
    padding: 16,
    gap: 16,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: '#1E1E1E',
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  cardSub: {
    color: '#616161',
    fontSize: 13,
    fontFamily: 'monospace',
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  pingBtn: {
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  pingBtnText: {
    color: '#2196F3',
    fontWeight: '600',
    fontSize: 14,
  },
  pickBtn: {
    backgroundColor: '#1E1E1E',
    borderRadius: 12,
    padding: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    borderStyle: 'dashed',
  },
  pickBtnIcon: {
    fontSize: 24,
  },
  pickBtnText: {
    color: '#2196F3',
    fontSize: 16,
    fontWeight: '600',
  },
  fileCard: {
    backgroundColor: '#1E1E1E',
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  fileIcon: {
    fontSize: 36,
  },
  fileInfo: {
    flex: 1,
    gap: 4,
  },
  fileName: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '500',
  },
  fileMeta: {
    color: '#616161',
    fontSize: 12,
  },
  progressSection: {
    gap: 8,
  },
  progressBg: {
    height: 8,
    backgroundColor: '#2a2a2a',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#2196F3',
    borderRadius: 4,
  },
  progressText: {
    color: '#9E9E9E',
    fontSize: 13,
    textAlign: 'center',
  },
  cancelBtn: {
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  cancelBtnText: {
    color: '#F44336',
    fontWeight: '600',
    fontSize: 14,
  },
  uploadBtn: {
    backgroundColor: '#2196F3',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  uploadBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  resultBanner: {
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  resultSuccess: {
    backgroundColor: '#0a2a0a',
    borderLeftWidth: 3,
    borderLeftColor: '#4CAF50',
  },
  resultError: {
    backgroundColor: '#2a0a0a',
    borderLeftWidth: 3,
    borderLeftColor: '#F44336',
  },
  resultText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '500',
  },
  resultHint: {
    color: '#9E9E9E',
    fontSize: 12,
  },
  instructions: {
    backgroundColor: '#1E1E1E',
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  instructionsTitle: {
    color: '#9E9E9E',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  instructionsText: {
    color: '#616161',
    fontSize: 13,
    lineHeight: 20,
  },
});
