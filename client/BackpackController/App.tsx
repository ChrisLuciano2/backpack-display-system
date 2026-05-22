import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {NavigationContainer} from '@react-navigation/native';
import React from 'react';
import {StatusBar, Text} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {BluetoothProvider, useBluetooth} from './src/context/BluetoothContext';
import BrowseFilesScreen from './src/screens/BrowseFilesScreen';
import NowPlayingScreen from './src/screens/NowPlayingScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import UploadScreen from './src/screens/UploadScreen';

const Tab = createBottomTabNavigator();

function TabIcon({label, emoji}: {label: string; emoji: string}) {
  return <Text style={{fontSize: 20}}>{emoji}</Text>;
}

function AppTabs() {
  const {connected} = useBluetooth();

  return (
    <Tab.Navigator
      screenOptions={{
        headerStyle: {backgroundColor: '#1E1E1E'},
        headerTintColor: '#FFFFFF',
        headerTitleStyle: {fontWeight: '600'},
        tabBarStyle: {backgroundColor: '#1E1E1E', borderTopColor: '#2a2a2a'},
        tabBarActiveTintColor: '#2196F3',
        tabBarInactiveTintColor: '#616161',
      }}>
      <Tab.Screen
        name="Now Playing"
        component={NowPlayingScreen}
        options={{
          tabBarIcon: () => <TabIcon label="Now Playing" emoji="▶️" />,
          tabBarLabel: 'Now Playing',
        }}
      />
      <Tab.Screen
        name="Browse"
        component={BrowseFilesScreen}
        options={{
          tabBarIcon: () => <TabIcon label="Browse" emoji="🎬" />,
          tabBarLabel: 'Browse',
        }}
      />
      <Tab.Screen
        name="Upload"
        component={UploadScreen}
        options={{
          tabBarIcon: () => <TabIcon label="Upload" emoji="⬆️" />,
          tabBarLabel: 'Upload',
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          tabBarIcon: () => <TabIcon label="Settings" emoji="⚙️" />,
          tabBarLabel: 'Settings',
          tabBarBadge: connected ? undefined : '!',
        }}
      />
    </Tab.Navigator>
  );
}

export default function App() {
  return (
    <BluetoothProvider>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor="#1E1E1E" />
        <NavigationContainer>
          <AppTabs />
        </NavigationContainer>
      </SafeAreaProvider>
    </BluetoothProvider>
  );
}
