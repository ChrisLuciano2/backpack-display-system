/**
 * SeekBar — pure-JS slider with no native dependencies.
 * Works as a drop-in replacement for @react-native-community/slider
 * for both seek-position and volume controls.
 *
 * Key design note:
 *   PanResponder is created once (stored in useRef) so it never loses the
 *   gesture mid-drag.  Stale-closure risk for props is handled by updating
 *   disabledRef / onValueChangeRef / onSlidingCompleteRef every render.
 */
import React, {useRef, useState} from 'react';
import {
  GestureResponderEvent,
  LayoutChangeEvent,
  PanResponder,
  StyleSheet,
  View,
} from 'react-native';

interface SeekBarProps {
  value: number;           // 0..1
  onValueChange?: (v: number) => void;
  onSlidingComplete?: (v: number) => void;
  minimumTrackTintColor?: string;
  maximumTrackTintColor?: string;
  thumbTintColor?: string;
  disabled?: boolean;
}

// Pure utility — safe to call inside the one-time PanResponder closure
function clamp(v: number) {
  return Math.min(1, Math.max(0, v));
}

export default function SeekBar({
  value,
  onValueChange,
  onSlidingComplete,
  minimumTrackTintColor = '#2196F3',
  maximumTrackTintColor = '#444',
  thumbTintColor = '#2196F3',
  disabled = false,
}: SeekBarProps) {
  const trackWidth = useRef(0);
  const trackPageX = useRef(0);
  const trackRef   = useRef<View>(null);

  const [sliding,    setSliding]    = useState(false);
  const [localValue, setLocalValue] = useState(value);

  // ── Mutable refs so the PanResponder always reads the latest prop values ──
  // These are updated synchronously on every render — before any event fires.
  const disabledRef           = useRef(disabled);
  const onValueChangeRef      = useRef(onValueChange);
  const onSlidingCompleteRef  = useRef(onSlidingComplete);
  disabledRef.current          = disabled;
  onValueChangeRef.current     = onValueChange;
  onSlidingCompleteRef.current = onSlidingComplete;

  // Show localValue while dragging; snap back to server value when idle
  const displayValue = sliding ? localValue : value;

  // Measure track width and absolute X position after layout / orientation change
  const measureTrack = (e: LayoutChangeEvent) => {
    trackWidth.current = e.nativeEvent.layout.width;
    trackRef.current?.measure((_x, _y, _w, _h, px) => {
      trackPageX.current = px ?? 0;
    });
  };

  // Created once — refs guarantee it always sees current prop values
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabledRef.current,
      onMoveShouldSetPanResponder:  () => !disabledRef.current,

      onPanResponderGrant: (e: GestureResponderEvent) => {
        if (disabledRef.current) {return;}
        setSliding(true);
        const v = clamp(
          (e.nativeEvent.pageX - trackPageX.current) / trackWidth.current,
        );
        setLocalValue(v);
        onValueChangeRef.current?.(v);
      },

      onPanResponderMove: (e: GestureResponderEvent) => {
        if (disabledRef.current) {return;}
        const v = clamp(
          (e.nativeEvent.pageX - trackPageX.current) / trackWidth.current,
        );
        setLocalValue(v);
        onValueChangeRef.current?.(v);
      },

      onPanResponderRelease: (e: GestureResponderEvent) => {
        if (disabledRef.current) {return;}
        const v = clamp(
          (e.nativeEvent.pageX - trackPageX.current) / trackWidth.current,
        );
        setLocalValue(v);
        setSliding(false);
        onSlidingCompleteRef.current?.(v);
      },

      onPanResponderTerminate: () => {
        setSliding(false);
      },
    }),
  ).current;

  const fillPct = `${(displayValue * 100).toFixed(1)}%`;

  return (
    <View style={styles.container}>
      <View
        ref={trackRef}
        style={[styles.track, {backgroundColor: maximumTrackTintColor}]}
        onLayout={measureTrack}
        {...panResponder.panHandlers}>
        <View
          style={[
            styles.fill,
            {width: fillPct, backgroundColor: minimumTrackTintColor},
          ]}
        />
        <View
          style={[
            styles.thumb,
            {left: fillPct, backgroundColor: thumbTintColor},
          ]}
        />
      </View>
    </View>
  );
}

const THUMB   = 18;
const TRACK_H = 4;

const styles = StyleSheet.create({
  container: {
    height: 36,
    justifyContent: 'center',
    paddingHorizontal: THUMB / 2,
  },
  track: {
    height: TRACK_H,
    borderRadius: TRACK_H / 2,
    flexDirection: 'row',
    position: 'relative',
  },
  fill: {
    height: TRACK_H,
    borderRadius: TRACK_H / 2,
  },
  thumb: {
    position: 'absolute',
    top: -(THUMB / 2 - TRACK_H / 2),
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    marginLeft: -(THUMB / 2),
    elevation: 2,
  },
});
