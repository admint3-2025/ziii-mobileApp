import React, { useRef, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  View,
  BackHandler,
  Platform,
  ActivityIndicator,
  StatusBar,
  Text,
  TouchableOpacity,
} from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewNavigation, WebViewMessageEvent } from 'react-native-webview';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

// ─── Configuración ────────────────────────────────────────────────────────────

const APP_URL = 'https://ziii-helpdesk.ddns.net';
const BRAND_COLOR = '#1A2B4A';
const ERROR_RETRY_DELAY = 3000;

// Mostrar notificaciones aunque la app esté en primer plano
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowInForeground: true,
  }),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getExpoPushToken(): Promise<string | null> {
  if (!Device.isDevice) return null;

  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;

  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('tickets', {
      name: 'Tickets ZIII HoS',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: BRAND_COLOR,
      sound: 'default',
    });
  }

  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    console.log('[Push] Token:', tokenData.data);
    return tokenData.data;
  } catch (e) {
    console.log('[Push] No disponible:', (e as Error).message);
    return null;
  }
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function App() {
  const webViewRef = useRef<WebView>(null);
  const canGoBackRef = useRef(false);
  const pushTokenRef = useRef<string | null>(null);
  const [hasError, setHasError] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);

  // Obtener push token al iniciar
  useEffect(() => {
    (async () => {
      try {
        pushTokenRef.current = await getExpoPushToken();
      } catch (_e) { /* ignorar */ }
    })();
  }, []);

  // Listener de notificaciones: cuando el usuario toca una, recarga/navega
  useEffect(() => {
    let sub: Notifications.Subscription;
    try {
      sub = Notifications.addNotificationResponseReceivedListener((response) => {
        const data = response.notification.request.content.data;
        if (data?.url && webViewRef.current) {
          webViewRef.current.injectJavaScript(
            `window.location.href = ${JSON.stringify(data.url)}; true;`
          );
        }
      });
    } catch (_e) { /* Expo Go */ }
    return () => { sub?.remove?.(); };
  }, []);

  // Android: botón atrás navega en el WebView
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBackRef.current && webViewRef.current) {
        webViewRef.current.goBack();
        return true;
      }
      return false;
    });
    return () => handler.remove();
  }, []);

  // Inyectar push token en la página web tras cada carga
  const injectToken = useCallback(() => {
    setIsLoading(false);
    setHasError(false);
    if (!pushTokenRef.current || !webViewRef.current) return;
    const script = `
      (function() {
        window.__expoPushToken = ${JSON.stringify(pushTokenRef.current)};
        window.dispatchEvent(new CustomEvent('expoPushTokenReady', { detail: { token: ${JSON.stringify(pushTokenRef.current)} } }));
      })();
      true;
    `;
    webViewRef.current.injectJavaScript(script);
  }, []);

  // Mensajes desde el WebView → nativo
  const onMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'requestPushToken') {
        injectToken();
      }
    } catch (_e) { /* mensaje no JSON, ignorar */ }
  }, [injectToken]);

  const onNavigationStateChange = useCallback((state: WebViewNavigation) => {
    canGoBackRef.current = state.canGoBack;
  }, []);

  if (hasError) {
    return (
      <View style={styles.errorContainer}>
        <StatusBar backgroundColor={BRAND_COLOR} barStyle="light-content" />
        <Text style={styles.errorEmoji}>📡</Text>
        <Text style={styles.errorTitle}>Sin conexión</Text>
        <Text style={styles.errorMsg}>No se pudo conectar con{'\n'}ziii-helpdesk.ddns.net</Text>
        <TouchableOpacity
          style={styles.retryBtn}
          onPress={() => {
            setHasError(false);
            setIsLoading(true);
            webViewRef.current?.reload();
          }}
        >
          <Text style={styles.retryText}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar backgroundColor={BRAND_COLOR} barStyle="light-content" />

      <WebView
        ref={webViewRef}
        source={{ uri: APP_URL }}
        style={styles.webview}
        onNavigationStateChange={onNavigationStateChange}
        onLoadEnd={injectToken}
        onMessage={onMessage}
        onError={() => setHasError(true)}
        onHttpError={(e) => {
          if (e.nativeEvent.statusCode >= 500) setHasError(true);
        }}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        allowsBackForwardNavigationGestures
        startInLoadingState
        renderLoading={() => (
          <View style={styles.loading}>
            <ActivityIndicator size="large" color={BRAND_COLOR} />
            <Text style={styles.loadingText}>Cargando ZIII HoS...</Text>
          </View>
        )}
      />
    </View>
  );
}

// ─── Estilos ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BRAND_COLOR,
  },
  webview: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  loading: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    gap: 12,
  },
  loadingText: {
    color: BRAND_COLOR,
    fontSize: 14,
    fontWeight: '500',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    padding: 32,
    gap: 12,
  },
  errorEmoji: {
    fontSize: 48,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: BRAND_COLOR,
  },
  errorMsg: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 22,
  },
  retryBtn: {
    marginTop: 8,
    backgroundColor: BRAND_COLOR,
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 15,
  },
});
