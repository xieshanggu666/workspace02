import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';
import { useStore } from './store';
import { theme } from './ui/theme';
import { LoginScreen } from './screens/LoginScreen';
import { SpeakersScreen, SpeakerDetailScreen } from './screens/SpeakersScreen';
import { RecorderScreen } from './screens/RecorderScreen';
import { AssetEditorScreen } from './screens/AssetEditorScreen';
import { LibraryScreen, CoursesScreen } from './screens/LibraryScreen';
import { CourseEditorScreen } from './screens/CourseEditorScreen';
import { CourseDetailScreen } from './screens/CourseDetailScreen';
import { SyncScreen } from './screens/SyncScreen';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

function icon(label: string) {
  return ({ focused }: { focused: boolean }) => (
    <Text style={{ fontSize: 18, opacity: focused ? 1 : 0.5 }}>{label}</Text>
  );
}

function Tabs() {
  const me = useStore((s) => s.me);
  const isStudent = me?.role === 'student';
  return (
    <Tab.Navigator
      screenOptions={{
        tabBarActiveTintColor: theme.color.accent,
        headerStyle: { backgroundColor: theme.color.primary },
        headerTintColor: '#fff',
      }}
    >
      {!isStudent && (
        <Tab.Screen
          name="SpeakersTab"
          component={SpeakersStack}
          options={{ title: '说话人', tabBarIcon: icon('👥') }}
        />
      )}
      <Tab.Screen
        name="LibraryTab"
        component={LibraryStack}
        options={{ title: isStudent ? '可练习素材' : '素材库', tabBarIcon: icon('🎙') }}
      />
      <Tab.Screen
        name="CoursesTab"
        component={CoursesStack}
        options={{ title: '课程', tabBarIcon: icon('📚') }}
      />
      <Tab.Screen
        name="SyncTab"
        component={SyncScreen}
        options={{ title: '同步', tabBarIcon: icon('🔄') }}
      />
    </Tab.Navigator>
  );
}

const headerStyle = {
  headerStyle: { backgroundColor: theme.color.primary },
  headerTintColor: '#fff',
};

function SpeakersStack() {
  return (
    <Stack.Navigator screenOptions={headerStyle}>
      <Stack.Screen name="Speakers" component={SpeakersScreen} options={{ title: '说话人与授权' }} />
      <Stack.Screen name="SpeakerDetail" component={SpeakerDetailScreen} options={{ title: '说话人档案' }} />
      <Stack.Screen name="Recorder" component={RecorderScreen} options={{ title: '现场录音' }} />
      <Stack.Screen name="AssetEditor" component={AssetEditorScreen} options={{ title: '波形标注' }} />
    </Stack.Navigator>
  );
}

function LibraryStack() {
  return (
    <Stack.Navigator screenOptions={headerStyle}>
      <Stack.Screen name="Library" component={LibraryScreen} options={{ title: '素材库' }} />
      <Stack.Screen name="AssetEditor" component={AssetEditorScreen} options={{ title: '波形标注' }} />
    </Stack.Navigator>
  );
}

function CoursesStack() {
  return (
    <Stack.Navigator screenOptions={headerStyle}>
      <Stack.Screen name="Courses" component={CoursesScreen} options={{ title: '跟读课' }} />
      <Stack.Screen name="CourseDetail" component={CourseDetailScreen} options={{ title: '课程练习' }} />
      <Stack.Screen name="CourseEditor" component={CourseEditorScreen} options={{ title: '编排课程' }} />
    </Stack.Navigator>
  );
}

export function RootNavigator() {
  const hydrated = useStore((s) => s.hydrated);
  const me = useStore((s) => s.me);
  if (!hydrated) return null;
  return (
    <NavigationContainer>
      {me ? <Tabs /> : <Stack.Navigator screenOptions={headerStyle}><Stack.Screen name="Login" component={LoginScreen} options={{ title: '登录' }} /></Stack.Navigator>}
    </NavigationContainer>
  );
}
