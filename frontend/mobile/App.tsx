import Ionicons from "@expo/vector-icons/Ionicons";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { DefaultTheme, NavigationContainer, type Theme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, type ComponentProps } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import type { MainTabParamList, RootStackParamList } from "./src/navigation/types";
import { HomeScreen } from "./src/screens/HomeScreen";
import { BookDetailsScreen } from "./src/screens/BookDetailsScreen";
import { BookReaderScreen } from "./src/screens/BookReaderScreen";
import { LibraryScreen } from "./src/screens/LibraryScreen";
import { ReaderScreen } from "./src/screens/ReaderScreen";
import { SearchScreen } from "./src/screens/SearchScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { OpenSourceLicensesScreen } from "./src/screens/OpenSourceLicensesScreen";
import { MeScreen } from "./src/screens/MeScreen";
import { AccountSecurityScreen } from "./src/screens/AccountSecurityScreen";
import { startMobileAuthSync, useMobileAuthStore } from "./src/account/auth";
import { AiScreen } from "./src/screens/AiScreen";
import { TimesScreen } from "./src/screens/TimesScreen";
import { TimesDetailScreen } from "./src/screens/TimesDetailScreen";
import { NotificationsScreen } from "./src/screens/NotificationsScreen";
import { BookshelfScreen } from "./src/screens/BookshelfScreen";
import { IS_EINK_RELEASE } from "./src/config/appVariant";
import { selectionHaptic } from "./src/lib/haptics";
import { useMobileStore } from "./src/store/mobileStore";
import { mobileTheme } from "./src/theme/tokens";
import { AppUpdatePrompt } from "./src/components/AppUpdatePrompt";

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<MainTabParamList>();

const tabIcons: Record<keyof MainTabParamList, ComponentProps<typeof Ionicons>["name"]> = {
  Today: "home-outline",
  Library: "library-outline",
  Search: "search-outline",
  AI: "sparkles-outline",
  Times: "newspaper-outline",
};

const tabLabels: Record<keyof MainTabParamList, string> = {
  Today: "首页",
  Library: "资料库",
  Search: "搜索",
  AI: "AI",
  Times: "时事",
};

function MainTabs() {
  const theme = mobileTheme;
  const insets = useSafeAreaInsets();
  const initialized = useMobileAuthStore((state) => state.initialized);
  const user = useMobileAuthStore((state) => state.user);
  const hapticsEnabled = useMobileStore((state) => state.hapticsEnabled);
  const authenticated = initialized && Boolean(user);

  return (
    <Tabs.Navigator
      initialRouteName="Today"
      backBehavior="initialRoute"
      detachInactiveScreens
      screenListeners={{
        tabPress: () => { void selectionHaptic(hapticsEnabled); },
      }}
      screenOptions={({ route }) => ({
        headerShown: false,
        lazy: true,
        freezeOnBlur: true,
        animation: "none",
        sceneStyle: { backgroundColor: theme.canvas },
        tabBarHideOnKeyboard: true,
        tabBarActiveTintColor: theme.red,
        tabBarInactiveTintColor: theme.muted,
        tabBarAllowFontScaling: false,
        tabBarAccessibilityLabel: tabLabels[route.name],
        tabBarLabel: tabLabels[route.name],
        tabBarLabelStyle: [styles.tabLabel, { fontFamily: theme.sans }],
        tabBarItemStyle: styles.tabButton,
        tabBarStyle: [
          styles.tabBar,
          {
            height: 56 + insets.bottom,
            paddingBottom: insets.bottom,
            backgroundColor: theme.paper,
            borderTopColor: theme.ruleDark,
          },
        ],
        tabBarIcon: ({ color, focused }) => (
          <View style={styles.tabIcon}>
            {focused ? <View style={[styles.tabIndicator, { backgroundColor: theme.red }]} /> : null}
            <Ionicons name={tabIcons[route.name]} color={color} size={20} />
          </View>
        ),
      })}
    >
      <Tabs.Screen name="Today" component={HomeScreen} />
      <Tabs.Screen name="Library" component={LibraryScreen} />
      <Tabs.Screen name="Search" component={SearchScreen} />
      {authenticated ? <Tabs.Screen name="AI" component={AiScreen} /> : null}
      {authenticated ? <Tabs.Screen name="Times" component={TimesScreen} /> : null}
    </Tabs.Navigator>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    elevation: 0,
    shadowOpacity: 0,
  },
  tabButton: { minHeight: 56 },
  tabIcon: { position: "relative", width: 28, height: 24, alignItems: "center", justifyContent: "center" },
  tabIndicator: { position: "absolute", top: -8, width: 22, height: 3 },
  tabLabel: { fontSize: 10, fontWeight: "800", letterSpacing: 0.4 },
});

export default function App() {
  const theme = mobileTheme;
  const navigationTheme = useMemo<Theme>(() => ({
    ...DefaultTheme,
    dark: false,
    colors: {
      ...DefaultTheme.colors,
      primary: theme.red,
      background: theme.canvas,
      card: theme.paper,
      text: theme.ink,
      border: theme.rule,
      notification: theme.red,
    },
  }), [theme]);

  useEffect(() => startMobileAuthSync(), []);

  return (
    <SafeAreaProvider>
      <AppUpdatePrompt />
      <StatusBar style="dark" backgroundColor={theme.paper} />
      <NavigationContainer theme={navigationTheme}>
        <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.paper } }}>
          <Stack.Screen name="Tabs" component={MainTabs} />
          <Stack.Screen
            name="Account"
            component={MeScreen}
            options={{
              gestureEnabled: true,
              fullScreenGestureEnabled: true,
              animation: IS_EINK_RELEASE ? "none" : "slide_from_right",
            }}
          />
          <Stack.Screen
            name="AccountSecurity"
            component={AccountSecurityScreen}
            options={{
              gestureEnabled: true,
              fullScreenGestureEnabled: true,
              animation: IS_EINK_RELEASE ? "none" : "slide_from_right",
            }}
          />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{
              gestureEnabled: true,
              fullScreenGestureEnabled: true,
              animation: IS_EINK_RELEASE ? "none" : "slide_from_right",
            }}
          />
          <Stack.Screen
            name="Notifications"
            component={NotificationsScreen}
            options={{
              gestureEnabled: true,
              fullScreenGestureEnabled: true,
              animation: IS_EINK_RELEASE ? "none" : "slide_from_right",
            }}
          />
          <Stack.Screen
            name="Bookshelf"
            component={BookshelfScreen}
            options={{
              gestureEnabled: true,
              fullScreenGestureEnabled: true,
              animation: IS_EINK_RELEASE ? "none" : "slide_from_right",
            }}
          />
          <Stack.Screen
            name="OpenSourceLicenses"
            component={OpenSourceLicensesScreen}
            options={{
              gestureEnabled: true,
              fullScreenGestureEnabled: true,
              animation: IS_EINK_RELEASE ? "none" : "slide_from_right",
            }}
          />
          <Stack.Screen
            name="Reader"
            component={ReaderScreen}
            options={{
              gestureEnabled: true,
              fullScreenGestureEnabled: true,
              animation: IS_EINK_RELEASE ? "none" : "slide_from_right",
            }}
          />
          <Stack.Screen
            name="BookDetails"
            component={BookDetailsScreen}
            options={{
              gestureEnabled: true,
              fullScreenGestureEnabled: true,
              animation: IS_EINK_RELEASE ? "none" : "slide_from_right",
            }}
          />
          <Stack.Screen
            name="BookReader"
            component={BookReaderScreen}
            options={{
              gestureEnabled: true,
              fullScreenGestureEnabled: true,
              animation: IS_EINK_RELEASE ? "none" : "slide_from_right",
            }}
          />
          <Stack.Screen
            name="TimesDetail"
            component={TimesDetailScreen}
            options={{
              gestureEnabled: true,
              fullScreenGestureEnabled: true,
              animation: IS_EINK_RELEASE ? "none" : "slide_from_right",
            }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
