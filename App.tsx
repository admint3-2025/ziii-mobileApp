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
import { File as FSFile, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

// ─── Configuración ────────────────────────────────────────────────────────────

const APP_URL = 'https://ziii-helpdesk.ddns.net';
const BRAND_COLOR = '#1A2B4A';
const ERROR_RETRY_DELAY = 3000;

// Mostrar notificaciones aunque la app esté en primer plano (API SDK 54)
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,   // banner/heads-up visible en primer plano
    shouldShowList: true,     // también en bandeja de notificaciones
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

// Altura de la barra de estado de Android (estática, disponible tras primer render)
const STATUSBAR_HEIGHT = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0;

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

function buildBridgeInjectionScript(token: string | null): string {
  const tokenScript = token
    ? `
      window.__expoPushToken = ${JSON.stringify(token)};
      window.dispatchEvent(new CustomEvent('expoPushTokenReady', {
        detail: { token: ${JSON.stringify(token)} }
      }));
    `
    : '';

  return `
    (function() {
      window.__ziiiNativeDownloadMode = 'url';
      ${tokenScript}
    })();
    true;
  `;
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function App() {
  const webViewRef = useRef<WebView>(null);
  const canGoBackRef = useRef(false);
  const pushTokenRef = useRef<string | null>(null);
  const [hasError, setHasError] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);

  // Obtener push token al iniciar e inyectarlo en cuanto esté disponible
  useEffect(() => {
    (async () => {
      try {
        const token = await getExpoPushToken();
        if (!token) return;
        pushTokenRef.current = token;
        // Inyectar inmediatamente si la página ya cargó (resuelve race condition)
        webViewRef.current?.injectJavaScript(buildBridgeInjectionScript(token));
      } catch (_e) { /* ignorar */ }
    })();
  }, []);

  // Listener de notificaciones: cuando el usuario toca una, recarga/navega
  useEffect(() => {
    let responseSub: Notifications.Subscription;
    let receivedSub: Notifications.Subscription;
    try {
      // Tap en la notificacion → navegar a la URL del ticket
      responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
        const data = response.notification.request.content.data;
        if (data?.url && webViewRef.current) {
          webViewRef.current.injectJavaScript(
            `window.location.href = ${JSON.stringify(data.url)}; true;`
          );
        }
      });
      // Notificacion recibida mientras la app esta abierta → avisar al WebView
      receivedSub = Notifications.addNotificationReceivedListener(() => {
        webViewRef.current?.injectJavaScript(
          `window.dispatchEvent(new CustomEvent('nativeNotificationReceived')); true;`
        );
      });
    } catch (_e) { /* Expo Go */ }
    return () => { responseSub?.remove?.(); receivedSub?.remove?.(); };
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
    if (!webViewRef.current) return;
    webViewRef.current.injectJavaScript(buildBridgeInjectionScript(pushTokenRef.current));
  }, []);

  const sharePdfFile = useCallback(async (fileUri: string) => {
    const canShare = await Sharing.isAvailableAsync();
    if (!canShare) return;

    await Sharing.shareAsync(fileUri, {
      mimeType: 'application/pdf',
      dialogTitle: 'Abrir PDF',
      UTI: 'com.adobe.pdf',
    });
  }, []);

  const savePdfFromBase64 = useCallback(async (dataUrl: string, filename: string) => {
    const base64 = String(dataUrl).replace(/^data:application\/pdf;base64,/, '');
    const file = new FSFile(Paths.cache, filename);
    file.create({ intermediates: true, overwrite: true });
    file.write(base64, { encoding: 'base64' });
    return file;
  }, []);

  const downloadPdfFromUrl = useCallback(async (url: string, filename: string) => {
    const file = new FSFile(Paths.cache, filename);
    return await FSFile.downloadFileAsync(url, file, { idempotent: true });
  }, []);

  // Mensajes desde el WebView → nativo
  const onMessage = useCallback((event: WebViewMessageEvent) => {
    (async () => {
      try {
        const data = JSON.parse(event.nativeEvent.data);
        if (data.type === 'requestPushToken') {
          injectToken();
        } else if (data.type === 'downloadPDFUrl') {
          const url = String(data.url || '');
          if (!url) return;
          const filename = (data.filename as string) || 'documento.pdf';
          const file = await downloadPdfFromUrl(url, filename);
          await sharePdfFile(file.uri);
        } else if (data.type === 'downloadPDF') {
          const filename = (data.filename as string) || 'documento.pdf';
          const file = await savePdfFromBase64(String(data.data || ''), filename);
          await sharePdfFile(file.uri);
        }
      } catch (error) {
        console.error('[WebView] PDF download failed:', error);
      }
    })();
  }, [downloadPdfFromUrl, injectToken, savePdfFromBase64, sharePdfFile]);

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
        userAgent="ZIIIHoSApp/1.0"
        injectedJavaScriptBeforeContentLoaded={buildBridgeInjectionScript(null)}
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
    paddingTop: STATUSBAR_HEIGHT, // evita que el WebView quede bajo la barra de estado
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
