import Ionicons from "@expo/vector-icons/Ionicons";
import { DefaultTheme, NavigationContainer, useIsFocused, type Theme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState, type ComponentProps, type ComponentType } from "react";
import { BackHandler, InteractionManager, Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { MainTabParamList, RootStackParamList } from "./src/navigation/types";
import { HomeScreen } from "./src/screens/HomeScreen";
import { BookDetailsScreen } from "./src/screens/BookDetailsScreen";
import { BookReaderScreen } from "./src/screens/BookReaderScreen";
import { LibraryScreen } from "./src/screens/LibraryScreen";
import { ReaderScreen } from "./src/screens/ReaderScreen";
import { SearchScreen } from "./src/screens/SearchScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { MeScreen } from "./src/screens/MeScreen";
import { startMobileAuthSync } from "./src/account/auth";
import { IS_EINK_RELEASE } from "./src/config/appVariant";
import { mobileTheme } from "./src/theme/tokens";

const Stack = createNativeStackNavigator<RootStackParamList>();

const tabIcons: Record<keyof MainTabParamList, ComponentProps<typeof Ionicons>["name"]> = {
  Today: "today-outline",
  Library: "library-outline",
  Search: "search-outline",
  Me: "person-outline",
};

const tabLabels: Record<keyof MainTabParamList, string> = {
  Today: "今日",
  Library: "资料库",
  Search: "搜索",
  Me: "我",
};

const tabPreloadOrder: Array<keyof MainTabParamList> = ["Library", "Search", "Me"];

const tabScreens: Record<keyof MainTabParamList, ComponentType> = {
  Today: HomeScreen,
  Library: LibraryScreen,
  Search: SearchScreen,
  Me: MeScreen,
};

function MainTabs() {
  const theme = mobileTheme;
  const tabsFocused = useIsFocused();
  const [activeTab, setActiveTab] = useState<keyof MainTabParamList>("Today");
  const [mountedTabs, setMountedTabs] = useState<Set<keyof MainTabParamList>>(() => new Set(["Today"]));
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    const interactionTasks: Array<{ cancel: () => void }> = [];
    const timers = tabPreloadOrder.map((routeName, index) => setTimeout(() => {
      const task = InteractionManager.runAfterInteractions(() => {
        setMountedTabs((current) => {
          if (current.has(routeName)) return current;
          return new Set([...current, routeName]);
        });
      });
      interactionTasks.push(task);
    }, 650 + index * 320));

    return () => {
      timers.forEach(clearTimeout);
      interactionTasks.forEach((task) => task.cancel());
    };
  }, []);

  useEffect(() => {
    const showSubscription = Keyboard.addListener("keyboardDidShow", () => setKeyboardVisible(true));
    const hideSubscription = Keyboard.addListener("keyboardDidHide", () => setKeyboardVisible(false));
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!tabsFocused) return undefined;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (activeTab === "Today") return false;
      setActiveTab("Today");
      return true;
    });
    return () => subscription.remove();
  }, [activeTab, tabsFocused]);

  function selectTab(routeName: keyof MainTabParamList) {
    setMountedTabs((current) => {
      if (current.has(routeName)) return current;
      return new Set([...current, routeName]);
    });
    setActiveTab(routeName);
  }

  return (
    <View style={[styles.tabsRoot, { backgroundColor: theme.paper }]}>
      <View style={[styles.sceneHost, { bottom: keyboardVisible ? 0 : 60 }]}>
        {(Object.keys(tabScreens) as Array<keyof MainTabParamList>).map((routeName) => {
          if (!mountedTabs.has(routeName)) return null;
          const Screen = tabScreens[routeName];
          const selected = activeTab === routeName;
          return (
            <View
              key={routeName}
              collapsable={false}
              importantForAccessibility={selected ? "auto" : "no-hide-descendants"}
              pointerEvents={selected ? "auto" : "none"}
              style={[styles.tabScene, { opacity: selected ? 1 : 0 }]}
            >
              <Screen />
            </View>
          );
        })}
      </View>
      {!keyboardVisible ? (
        <View accessibilityRole="tablist" style={[styles.tabBar, { backgroundColor: theme.paper, borderTopColor: theme.ruleDark }]}>
          {(Object.keys(tabScreens) as Array<keyof MainTabParamList>).map((routeName) => {
            const selected = activeTab === routeName;
            const color = selected ? theme.red : theme.muted;
            return (
              <Pressable
                key={routeName}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                accessibilityLabel={tabLabels[routeName]}
                onPress={() => selectTab(routeName)}
                style={styles.tabButton}
              >
                <Ionicons name={tabIcons[routeName]} color={color} size={21} />
                <Text style={[styles.tabLabel, { color, fontFamily: theme.sans }]}>{tabLabels[routeName]}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tabsRoot: { flex: 1 },
  sceneHost: { position: "absolute", top: 0, left: 0, right: 0 },
  tabScene: { ...StyleSheet.absoluteFillObject },
  tabBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 60,
    paddingTop: 5,
    paddingBottom: 5,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
  },
  tabButton: { flex: 1, alignItems: "center", justifyContent: "center", gap: 1 },
  tabLabel: { fontSize: 10, fontWeight: "700" },
});

export default function App() {
  const theme = mobileTheme;
  const navigationTheme = useMemo<Theme>(() => ({
    ...DefaultTheme,
    dark: false,
    colors: {
      ...DefaultTheme.colors,
      primary: theme.red,
      background: theme.paper,
      card: theme.paper,
      text: theme.ink,
      border: theme.rule,
      notification: theme.red,
    },
  }), [theme]);

  useEffect(() => startMobileAuthSync(), []);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" backgroundColor={theme.paper} />
      <NavigationContainer theme={navigationTheme}>
        <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.paper } }}>
          <Stack.Screen name="Tabs" component={MainTabs} />
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
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
