/**
 * SeekBar — pure-JS slider with no native dependencies.
 * Works as a drop-in replacement for @react-native-community/slider
 * for both seek-position and volume controls.
 */
import React, {useCallback, useRef, useState} from 'react';
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
  const [sliding, setSliding] = useState(false);
  const [localValue, setLocalValue] = useState(value);

  // Keep localValue in sync when not sliding
  const displayValue = sliding ? localValue : value;

  const clamp = (v: number) => Math.min(1, Math.max(0, v));

  const valueFromX = useCallback(
    (pageX: number, trackX: number) => {
      if (trackWidth.current <= 0) {return value;}
      return clamp((pageX - trackX) / trackWidth.current);
    },
    [value],
  );

  // We need the track's screen X offset to compute values from touch.
  const trackRef = useRef<View>(null);
  const trackPageX = useRef(0);

  const measureTrack = useCallback((e: LayoutChangeEvent) => {
    trackWidth.current = e.nativeEvent.layout.width;
    // measure absolute position
    trackRef.current?.measure((_x, _y, _w, _h, px) => {
      trackPageX.current = px;
    });
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabled,
      onMoveShouldSetPanResponder: () => !disabled,
      onPanResponderGrant: (e: GestureResponderEvent) => {
        setSliding(true);
        const v = clamp(
          (e.nativeEvent.pageX - trackPageX.current) / trackWidth.current,
        );
        setLocalValue(v);
        onValueChange?.(v);
      },
      onPanResponderMove: (e: GestureResponderEvent) => {
        const v = clamp(
          (e.nativeEvent.pageX - trackPageX.current) / trackWidth.current,
        );
        setLocalValue(v);
        onValueChange?.(v);
      },
      onPanResponderRelease: (e: GestureResponderEvent) => {
        const v = clamp(
          (e.nativeEvent.pageX - trackPageX.current) / trackWidth.current,
        );
        setLocalValue(v);
        setSliding(false);
        onSlidingComplete?.(v);
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

const THUMB = 18;
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
